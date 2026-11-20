import assert from 'node:assert/strict';
import test from 'node:test';
import { Progress } from '../src/progress.js';

test('onActivity receives each new tool activity once', async () => {
  const activities: string[] = [];
  const progress = new Progress(
    { edit: async () => undefined },
    0,
    (activity) => activities.push(activity),
  );

  progress.start();
  progress.handleEvent({
    type: 'tool_running',
    toolName: 'read_file',
    description: 'src/bot.ts',
  });
  progress.handleEvent({
    type: 'tool_running',
    toolName: 'read_file',
    description: 'src/bot.ts',
  });
  progress.handleEvent({ type: 'turn_start', turnNumber: 2 });
  progress.handleEvent({ type: 'text_delta', delta: 'hi' });

  await progress.finish('完了');

  assert.deepEqual(activities, ['read_file: src/bot.ts', 'ターン 2', '応答を生成中']);
});
