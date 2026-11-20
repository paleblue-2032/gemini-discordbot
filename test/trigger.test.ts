import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrigger, TRIGGER_PREFIX } from '../src/trigger.js';

test('a message without the prefix is ignored', () => {
  const result = parseTrigger('ただの雑談です', 0);
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'no-prefix');
  assert.equal(result.prompt, '');
});

test('a prefixed message runs and strips the prefix', () => {
  const result = parseTrigger(`${TRIGGER_PREFIX} これを直して`, 0);
  assert.equal(result.triggered, true);
  assert.equal(result.prompt, 'これを直して');
  assert.equal(result.reason, 'ok');
});

test('the prefix works after leading whitespace', () => {
  const result = parseTrigger('   ! テスト', 0);
  assert.equal(result.triggered, true);
  assert.equal(result.prompt, 'テスト');
});

test('a bare prefix with no attachment is ignored', () => {
  const result = parseTrigger('!', 0);
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'empty-after-prefix');
});

test('a bare prefix with an attachment runs with no text', () => {
  const result = parseTrigger('!', 2);
  assert.equal(result.triggered, true);
  assert.equal(result.prompt, '');
});

test('an attachment without the prefix is ignored', () => {
  const result = parseTrigger('', 1);
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'attachment-without-prefix');
});

test('a prefixed message with attachments keeps both', () => {
  const result = parseTrigger('! 画像を見て', 1);
  assert.equal(result.triggered, true);
  assert.equal(result.prompt, '画像を見て');
});

test('prefix mode can be turned off to accept every message', () => {
  const result = parseTrigger('prefix なし', 0, false);
  assert.equal(result.triggered, true);
  assert.equal(result.prompt, 'prefix なし');
  assert.equal(result.reason, 'ok');
});

test('an empty message without attachments does not trigger', () => {
  assert.equal(parseTrigger('   ', 0).triggered, false);
  assert.equal(parseTrigger('', 0, false).triggered, false);
});
