import { existsSync } from 'node:fs';
import path from 'node:path';
import { Bot } from './bot.js';
import { loadConfig } from './config.js';
import { GeminiHistoryStore } from './gemini.js';
import { errorMessage, logger } from './logger.js';
import { SessionStore } from './sessions.js';
import { isRecoverableWebSocketError } from './ws-errors.js';

const envFile = process.env.BOT_ENV_FILE
  ? path.resolve(process.env.BOT_ENV_FILE)
  : path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    if (!process.env.DISCORD_TOKEN) throw error;
  }
}

process.on('uncaughtException', (error) => {
  if (isRecoverableWebSocketError(error)) {
    logger.warn(`WebSocket 接続エラーを無視して再接続を続けます: ${errorMessage(error)}`);
    return;
  }
  logger.error(`未処理の例外: ${errorMessage(error)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未処理の Promise 拒否: ${errorMessage(reason)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const config = await loadConfig();
  const sessions = await SessionStore.load(config.sessionsFile);
  const geminiHistory = await GeminiHistoryStore.load(config.gemini.historyFile);
  const bot = new Bot(config, sessions, geminiHistory);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} を受信しました。停止します。`);
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await bot.start();
  logger.info('起動しました。');
}

main().catch((error: unknown) => {
  logger.error(`起動に失敗しました: ${errorMessage(error)}`);
  process.exitCode = 1;
});
