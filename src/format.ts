const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  marker: string;
  lang: string;
}

function advanceFence(state: Fence | null, line: string): Fence | null {
  const match = FENCE_LINE.exec(line);
  if (!match) return state;
  const marker = match[1]!;
  const rest = match[2]!.trim();

  if (state === null) {
    const lang = rest.split(/\s+/)[0] ?? '';
    return { marker, lang };
  }

  if (marker[0] === state.marker[0] && marker.length >= state.marker.length && rest === '') {
    return null;
  }

  return state;
}

export function splitMessage(text: string, limit = 2000): string[] {
  if (limit < 64) {
    throw new RangeError('limit must be at least 64');
  }
  if (text.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let position = 0;
  let fence: Fence | null = null;

  while (position < text.length) {
    const prefix = fence ? `${fence.marker}${fence.lang}\n` : '';
    const budget = limit - prefix.length - 16;
    if (budget <= 0) {
      throw new RangeError('limit is too small for the fence prefix');
    }

    let end = Math.min(text.length, position + budget);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= position + Math.floor(budget * 0.6)) {
        end = newline + 1;
      }
    }

    const body = text.slice(position, end);
    const startsAtLineStart = position === 0 || text[position - 1] === '\n';
    const lines = body.split('\n');
    let nextFence: Fence | null = fence;
    for (let index = 0; index < lines.length; index += 1) {
      if (index === 0 && !startsAtLineStart) continue;
      nextFence = advanceFence(nextFence, lines[index]!);
    }

    let chunk = prefix + body;
    if (nextFence) {
      if (!chunk.endsWith('\n')) chunk += '\n';
      chunk += nextFence.marker;
    }

    chunks.push(chunk);
    position = end;
    fence = nextFence;
  }

  return chunks;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} 分 ${seconds} 秒`;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
