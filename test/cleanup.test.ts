import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sweepUploads } from '../src/cleanup.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-cleanup-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('sweepUploads removes only expired upload directories', async () => {
  await withRoot(async (root) => {
    const uploads = path.join(root, '.discord-uploads');
    const old = path.join(uploads, '100-1000000000000');
    const fresh = path.join(uploads, `200-${Date.now()}`);
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(path.join(old, '0-a.txt'), 'x');
    await writeFile(path.join(fresh, '0-b.txt'), 'x');
    await writeFile(path.join(uploads, '.gitignore'), '*\n');

    const result = await sweepUploads([root], 60 * 60 * 1000);

    assert.equal(result.removed, 1);
    assert.equal(result.errors, 0);
    const remaining = await readdir(uploads);
    assert.deepEqual(remaining.sort(), ['.gitignore', path.basename(fresh)].sort());
  });
});

test('sweepUploads finds nested project upload directories', async () => {
  await withRoot(async (root) => {
    const nested = path.join(root, 'repoA', 'sub', '.discord-uploads', '300-1000000000000');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, '0-a.txt'), 'x');

    const result = await sweepUploads([root], 60 * 60 * 1000);

    assert.equal(result.removed, 1);
    await assert.rejects(readdir(nested), /ENOENT/);
  });
});

test('sweepUploads never touches directories that are not upload dirs', async () => {
  await withRoot(async (root) => {
    const keep = path.join(root, 'keep-1000000000000');
    await mkdir(keep, { recursive: true });
    await writeFile(path.join(keep, 'data.txt'), 'x');

    const result = await sweepUploads([root], 60 * 60 * 1000);

    assert.equal(result.removed, 0);
    assert.deepEqual(await readdir(keep), ['data.txt']);
  });
});

test('sweepUploads ignores entries without a timestamp suffix', async () => {
  await withRoot(async (root) => {
    const uploads = path.join(root, '.discord-uploads');
    const manual = path.join(uploads, 'notes');
    await mkdir(manual, { recursive: true });
    await writeFile(path.join(manual, 'keep.txt'), 'x');

    const result = await sweepUploads([root], 60 * 60 * 1000);

    assert.equal(result.removed, 0);
    assert.deepEqual(await readdir(manual), ['keep.txt']);
  });
});

test('a zero ttl disables the sweep', async () => {
  await withRoot(async (root) => {
    const old = path.join(root, '.discord-uploads', '100-1000000000000');
    await mkdir(old, { recursive: true });

    const result = await sweepUploads([root], 0);

    assert.equal(result.removed, 0);
    assert.deepEqual(await readdir(old), []);
  });
});

test('a missing root is skipped without throwing', async () => {
  const result = await sweepUploads(['/nonexistent-cmdbot-root'], 1000);
  assert.equal(result.removed, 0);
  assert.equal(result.errors, 0);
});
