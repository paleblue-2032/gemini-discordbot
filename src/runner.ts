import { spawn, type ChildProcess } from 'node:child_process';

export type AgentEvent = { type: string } & Record<string, unknown>;

export interface ResultPayload {
  type?: string;
  subtype: string;
  sessionId?: string;
  stopReason?: string;
  finalText?: string;
  error?: string;
  durationMs?: number;
  usage?: unknown;
}

export interface RunOptions {
  cmdBin: string;
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export const MAX_TURNS = 1_000_000;

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result: ResultPayload | null;
  sessionId: string | null;
  stderr: string;
  aborted: boolean;
  spawnError: string | null;
  durationMs: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NdjsonParser {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  end(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line !== '') this.onLine(line);
  }
}

export function cmdEnvironment(): NodeJS.ProcessEnv {
  const keys = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'LOGNAME'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildArgs(options: RunOptions): string[] {
  const args = [
    '-p',
    options.prompt,
    '--output-format',
    'json',
    '--yolo',
    '--trust',
    '--skip-onboarding',
    '--max-turns',
    String(MAX_TURNS),
  ];
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  return args;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
}

export function runCmd(options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const args = buildArgs(options);

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.cmdBin, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: cmdEnvironment(),
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        result: null,
        sessionId: null,
        stderr: '',
        aborted: false,
        spawnError: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    let stderr = '';
    let result: ResultPayload | null = null;
    let runSessionId: string | null = null;
    let aborted = false;
    let spawnError: string | null = null;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const parser = new NdjsonParser((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;

      if (parsed.type === 'event' && isRecord(parsed.event)) {
        const event = parsed.event as AgentEvent;
        if (event.type === 'run_start' && typeof event.sessionId === 'string') {
          runSessionId = event.sessionId;
        }
        options.onEvent?.(event);
      } else if (parsed.type === 'result') {
        result = parsed as unknown as ResultPayload;
      }
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      parser.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const onAbort = (): void => {
      aborted = true;
      if (child.pid) {
        killGroup(child.pid, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (child.pid) killGroup(child.pid, 'SIGKILL');
        }, 3000);
        forceKillTimer.unref();
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      parser.end();
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        result,
        sessionId: result?.sessionId ?? runSessionId,
        stderr,
        aborted,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

export const EXIT_MEANINGS: Record<number, string> = {
  0: '成功',
  1: '一般エラー',
  3: '未認証（cmd login が必要）',
  4: '権限拒否',
  5: 'レート制限',
  6: 'ネットワークエラー',
  7: 'サーバーエラー',
  8: '最大ターン数に到達',
  9: 'モデルから応答なし',
  10: 'クレジット不足',
  130: '中断',
};

export function describeExitCode(code: number | null): string {
  if (code === null) return 'シグナルにより終了';
  return EXIT_MEANINGS[code] ?? `終了コード ${code}`;
}
