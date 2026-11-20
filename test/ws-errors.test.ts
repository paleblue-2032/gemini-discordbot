import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoverableWebSocketError } from '../src/ws-errors.js';

test('ws handshake errors are recoverable', () => {
  const error = new Error('Opening handshake has timed out');
  error.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (/app/node_modules/ws/lib/websocket.js:920:7)',
    '    at ClientRequest.emit (node:events:519:28)',
  ].join('\n');

  assert.equal(isRecoverableWebSocketError(error), true);
});

test('other errors and non-errors are not recoverable', () => {
  assert.equal(isRecoverableWebSocketError(new Error('boom')), false);
  assert.equal(isRecoverableWebSocketError('boom'), false);
  assert.equal(isRecoverableWebSocketError(null), false);
});
