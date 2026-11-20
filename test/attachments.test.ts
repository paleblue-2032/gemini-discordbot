import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractAttachmentMarkers,
  safeFileName,
} from '../src/attachments.js';

test('safeFileName strips paths and control characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a/b/c.txt'), 'c.txt');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName('日本語 ファイル.txt'), '日本語 ファイル.txt');
});

test('extractAttachmentMarkers returns files under cwd', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-attach-'));
  try {
    await writeFile(path.join(root, 'out.txt'), 'hello');
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', 'data.csv'), 'a,b');

    const result = await extractAttachmentMarkers(
      'done [[attach:out.txt]] and [[attach:sub/data.csv]]',
      root,
    );

    assert.equal(result.text, 'done  and');
    assert.deepEqual(
      result.files.map((file) => path.relative(root, file.path)).sort(),
      ['out.txt', 'sub/data.csv'],
    );
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extractAttachmentMarkers deduplicates repeated markers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-attach-'));
  try {
    await writeFile(path.join(root, 'out.txt'), 'hello');
    const result = await extractAttachmentMarkers(
      '[[attach:out.txt]] [[attach:out.txt]]',
      root,
    );
    assert.equal(result.files.length, 1);
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extractAttachmentMarkers rejects unsafe paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-attach-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'cmdbot-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await writeFile(path.join(root, '.env'), 'TOKEN=x');
    await mkdir(path.join(root, 'folder'));

    const result = await extractAttachmentMarkers(
      '[[attach:../secret.txt]] [[attach:.env]] [[attach:folder]] [[attach:missing.txt]]',
      root,
    );

    assert.equal(result.files.length, 0);
    assert.equal(result.errors.length, 4);
    assert.equal(result.text, '');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
