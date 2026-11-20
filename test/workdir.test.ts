import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMetaBlock,
  applyMetaBlock,
  META_BEGIN,
  META_END,
  type WorkdirMeta,
} from '../src/workdir.js';

const meta: WorkdirMeta = {
  threadLabel: 'Bug Reports / ログインできない',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
  sessionId: 'session-1',
  model: 'deepseek/deepseek-v4.1-flash',
  effort: 'high',
};

test('an empty file gets a header and the meta block', () => {
  const result = applyMetaBlock('', meta);
  assert.ok(result.includes('# 作業ディレクトリ'));
  assert.ok(result.includes(META_BEGIN));
  assert.ok(result.includes(META_END));
  assert.ok(result.includes(`- スレッド: ${meta.threadLabel}`));
});

test('an existing AGENTS.md without a block is left untouched', () => {
  const existing = '# My notes\n\n手順をここに書く。\n';
  assert.equal(applyMetaBlock(existing, meta), existing);
});

test('a fresh file receives the block and keeps existing text on update', () => {
  const withBlock = applyMetaBlock('', meta);
  const edited = `${withBlock}追加のメモ\n`;
  const updated = applyMetaBlock(edited, {
    ...meta,
    updatedAt: '2026-11-20T00:00:00.000Z',
  });

  assert.ok(updated.includes('追加のメモ'));
  assert.equal(updated.split(META_BEGIN).length - 1, 1);
  assert.ok(updated.includes('2026-11-20'));
  assert.equal(applyMetaBlock(updated, { ...meta, updatedAt: '2026-11-20T00:00:00.000Z' }), updated);
});

test('a half-written marker pair is not modified', () => {
  const broken = `${META_BEGIN}\n- スレッド: x\n`;
  assert.equal(applyMetaBlock(broken, meta), broken);
});

test('parseMetaBlock round-trips the rendered values', () => {
  const text = applyMetaBlock('', meta);
  const parsed = parseMetaBlock(text);
  assert.deepEqual(parsed, meta);
});

test('parseMetaBlock maps placeholder values to null', () => {
  const text = applyMetaBlock('', {
    ...meta,
    sessionId: null,
    model: null,
    effort: null,
  });
  const parsed = parseMetaBlock(text);
  assert.equal(parsed?.sessionId, null);
  assert.equal(parsed?.model, null);
  assert.equal(parsed?.effort, null);
});

test('parseMetaBlock returns null without a block', () => {
  assert.equal(parseMetaBlock('# hello\n'), null);
  assert.equal(parseMetaBlock(''), null);
});
