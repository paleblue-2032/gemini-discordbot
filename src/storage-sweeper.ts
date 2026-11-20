import { readDiskStatus, type DiskStatus } from './disk-health.js';
import { errorMessage, logger } from './logger.js';
import type { SessionStore } from './sessions.js';
import { measureDirectory, removeWorkdir } from './workdir.js';

export const MAX_REMOVALS_PER_SWEEP = 5;

export interface StorageSweeperOptions {
  workRoot: string;
  smartFile: string;
  targetRatio: number;
  degradedRatio: number;
  intervalMs: number;
  isBusy: (key: string) => boolean;
  sessions: SessionStore;
  now?: () => number;
}

export interface SweepOutcome {
  before: DiskStatus;
  targetRatio: number;
  removed: string[];
  freedBytes: number;
  stoppedReason: 'below-target' | 'no-candidates' | 'max-removals' | 'disabled';
}

export interface StorageCandidate {
  key: string;
  cwd: string;
  lastUsedAt: number;
  bytes: number;
}

export async function listCandidates(
  sessions: SessionStore,
  workRoot: string,
  isBusy: (key: string) => boolean,
): Promise<StorageCandidate[]> {
  const candidates: StorageCandidate[] = [];

  for (const [key, record] of sessions.entries()) {
    if (record.cwdSource !== 'thread') continue;
    if (!record.cwd.startsWith(`${workRoot}/`)) continue;
    if (isBusy(key)) continue;

    const lastUsedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(lastUsedAt)) continue;

    candidates.push({ key, cwd: record.cwd, lastUsedAt, bytes: 0 });
  }

  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  return candidates;
}

export async function sweepStorage(options: StorageSweeperOptions): Promise<SweepOutcome> {
  const now = options.now ?? Date.now;
  const before = await readDiskStatus(options.workRoot, options.smartFile, now());

  if (options.targetRatio <= 0) {
    return {
      before,
      targetRatio: 0,
      removed: [],
      freedBytes: 0,
      stoppedReason: 'disabled',
    };
  }

  const degraded = before.smart === 'warning' || before.smart === 'critical';
  const targetRatio = degraded
    ? Math.min(options.targetRatio, options.degradedRatio)
    : options.targetRatio;

  if (before.usedRatio <= targetRatio) {
    return { before, targetRatio, removed: [], freedBytes: 0, stoppedReason: 'below-target' };
  }

  const candidates = await listCandidates(options.sessions, options.workRoot, options.isBusy);
  if (candidates.length === 0) {
    return { before, targetRatio, removed: [], freedBytes: 0, stoppedReason: 'no-candidates' };
  }

  const removed: string[] = [];
  let freedBytes = 0;
  let stoppedReason: SweepOutcome['stoppedReason'] = 'max-removals';
  let usedBytes = before.usedBytes;

  for (const candidate of candidates) {
    if (removed.length >= MAX_REMOVALS_PER_SWEEP) break;

    const size = await measureDirectory(candidate.cwd);
    const result = await removeWorkdir(candidate.cwd, options.workRoot);
    if (!result.removed) continue;

    await options.sessions.remove(candidate.key);
    removed.push(candidate.cwd);
    freedBytes += result.freedBytes;
    usedBytes = Math.max(0, usedBytes - result.freedBytes);

    logger.info(
      `作業ディレクトリを削除しました cwd=${candidate.cwd} size=${Math.round(result.freedBytes / 1024 / 1024)}MB lastUsed=${new Date(candidate.lastUsedAt).toISOString()} measured=${Math.round(size / 1024 / 1024)}MB`,
    );

    const ratio = before.totalBytes > 0 ? usedBytes / before.totalBytes : 0;
    if (ratio <= targetRatio) {
      stoppedReason = 'max-removals';
      break;
    }
  }

  if (removed.length === 0) stoppedReason = 'no-candidates';

  return { before, targetRatio, removed, freedBytes, stoppedReason };
}

export function startStorageSweeper(options: StorageSweeperOptions): () => void {
  if (options.targetRatio <= 0) return () => undefined;

  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const outcome = await sweepStorage(options);
      if (outcome.removed.length > 0) {
        logger.info(
          `容量調整を実行しました removed=${outcome.removed.length} freed=${Math.round(outcome.freedBytes / 1024 / 1024)}MB used=${(outcome.before.usedRatio * 100).toFixed(1)}% smart=${outcome.before.smart} target=${(outcome.targetRatio * 100).toFixed(0)}%`,
        );
      } else if (outcome.before.smart === 'critical' || outcome.before.smart === 'warning') {
        logger.warn(
          `ディスクの健全性に注意 smart=${outcome.before.smart} used=${(outcome.before.usedRatio * 100).toFixed(1)}%`,
        );
      }
    } catch (error) {
      logger.warn(`容量調整に失敗しました: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, options.intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
