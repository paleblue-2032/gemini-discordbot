import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from 'discord.js';
import { errorMessage } from './logger.js';
import { isWithin } from './paths.js';

export interface SavedAttachment {
  path: string;
  name: string;
  type: string;
  size: number;
}

export interface FileToSend {
  path: string;
  name: string;
}

export interface SaveResult {
  saved: SavedAttachment[];
  errors: string[];
}

export interface ExtractResult {
  text: string;
  files: FileToSend[];
  errors: string[];
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SEND_BYTES = 24 * 1024 * 1024;
export const UPLOAD_DIR = '.discord-uploads';
const UPLOAD_GITIGNORE = '*\n';
const SENSITIVE_BASENAMES = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /^credentials/i,
  /^\.npmrc$/i,
  /^\.gitconfig$/i,
];
const SENSITIVE_DIRS = new Set(['.git', '.commandcode', '.ssh', 'node_modules']);

export function safeFileName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[/\\\u0000-\u001f\u007f]+/g, '_')
    .replace(/^\.+/, '');
  const trimmed = base.slice(0, 120);
  return trimmed === '' ? 'file' : trimmed;
}

function isSensitiveFile(realPath: string, cwd: string): boolean {
  const relative = path.relative(cwd, realPath);
  if (relative.split(path.sep).some((part) => SENSITIVE_DIRS.has(part))) {
    return true;
  }
  const basename = path.basename(realPath);
  return SENSITIVE_BASENAMES.some((pattern) => pattern.test(basename));
}

export async function saveAttachments(
  attachments: Attachment[],
  cwd: string,
  messageId: string,
): Promise<SaveResult> {
  const saved: SavedAttachment[] = [];
  const errors: string[] = [];
  if (attachments.length === 0) {
    return { saved, errors };
  }

  const safeMessageId = messageId.replace(/[^0-9]/g, '') || 'message';
  const uploadRoot = path.join(cwd, UPLOAD_DIR);
  const directory = path.join(uploadRoot, `${safeMessageId}-${Date.now()}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(uploadRoot, '.gitignore'), UPLOAD_GITIGNORE, {
      flag: 'wx',
      mode: 0o644,
    }).catch(() => undefined);
  } catch (error) {
    return { saved, errors: [`保存先を作成できません: ${errorMessage(error)}`] };
  }

  let total = 0;
  let index = 0;
  for (const attachment of attachments) {
    if (saved.length >= MAX_FILES) {
      errors.push(`${attachment.name}: ファイル数上限を超えています`);
      continue;
    }
    if (attachment.size > MAX_FILE_BYTES) {
      errors.push(`${attachment.name}: サイズ上限を超えています`);
      continue;
    }

    const name = safeFileName(attachment.name);
    const destination = path.join(directory, `${index}-${name}`);
    index += 1;

    try {
      const response = await fetch(attachment.url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (total + buffer.length > MAX_TOTAL_BYTES) {
        errors.push(`${attachment.name}: 合計サイズ上限を超えています`);
        continue;
      }
      await writeFile(destination, buffer, { mode: 0o600 });
      total += buffer.length;
      saved.push({
        path: destination,
        name: attachment.name,
        type: attachment.contentType ?? 'application/octet-stream',
        size: buffer.length,
      });
    } catch (error) {
      errors.push(`${attachment.name}: ${errorMessage(error)}`);
    }
  }

  return { saved, errors };
}

export async function extractAttachmentMarkers(
  text: string,
  cwd: string,
): Promise<ExtractResult> {
  const files: FileToSend[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const marker = /\[\[attach:([^\]\n]+)\]\]/g;

  let match = marker.exec(text);
  while (match !== null) {
    const raw = match[1]!.trim();
    if (raw !== '') {
      try {
        const candidate = path.resolve(cwd, raw);
        const real = await realpath(candidate);
        if (!isWithin(cwd, real)) {
          errors.push(`${raw}: cwd の外です`);
        } else if (isSensitiveFile(real, cwd)) {
          errors.push(`${raw}: 送信が禁止されています`);
        } else {
          const info = await stat(real);
          if (!info.isFile()) {
            errors.push(`${raw}: ファイルではありません`);
          } else if (info.size > MAX_SEND_BYTES) {
            errors.push(`${raw}: サイズ上限を超えています`);
          } else if (!seen.has(real)) {
            seen.add(real);
            files.push({ path: real, name: safeFileName(path.basename(real)) });
          }
        }
      } catch (error) {
        errors.push(`${raw}: ${errorMessage(error)}`);
      }
    }
    match = marker.exec(text);
  }

  marker.lastIndex = 0;
  const cleaned = text
    .replace(marker, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: cleaned, files, errors };
}
