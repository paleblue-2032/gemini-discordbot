import { formatDuration, oneLine, truncate } from './format.js';
import { errorMessage, logger } from './logger.js';
import { isRecord, type AgentEvent } from './runner.js';

export interface ProgressTarget {
  edit(content: string): Promise<unknown>;
}

const MAX_ACTIVITIES = 8;
const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

function toolDetail(input: Record<string, unknown>): string | null {
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return oneLine(value);
    }
  }
  return null;
}

class ThrottledEditor {
  private latest = '';
  private timer: NodeJS.Timeout | null = null;
  private lastRun = 0;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly apply: (content: string) => Promise<unknown>,
    private readonly intervalMs: number,
  ) {}

  update(content: string): void {
    if (this.closed) return;
    this.latest = content;
    if (this.running || this.timer) return;

    const wait = Math.max(0, this.lastRun + this.intervalMs - Date.now());
    if (wait === 0) {
      void this.flush();
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, wait);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
    }
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    const content = this.latest;
    this.lastRun = Date.now();

    this.running = (async () => {
      try {
        await this.apply(content);
      } catch (error) {
        logger.warn(`進捗メッセージを更新できませんでした: ${errorMessage(error)}`);
      }
    })();
    await this.running;
    this.running = null;

    if (!this.closed && this.latest !== content) {
      this.update(this.latest);
    }
  }
}

export class Progress {
  private readonly startedAt = Date.now();
  private readonly activities: string[] = [];
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly editor: ThrottledEditor;
  private textStarted = false;
  private finished = false;

  constructor(
    private readonly target: ProgressTarget,
    intervalMs: number,
    private readonly onActivity?: (activity: string) => void,
  ) {
    this.editor = new ThrottledEditor((content) => target.edit(content), intervalMs);
  }

  start(): void {
    this.editor.update(this.render());
  }

  handleEvent(event: AgentEvent): void {
    if (this.finished) return;

    switch (event.type) {
      case 'tool_queued': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
        if (id && isRecord(event.input)) {
          this.toolInputs.set(id, event.input);
        }
        break;
      }
      case 'tool_running': {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : null;
        const input = id ? this.toolInputs.get(id) : undefined;
        const description =
          typeof event.description === 'string' && event.description.trim() !== ''
            ? event.description
            : null;
        const detail = description ?? (input ? toolDetail(input) : null);
        this.push(`${toolName}${detail ? `: ${truncate(detail, 120)}` : ''}`);
        break;
      }
      case 'turn_start': {
        const turn = typeof event.turnNumber === 'number' ? event.turnNumber : null;
        if (turn !== null && turn > 1) {
          this.push(`ターン ${turn}`);
        }
        break;
      }
      case 'text_delta': {
        if (!this.textStarted) {
          this.textStarted = true;
          this.push('応答を生成中');
        }
        break;
      }
      case 'backend_status': {
        const message = typeof event.message === 'string' ? event.message.trim() : '';
        if (message !== '') this.push(message);
        break;
      }
      default:
        break;
    }

    this.editor.update(this.render());
  }

  async finish(status: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.editor.stop();
    try {
      await this.target.edit(status);
    } catch (error) {
      logger.warn(`進捗メッセージを更新できませんでした: ${errorMessage(error)}`);
    }
  }

  private push(activity: string): void {
    const line = truncate(oneLine(activity), 200);
    if (this.activities[this.activities.length - 1] === line) return;
    this.activities.push(line);
    if (this.activities.length > MAX_ACTIVITIES * 2) {
      this.activities.splice(0, this.activities.length - MAX_ACTIVITIES);
    }
    this.onActivity?.(line);
  }

  private render(): string {
    const header = `実行中 (${formatDuration(Date.now() - this.startedAt)})`;
    const lines = this.activities.slice(-MAX_ACTIVITIES).map((activity) => `- ${activity}`);
    if (lines.length === 0) {
      lines.push('- 開始しています…');
    }
    return truncate(`${header}\n${lines.join('\n')}`, 1900);
  }
}
