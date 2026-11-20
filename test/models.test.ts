import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelList } from '../src/models.js';

test('parseModelList extracts ids and descriptions', () => {
  const output = `Available models  ·  3 models

Open Source

deepseek/deepseek-v4.1-flash            V4.1 hybrid-attention reasoning with vision (default)
z-ai/glm-5.3-flash                      fast, affordable GLM coding with 1M context

Stealth

stealth/space-bunny-alpha               stealth model with 1M context
`;

  const models = parseModelList(output);
  assert.deepEqual(
    models.map((model) => model.id),
    [
      'deepseek/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'stealth/space-bunny-alpha',
    ],
  );
  assert.match(models[0]!.description, /V4\.1/);
  assert.match(models[1]!.description, /GLM/);
  assert.match(models[2]!.description, /stealth/);
});

test('parseModelList ignores headings and empty output', () => {
  assert.deepEqual(
    parseModelList('Available models  ·  0 models\n\nOpen Source\nStealth\n'),
    [],
  );
});

test('parseModelList deduplicates repeated models', () => {
  const output =
    'deepseek/deepseek-v4-flash            first\n' +
    'deepseek/deepseek-v4-flash            second\n';
  const models = parseModelList(output);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.description, 'first');
});
