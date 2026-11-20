import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isWithin, resolveDirectory } from '../src/paths.js';

test('isWithin does not confuse sibling prefixes', () => {
  assert.equal(isWithin('/srv/work', '/srv/work'), true);
  assert.equal(isWithin('/srv/work', '/srv/work/repo'), true);
  assert.equal(isWithin('/srv/work', '/srv/work-evil'), false);
  assert.equal(isWithin('/srv/work', '/srv'), false);
});

test('resolveDirectory accepts a directory under the root', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-paths-')));
  try {
    await mkdir(path.join(root, 'repo'));
    const resolved = await resolveDirectory('repo', [root], root);
    assert.equal(resolved, path.join(root, 'repo'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveDirectory rejects paths outside the root', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-paths-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-outside-')));
  try {
    await assert.rejects(resolveDirectory(outside, [root], root), /許可されたルートの外/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('resolveDirectory rejects missing paths and files', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cmdbot-paths-')));
  try {
    await assert.rejects(resolveDirectory('missing', [root], root), /見つかりません/);
    await writeFile(path.join(root, 'file.txt'), 'x');
    await assert.rejects(resolveDirectory('file.txt', [root], root), /ディレクトリではありません/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
