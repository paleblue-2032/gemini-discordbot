import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ChannelType } from 'discord.js';
import {
  decideThreadCwd,
  describeChannel,
  slugify,
  threadCwdPath,
} from '../src/discord-context.js';

test('slugify keeps safe ascii and collapses separators', () => {
  assert.equal(slugify('Login Bug'), 'login-bug');
  assert.equal(slugify('a  b__c'), 'a-b__c');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
});

test('slugify falls back when nothing usable remains', () => {
  assert.equal(slugify('バグ報告'), 'post');
  assert.equal(slugify('!!!'), 'post');
  assert.equal(slugify('', 'forum'), 'forum');
});

test('slugify caps the length and trims trailing separators', () => {
  const slug = slugify('a'.repeat(100));
  assert.equal(slug.length, 40);
  assert.equal(slugify(`${'b'.repeat(39)}-x`).length, 39);
});

test('a forum post resolves to a nested cwd slug', () => {
  const ctx = describeChannel({
    id: 'thread-1',
    name: 'ログインできない',
    isThread: () => true,
    parentId: 'forum-1',
    parent: { id: 'forum-1', name: 'Bug Reports', type: ChannelType.GuildForum },
  });

  assert.equal(ctx.key, 'thread-1');
  assert.equal(ctx.parentId, 'forum-1');
  assert.equal(ctx.isThread, true);
  assert.equal(ctx.isForumPost, true);
  assert.equal(ctx.cwdSlug, 'bug-reports/post');
  assert.equal(ctx.label, 'Bug Reports / ログインできない');
});

test('a thread under a text channel is not a forum post', () => {
  const ctx = describeChannel({
    id: 'thread-2',
    name: 'side chat',
    isThread: () => true,
    parentId: 'text-1',
    parent: { id: 'text-1', name: 'general', type: ChannelType.GuildText },
  });

  assert.equal(ctx.isThread, true);
  assert.equal(ctx.isForumPost, false);
  assert.equal(ctx.cwdSlug, null);
});

test('a plain channel has no parent and no cwd slug', () => {
  const ctx = describeChannel({
    id: 'text-1',
    name: 'agent',
    type: ChannelType.GuildText,
    parentId: null,
    parent: null,
  });

  assert.equal(ctx.key, 'text-1');
  assert.equal(ctx.parentId, null);
  assert.equal(ctx.isForumPost, false);
  assert.equal(ctx.cwdSlug, null);
  assert.equal(ctx.label, 'agent');
});

test('a channel without a name falls back to its id', () => {
  const ctx = describeChannel({ id: 'unknown-1' });
  assert.equal(ctx.label, 'unknown-1');
});

test('a parent override restores the forum slug for partially cached threads', () => {
  const ctx = describeChannel(
    {
      id: 'thread-3',
      name: 'crash on start',
      isThread: () => true,
      parentId: 'forum-2',
      parent: null,
    },
    { id: 'forum-2', name: 'Bug Reports', type: ChannelType.GuildForum },
  );

  assert.equal(ctx.parentId, 'forum-2');
  assert.equal(ctx.parentName, 'Bug Reports');
  assert.equal(ctx.isForumPost, true);
  assert.equal(ctx.cwdSlug, 'bug-reports/crash-on-start');
});

const forumCtx = describeChannel({
  id: 'thread-9',
  name: 'ログインできない',
  isThread: () => true,
  parentId: 'forum-9',
  parent: { id: 'forum-9', name: 'Bug Reports', type: ChannelType.GuildForum },
});

test('a brand new forum post gets an automatic cwd', () => {
  const decision = decideThreadCwd(
    forumCtx,
    { cwd: '/srv/work', cwdSource: 'default' },
    'auto',
  );
  assert.equal(decision.auto, true);
  assert.equal(decision.slug, 'bug-reports/post');
});

test('shared mode keeps the default cwd', () => {
  const decision = decideThreadCwd(
    forumCtx,
    { cwd: '/srv/work', cwdSource: 'default' },
    'shared',
  );
  assert.equal(decision.auto, false);
  assert.equal(decision.reason, 'shared-mode');
});

test('an explicit /cwd is never overwritten', () => {
  const decision = decideThreadCwd(
    forumCtx,
    { cwd: '/srv/work/repo', cwdSource: 'user' },
    'auto',
  );
  assert.equal(decision.auto, false);
  assert.equal(decision.reason, 'explicit-cwd');
});

test('existing records and non-forum threads keep their cwd', () => {
  assert.equal(
    decideThreadCwd(forumCtx, { cwd: '/srv/work', cwdSource: 'unknown' }, 'auto').reason,
    'existing-record',
  );
  assert.equal(
    decideThreadCwd(forumCtx, { cwd: '/srv/work/x', cwdSource: 'thread' }, 'auto').reason,
    'existing-record',
  );
  assert.equal(
    decideThreadCwd(null, { cwd: '/srv/work', cwdSource: 'default' }, 'auto').reason,
    'not-forum-post',
  );
});

test('threadCwdPath falls back to an id suffix when the path is taken', () => {
  const free = threadCwdPath('/srv/work', 'bug-reports/post', '1234567890', () => false);
  assert.equal(free, path.join('/srv/work', 'bug-reports/post'));

  const taken = threadCwdPath('/srv/work', 'bug-reports/post', '1234567890', () => true);
  assert.equal(taken, `${path.join('/srv/work', 'bug-reports/post')}-7890`);
});
