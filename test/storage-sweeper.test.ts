import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/sessions.js';
import { listCandidates, sweepStorage } from '../src/storage-sweeper.js';

async function setup(
  run: (ctx: {
    root: string;
    sessions: SessionStore;
    smartFile: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-storage-'));
  try {
    const sessions = await SessionStore.load(path.join(root, '.sessions.json'));
    await run({ root, sessions, smartFile: path.join(root, 'smart.json') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeThread(
  sessions: SessionStore,
  root: string,
  key: string,
  slug: string,
  ageDays: number,
  bytes = 1024,
): Promise<string> {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'data.bin'), 'x'.repeat(bytes));
  await sessions.setCwd(key, dir, 'thread');
  const record = sessions.get(key, root);
  record.updatedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  return dir;
}

const baseOptions = (root: string, smartFile: string, sessions: SessionStore) => ({
  workRoot: root,
  smartFile,
  targetRatio: 0.75,
  degradedRatio: 0.6,
  intervalMs: 3_600_000,
  isBusy: () => false,
  sessions,
});

test('candidates include only thread directories under the work root', async () => {
  await setup(async ({ root, sessions }) => {
    await makeThread(sessions, root, 'thread-1', 'forum/a', 10);
    const outside = await mkdtemp(path.join(tmpdir(), 'cmdbot-outside-'));
    try {
      await sessions.setCwd('thread-2', outside, 'thread');
      const candidates = await listCandidates(sessions, root, () => false);
      assert.deepEqual(candidates.map((candidate) => candidate.key), ['thread-1']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('busy threads are excluded from candidates', async () => {
  await setup(async ({ root, sessions }) => {
    await makeThread(sessions, root, 'thread-1', 'forum/a', 10);
    const candidates = await listCandidates(sessions, root, (key) => key === 'thread-1');
    assert.deepEqual(candidates, []);
  });
});

test('candidates are sorted oldest first', async () => {
  await setup(async ({ root, sessions }) => {
    await makeThread(sessions, root, 'new', 'forum/new', 1);
    await makeThread(sessions, root, 'old', 'forum/old', 30);
    await makeThread(sessions, root, 'mid', 'forum/mid', 10);
    const candidates = await listCandidates(sessions, root, () => false);
    assert.deepEqual(candidates.map((candidate) => candidate.key), ['old', 'mid', 'new']);
  });
});

test('a disabled target does nothing', async () => {
  await setup(async ({ root, sessions, smartFile }) => {
    const dir = await makeThread(sessions, root, 'thread-1', 'forum/a', 30);
    const outcome = await sweepStorage({
      ...baseOptions(root, smartFile, sessions),
      targetRatio: 0,
    });

    assert.equal(outcome.stoppedReason, 'disabled');
    assert.deepEqual(outcome.removed, []);
    assert.deepEqual(await readdir(dir), ['data.bin']);
  });
});

test('nothing is deleted while usage is below target', async () => {
  await setup(async ({ root, sessions, smartFile }) => {
    const dir = await makeThread(sessions, root, 'thread-1', 'forum/a', 30);
    const outcome = await sweepStorage({
      ...baseOptions(root, smartFile, sessions),
      targetRatio: 1,
    });

    assert.equal(outcome.stoppedReason, 'below-target');
    assert.deepEqual(await readdir(dir), ['data.bin']);
  });
});

test('over-target usage removes the oldest thread first', async () => {
  await setup(async ({ root, sessions, smartFile }) => {
    const oldDir = await makeThread(sessions, root, 'old', 'forum/old', 30);
    const newDir = await makeThread(sessions, root, 'new', 'forum/new', 1);

    const outcome = await sweepStorage({
      ...baseOptions(root, smartFile, sessions),
      targetRatio: 0.0000000001,
    });

    assert.ok(outcome.removed.length >= 1);
    assert.equal(outcome.removed[0], oldDir);
    await assert.rejects(readdir(oldDir), /ENOENT/);
    assert.equal(sessions.entries().some(([key]) => key === 'old'), false);
    if (!outcome.removed.includes(newDir)) {
      assert.deepEqual(await readdir(newDir), ['data.bin']);
    }
  });
});

test('a degraded SMART verdict lowers the target ratio', async () => {
  await setup(async ({ root, sessions, smartFile }) => {
    await writeFile(
      smartFile,
      JSON.stringify({
        device: '/dev/sdb',
        verdict: 'warning',
        reallocated: 0,
        pending: 0,
        temperature: 55,
        at: new Date().toISOString(),
      }),
    );

    const outcome = await sweepStorage({
      ...baseOptions(root, smartFile, sessions),
      targetRatio: 1,
      degradedRatio: 0.6,
    });

    assert.equal(outcome.targetRatio, 0.6);
    assert.equal(outcome.before.smart, 'warning');
  });
});
