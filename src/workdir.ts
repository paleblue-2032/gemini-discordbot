import { readdir, readFile, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, logger } from './logger.js';
import { isWithin } from './paths.js';

export const META_BEGIN = '<!-- agent-meta:begin -->';
export const META_END = '<!-- agent-meta:end -->';

export interface WorkdirMeta {
  threadLabel: string;
  updatedAt: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  createdAt: string;
}

export const DISCARDABLE_DIRS = [
  '.discord-uploads',
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.turbo',
  '.cache',
];

const AGENTS_HEADER = `# 作業ディレクトリ

このディレクトリは Discord bot がスレッドごとに自動作成しています。
下の agent-meta ブロックは bot が自動更新します。それ以外は自由に追記してかまいません。
`;

function formatLine(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

export function renderMetaBlock(meta: WorkdirMeta): string {
  return [
    META_BEGIN,
    formatLine('スレッド', meta.threadLabel),
    formatLine('作成', meta.createdAt),
    formatLine('最終作業', meta.updatedAt),
    formatLine('session', meta.sessionId ?? 'なし'),
    formatLine('model', meta.model ?? 'デフォルト'),
    formatLine('effort', meta.effort ?? 'デフォルト'),
    META_END,
  ].join('\n');
}

export function applyMetaBlock(existing: string, meta: WorkdirMeta): string {
  const block = renderMetaBlock(meta);
  const begin = existing.indexOf(META_BEGIN);
  const end = existing.indexOf(META_END);

  if (begin !== -1 && end > begin) {
    return `${existing.slice(0, begin)}${block}${existing.slice(end + META_END.length)}`;
  }

  if (begin !== -1 || end !== -1) {
    return existing;
  }

  const base = existing.trimEnd();
  if (base === '') return `${AGENTS_HEADER}\n${block}\n`;

  return existing;
}

export function parseMetaBlock(text: string): WorkdirMeta | null {
  const begin = text.indexOf(META_BEGIN);
  const end = text.indexOf(META_END);
  if (begin === -1 || end <= begin) return null;

  const body = text.slice(begin + META_BEGIN.length, end);
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^-\s*([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1]!.trim(), match[2]!.trim());
  }

  const threadLabel = fields.get('スレッド');
  const createdAt = fields.get('作成');
  const updatedAt = fields.get('最終作業');
  if (!threadLabel || !createdAt || !updatedAt) return null;

  const nullable = (value: string | undefined): string | null =>
    value === undefined || value === 'なし' || value === 'デフォルト' ? null : value;

  return {
    threadLabel,
    createdAt,
    updatedAt,
    sessionId: nullable(fields.get('session')),
    model: nullable(fields.get('model')),
    effort: nullable(fields.get('effort')),
  };
}

export async function upsertWorkdirAgents(dir: string, meta: WorkdirMeta): Promise<void> {
  const file = path.join(dir, 'AGENTS.md');
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`${file} を読み込めませんでした: ${errorMessage(error)}`);
      return;
    }
  }

  const next = applyMetaBlock(existing, meta);
  if (next === existing) return;

  const temporary = `${file}.tmp`;
  await writeFile(temporary, next, { mode: 0o644 });
  await rename(temporary, file);
}

export async function readWorkdirMeta(dir: string): Promise<WorkdirMeta | null> {
  try {
    const text = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    return parseMetaBlock(text);
  } catch {
    return null;
  }
}

export async function measureDirectory(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await measureDirectory(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(full)).size;
    } catch {
      // unreadable file, skip
    }
  }
  return total;
}

async function discardGenerated(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (DISCARDABLE_DIRS.includes(entry.name)) {
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    await discardGenerated(full);
  }
}

export async function removeWorkdir(
  dir: string,
  defaultCwd: string,
): Promise<{ removed: boolean; freedBytes: number }> {
  let real: string;
  let realRoot: string;
  try {
    real = await realpath(dir);
    realRoot = await realpath(defaultCwd);
  } catch {
    return { removed: false, freedBytes: 0 };
  }

  if (real === realRoot) return { removed: false, freedBytes: 0 };
  if (!isWithin(realRoot, real)) return { removed: false, freedBytes: 0 };

  let info;
  try {
    info = await stat(real);
  } catch {
    return { removed: false, freedBytes: 0 };
  }
  if (!info.isDirectory()) return { removed: false, freedBytes: 0 };

  const freedBytes = await measureDirectory(real);

  try {
    await discardGenerated(real);
    await rm(real, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`${real} を削除できませんでした: ${errorMessage(error)}`);
    return { removed: false, freedBytes: 0 };
  }

  return { removed: true, freedBytes };
}

export async function ensureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o775 });
}
