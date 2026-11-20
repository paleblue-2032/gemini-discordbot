import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/sessions.js';

test('session ids and cwd survive a reload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);
    const record = store.get('channel-1', '/srv/work');
    assert.equal(record.cwd, '/srv/work');
    assert.equal(record.sessionId, null);

    await store.setCwd('channel-1', '/srv/work/repo');
    await store.setSessionId('channel-1', 'session-1');
    await store.setModel('channel-1', 'deepseek/deepseek-v4-flash');
    await store.setEffort('channel-1', 'high');

    const reloaded = await SessionStore.load(file);
    const loaded = reloaded.get('channel-1', '/fallback');
    assert.equal(loaded.cwd, '/srv/work/repo');
    assert.equal(loaded.sessionId, 'session-1');
    assert.equal(loaded.model, 'deepseek/deepseek-v4-flash');
    assert.equal(loaded.effort, 'high');

    await reloaded.setCwd('channel-1', '/srv/work/other');
    assert.equal(reloaded.get('channel-1', '/fallback').model, 'deepseek/deepseek-v4-flash');
    assert.equal(reloaded.get('channel-1', '/fallback').effort, 'high');

    await reloaded.clearSession('channel-1');
    const cleared = await SessionStore.load(file);
    assert.equal(cleared.get('channel-1', '/fallback').sessionId, null);
    assert.equal(cleared.get('channel-1', '/fallback').model, 'deepseek/deepseek-v4-flash');
    assert.equal(cleared.get('channel-1', '/fallback').effort, 'high');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupt sessions file starts empty', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    await writeFile(file, 'not json');
    const store = await SessionStore.load(file);
    const record = store.get('channel-1', '/srv/work');
    assert.equal(record.cwd, '/srv/work');
    assert.equal(record.sessionId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cwdSource defaults and round-trips through setCwd', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);

    assert.equal(store.get('thread-1', '/srv/work').cwdSource, 'default');

    await store.setCwd('thread-1', '/srv/work/forum/post', 'thread');
    assert.equal(store.get('thread-1', '/fallback').cwdSource, 'thread');

    const reloaded = await SessionStore.load(file);
    assert.equal(reloaded.get('thread-1', '/fallback').cwdSource, 'thread');

    await reloaded.setCwd('thread-1', '/srv/work/other');
    assert.equal(reloaded.get('thread-1', '/fallback').cwdSource, 'user');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('records without cwdSource load as unknown for backward compatibility', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    await writeFile(
      file,
      JSON.stringify({
        legacy: { cwd: '/srv/work/legacy', sessionId: 'session-1', model: null, effort: null },
      }),
    );

    const store = await SessionStore.load(file);
    const record = store.get('legacy', '/fallback');
    assert.equal(record.cwd, '/srv/work/legacy');
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.cwdSource, 'unknown');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cwdTaken reports other keys sharing a directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);

    await store.setCwd('thread-1', '/srv/work/shared', 'thread');
    assert.equal(store.cwdTaken('/srv/work/shared', 'thread-2'), true);
    assert.equal(store.cwdTaken('/srv/work/shared', 'thread-1'), false);
    assert.equal(store.cwdTaken('/srv/work/free', 'thread-2'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('createdAt is recorded once and preserved across setCwd', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);

    const created = store.get('thread-1', '/srv/work').createdAt;
    assert.ok(created !== null);

    await store.setCwd('thread-1', '/srv/work/forum/a', 'thread');
    assert.equal(store.get('thread-1', '/fallback').createdAt, created);

    await store.setCwd('thread-1', '/srv/work/other');
    assert.equal(store.get('thread-1', '/fallback').createdAt, created);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('models and efforts are stored per backend', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);
    store.get('channel-1', '/srv/work');

    await store.setModel('channel-1', 'gemini-3.1-flash-lite', 'gemini');
    await store.setModel('channel-1', 'deepseek/deepseek-v4.1-flash', 'cmd');
    await store.setEffort('channel-1', 'high', 'cmd');

    const reloaded = await SessionStore.load(file);
    const record = reloaded.get('channel-1', '/fallback');
    assert.equal(record.models.gemini, 'gemini-3.1-flash-lite');
    assert.equal(record.models.cmd, 'deepseek/deepseek-v4.1-flash');
    assert.equal(record.efforts.cmd, 'high');
    assert.equal(record.efforts.gemini, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy model and effort fields migrate to the cmd maps', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    await writeFile(
      file,
      JSON.stringify({
        legacy: {
          cwd: '/srv/work/legacy',
          sessionId: 'session-1',
          model: 'deepseek/deepseek-v4.1-flash',
          effort: 'high',
        },
      }),
    );

    const store = await SessionStore.load(file);
    const record = store.get('legacy', '/fallback');
    assert.equal(record.models.cmd, 'deepseek/deepseek-v4.1-flash');
    assert.equal(record.efforts.cmd, 'high');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entries and remove manage the whole record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-sessions-'));
  try {
    const file = path.join(directory, 'sessions.json');
    const store = await SessionStore.load(file);

    await store.setCwd('thread-1', '/srv/work/forum/a', 'thread');
    await store.setCwd('thread-2', '/srv/work/forum/b', 'thread');
    assert.equal(store.entries().length, 2);

    await store.remove('thread-1');
    const reloaded = await SessionStore.load(file);
    assert.equal(reloaded.entries().length, 1);
    assert.deepEqual(
      reloaded.entries().map(([key]) => key),
      ['thread-2'],
    );

    await reloaded.remove('does-not-exist');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
