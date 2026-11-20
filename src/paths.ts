import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolveDirectory(
  input: string,
  allowedRoots: string[],
  base: string,
): Promise<string> {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('パスが空です');
  }

  const candidate = path.resolve(base, trimmed);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`ディレクトリが見つかりません: ${candidate}`);
  }

  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`ディレクトリではありません: ${resolved}`);
  }

  if (!allowedRoots.some((root) => isWithin(root, resolved))) {
    throw new Error(`許可されたルートの外です: ${resolved}`);
  }

  return resolved;
}

export async function resolveAllowedRoot(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(root));
  } catch {
    throw new Error(`ALLOWED_ROOTS が存在しません: ${root}`);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`ALLOWED_ROOTS がディレクトリではありません: ${root}`);
  }
  return resolved;
}
