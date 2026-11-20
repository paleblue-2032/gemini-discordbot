import path from 'node:path';
import { ChannelType } from 'discord.js';

export interface ChatContext {
  key: string;
  parentId: string | null;
  parentName: string | null;
  name: string | null;
  isThread: boolean;
  isForumPost: boolean;
  label: string;
  cwdSlug: string | null;
}

export interface ChannelLike {
  id: string;
  name?: string | null;
  type?: ChannelType;
  isThread?: () => boolean;
  parentId?: string | null;
  parent?: ChannelLike | null;
}

const MAX_SLUG_LENGTH = 40;

export function slugify(name: string, fallback = 'post'): string {
  const normalized = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-._]+$/, '');
  return normalized === '' ? fallback : normalized;
}

export function describeChannel(
  channel: ChannelLike,
  parentOverride?: ChannelLike | null,
): ChatContext {
  const isThread = typeof channel.isThread === 'function' ? channel.isThread() : false;
  const parent = parentOverride ?? channel.parent ?? null;
  const parentId = channel.parentId ?? parent?.id ?? null;
  const parentName = parent?.name ?? null;
  const name = channel.name ?? null;
  const isForumPost = isThread && parent?.type === ChannelType.GuildForum;

  const labelParts = [parentName, name].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );

  return {
    key: channel.id,
    parentId,
    parentName,
    name,
    isThread,
    isForumPost,
    label: labelParts.length > 0 ? labelParts.join(' / ') : channel.id,
    cwdSlug: isForumPost
      ? `${slugify(parentName ?? '', 'forum')}/${slugify(name ?? '', 'post')}`
      : null,
  };
}

export interface ThreadCwdDecision {
  auto: boolean;
  slug: string | null;
  reason: 'ok' | 'shared-mode' | 'not-forum-post' | 'explicit-cwd' | 'existing-record';
}

export function decideThreadCwd(
  ctx: ChatContext | null,
  record: { cwd: string; cwdSource: 'default' | 'thread' | 'user' | 'unknown' },
  forumCwd: 'auto' | 'shared',
): ThreadCwdDecision {
  if (!ctx || !ctx.isForumPost || ctx.cwdSlug === null) {
    return { auto: false, slug: null, reason: 'not-forum-post' };
  }
  if (forumCwd === 'shared') {
    return { auto: false, slug: null, reason: 'shared-mode' };
  }
  if (record.cwdSource === 'user') {
    return { auto: false, slug: null, reason: 'explicit-cwd' };
  }
  if (record.cwdSource !== 'default') {
    return { auto: false, slug: null, reason: 'existing-record' };
  }
  return { auto: true, slug: ctx.cwdSlug, reason: 'ok' };
}

export function threadCwdPath(
  defaultCwd: string,
  slug: string,
  key: string,
  taken: (candidate: string) => boolean,
): string {
  const base = path.join(defaultCwd, slug);
  if (!taken(base)) return base;
  return `${base}-${key.slice(-4)}`;
}
