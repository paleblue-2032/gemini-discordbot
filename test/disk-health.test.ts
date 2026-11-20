import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSmartOutput, readSmartReport } from '../src/disk-health.js';

const HEADER = `ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE`;

function smartOutput(options: {
  health: 'PASSED' | 'FAILED';
  reallocated?: number;
  pending?: number;
  temperature?: number;
}): string {
  return [
    `SMART overall-health self-assessment test result: ${options.health}`,
    HEADER,
    `  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       ${options.reallocated ?? 0}`,
    `197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       ${options.pending ?? 0}`,
    `194 Temperature_Celsius     0x0022   069   055   000    Old_age   Always       -       ${options.temperature ?? 31}`,
  ].join('\n');
}

test('a healthy drive parses as ok', () => {
  const result = parseSmartOutput(smartOutput({ health: 'PASSED' }));
  assert.equal(result.verdict, 'ok');
});

test('FAILED health parses as critical', () => {
  const result = parseSmartOutput(smartOutput({ health: 'FAILED' }));
  assert.equal(result.verdict, 'critical');
  assert.match(result.detail ?? '', /FAILED/);
});

test('reallocated sectors are critical', () => {
  const result = parseSmartOutput(smartOutput({ health: 'PASSED', reallocated: 8 }));
  assert.equal(result.verdict, 'critical');
  assert.match(result.detail ?? '', /Reallocated/);
});

test('pending sectors are critical', () => {
  const result = parseSmartOutput(smartOutput({ health: 'PASSED', pending: 2 }));
  assert.equal(result.verdict, 'critical');
  assert.match(result.detail ?? '', /Pending/);
});

test('high temperature is a warning', () => {
  const result = parseSmartOutput(smartOutput({ health: 'PASSED', temperature: 55 }));
  assert.equal(result.verdict, 'warning');
  assert.match(result.detail ?? '', /55/);
});

test('unparseable output is unavailable', () => {
  assert.equal(parseSmartOutput('smartctl: command failed').verdict, 'unavailable');
});

async function withFile(contents: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmdbot-smart-'));
  try {
    const file = path.join(dir, 'smart.json');
    await writeFile(file, contents);
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readSmartReport loads a fresh report', async () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  await withFile(
    JSON.stringify({
      device: '/dev/sdb',
      verdict: 'ok',
      reallocated: 0,
      pending: 0,
      temperature: 31,
      at: '2026-11-19T11:00:00Z',
    }),
    async (file) => {
      const report = await readSmartReport(file, now);
      assert.equal(report?.verdict, 'ok');
      assert.equal(report?.device, '/dev/sdb');
    },
  );
});

test('readSmartReport rejects stale and broken files', async () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  await withFile(
    JSON.stringify({ device: '/dev/sdb', verdict: 'critical', at: '2026-11-10T00:00:00Z' }),
    async (file) => {
      assert.equal(await readSmartReport(file, now), null);
    },
  );
  await withFile('not json', async (file) => {
    assert.equal(await readSmartReport(file, now), null);
  });
  assert.equal(await readSmartReport('/nonexistent/smart.json', now), null);
});
