import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { measureDirectory, removeWorkdir } from '../src/workdir.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cmdbot-workdir-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('removeWorkdir deletes a thread directory under the work root', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'forum', 'post');
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'index.ts'), 'x'.repeat(1024));
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'y'.repeat(2048));

    const result = await removeWorkdir(dir, root);

    assert.equal(result.removed, true);
    assert.ok(result.freedBytes >= 3072);
    await assert.rejects(readdir(dir), /ENOENT/);
    assert.deepEqual(await readdir(path.join(root, 'forum')), []);
  });
});

test('removeWorkdir refuses the work root itself', async () => {
  await withRoot(async (root) => {
    const result = await removeWorkdir(root, root);
    assert.equal(result.removed, false);
    assert.equal(result.freedBytes, 0);
    assert.deepEqual(await readdir(root), []);
  });
});

test('removeWorkdir refuses directories outside the work root', async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'cmdbot-outside-'));
    try {
      await writeFile(path.join(outside, 'keep.txt'), 'x');
      const result = await removeWorkdir(outside, root);
      assert.equal(result.removed, false);
      assert.deepEqual(await readdir(outside), ['keep.txt']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('removeWorkdir refuses a missing directory', async () => {
  await withRoot(async (root) => {
    const result = await removeWorkdir(path.join(root, 'missing'), root);
    assert.equal(result.removed, false);
  });
});

test('measureDirectory ignores symlinks and sums real files', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'a.txt'), 'x'.repeat(100));
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', 'b.txt'), 'y'.repeat(50));

    const outside = await mkdtemp(path.join(tmpdir(), 'cmdbot-outside-'));
    try {
      await writeFile(path.join(outside, 'big.bin'), 'z'.repeat(10_000));
      await symlink(outside, path.join(root, 'link'));

      const size = await measureDirectory(root);
      assert.equal(size, 150);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
