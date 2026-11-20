import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelQueue, Semaphore } from '../src/queue.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('semaphore limits concurrency', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maximum = 0;

  const task = async (): Promise<void> => {
    const release = await semaphore.acquire();
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(20);
    active -= 1;
    release();
  };

  await Promise.all(Array.from({ length: 6 }, () => task()));
  assert.equal(maximum, 2);
});

test('same channel runs serially', async () => {
  const queue = new ChannelQueue(2);
  const events: string[] = [];

  const run = (key: string, id: string): Promise<void> =>
    queue.run(key, async () => {
      events.push(`start:${id}`);
      await delay(20);
      events.push(`end:${id}`);
    });

  await Promise.all([run('a', 'a1'), run('a', 'a2'), run('b', 'b1'), run('b', 'b2')]);

  assert.ok(events.indexOf('end:a1') < events.indexOf('start:a2'));
  assert.ok(events.indexOf('end:b1') < events.indexOf('start:b2'));
});

test('a failed job does not block the next job on the same channel', async () => {
  const queue = new ChannelQueue(1);

  await assert.rejects(
    queue.run('a', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  const result = await queue.run('a', async () => 'ok');
  assert.equal(result, 'ok');
});

test('depth counts queued and running jobs per key, then returns to zero', async () => {
  const queue = new ChannelQueue(1);
  assert.equal(queue.depth('a'), 0);

  const first = queue.run('a', async () => {
    await delay(30);
  });
  assert.equal(queue.depth('a'), 1);

  const second = queue.run('a', async () => undefined);
  const other = queue.run('b', async () => undefined);
  assert.equal(queue.depth('a'), 2);
  assert.equal(queue.depth('b'), 1);

  await Promise.all([first, second, other]);
  assert.equal(queue.depth('a'), 0);
  assert.equal(queue.depth('b'), 0);
});
