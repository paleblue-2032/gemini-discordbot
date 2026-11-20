import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SavedAttachment } from './attachments.js';
import { truncate } from './format.js';
import { errorMessage, logger } from './logger.js';
import type { ModelInfo } from './models.js';
import { isRecord, type AgentEvent, type RunResult } from './runner.js';

export type GeminiRole = 'user' | 'model';

export interface GeminiTextPart {
  text: string;
}

export interface GeminiFilePart {
  file: {
    path: string;
    mimeType: string;
    name: string;
  };
}

export type GeminiPart = GeminiTextPart | GeminiFilePart;

export interface GeminiHistoryMessage {
  role: GeminiRole;
  parts: GeminiPart[];
}

interface GeminiHistoryEntry {
  updatedAt: string;
  messages: GeminiHistoryMessage[];
}

type GeminiHistoryData = Record<string, GeminiHistoryEntry>;

interface GeminiApiTextPart {
  text: string;
}

interface GeminiApiInlinePart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

type GeminiApiPart = GeminiApiTextPart | GeminiApiInlinePart;

interface GeminiApiContent {
  role: GeminiRole;
  parts: GeminiApiPart[];
}

interface GeminiRequestOptions {
  systemPrompt: string;
  maxOutputTokens: number;
  googleSearch: boolean;
}

export interface GeminiRunOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  sessionKey: string;
  attachments: SavedAttachment[];
  history: GeminiHistoryStore;
  systemPrompt: string;
  googleSearch: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxHistoryMessages: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  fetchImpl?: typeof fetch;
}

const MAX_TEXT_FILE_BYTES = 256_000;
const MAX_INLINE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_CHARS = 400_000;
const MODEL_EXCLUDE =
  /(tts|image|embedding|embed|live|transcribe|computer-use|deep-research|robotics|lyria|nano-banana|aqa|veo|audio|speech|native-audio)/i;

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'application/toml',
]);

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
};

function messageChars(message: GeminiHistoryMessage): number {
  return message.parts.reduce(
    (total, part) => total + ('text' in part ? part.text.length : 0),
    0,
  );
}

export function trimHistory(
  messages: readonly GeminiHistoryMessage[],
  maxMessages: number,
): GeminiHistoryMessage[] {
  const limit = Math.max(1, maxMessages);
  const lowerBound = Math.max(0, messages.length - limit);
  let start = lowerBound;
  let chars = 0;
  for (let index = messages.length - 1; index >= lowerBound; index -= 1) {
    const size = messageChars(messages[index]!);
    if (chars + size > MAX_HISTORY_CHARS && index < messages.length - 1) {
      start = index + 1;
      break;
    }
    chars += size;
    start = index;
  }
  let trimmed = messages.slice(start);
  while (trimmed.length > 0 && trimmed[0]!.role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function normalizePart(value: unknown): GeminiPart | null {
  if (!isRecord(value)) return null;
  if (typeof value.text === 'string' && value.text !== '') {
    return { text: value.text };
  }
  if (isRecord(value.file)) {
    const file = value.file;
    if (
      typeof file.path === 'string' &&
      file.path !== '' &&
      typeof file.mimeType === 'string' &&
      typeof file.name === 'string'
    ) {
      return {
        file: {
          path: file.path,
          mimeType: file.mimeType,
          name: file.name,
        },
      };
    }
  }
  return null;
}

function normalizeMessage(value: unknown): GeminiHistoryMessage | null {
  if (!isRecord(value)) return null;
  if (value.role !== 'user' && value.role !== 'model') return null;
  if (!Array.isArray(value.parts)) return null;
  const parts = value.parts.map(normalizePart).filter((part): part is GeminiPart => part !== null);
  if (parts.length === 0) return null;
  return { role: value.role, parts };
}

function normalizeEntry(value: unknown): GeminiHistoryEntry | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const messages = value.messages
    .map(normalizeMessage)
    .filter((message): message is GeminiHistoryMessage => message !== null);
  if (messages.length === 0) return null;
  const updatedAt =
    typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();
  return { updatedAt, messages };
}

export class GeminiHistoryStore {
  private data: GeminiHistoryData = {};
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async load(file: string): Promise<GeminiHistoryStore> {
    const store = new GeminiHistoryStore(file);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const entry = normalizeEntry(value);
          if (entry) store.data[key] = entry;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          `${file} を読み込めませんでした。空の履歴で開始します: ${errorMessage(error)}`,
        );
      }
    }
    return store;
  }

  get(key: string): GeminiHistoryMessage[] {
    return this.data[key]?.messages ?? [];
  }

  count(key: string): number {
    return this.data[key]?.messages.length ?? 0;
  }

  async append(
    key: string,
    messages: readonly GeminiHistoryMessage[],
    maxMessages: number,
  ): Promise<void> {
    const existing = this.data[key]?.messages ?? [];
    this.data[key] = {
      updatedAt: new Date().toISOString(),
      messages: trimHistory([...existing, ...messages], maxMessages),
    };
    await this.persist();
  }

  async clear(key: string): Promise<void> {
    if (!(key in this.data)) return;
    delete this.data[key];
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writeChain = this.writeChain.catch((error: unknown) => {
      logger.error(`Gemini の履歴を保存できませんでした: ${errorMessage(error)}`);
    });
    return this.writeChain;
  }
}

function normalizeMime(mimeType: string, name: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized !== '' && normalized !== 'application/octet-stream') return normalized;
  const extension = path.extname(name).toLowerCase();
  return EXTENSION_MIME[extension] ?? 'application/octet-stream';
}

function isTextMime(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (TEXT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isInlineMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType === 'application/pdf'
  );
}

interface InlineBudget {
  total: number;
}

async function resolvePart(
  part: GeminiPart,
  budget: InlineBudget,
): Promise<GeminiApiPart | null> {
  if ('text' in part) {
    return part.text === '' ? null : { text: part.text };
  }

  const file = part.file;
  try {
    const info = await stat(file.path);
    if (!info.isFile()) {
      return { text: `[添付: ${file.name} はファイルではありません]` };
    }
    const mimeType = normalizeMime(file.mimeType, file.name);

    if (isTextMime(mimeType, file.name)) {
      if (info.size > MAX_TEXT_FILE_BYTES) {
        return {
          text: `[添付: ${file.name} は大きすぎるため全文を読み込めません (${info.size} bytes)]`,
        };
      }
      const content = await readFile(file.path, 'utf8');
      return { text: `--- 添付ファイル: ${file.name} (${mimeType}) ---\n${content}` };
    }

    if (isInlineMime(mimeType)) {
      if (info.size > MAX_INLINE_FILE_BYTES) {
        return {
          text: `[添付: ${file.name} は大きすぎるため送信できません (${info.size} bytes)]`,
        };
      }
      if (budget.total + info.size > MAX_INLINE_TOTAL_BYTES) {
        return {
          text: `[添付: ${file.name} は合計サイズ上限を超えるため送信できません]`,
        };
      }
      const data = await readFile(file.path);
      budget.total += data.length;
      return { inlineData: { mimeType, data: data.toString('base64') } };
    }

    return {
      text: `[添付: ${file.name} (${mimeType}, ${info.size} bytes) は直接読めません]`,
    };
  } catch {
    return { text: `[添付ファイルが見つかりません: ${file.name}]` };
  }
}

export async function buildGeminiContents(
  history: readonly GeminiHistoryMessage[],
  userMessage: GeminiHistoryMessage,
): Promise<GeminiApiContent[]> {
  const budget: InlineBudget = { total: 0 };
  const contents: GeminiApiContent[] = [];
  for (const message of [...history, userMessage]) {
    const parts: GeminiApiPart[] = [];
    for (const part of message.parts) {
      const resolved = await resolvePart(part, budget);
      if (resolved) parts.push(resolved);
    }
    if (parts.length === 0) continue;
    contents.push({ role: message.role, parts });
  }
  return contents;
}

export function buildGeminiRequest(
  contents: GeminiApiContent[],
  options: GeminiRequestOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens,
    },
  };
  if (options.systemPrompt.trim() !== '') {
    body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
  }
  if (options.googleSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

export interface GeminiExtractResult {
  text: string;
  finishReason: string | null;
  blockReason: string | null;
  usage: unknown;
}

export function extractGeminiText(payload: unknown): GeminiExtractResult {
  if (!isRecord(payload)) {
    return { text: '', finishReason: null, blockReason: null, usage: null };
  }

  const feedback = isRecord(payload.promptFeedback) ? payload.promptFeedback : null;
  const blockReason =
    feedback && typeof feedback.blockReason === 'string' ? feedback.blockReason : null;

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : null;
  const finishReason =
    candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : null;
  const content = candidate && isRecord(candidate.content) ? candidate.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.thought === true) continue;
    if (typeof part.text === 'string' && part.text !== '') texts.push(part.text);
  }

  return {
    text: texts.join(''),
    finishReason,
    blockReason,
    usage: payload.usageMetadata ?? null,
  };
}

export function parseGeminiModels(payload: unknown): ModelInfo[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of payload.models) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    const id = raw.name.replace(/^models\//, '');
    if (id === '' || seen.has(id) || MODEL_EXCLUDE.test(id)) continue;

    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];
    if (!methods.includes('generateContent')) continue;

    const displayName =
      typeof raw.displayName === 'string' && raw.displayName.trim() !== ''
        ? raw.displayName.trim()
        : id;
    const description =
      typeof raw.description === 'string' && raw.description.trim() !== ''
        ? raw.description.trim()
        : displayName;

    seen.add(id);
    models.push({ id, description });
  }

  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

export async function listGeminiModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${baseUrl}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Gemini のモデル一覧を取得できませんでした (HTTP ${response.status})${detail ? `: ${truncate(detail, 200)}` : ''}`,
    );
  }
  return parseGeminiModels(await response.json());
}

function geminiModelId(model: string): string {
  return model.replace(/^models\//, '');
}

export function geminiGenerateUrl(baseUrl: string, model: string): string {
  return `${baseUrl}/models/${encodeURIComponent(geminiModelId(model))}:generateContent`;
}

function geminiErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const message = payload.error.message;
  const status = payload.error.status;
  if (typeof message !== 'string' || message === '') return null;
  return typeof status === 'string' && status !== '' ? `${status}: ${message}` : message;
}

function failure(startedAt: number, message: string): RunResult {
  const durationMs = Date.now() - startedAt;
  return {
    exitCode: 1,
    signal: null,
    result: {
      type: 'result',
      subtype: 'error',
      error: message,
      finalText: '',
      durationMs,
    },
    sessionId: null,
    stderr: message,
    aborted: false,
    spawnError: null,
    durationMs,
  };
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export async function runGemini(options: GeminiRunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const userParts: GeminiPart[] = [];
  if (options.prompt.trim() !== '') userParts.push({ text: options.prompt });
  for (const attachment of options.attachments) {
    userParts.push({
      file: {
        path: attachment.path,
        mimeType: attachment.type,
        name: attachment.name,
      },
    });
  }
  if (userParts.length === 0) userParts.push({ text: '(no text)' });
  const userMessage: GeminiHistoryMessage = { role: 'user', parts: userParts };

  options.onEvent?.({ type: 'backend_status', message: 'Gemini に送信中' });

  try {
    const contents = await buildGeminiContents(
      options.history.get(options.sessionKey),
      userMessage,
    );
    const body = buildGeminiRequest(contents, {
      systemPrompt: options.systemPrompt,
      maxOutputTokens: options.maxOutputTokens,
      googleSearch: options.googleSearch,
    });
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(geminiGenerateUrl(options.baseUrl, options.model), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify(body),
      signal: combineSignals(options.signal, options.timeoutMs),
    });

    const raw = await response.text();
    let payload: unknown = null;
    try {
      payload = raw === '' ? null : JSON.parse(raw);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = geminiErrorMessage(payload) ?? truncate(raw, 500);
      return failure(
        startedAt,
        `Gemini API エラー (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      );
    }

    const extracted = extractGeminiText(payload);
    if (extracted.blockReason) {
      return failure(
        startedAt,
        `Gemini がリクエストをブロックしました: ${extracted.blockReason}`,
      );
    }
    if (extracted.text.trim() === '') {
      return failure(
        startedAt,
        `Gemini から応答がありませんでした${extracted.finishReason ? ` (${extracted.finishReason})` : ''}`,
      );
    }

    const finalText =
      extracted.finishReason === 'MAX_TOKENS'
        ? `${extracted.text.trim()}\n\n（出力が上限に達したため途中で終了しました）`
        : extracted.text.trim();

    await options.history.append(
      options.sessionKey,
      [userMessage, { role: 'model', parts: [{ text: finalText }] }],
      options.maxHistoryMessages,
    );

    if (isRecord(extracted.usage)) {
      logger.info(
        `Gemini usage model=${options.model} prompt=${String(extracted.usage.promptTokenCount ?? '?')} candidates=${String(extracted.usage.candidatesTokenCount ?? '?')}`,
      );
    }

    options.onEvent?.({ type: 'text_delta' });

    const durationMs = Date.now() - startedAt;
    return {
      exitCode: 0,
      signal: null,
      result: {
        type: 'result',
        subtype: 'success',
        finalText,
        durationMs,
        usage: extracted.usage,
      },
      sessionId: null,
      stderr: '',
      aborted: false,
      spawnError: null,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (options.signal?.aborted) {
      return {
        exitCode: null,
        signal: null,
        result: null,
        sessionId: null,
        stderr: '',
        aborted: true,
        spawnError: null,
        durationMs,
      };
    }
    if (isAbortError(error)) {
      return failure(
        startedAt,
        `Gemini API がタイムアウトしました (${Math.round(options.timeoutMs / 1000)} 秒)`,
      );
    }
    return failure(
      startedAt,
      `Gemini API 呼び出しに失敗しました: ${errorMessage(error)}`,
    );
  }
}
