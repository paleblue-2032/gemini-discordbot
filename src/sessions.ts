import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackendName } from './config.js';
import { errorMessage, logger } from './logger.js';

export type CwdSource = 'default' | 'thread' | 'user' | 'unknown';

export interface SessionRecord {
  cwd: string;
  cwdSource: CwdSource;
  createdAt: string | null;
  sessionId: string | null;
  model: string | null;
  modelBackend: BackendName | null;
  models: Partial<Record<BackendName, string | null>>;
  effort: string | null;
  effortBackend: BackendName | null;
  efforts: Partial<Record<BackendName, string | null>>;
  updatedAt: string;
}

type SessionData = Record<string, SessionRecord>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCwdSource(value: unknown): CwdSource {
  if (value === 'default' || value === 'thread' || value === 'user') return value;
  return 'unknown';
}

function normalizeBackend(value: unknown): BackendName | null {
  return value === 'cmd' || value === 'gemini' ? value : null;
}

function normalizeBackendMap(value: unknown): Partial<Record<BackendName, string | null>> {
  if (!isObject(value)) return {};
  const map: Partial<Record<BackendName, string | null>> = {};
  for (const backend of ['cmd', 'gemini'] as const) {
    const entry = value[backend];
    if (entry === null) map[backend] = null;
    else if (typeof entry === 'string' && entry !== '') map[backend] = entry;
  }
  return map;
}

function normalizeRecord(value: unknown): SessionRecord | null {
  if (!isObject(value) || typeof value.cwd !== 'string') return null;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null;
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : null;
  const effort = typeof value.effort === 'string' && value.effort !== '' ? value.effort : null;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();
  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt !== '' ? value.createdAt : null;
  const modelBackend = normalizeBackend(value.modelBackend);
  const effortBackend = normalizeBackend(value.effortBackend);
  const models = normalizeBackendMap(value.models);
  const efforts = normalizeBackendMap(value.efforts);

  const legacyModelBackend = modelBackend ?? 'cmd';
  if (model !== null && !(legacyModelBackend in models)) {
    models[legacyModelBackend] = model;
  }
  const legacyEffortBackend = effortBackend ?? 'cmd';
  if (effort !== null && !(legacyEffortBackend in efforts)) {
    efforts[legacyEffortBackend] = effort;
  }

  return {
    cwd: value.cwd,
    cwdSource: normalizeCwdSource(value.cwdSource),
    createdAt,
    sessionId,
    model,
    modelBackend,
    models,
    effort,
    effortBackend,
    efforts,
    updatedAt,
  };
}

export class SessionStore {
  private data: SessionData = {};
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async load(file: string): Promise<SessionStore> {
    const store = new SessionStore(file);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) {
        for (const [channelId, value] of Object.entries(parsed)) {
          const record = normalizeRecord(value);
          if (record) store.data[channelId] = record;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`${file} を読み込めませんでした。空の状態で開始します: ${errorMessage(error)}`);
      }
    }
    return store;
  }

  get(channelId: string, defaultCwd: string): SessionRecord {
    const existing = this.data[channelId];
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: SessionRecord = {
      cwd: defaultCwd,
      cwdSource: 'default',
      createdAt: now,
      sessionId: null,
      model: null,
      modelBackend: null,
      models: {},
      effort: null,
      effortBackend: null,
      efforts: {},
      updatedAt: now,
    };
    this.data[channelId] = created;
    return created;
  }

  entries(): Array<[string, SessionRecord]> {
    return Object.entries(this.data);
  }

  async remove(channelId: string): Promise<void> {
    if (!(channelId in this.data)) return;
    delete this.data[channelId];
    await this.persist();
  }

  async setCwd(
    channelId: string,
    cwd: string,
    source: Exclude<CwdSource, 'unknown'> = 'user',
  ): Promise<void> {
    const existing = this.data[channelId];
    this.data[channelId] = {
      cwd,
      cwdSource: source,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      sessionId: null,
      model: existing?.model ?? null,
      modelBackend: existing?.modelBackend ?? null,
      models: { ...(existing?.models ?? {}) },
      effort: existing?.effort ?? null,
      effortBackend: existing?.effortBackend ?? null,
      efforts: { ...(existing?.efforts ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  cwdTaken(cwd: string, exceptKey: string): boolean {
    for (const [key, record] of Object.entries(this.data)) {
      if (key === exceptKey) continue;
      if (record.cwd === cwd) return true;
    }
    return false;
  }

  async setModel(
    channelId: string,
    model: string | null,
    backend: BackendName | null = null,
  ): Promise<void> {
    const record = this.data[channelId];
    if (!record) return;
    const nextBackend = backend ?? record.modelBackend;
    const mapBackend = backend ?? record.modelBackend ?? 'cmd';
    if (record.model === model && record.models[mapBackend] === model) return;
    record.model = model;
    record.modelBackend = nextBackend;
    record.models = { ...record.models, [mapBackend]: model };
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setEffort(
    channelId: string,
    effort: string | null,
    backend: BackendName | null = null,
  ): Promise<void> {
    const record = this.data[channelId];
    if (!record) return;
    const mapBackend = backend ?? record.effortBackend ?? 'cmd';
    if (record.effort === effort && record.efforts[mapBackend] === effort) return;
    record.effort = effort;
    record.effortBackend = backend ?? record.effortBackend;
    record.efforts = { ...record.efforts, [mapBackend]: effort };
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async setSessionId(channelId: string, sessionId: string): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.sessionId === sessionId) return;
    record.sessionId = sessionId;
    record.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async clearSession(channelId: string): Promise<void> {
    const record = this.data[channelId];
    if (!record || record.sessionId === null) return;
    record.sessionId = null;
    record.updatedAt = new Date().toISOString();
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
      logger.error(`セッションを保存できませんでした: ${errorMessage(error)}`);
    });
    return this.writeChain;
  }
}
