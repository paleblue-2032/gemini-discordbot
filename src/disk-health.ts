import { readFile, statfs } from 'node:fs/promises';
import { errorMessage, logger } from './logger.js';

export type SmartVerdict = 'ok' | 'warning' | 'critical' | 'unavailable';

export interface SmartReport {
  device: string;
  verdict: SmartVerdict;
  reallocated: number | null;
  pending: number | null;
  temperature: number | null;
  at: string;
}

export interface DiskStatus {
  totalBytes: number;
  usedBytes: number;
  usedRatio: number;
  smart: SmartVerdict;
  smartDetail: string | null;
  source: string;
}

const SMART_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function parseSmartOutput(text: string): { verdict: SmartVerdict; detail: string | null } {
  const failed = /SMART overall-health self-assessment test result:\s*FAILED/i.test(text);
  const passed = /SMART overall-health self-assessment test result:\s*PASSED/i.test(text);

  const readAttribute = (name: string): number | null => {
    for (const line of text.split('\n')) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10) continue;
      if (!columns.includes(name)) continue;
      const raw = columns[columns.length - 1]!;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };

  const reallocated = readAttribute('Reallocated_Sector_Ct');
  const pending = readAttribute('Current_Pending_Sector');
  const temperature = readAttribute('Temperature_Celsius');

  if (failed) {
    return { verdict: 'critical', detail: 'SMART overall-health が FAILED' };
  }
  if (reallocated !== null && reallocated > 0) {
    return { verdict: 'critical', detail: `Reallocated_Sector_Ct=${reallocated}` };
  }
  if (pending !== null && pending > 0) {
    return { verdict: 'critical', detail: `Current_Pending_Sector=${pending}` };
  }
  if (temperature !== null && temperature > 50) {
    return { verdict: 'warning', detail: `温度 ${temperature}℃` };
  }
  if (passed) {
    const health = /Overall-Health-Self-Assessment\s*:?\s*(.+)/i.exec(text);
    return { verdict: 'ok', detail: health?.[1]?.trim() ?? 'PASSED' };
  }
  return { verdict: 'unavailable', detail: 'SMART の判定行が見つかりません' };
}

function isSmartReport(value: unknown): value is SmartReport {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  return (
    typeof record.device === 'string' &&
    typeof record.at === 'string' &&
    (verdict === 'ok' || verdict === 'warning' || verdict === 'critical' || verdict === 'unavailable')
  );
}

export async function readSmartReport(
  smartFile: string,
  now = Date.now(),
): Promise<SmartReport | null> {
  let raw: string;
  try {
    raw = await readFile(smartFile, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSmartReport(parsed)) return null;

  const at = Date.parse(parsed.at);
  if (!Number.isFinite(at) || now - at > SMART_MAX_AGE_MS) return null;
  return parsed;
}

export async function readDiskStatus(
  workRoot: string,
  smartFile: string,
  now = Date.now(),
): Promise<DiskStatus> {
  let totalBytes = 0;
  let usedBytes = 0;
  let source = workRoot;

  try {
    const info = await statfs(workRoot);
    const blockSize = Number(info.bsize);
    totalBytes = Number(info.blocks) * blockSize;
    const free = Number(info.bavail) * blockSize;
    usedBytes = Math.max(0, totalBytes - free);
  } catch (error) {
    logger.warn(`ディスク使用量を取得できませんでした ${workRoot}: ${errorMessage(error)}`);
  }

  const report = await readSmartReport(smartFile, now);
  const usedRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;

  return {
    totalBytes,
    usedBytes,
    usedRatio,
    smart: report?.verdict ?? 'unavailable',
    smartDetail: report ? report.verdict + (report.temperature !== null ? ` (${report.temperature}℃)` : '') : 'SMART 情報なし',
    source: report?.device ?? source,
  };
}
