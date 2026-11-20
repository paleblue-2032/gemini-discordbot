import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isUserAllowed, loadConfig } from '../src/config.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-config-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('empty ALLOWED_USER_IDS allows every user', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
    });

    assert.equal(config.allowedUserIds.size, 0);
    assert.equal(isUserAllowed(config.allowedUserIds, 'any-user'), true);
  });
});

test('ALLOWED_USER_IDS works as an allowlist when set', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      ALLOWED_USER_IDS: ' 111, 222 ,, ',
    });

    assert.deepEqual([...config.allowedUserIds].sort(), ['111', '222']);
    assert.equal(isUserAllowed(config.allowedUserIds, '111'), true);
    assert.equal(isUserAllowed(config.allowedUserIds, '333'), false);
  });
});

test('concurrency defaults to three so separate threads run in parallel', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root });
    assert.equal(config.maxConcurrency, 3);
  });
});

test('forum cwd and upload retention defaults', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root });
    assert.equal(config.forumCwd, 'auto');
    assert.equal(config.uploadTtlMs, 0, 'attachments must be kept by default');
    assert.equal(config.uploadSweepIntervalMs, 60 * 60 * 1000);
  });
});

test('UPLOAD_TTL_HOURS enables attachment cleanup', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      UPLOAD_TTL_HOURS: '24',
    });
    assert.equal(config.uploadTtlMs, 24 * 60 * 60 * 1000);
  });
});

test('the sweep interval never drops below five minutes', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      UPLOAD_SWEEP_INTERVAL_MINUTES: '1',
    });
    assert.equal(config.uploadSweepIntervalMs, 5 * 60 * 1000);
  });
});

test('invalid forum cwd and retention values are rejected', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, FORUM_CWD: 'bogus' }),
      /FORUM_CWD/,
    );
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, UPLOAD_TTL_HOURS: '-1' }),
      /UPLOAD_TTL_HOURS/,
    );
  });
});

test('storage defaults and disabling', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root });
    assert.equal(config.storageTargetRatio, 0.75);
    assert.equal(config.storageDegradedRatio, 0.6);
    assert.equal(config.storageSweepIntervalMs, 60 * 60 * 1000);
    assert.equal(config.workdirMeta, 'thread');
    assert.equal(config.cwdConflict, 'deny');

    const disabled = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      STORAGE_TARGET_PERCENT: '0',
    });
    assert.equal(disabled.storageTargetRatio, 0);
  });
});

test('degraded ratio must stay below the target ratio', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      loadConfig({
        DISCORD_TOKEN: 'token',
        ALLOWED_ROOTS: root,
        STORAGE_TARGET_PERCENT: '50',
        STORAGE_DEGRADED_PERCENT: '50',
      }),
      /STORAGE_DEGRADED_PERCENT/,
    );
  });
});

test('invalid workdir meta and cwd conflict values are rejected', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, WORKDIR_META: 'bogus' }),
      /WORKDIR_META/,
    );
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, CWD_CONFLICT: 'bogus' }),
      /CWD_CONFLICT/,
    );
  });
});

test('AI_BACKEND=gemini requires a key and uses Gemini defaults', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, AI_BACKEND: 'gemini' }),
      /GEMINI_API_KEY/,
    );

    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      AI_BACKEND: 'gemini',
      GEMINI_API_KEY: 'test-key',
    });

    assert.equal(config.backend, 'gemini');
    assert.equal(config.defaultModel, 'gemini-3.5-flash-lite');
    assert.equal(config.defaultEffort, null);
    assert.equal(config.gemini.apiKey, 'test-key');
    assert.equal(config.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
    assert.equal(config.gemini.maxHistoryMessages, 40);
    assert.equal(config.gemini.timeoutMs, 180_000);
    assert.equal(config.gemini.maxOutputTokens, 8192);
    assert.equal(config.gemini.googleSearch, false);
  });
});

test('AI_BACKEND=cmd keeps the Command Code defaults', async () => {
  await withRoot(async (root) => {
    const config = await loadConfig({
      DISCORD_TOKEN: 'token',
      ALLOWED_ROOTS: root,
      CMD_MODEL: 'deepseek/deepseek-v4.1-flash',
      CMD_EFFORT: 'off',
    });
    assert.equal(config.backend, 'cmd');
    assert.equal(config.defaultModel, 'deepseek/deepseek-v4.1-flash');
    assert.equal(config.defaultEffort, 'off');
  });
});

test('invalid backend and boolean values are rejected', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      loadConfig({ DISCORD_TOKEN: 'token', ALLOWED_ROOTS: root, AI_BACKEND: 'bogus' }),
      /AI_BACKEND/,
    );
    await assert.rejects(
      loadConfig({
        DISCORD_TOKEN: 'token',
        ALLOWED_ROOTS: root,
        AI_BACKEND: 'gemini',
        GEMINI_API_KEY: 'test-key',
        GEMINI_GOOGLE_SEARCH: 'maybe',
      }),
      /GEMINI_GOOGLE_SEARCH/,
    );
  });
});
