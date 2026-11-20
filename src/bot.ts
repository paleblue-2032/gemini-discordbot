import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type Attachment,
  type AutocompleteInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
} from 'discord.js';
import {
  extractAttachmentMarkers,
  saveAttachments,
  type ExtractResult,
  type FileToSend,
  type SavedAttachment,
} from './attachments.js';
import { startUploadSweeper } from './cleanup.js';
import { isUserAllowed, type Config } from './config.js';
import { readDiskStatus } from './disk-health.js';
import {
  decideThreadCwd,
  describeChannel,
  threadCwdPath,
  type ChatContext,
} from './discord-context.js';
import { formatDuration, splitMessage, stripAnsi, truncate } from './format.js';
import {
  listGeminiModels,
  runGemini,
  type GeminiHistoryStore,
} from './gemini.js';
import { errorMessage, logger } from './logger.js';
import { ALL_EFFORTS, effectiveEffort, effortsFor } from './model-caps.js';
import { listModels, type ModelInfo } from './models.js';
import { isWithin, resolveDirectory } from './paths.js';
import { Progress } from './progress.js';
import { buildGeminiPrompt, buildPrompt, createNonce } from './prompt.js';
import { ChannelQueue } from './queue.js';
import {
  describeExitCode,
  runCmd,
  type ResultPayload,
  type RunResult,
} from './runner.js';
import type { SessionRecord, SessionStore } from './sessions.js';
import { listCandidates, startStorageSweeper } from './storage-sweeper.js';
import { parseTrigger } from './trigger.js';
import { readWorkdirMeta, measureDirectory, upsertWorkdirAgents } from './workdir.js';

interface ProgressUi {
  edit(content: string): Promise<unknown>;
}

interface PromptUi {
  createProgress(content: string): Promise<ProgressUi>;
  sendAnswer(content: string): Promise<void>;
  sendFiles(files: FileToSend[]): Promise<void>;
}

interface SendableChannel {
  send(options: MessageCreateOptions): Promise<Message>;
}

function isSendable(
  channel: Channel | null,
): channel is Channel & SendableChannel {
  return typeof (channel as { send?: unknown } | null)?.send === 'function';
}

function attachmentBuilders(files: FileToSend[]): AttachmentBuilder[] {
  return files.map(
    (file) => new AttachmentBuilder(file.path, { name: file.name }),
  );
}

const EFFORTS = ALL_EFFORTS;

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('このチャンネルのセッションにプロンプトを送る')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('送信するプロンプト').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('セッションを捨てて新しく始める'),
  new SlashCommandBuilder()
    .setName('cwd')
    .setDescription('作業ディレクトリを変更する')
    .addStringOption((option) =>
      option.setName('path').setDescription('許可ルート配下のパス').setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('force')
        .setDescription('他のスレッドが使用中でも変更する')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('モデルと推論の強さを表示・変更する')
    .addStringOption((option) =>
      option
        .setName('model')
        .setDescription('モデル ID（入力で候補を絞り込み）')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('effort')
        .setDescription('推論の強さ（off / low / medium / high / xhigh / max）')
        .setAutocomplete(true)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の cwd とセッション状態を表示する'),
  new SlashCommandBuilder()
    .setName('storage')
    .setDescription('ディスク使用量と削除候補を表示する'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('実行中の処理を停止する'),
  new SlashCommandBuilder()
    .setName('usage')
    .setDescription('使用量・クレジットの確認先を表示する'),
].map((command) => command.toJSON());

function lastStderrLine(stderr: string): string | null {
  const lines = stripAnsi(stderr)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export class Bot {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  private readonly queue: ChannelQueue;
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly startedAt = Date.now();
  private stopSweeper: (() => void) | null = null;
  private stopStorageSweeper: (() => void) | null = null;
  private modelCache: ModelInfo[] | null = null;
  private modelCacheAt = 0;
  private modelLoad: Promise<ModelInfo[]> | null = null;
  private modelFailureAt = 0;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStore,
    private readonly geminiHistory: GeminiHistoryStore,
  ) {
    this.queue = new ChannelQueue(config.maxConcurrency);
    this.client.once(Events.ClientReady, (readyClient) => {
      void this.onReady(readyClient);
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction);
    });
    this.client.on(Events.Error, (error) => {
      logger.error(`Discord クライアントエラー: ${errorMessage(error)}`);
    });
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      logger.warn(
        `Discord 切断 shard=${shardId} code=${event.code} reason=${event.reason || 'none'}`,
      );
    });
    this.client.on(Events.ShardError, (error, shardId) => {
      logger.warn(`Discord 接続エラー shard=${shardId}: ${errorMessage(error)}`);
    });
    this.client.on(Events.ShardReconnecting, (shardId) => {
      logger.info(`Discord に再接続中 shard=${shardId}`);
    });
    this.client.on(Events.ShardResume, (shardId, replayed) => {
      logger.info(`Discord に再接続しました shard=${shardId} replayed=${replayed}`);
    });
  }

  start(): Promise<string> {
    return this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    if (this.stopSweeper) {
      this.stopSweeper();
      this.stopSweeper = null;
    }
    if (this.stopStorageSweeper) {
      this.stopStorageSweeper();
      this.stopStorageSweeper = null;
    }
    for (const controllers of this.pending.values()) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
    this.pending.clear();
    for (const controller of this.active.values()) {
      controller.abort();
    }
    await this.client.destroy();
  }

  private async onReady(client: Client<true>): Promise<void> {
    logger.info(`Discord に接続しました: ${client.user.tag}`);
    try {
      const application = client.application;
      if (!application) {
        logger.warn('application が取得できないためコマンドを登録できません。');
        return;
      }
      for (const guild of client.guilds.cache.values()) {
        try {
          await guild.commands.set([]);
        } catch (error) {
          logger.warn(
            `ギルド ${guild.id} の旧コマンドを削除できませんでした: ${errorMessage(error)}`,
          );
        }
      }
      await application.commands.set(COMMANDS);
      logger.info(`スラッシュコマンドをグローバルに登録しました: ${COMMANDS.length} 件`);
    } catch (error) {
      logger.error(`スラッシュコマンドの登録に失敗しました: ${errorMessage(error)}`);
    }

    void this.getModels();

    if (this.config.uploadTtlMs > 0) {
      this.stopSweeper = startUploadSweeper(
        this.config.allowedRoots,
        this.config.uploadTtlMs,
        this.config.uploadSweepIntervalMs,
      );
      logger.info(
        `添付の定期削除を開始しました ttl=${Math.round(this.config.uploadTtlMs / 3600000)}時間 interval=${Math.round(this.config.uploadSweepIntervalMs / 60000)}分`,
      );
    }

    if (this.config.storageTargetRatio > 0) {
      this.stopStorageSweeper = startStorageSweeper({
        workRoot: this.config.defaultCwd,
        smartFile: this.config.smartFile,
        targetRatio: this.config.storageTargetRatio,
        degradedRatio: this.config.storageDegradedRatio,
        intervalMs: this.config.storageSweepIntervalMs,
        isBusy: (key) => this.active.has(key) || this.pending.has(key),
        sessions: this.sessions,
      });
      logger.info(
        `容量調整を開始しました target=${Math.round(this.config.storageTargetRatio * 100)}% degraded=${Math.round(this.config.storageDegradedRatio * 100)}% interval=${Math.round(this.config.storageSweepIntervalMs / 60000)}分`,
      );
    }
  }

  private isAllowedUser(userId: string): boolean {
    return isUserAllowed(this.config.allowedUserIds, userId);
  }

  private isAllowedChannel(channelId: string, parentId: string | null = null): boolean {
    if (this.config.allowedChannelIds.size === 0) return true;
    if (this.config.allowedChannelIds.has(channelId)) return true;
    return parentId !== null && this.config.allowedChannelIds.has(parentId);
  }

  private activeModel(record: SessionRecord): string | null {
    if (this.config.backend in record.models) {
      return record.models[this.config.backend] ?? this.config.defaultModel;
    }
    if ((record.modelBackend ?? 'cmd') !== this.config.backend) {
      return this.config.defaultModel;
    }
    return record.model ?? this.config.defaultModel;
  }

  private activeEffort(record: SessionRecord): string | null {
    if (this.config.backend !== 'cmd') return null;
    if ('cmd' in record.efforts) {
      return record.efforts.cmd ?? this.config.defaultEffort;
    }
    if ((record.effortBackend ?? 'cmd') !== 'cmd') return this.config.defaultEffort;
    return record.effort ?? this.config.defaultEffort;
  }

  private storedCmdEffort(record: SessionRecord): string | null {
    if ('cmd' in record.efforts) return record.efforts.cmd ?? null;
    return (record.effortBackend ?? 'cmd') === 'cmd' ? record.effort : null;
  }

  private backendLabel(): string {
    return this.config.backend === 'gemini' ? 'gemini（直結）' : 'cmd';
  }

  private async onMessage(message: Message): Promise<void> {
    try {
      if (message.author.bot || message.system) return;

      const channel = await this.resolveChannel(message);
      const ctx = channel ? await this.resolveContext(channel) : null;

      if (!this.isAllowedUser(message.author.id)) return;
      if (!this.isAllowedChannel(message.channelId, ctx?.parentId ?? null)) return;

      const attachments = [...message.attachments.values()];
      const trigger = parseTrigger(
        message.content,
        attachments.length,
        this.config.requireTrigger,
      );
      if (!trigger.triggered) {
        if (trigger.reason === 'attachment-without-prefix') {
          logger.info(
            `トリガーなしの添付を無視しました channel=${message.channelId} user=${message.author.id}`,
          );
        }
        return;
      }

      const prompt = trigger.prompt;
      if (prompt === '' && attachments.length === 0) return;

      const ui = channel ? this.channelUi(channel) : null;
      if (!ui || !ctx) {
        logger.warn(`送信できないチャンネルです: ${message.channelId}`);
        return;
      }

      await this.handlePrompt(message.channelId, prompt, ui, attachments, message.id, ctx);
    } catch (error) {
      logger.error(`メッセージ処理に失敗しました: ${errorMessage(error)}`);
    }
  }

  private async resolveChannel(message: Message): Promise<Channel | null> {
    if (message.channel) return message.channel;
    try {
      return await this.client.channels.fetch(message.channelId);
    } catch (error) {
      logger.warn(
        `チャンネルを取得できませんでした channel=${message.channelId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async resolveContext(channel: Channel): Promise<ChatContext> {
    const parentId = channel.isThread() ? (channel.parentId ?? null) : null;
    if (!channel.isThread() || channel.parent || parentId === null) {
      return describeChannel(channel);
    }

    try {
      const parent = await this.client.channels.fetch(parentId);
      if (parent) return describeChannel(channel, parent);
    } catch (error) {
      logger.warn(
        `親チャンネルを取得できませんでした channel=${parentId}: ${errorMessage(error)}`,
      );
    }
    return describeChannel(channel);
  }

  private channelUi(channel: Channel | null): PromptUi | null {
    if (!isSendable(channel)) return null;

    return {
      createProgress: async (content) => {
        const sent = await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
        return {
          edit: (next) =>
            sent.edit({
              content: next,
              allowedMentions: { parse: [] },
            }),
        };
      },
      sendAnswer: async (content) => {
        await channel.send({
          content,
          allowedMentions: { parse: [] },
        });
      },
      sendFiles: async (files) => {
        for (let index = 0; index < files.length; index += 10) {
          await channel.send({
            files: attachmentBuilders(files.slice(index, index + 10)),
            allowedMentions: { parse: [] },
          });
        }
      },
    };
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    try {
      if (!this.isAllowedUser(interaction.user.id)) {
        await interaction.reply({
          content: 'この操作は許可されていません。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const ctx = interaction.channel
        ? await this.resolveContext(interaction.channel)
        : null;
      if (!this.isAllowedChannel(interaction.channelId, ctx?.parentId ?? null)) {
        await interaction.reply({
          content: 'このチャンネルは許可されていません。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      switch (interaction.commandName) {
        case 'ask':
          await this.handleAsk(interaction, ctx);
          break;
        case 'new':
          await this.handleNew(interaction);
          break;
        case 'cwd':
          await this.handleCwd(interaction);
          break;
        case 'status':
          await this.handleStatus(interaction);
          break;
        case 'storage':
          await this.handleStorage(interaction);
          break;
        case 'stop':
          await this.handleStop(interaction);
          break;
        case 'model':
          await this.handleModel(interaction);
          break;
        case 'usage':
          await this.handleUsage(interaction);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error(`インタラクション処理に失敗しました: ${errorMessage(error)}`);
      try {
        const content = `エラー: ${errorMessage(error)}`;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      const parentId = interaction.channel?.isThread()
        ? (interaction.channel.parentId ?? null)
        : null;
      if (
        !this.isAllowedUser(interaction.user.id) ||
        !this.isAllowedChannel(interaction.channelId, parentId)
      ) {
        await interaction.respond([]);
        return;
      }
      if (interaction.commandName !== 'model') {
        await interaction.respond([]);
        return;
      }

      const focused = interaction.options.getFocused(true);
      const query = String(focused.value ?? '').toLowerCase();

      if (focused.name === 'effort') {
        if (this.config.backend === 'gemini') {
          await interaction.respond([]);
          return;
        }
        const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
        const effectiveModel = this.activeModel(record);
        const support = effortsFor(effectiveModel);
        const current = this.activeEffort(record);
        const values = new Map<string, string>();
        if (current && current.includes(query)) {
          values.set(current, current);
        }
        if ('default'.includes(query)) {
          values.set('default', 'default');
        }
        for (const level of support.known ? support.efforts : EFFORTS) {
          if (level.includes(query)) values.set(level, level);
        }
        await interaction.respond(
          [...values.entries()]
            .slice(0, 25)
            .map(([value, name]) => ({ name, value })),
        );
        return;
      }

      if (focused.name !== 'model') {
        await interaction.respond([]);
        return;
      }

      const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
      const current = this.activeModel(record);
      const models = this.modelCache ?? [];
      if (!this.modelCache) {
        void this.getModels();
      }
      const choices = new Map<string, string>();

      if (current && current.toLowerCase().includes(query)) {
        choices.set(current, truncate(current, 100));
      }
      if ('default'.includes(query)) {
        choices.set('default', 'default');
      }
      for (const model of models) {
        if (!model.id.toLowerCase().includes(query)) continue;
        if (choices.has(model.id)) continue;
        choices.set(
          model.id,
          truncate(`${model.id}: ${model.description}`, 100),
        );
        if (choices.size >= 25) break;
      }

      await interaction.respond(
        [...choices.entries()]
          .slice(0, 25)
          .map(([value, name]) => ({ name, value })),
      );
    } catch (error) {
      logger.error(`autocomplete に失敗しました: ${errorMessage(error)}`);
      try {
        await interaction.respond([]);
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async getModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCacheAt < 10 * 60 * 1000) {
      return this.modelCache;
    }
    if (now - this.modelFailureAt < 60 * 1000) {
      return [];
    }
    if (this.modelLoad) {
      return this.modelLoad;
    }

    const load =
      this.config.backend === 'gemini'
        ? listGeminiModels(this.config.gemini.apiKey, this.config.gemini.baseUrl)
        : listModels(this.config.cmdBin, this.config.defaultCwd);

    this.modelLoad = load
      .then((models) => {
        this.modelCache = models;
        this.modelCacheAt = Date.now();
        logger.info(`モデル一覧を取得しました: ${models.length} 件`);
        return models;
      })
      .catch((error: unknown) => {
        this.modelFailureAt = Date.now();
        logger.warn(`モデル一覧を取得できませんでした: ${errorMessage(error)}`);
        return [];
      })
      .finally(() => {
        this.modelLoad = null;
      });

    return this.modelLoad;
  }

  private async handleAsk(
    interaction: ChatInputCommandInteraction,
    ctx: ChatContext | null,
  ): Promise<void> {
    const prompt = interaction.options.getString('prompt', true).trim();
    if (prompt === '') {
      await interaction.reply({ content: 'プロンプトが空です。', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    const ui: PromptUi = {
      createProgress: async (content) => {
        await interaction.editReply({
          content,
          allowedMentions: { parse: [] },
        });
        return {
          edit: (next) =>
            interaction.editReply({
              content: next,
              allowedMentions: { parse: [] },
            }),
        };
      },
      sendAnswer: async (content) => {
        await interaction.followUp({
          content,
          allowedMentions: { parse: [] },
        });
      },
      sendFiles: async (files) => {
        for (let index = 0; index < files.length; index += 10) {
          await interaction.followUp({
            files: attachmentBuilders(files.slice(index, index + 10)),
            allowedMentions: { parse: [] },
          });
        }
      },
    };

    await this.handlePrompt(interaction.channelId, prompt, ui, [], null, ctx);
  }

  private async handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
    const record = this.sessions.get(interaction.channelId, this.config.defaultCwd);
    await this.sessions.clearSession(interaction.channelId);
    await this.geminiHistory.clear(interaction.channelId);
    await interaction.reply({
      content: `セッションをリセットしました。\ncwd: \`${record.cwd}\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleCwd(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString('path', true);
    const force = interaction.options.getBoolean('force') ?? false;
    const key = interaction.channelId;
    const record = this.sessions.get(key, this.config.defaultCwd);
    try {
      const target = await resolveDirectory(input, this.config.allowedRoots, record.cwd);

      if (!force && target !== record.cwd && this.sessions.cwdTaken(target, key)) {
        const users = this.sessions
          .entries()
          .filter(([other, otherRecord]) => other !== key && otherRecord.cwd === target)
          .length;
        if (this.config.cwdConflict === 'deny') {
          await interaction.reply({
            content: `\`${target}\` は他の ${users} スレッドが使用中です。\n同時に編集すると衝突するため変更しません。意図的な共有なら \`force:true\` を付けてください。`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        logger.warn(`cwd が重複しています target=${target} channel=${key} users=${users}`);
      }

      await this.sessions.setCwd(key, target);
      await this.geminiHistory.clear(key);
      await interaction.reply({
        content: `cwd を変更しました: \`${target}\`\nセッションはリセットされました。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: `変更できません: ${errorMessage(error)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
    const key = interaction.channelId;
    const modelInputRaw = interaction.options.getString('model');
    const effortInputRaw = interaction.options.getString('effort');
    const modelInput = modelInputRaw === null ? null : modelInputRaw.trim();
    const effortInput =
      effortInputRaw === null ? null : effortInputRaw.trim().toLowerCase();

    if (this.config.backend === 'gemini' && effortInput !== null && effortInput !== '') {
      await interaction.reply({
        content: 'Gemini 直結では effort を使いません。model のみ指定できます。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let nextModel: string | null | undefined;
    if (modelInput !== null && modelInput !== '') {
      if (modelInput === 'default' || modelInput === 'reset') {
        nextModel = null;
      } else if (!/^[A-Za-z0-9._:/-]+$/.test(modelInput)) {
        await interaction.reply({
          content: `モデル ID の形式が不正です: \`${modelInput}\``,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else {
        nextModel = modelInput;
      }
    }

    const record = this.sessions.get(key, this.config.defaultCwd);
    const targetModel =
      nextModel !== undefined ? nextModel : this.activeModel(record);
    const support = effortsFor(targetModel);

    let nextEffort: string | null | undefined;
    if (effortInput !== null && effortInput !== '') {
      if (effortInput === 'default' || effortInput === 'reset') {
        nextEffort = null;
      } else if (!(EFFORTS as readonly string[]).includes(effortInput)) {
        await interaction.reply({
          content: `effort は ${EFFORTS.join(' / ')} のいずれかです。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else if (support.known && support.efforts.length === 0) {
        await interaction.reply({
          content: `\`${targetModel}\` は effort に対応していません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else if (support.known && !(support.efforts as readonly string[]).includes(effortInput)) {
        await interaction.reply({
          content: `\`${targetModel}\` で使える effort は ${support.efforts.join(' / ')} です。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      } else {
        nextEffort = effortInput;
      }
    }

    const notes: string[] = [];
    if (nextModel !== undefined) {
      await this.sessions.setModel(key, nextModel, this.config.backend);
      if (this.config.backend === 'cmd') {
        const current = this.sessions.get(key, this.config.defaultCwd);
        const kept = this.storedCmdEffort(current);
        if (kept !== null && nextEffort === undefined) {
          const nextSupport = effortsFor(nextModel);
          if (nextSupport.known && !(nextSupport.efforts as readonly string[]).includes(kept)) {
            await this.sessions.setEffort(key, null, 'cmd');
            notes.push(`effort を解除しました（\`${nextModel ?? 'デフォルト'}\` では使えない値でした）。`);
          }
        }
      }
    }
    if (nextEffort !== undefined) {
      await this.sessions.setEffort(key, nextEffort, this.config.backend);
    }

    const updated = this.sessions.get(key, this.config.defaultCwd);
    const model = this.activeModel(updated);
    const storedEffort =
      this.config.backend === 'cmd' ? this.storedCmdEffort(updated) : null;
    const resolved = effectiveEffort(model, storedEffort, this.config.defaultEffort);
    const changed = nextModel !== undefined || nextEffort !== undefined;
    if (changed) {
      logger.info(
        `model 設定 channel=${key} backend=${this.config.backend} model=${updated.model ?? 'default'} effort=${updated.effort ?? 'default'}`,
      );
    }

    const effortSupport = effortsFor(model);
    const effortLabel =
      this.config.backend === 'gemini'
        ? 'なし（Gemini 直結では未使用）'
        : resolved.effort !== null
          ? `\`${resolved.effort}\`${resolved.reason === 'default' ? '（CMD_EFFORT）' : ''}`
          : effortSupport.known && effortSupport.efforts.length === 0
            ? 'なし（このモデルは非対応）'
            : '未設定（モデル既定）';

    const lines = [
      `backend: ${this.backendLabel()}`,
      `model: ${model ? `\`${model}\`` : 'デフォルト'}`,
      `effort: ${effortLabel}`,
      ...notes,
      changed
        ? '次のメッセージから適用されます。'
        : '変更するには model / effort を指定してください（候補から選択できます）。',
    ];
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleUsage(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({
      content:
        this.config.backend === 'gemini'
          ? 'Gemini API の使用量は Google AI Studio の Usage か Google Cloud の課金コンソールで確認してください。'
          : '使用量・クレジットは対話モードの `/usage` か https://commandcode.ai/usage で確認できます。ヘッドレス実行からは実数値を取得できません。',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const ctx = interaction.channel
      ? await this.resolveContext(interaction.channel)
      : null;
    const key = interaction.channelId;
    const record = this.sessions.get(key, this.config.defaultCwd);
    const model = this.activeModel(record);
    const storedEffort =
      this.config.backend === 'cmd' ? this.storedCmdEffort(record) : null;
    const resolvedEffort = effectiveEffort(model, storedEffort, this.config.defaultEffort);
    const effort = this.config.backend === 'gemini' ? null : resolvedEffort.effort;
    const running = this.active.has(key);
    const waiting = this.queue.depth(key) - (running ? 1 : 0);
    const sourceLabel: Record<SessionRecord['cwdSource'], string> = {
      default: '既定',
      thread: '投稿ごとに自動作成',
      user: '/cwd で指定',
      unknown: '既存の設定',
    };
    const effortSupport = effortsFor(model);
    const effortLabel =
      this.config.backend === 'gemini'
        ? 'なし（Gemini 直結では未使用）'
        : effort
          ? `\`${effort}\`${resolvedEffort.reason === 'default' ? '（CMD_EFFORT）' : ''}`
          : effortSupport.known && effortSupport.efforts.length === 0
            ? 'なし（このモデルは非対応）'
            : '未設定（モデル既定）';
    const agentsMeta = await readWorkdirMeta(record.cwd);
    const agentsExists = await fileExists(path.join(record.cwd, 'AGENTS.md'));
    const lines = [
      `backend: ${this.backendLabel()}`,
      ...(ctx ? [`場所: ${ctx.label}`] : []),
      `cwd: \`${record.cwd}\` (${sourceLabel[record.cwdSource]})`,
      this.config.backend === 'gemini'
        ? `履歴: ${this.geminiHistory.count(key)} 件`
        : `session: ${record.sessionId ? `\`${record.sessionId}\`` : 'なし'}`,
      `model: ${model ? `\`${model}\`` : 'デフォルト'}`,
      `effort: ${effortLabel}`,
      ...(record.createdAt
        ? [`作成: ${record.createdAt.slice(0, 16).replace('T', ' ')} / 最終作業: ${record.updatedAt.slice(0, 16).replace('T', ' ')}`]
        : [`最終作業: ${record.updatedAt.slice(0, 16).replace('T', ' ')}`]),
      `AGENTS.md: ${agentsMeta ? '自動更新あり' : agentsExists ? 'あり（自動更新なし）' : 'なし'}`,
      `状態: ${running ? '実行中' : '待機中'}${waiting > 0 ? ` / 待ち ${waiting} 件` : ''}`,
      `同時実行上限: ${this.config.maxConcurrency}`,
      `稼働時間: ${formatDuration(Date.now() - this.startedAt)}`,
    ];
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  }

  private async handleStorage(interaction: ChatInputCommandInteraction): Promise<void> {
    const status = await readDiskStatus(this.config.defaultCwd, this.config.smartFile);
    const degraded = status.smart === 'warning' || status.smart === 'critical';
    const targetRatio = degraded
      ? Math.min(this.config.storageTargetRatio, this.config.storageDegradedRatio)
      : this.config.storageTargetRatio;

    const candidates = await listCandidates(
      this.sessions,
      this.config.defaultCwd,
      (key) => this.active.has(key) || this.pending.has(key),
    );
    const top = candidates.slice(0, 5);
    const sizes = await Promise.all(top.map((candidate) => measureDirectory(candidate.cwd)));

    const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
    const lines = [
      `作業領域: \`${this.config.defaultCwd}\` (${gb(status.usedBytes)} / ${gb(status.totalBytes)}, ${(status.usedRatio * 100).toFixed(1)}%)`,
      `目標: ${Math.round(targetRatio * 100)}%${degraded ? '（SMART 劣化中のため強化）' : ''}`,
      `SMART: ${status.smart}${status.smartDetail ? ` (${status.smartDetail})` : ''}`,
      `削除候補: ${candidates.length} 件（自動削除は 1 回 5 件まで）`,
    ];

    top.forEach((candidate, index) => {
      const when = new Date(candidate.lastUsedAt).toISOString().slice(0, 10);
      lines.push(
        `${index + 1}. ${candidate.cwd.replace(`${this.config.defaultCwd}/`, '')} — ${gb(sizes[index] ?? 0)}, 最終 ${when}`,
      );
    });

    if (candidates.length === 0) lines.push('（自動作成された作業ディレクトリのみが対象です）');

    await interaction.reply({
      content: truncate(lines.join('\n'), 1900),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const key = interaction.channelId;
    const running = this.active.get(key);
    if (running) {
      running.abort();
      await interaction.reply({ content: '停止しました。', flags: MessageFlags.Ephemeral });
      return;
    }

    const queued = this.pending.get(key);
    if (queued && queued.size > 0) {
      for (const controller of queued) {
        controller.abort();
      }
      queued.clear();
      this.pending.delete(key);
      await interaction.reply({
        content: '待機中のジョブを取り消しました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: '実行中の処理はありません。',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handlePrompt(
    channelId: string,
    prompt: string,
    ui: PromptUi,
    attachments: Attachment[] = [],
    messageId: string | null = null,
    ctx: ChatContext | null = null,
  ): Promise<void> {
    const key = channelId;
    const queuedAhead = this.queue.depth(key);
    const placeholder =
      queuedAhead > 0 ? `待機中… (待ち ${queuedAhead} 件)` : '待機中…';
    const progressUi = await this.safeCreateProgress(ui, placeholder);

    const controller = new AbortController();
    const queued = this.pending.get(key) ?? new Set<AbortController>();
    queued.add(controller);
    this.pending.set(key, queued);

    const job = this.queue.run(key, async () => {
      queued.delete(controller);
      if (queued.size === 0 && this.pending.get(key) === queued) {
        this.pending.delete(key);
      }
      if (controller.signal.aborted) {
        await progressUi.edit('取り消しました。');
        return;
      }
      this.active.set(key, controller);

      try {
        const record = this.sessions.get(key, this.config.defaultCwd);
        const cwd = await this.resolveThreadCwd(key, record, ctx);
        const backend = this.config.backend;
        const sessionId =
          backend === 'cmd' && cwd === record.cwd ? record.sessionId : null;
        await this.ensureCwd(cwd);

        let saved: SavedAttachment[] = [];
        let attachmentErrors: string[] = [];
        if (attachments.length > 0 && messageId) {
          const attachmentResult = await saveAttachments(attachments, cwd, messageId);
          saved = attachmentResult.saved;
          attachmentErrors = attachmentResult.errors;
        }
        const effectivePrompt =
          backend === 'gemini'
            ? buildGeminiPrompt(prompt, attachmentErrors)
            : buildPrompt({
                prompt,
                files: saved,
                errors: attachmentErrors,
                nonce: createNonce(),
              });
        const model = this.activeModel(record);
        let effortArg: string | null = null;

        if (backend === 'cmd') {
          const storedEffort = this.storedCmdEffort(record);
          const resolved = effectiveEffort(
            model,
            storedEffort,
            this.config.defaultEffort,
          );
          effortArg = resolved.effort;

          if (resolved.reason === 'stored-unsupported') {
            logger.warn(
              `effort を解除します（モデル非対応） channel=${key} model=${model ?? 'default'} effort=${record.effort}`,
            );
            await this.sessions.setEffort(key, null, 'cmd');
          } else if (resolved.reason === 'default-unsupported') {
            logger.warn(
              `CMD_EFFORT を無視します（モデル非対応） channel=${key} model=${model ?? 'default'} effort=${this.config.defaultEffort}`,
            );
          }
        }

        const progress = new Progress(progressUi, this.config.progressIntervalMs, (activity) => {
          logger.info(`進捗 channel=${key} ${activity}`);
        });
        progress.start();

        logger.info(
          `実行開始 backend=${backend} channel=${key} cwd=${cwd} resume=${sessionId ? 'yes' : 'no'} model=${model ?? 'default'} effort=${effortArg ?? 'default'} attachments=${saved.length}${ctx ? ` where=${ctx.label}` : ''}`,
        );
        const run =
          backend === 'gemini'
            ? await runGemini({
                apiKey: this.config.gemini.apiKey,
                baseUrl: this.config.gemini.baseUrl,
                model: model ?? this.config.gemini.model,
                prompt: effectivePrompt,
                sessionKey: key,
                attachments: saved,
                history: this.geminiHistory,
                systemPrompt: this.config.gemini.systemPrompt,
                googleSearch: this.config.gemini.googleSearch,
                timeoutMs: this.config.gemini.timeoutMs,
                maxOutputTokens: this.config.gemini.maxOutputTokens,
                maxHistoryMessages: this.config.gemini.maxHistoryMessages,
                signal: controller.signal,
                onEvent: (event) => progress.handleEvent(event),
              })
            : await runCmd({
                cmdBin: this.config.cmdBin,
                prompt: effectivePrompt,
                cwd,
                sessionId,
                model,
                effort: effortArg,
                signal: controller.signal,
                onEvent: (event) => progress.handleEvent(event),
              });
        logger.info(
          `実行終了 channel=${key} exit=${run.exitCode} duration=${run.durationMs}ms`,
        );
        await this.completeRun(key, run, ui, progress, cwd);
        await this.updateWorkdirAgents(key, cwd, record, ctx, run);
      } finally {
        if (this.active.get(key) === controller) {
          this.active.delete(key);
        }
      }
    });

    try {
      await job;
    } catch (error) {
      logger.error(`実行に失敗しました: ${errorMessage(error)}`);
      try {
        await progressUi.edit(truncate(`失敗: ${errorMessage(error)}`, 1900));
      } catch {
        // ignore secondary failures
      }
    }
  }

  private async resolveThreadCwd(
    key: string,
    record: SessionRecord,
    ctx: ChatContext | null,
  ): Promise<string> {
    const decision = decideThreadCwd(ctx, record, this.config.forumCwd);
    if (!decision.auto || decision.slug === null) return record.cwd;

    const target = threadCwdPath(
      this.config.defaultCwd,
      decision.slug,
      key,
      (candidate) => this.sessions.cwdTaken(candidate, key),
    );

    try {
      await mkdir(target, { recursive: true, mode: 0o775 });
      const real = await realpath(target);
      if (!this.config.allowedRoots.some((root) => isWithin(root, real))) {
        logger.warn(`投稿用の cwd が許可ルートの外です: ${real}`);
        return record.cwd;
      }
      if (real !== record.cwd) {
        await this.sessions.setCwd(key, real, 'thread');
      }
      return real;
    } catch (error) {
      logger.warn(
        `投稿用の cwd を作成できませんでした ${target}: ${errorMessage(error)}`,
      );
      return record.cwd;
    }
  }

  private async safeCreateProgress(
    ui: PromptUi,
    placeholder = '待機中…',
  ): Promise<ProgressUi> {
    try {
      return await ui.createProgress(placeholder);
    } catch (error) {
      logger.warn(`進捗メッセージを作成できませんでした: ${errorMessage(error)}`);
      return {
        edit: async () => undefined,
      };
    }
  }

  private async ensureCwd(cwd: string): Promise<void> {
    let info;
    try {
      info = await stat(cwd);
    } catch {
      throw new Error(`cwd が存在しません: ${cwd}\n/cwd で変更してください。`);
    }
    if (!info.isDirectory()) {
      throw new Error(`cwd がディレクトリではありません: ${cwd}`);
    }
  }

  private async updateWorkdirAgents(
    key: string,
    cwd: string,
    record: SessionRecord,
    ctx: ChatContext | null,
    run: RunResult,
  ): Promise<void> {
    if (this.config.workdirMeta === 'off') return;
    if (this.config.workdirMeta === 'thread' && record.cwdSource !== 'thread') return;

    try {
      const current = this.sessions.get(key, this.config.defaultCwd);
      const previous = await readWorkdirMeta(cwd);
      const now = new Date().toISOString();
      const isCmd = this.config.backend === 'cmd';
      await upsertWorkdirAgents(cwd, {
        threadLabel: ctx?.label ?? key,
        createdAt: previous?.createdAt ?? record.createdAt ?? now,
        updatedAt: now,
        sessionId: isCmd ? (run.sessionId ?? current.sessionId) : null,
        model: this.activeModel(current),
        effort: isCmd ? this.activeEffort(current) : null,
      });
    } catch (error) {
      logger.warn(`AGENTS.md を更新できませんでした ${cwd}: ${errorMessage(error)}`);
    }
  }

  private async completeRun(
    channelId: string,
    run: RunResult,
    ui: PromptUi,
    progress: Progress,
    cwd: string,
  ): Promise<void> {
    const isGemini = this.config.backend === 'gemini';
    const result: ResultPayload | null = run.result;
    const rawText = result?.finalText?.trim() ?? '';
    const extracted: ExtractResult =
      rawText === ''
        ? { text: '', files: [], errors: [] }
        : await extractAttachmentMarkers(rawText, cwd);
    const finalText = extracted.text;
    const files = run.aborted ? [] : extracted.files;
    const fileErrors = extracted.errors;
    let answer: string | null = null;
    let status: string;

    if (run.aborted) {
      status = '停止しました。';
    } else if (run.spawnError) {
      status = `バックエンドを起動できませんでした: ${truncate(run.spawnError, 500)}`;
    } else if (run.exitCode === 0 && result?.subtype === 'success') {
      status = `完了 (${formatDuration(run.durationMs)})`;
      answer = finalText === '' ? null : finalText;
      if (!answer) status += '\n応答は空でした。';
    } else if (!isGemini && run.exitCode === 0 && result?.subtype === 'max_turns') {
      status = `最大ターン数に達しました (${formatDuration(run.durationMs)})\nプロンプトを分割してください。`;
      answer = finalText === '' ? null : finalText;
    } else {
      status = `失敗: ${isGemini ? 'Gemini API' : describeExitCode(run.exitCode)} (${formatDuration(run.durationMs)})`;
      const detail = result?.error ?? lastStderrLine(run.stderr);
      if (detail) status += `\n${truncate(detail, 500)}`;
      answer = finalText === '' ? null : finalText;

      if (!isGemini) {
        if (run.exitCode === 3) {
          status += '\nサーバーで `cmd login` を実行してください。';
        } else if (run.exitCode === 4) {
          status += '\n`.commandcode/settings.json` の deny ルールを確認してください。';
        } else if (run.exitCode === 5) {
          status += '\n少し待ってから再試行してください。';
        } else if (run.exitCode === 6) {
          status += '\nネットワーク接続を確認してください。';
        } else if (run.exitCode === 10) {
          status += '\nhttps://commandcode.ai/billing を確認してください。';
        }
      }
    }

    if (files.length > 0) {
      status += `\n添付: ${files.length} ファイル`;
    }

    if (!isGemini) {
      if (result?.error?.includes('No session') && !run.sessionId) {
        await this.sessions.clearSession(channelId);
      } else if (run.sessionId) {
        await this.sessions.setSessionId(channelId, run.sessionId);
      }
    }

    if (!isGemini && run.exitCode !== 0 && !run.aborted) {
      const detail = `${result?.error ?? ''}\n${run.stderr}`.toLowerCase();
      const effortRejected =
        detail.includes('effort') &&
        (detail.includes('invalid') ||
          detail.includes('unsupported') ||
          detail.includes('not supported'));
      if (
        effortRejected &&
        this.storedCmdEffort(this.sessions.get(channelId, this.config.defaultCwd)) !== null
      ) {
        await this.sessions.setEffort(channelId, null, 'cmd');
        logger.warn(`effort が拒否されたため解除しました channel=${channelId}`);
        status += '\neffort を解除しました。次のメッセージから既定値で実行します。';
      }
    }

    await progress.finish(truncate(status, 1900));

    if (answer) {
      const chunks = splitMessage(answer, 2000);
      for (const chunk of chunks) {
        try {
          await ui.sendAnswer(chunk);
        } catch (error) {
          logger.error(`応答の投稿に失敗しました: ${errorMessage(error)}`);
          break;
        }
      }
    }

    if (files.length > 0) {
      try {
        await ui.sendFiles(files);
      } catch (error) {
        logger.error(`ファイルの送信に失敗しました: ${errorMessage(error)}`);
        try {
          await ui.sendAnswer(
            truncate(`ファイル送信に失敗しました: ${errorMessage(error)}`, 1900),
          );
        } catch {
          // ignore secondary failures
        }
      }
    }

    if (fileErrors.length > 0) {
      try {
        await ui.sendAnswer(
          truncate(`添付できなかったファイル: ${fileErrors.join(', ')}`, 1900),
        );
      } catch {
        // ignore secondary failures
      }
    }
  }
}
