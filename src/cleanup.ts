import { readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_DIR } from './attachments.js';
import { errorMessage, logger } from './logger.js';
import { isWithin } from './paths.js';

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.commandcode', UPLOAD_DIR]);
const ENTRY_PATTERN = /-(\d+)$/;

export interface SweepResult {
  removed: number;
  errors: number;
}

async function findUploadDirs(
  root: string,
  directory: string,
  depth: number,
  found: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(directory, entry.name);
    if (entry.name === UPLOAD_DIR) {
      found.push(full);
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    await findUploadDirs(root, full, depth + 1, found);
  }
}

async function sweepDirectory(
  uploadDir: string,
  root: string,
  cutoff: number,
): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, errors: 0 };

  let realUploadDir: string;
  try {
    realUploadDir = await realpath(uploadDir);
  } catch {
    return result;
  }
  if (!isWithin(root, realUploadDir)) return result;

  let entries;
  try {
    entries = await readdir(realUploadDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = ENTRY_PATTERN.exec(entry.name);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;

    const target = path.join(realUploadDir, entry.name);
    try {
      const real = await realpath(target);
      if (!isWithin(realUploadDir, real)) continue;
      await rm(real, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}

export async function sweepUploads(
  roots: string[],
  ttlMs: number,
  now = Date.now(),
): Promise<SweepResult> {
  const total: SweepResult = { removed: 0, errors: 0 };
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return total;

  const cutoff = now - ttlMs;
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }

    const found: string[] = [];
    await findUploadDirs(realRoot, realRoot, 0, found);
    for (const uploadDir of found) {
      const result = await sweepDirectory(uploadDir, realRoot, cutoff);
      total.removed += result.removed;
      total.errors += result.errors;
    }
  }

  return total;
}

export function startUploadSweeper(
  roots: string[],
  ttlMs: number,
  intervalMs: number,
  now: () => number = Date.now,
): () => void {
  if (ttlMs <= 0) return () => undefined;

  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await sweepUploads(roots, ttlMs, now());
      if (result.removed > 0 || result.errors > 0) {
        logger.info(
          `添付を削除しました removed=${result.removed} errors=${result.errors} ttl=${Math.round(ttlMs / 60000)}分`,
        );
      }
    } catch (error) {
      logger.warn(`添付の削除に失敗しました: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
