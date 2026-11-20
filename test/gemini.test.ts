import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildGeminiContents,
  buildGeminiRequest,
  extractGeminiText,
  GeminiHistoryStore,
  geminiGenerateUrl,
  parseGeminiModels,
  runGemini,
  trimHistory,
  type GeminiHistoryMessage,
} from '../src/gemini.js';

function user(text: string): GeminiHistoryMessage {
  return { role: 'user', parts: [{ text }] };
}

function model(text: string): GeminiHistoryMessage {
  return { role: 'model', parts: [{ text }] };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withTemp(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('trimHistory keeps the newest messages and starts with a user message', () => {
  const history = [user('u1'), model('m1'), user('u2'), model('m2'), user('u3')];
  const trimmed = trimHistory(history, 4);
  assert.deepEqual(
    trimmed.map((message) => message.role),
    ['user', 'model', 'user'],
  );
  assert.equal(trimmed[0]!.role, 'user');
  assert.deepEqual(trimmed[0]!.parts, [{ text: 'u2' }]);
});

test('GeminiHistoryStore persists and clears per channel', async () => {
  await withTemp(async (directory) => {
    const file = path.join(directory, 'history.json');
    const store = await GeminiHistoryStore.load(file);
    assert.equal(store.count('channel-1'), 0);

    await store.append('channel-1', [user('こんにちは'), model('やあ')], 10);
    assert.equal(store.count('channel-1'), 2);

    const reloaded = await GeminiHistoryStore.load(file);
    assert.deepEqual(reloaded.get('channel-1'), [user('こんにちは'), model('やあ')]);

    await reloaded.clear('channel-1');
    assert.equal(reloaded.count('channel-1'), 0);
    const cleared = await GeminiHistoryStore.load(file);
    assert.equal(cleared.count('channel-1'), 0);
  });
});

test('GeminiHistoryStore ignores a corrupt file and starts empty', async () => {
  await withTemp(async (directory) => {
    const file = path.join(directory, 'history.json');
    await writeFile(file, 'not json');
    const store = await GeminiHistoryStore.load(file);
    assert.equal(store.count('channel-1'), 0);
  });
});

test('parseGeminiModels keeps generateContent models and drops special-purpose ones', () => {
  const models = parseGeminiModels({
    models: [
      {
        name: 'models/gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        description: 'Flash model',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-3.8-flash-tts',
        displayName: 'TTS',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/gemini-3.1-pro-preview',
        displayName: 'Gemini 3.1 Pro',
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        displayName: 'Embedding',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  });

  assert.deepEqual(
    models.map((entry) => entry.id),
    ['gemini-3.1-pro-preview', 'gemini-3.8-flash'],
  );
});

test('extractGeminiText ignores thought parts and reports finish/block reasons', () => {
  const extracted = extractGeminiText({
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: [
      {
        finishReason: 'MAX_TOKENS',
        content: {
          parts: [
            { text: 'internal thought', thought: true },
            { text: 'visible answer' },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 3 },
  });

  assert.equal(extracted.text, 'visible answer');
  assert.equal(extracted.finishReason, 'MAX_TOKENS');
  assert.equal(extracted.blockReason, 'SAFETY');
  assert.deepEqual(extracted.usage, { promptTokenCount: 3 });
});

test('buildGeminiContents inlines images and text attachments', async () => {
  await withTemp(async (directory) => {
    const imagePath = path.join(directory, 'picture.png');
    const textPath = path.join(directory, 'note.txt');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(textPath, 'attachment text');

    const contents = await buildGeminiContents([], {
      role: 'user',
      parts: [
        { text: 'see these' },
        { file: { path: imagePath, mimeType: 'image/png', name: 'picture.png' } },
        { file: { path: textPath, mimeType: 'text/plain', name: 'note.txt' } },
        {
          file: {
            path: path.join(directory, 'missing.txt'),
            mimeType: 'text/plain',
            name: 'missing.txt',
          },
        },
      ],
    });

    const parts = contents[0]!.parts as Array<Record<string, unknown>>;
    assert.deepEqual(parts[0], { text: 'see these' });
    const inline = parts[1]!.inlineData as { mimeType: string; data: string };
    assert.equal(inline.mimeType, 'image/png');
    assert.equal(inline.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
    assert.match(String((parts[2] as { text: string }).text), /attachment text/);
    assert.match(String((parts[3] as { text: string }).text), /見つかりません/);
  });
});

test('buildGeminiRequest adds the system instruction and search tool', () => {
  const body = buildGeminiRequest([], {
    systemPrompt: 'you are a bot',
    maxOutputTokens: 123,
    googleSearch: true,
  });
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 123 });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'you are a bot' }] });
  assert.deepEqual(body.tools, [{ google_search: {} }]);
});

test('geminiGenerateUrl strips the models/ prefix', () => {
  assert.equal(
    geminiGenerateUrl('https://example.test/v1beta', 'models/gemini-3.1-flash-lite'),
    'https://example.test/v1beta/models/gemini-3.1-flash-lite:generateContent',
  );
});

test('runGemini sends the history and stores the answer', async () => {
  await withTemp(async (directory) => {
    const file = path.join(directory, 'history.json');
    const history = await GeminiHistoryStore.load(file);
    await history.append('channel-1', [user('previous'), model('answer')], 10);

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'こんにちは！' }] },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      });
    }) as typeof fetch;

    const events: string[] = [];
    const result = await runGemini({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1beta',
      model: 'gemini-3.1-flash-lite',
      prompt: '今日は？',
      sessionKey: 'channel-1',
      attachments: [],
      history,
      systemPrompt: 'system prompt',
      googleSearch: false,
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxHistoryMessages: 10,
      onEvent: (event) => events.push(event.type),
      fetchImpl,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.result?.subtype, 'success');
    assert.equal(result.result?.finalText, 'こんにちは！');
    assert.deepEqual(events, ['backend_status', 'text_delta']);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /models\/gemini-3.1-flash-lite:generateContent$/);

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'test-key');

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
      systemInstruction: { parts: Array<{ text: string }> };
    };
    assert.deepEqual(
      body.contents.map((content) => content.role),
      ['user', 'model', 'user'],
    );
    assert.deepEqual(body.contents[2]!.parts, [{ text: '今日は？' }]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system prompt' }] });

    assert.equal(history.count('channel-1'), 4);
    assert.deepEqual(history.get('channel-1').at(-1), model('こんにちは！'));
  });
});

test('runGemini returns an error result on HTTP failure', async () => {
  await withTemp(async (directory) => {
    const history = await GeminiHistoryStore.load(path.join(directory, 'history.json'));
    const fetchImpl = (async () =>
      jsonResponse(
        { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } },
        400,
      )) as typeof fetch;

    const result = await runGemini({
      apiKey: 'bad-key',
      baseUrl: 'https://example.test/v1beta',
      model: 'gemini-3.1-flash-lite',
      prompt: 'hello',
      sessionKey: 'channel-1',
      attachments: [],
      history,
      systemPrompt: '',
      googleSearch: false,
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxHistoryMessages: 10,
      fetchImpl,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.result?.error ?? '', /HTTP 400/);
    assert.match(result.result?.error ?? '', /API key not valid/);
    assert.equal(history.count('channel-1'), 0, 'failed runs must not persist history');
  });
});

test('runGemini reports an empty candidate as an error', async () => {
  await withTemp(async (directory) => {
    const history = await GeminiHistoryStore.load(path.join(directory, 'history.json'));
    const fetchImpl = (async () =>
      jsonResponse({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
      })) as typeof fetch;

    const result = await runGemini({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1beta',
      model: 'gemini-3.1-flash-lite',
      prompt: 'hello',
      sessionKey: 'channel-1',
      attachments: [],
      history,
      systemPrompt: '',
      googleSearch: false,
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxHistoryMessages: 10,
      fetchImpl,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.result?.error ?? '', /応答がありませんでした/);
    assert.match(result.result?.error ?? '', /SAFETY/);
  });
});

test('runGemini marks an aborted request as aborted', async () => {
  await withTemp(async (directory) => {
    const history = await GeminiHistoryStore.load(path.join(directory, 'history.json'));
    const controller = new AbortController();
    controller.abort();

    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error('should not reach the API');
    }) as typeof fetch;

    const result = await runGemini({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1beta',
      model: 'gemini-3.1-flash-lite',
      prompt: 'hello',
      sessionKey: 'channel-1',
      attachments: [],
      history,
      systemPrompt: '',
      googleSearch: false,
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxHistoryMessages: 10,
      signal: controller.signal,
      fetchImpl,
    });

    assert.equal(result.aborted, true);
    assert.equal(result.exitCode, null);
    assert.equal(history.count('channel-1'), 0);
  });
});
