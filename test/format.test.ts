import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDuration,
  splitMessage,
  stripAnsi,
  truncate,
} from '../src/format.js';

function fenceLines(chunk: string): string[] {
  return chunk.split('\n').filter((line) => /^ {0,3}```/.test(line));
}

test('short text stays in one chunk', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('empty text returns no chunks', () => {
  assert.deepEqual(splitMessage(''), []);
});

test('long plain text is split under the limit and preserved', () => {
  const text = 'a'.repeat(5000);
  const chunks = splitMessage(text, 2000);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000);
  }
  assert.equal(chunks.join(''), text);
});

test('japanese text is split without exceeding the limit', () => {
  const text = 'あいうえお'.repeat(600);
  const chunks = splitMessage(text, 500);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
  }
  assert.equal(chunks.join(''), text);
});

test('code fences are balanced in every chunk', () => {
  const code = Array.from({ length: 200 }, (_, index) => `line ${index} 0123456789`).join('\n');
  const text = `before\n\`\`\`ts\n${code}\n\`\`\`\nafter`;
  const chunks = splitMessage(text, 500);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
    assert.equal(fenceLines(chunk).length % 2, 0, chunk.slice(0, 120));
  }

  const withoutFences = chunks
    .map((chunk) => chunk.split('\n').filter((line) => !/^ {0,3}```/.test(line)).join('\n'))
    .join('\n');
  assert.ok(withoutFences.includes('line 0'));
  assert.ok(withoutFences.includes('line 199'));
  assert.ok(withoutFences.includes('after'));
});

test('continuation chunks reopen the language fence', () => {
  const inner = 'x\n'.repeat(1000);
  const chunks = splitMessage(`\`\`\`python\n${inner}\`\`\``, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[1]!.startsWith('```python\n'));
});

test('formatDuration formats seconds and minutes', () => {
  assert.equal(formatDuration(1234), '1.2 秒');
  assert.equal(formatDuration(65000), '1 分 5 秒');
});

test('truncate adds an ellipsis only when needed', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
});

test('stripAnsi removes color sequences', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});
