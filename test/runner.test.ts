import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildArgs,
  describeExitCode,
  MAX_TURNS,
  NdjsonParser,
  runCmd,
} from '../src/runner.js';

test('NdjsonParser handles lines split across chunks', () => {
  const lines: string[] = [];
  const parser = new NdjsonParser((line) => lines.push(line));

  parser.push('{"a":1}\n{"b"');
  parser.push(':2}\n');
  parser.end();

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('NdjsonParser parses a final line without a newline', () => {
  const lines: string[] = [];
  const parser = new NdjsonParser((line) => lines.push(line));
  parser.push('{"a":1}');
  parser.end();
  assert.deepEqual(lines, ['{"a":1}']);
});

test('buildArgs includes resume, model, and the turn limit override', () => {
  const args = buildArgs({
    cmdBin: 'cmd',
    prompt: 'hello',
    cwd: '/tmp',
    sessionId: 'session-1',
    model: 'deepseek/deepseek-v4-flash',
    effort: 'high',
  });

  assert.deepEqual(args.slice(0, 2), ['-p', 'hello']);
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('json'));
  assert.ok(args.includes('--yolo'));
  assert.equal(args[args.indexOf('--resume') + 1], 'session-1');
  assert.equal(args[args.indexOf('-m') + 1], 'deepseek/deepseek-v4-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(args[args.indexOf('--max-turns') + 1], String(MAX_TURNS));
});

test('buildArgs omits resume when no session exists', () => {
  const args = buildArgs({
    cmdBin: 'cmd',
    prompt: 'hello',
    cwd: '/tmp',
    sessionId: null,
  });
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('-m'));
  assert.ok(!args.includes('--effort'));
});

test('describeExitCode returns known meanings', () => {
  assert.match(describeExitCode(3), /未認証/);
  assert.match(describeExitCode(10), /クレジット不足/);
  assert.match(describeExitCode(999), /999/);
});

test('runCmd parses events and the final result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cmdbot-runner-'));
  try {
    const script = path.join(directory, 'fake-cmd.sh');
    await writeFile(
      script,
      `#!/bin/sh
cat <<'EOF'
{"type":"event","event":{"type":"run_start","sessionId":"sess-1"}}
{"type":"event","event":{"type":"text_delta","delta":"hi"}}
{"type":"result","subtype":"success","sessionId":"sess-1","finalText":"hello","durationMs":12}
EOF
`,
      { mode: 0o755 },
    );

    const events: string[] = [];
    const result = await runCmd({
      cmdBin: script,
      prompt: 'ignored',
      cwd: directory,
      onEvent: (event) => events.push(event.type),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.result?.subtype, 'success');
    assert.equal(result.result?.finalText, 'hello');
    assert.deepEqual(events, ['run_start', 'text_delta']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
