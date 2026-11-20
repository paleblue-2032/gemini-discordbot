export function isRecoverableWebSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.stack?.includes('ws/lib/websocket.js') ?? false;
}
