import { execFile } from 'node:child_process';
import { stripAnsi } from './format.js';
import { cmdEnvironment } from './runner.js';

export interface ModelInfo {
  id: string;
  description: string;
}

const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s{2,}(.+)$/;

export function parseModelList(output: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripAnsi(output).split('\n')) {
    const line = rawLine.trimEnd();
    const match = MODEL_LINE.exec(line);
    if (!match) continue;

    const id = match[1]!;
    const description = match[2]!.trim();
    if (description === '' || seen.has(id)) continue;

    seen.add(id);
    models.push({ id, description });
  }

  return models;
}

export function listModels(cmdBin: string, cwd: string): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      cmdBin,
      ['--list-models'],
      { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: cmdEnvironment() },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(parseModelList(String(stdout)));
      },
    );
  });
}
