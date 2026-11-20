export const TRIGGER_PREFIX = '!';

export type TriggerReason =
  | 'ok'
  | 'no-prefix'
  | 'empty-after-prefix'
  | 'attachment-without-prefix';

export interface TriggerResult {
  triggered: boolean;
  prompt: string;
  reason: TriggerReason;
}

export function parseTrigger(
  content: string,
  attachmentCount: number,
  requirePrefix = true,
): TriggerResult {
  const trimmed = content.trim();

  if (!requirePrefix) {
    if (trimmed === '' && attachmentCount === 0) {
      return { triggered: false, prompt: '', reason: 'empty-after-prefix' };
    }
    return { triggered: true, prompt: trimmed, reason: 'ok' };
  }

  if (!trimmed.startsWith(TRIGGER_PREFIX)) {
    return {
      triggered: false,
      prompt: '',
      reason:
        attachmentCount > 0 && trimmed === ''
          ? 'attachment-without-prefix'
          : 'no-prefix',
    };
  }

  const body = trimmed.slice(TRIGGER_PREFIX.length).trim();
  if (body === '' && attachmentCount === 0) {
    return { triggered: false, prompt: '', reason: 'empty-after-prefix' };
  }

  return { triggered: true, prompt: body, reason: 'ok' };
}
