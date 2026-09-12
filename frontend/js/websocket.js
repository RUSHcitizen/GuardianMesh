/**
 * GuardianMesh — WebSocket transport.
 *
 * Vanilla WebSocket with bounded backoff. Every failure path is non-fatal:
 * the interface reports CONNECTED / RECONNECTING / DISCONNECTED and Demo Mode
 * keeps working regardless.
 */

import { CONFIG } from './config.js';

export function createEventSocket({ url, onEvent, onStatus }) {
  let socket = null;
  let attempt = 0;
  let closedByUs = false;
  let retryTimer = null;

  const report = (status, detail) => onStatus?.(status, detail);

  function connect() {
    if (!url || typeof WebSocket === 'undefined') {
      report('disconnected', 'WebSocket unavailable in this browser');
      return;
    }
    closedByUs = false;
    report(attempt === 0 ? 'connecting' : 'reconnecting');

    try {
      socket = new WebSocket(url);
    } catch (err) {
      scheduleRetry(err);
      return;
    }

    const guard = window.setTimeout(() => {
      if (socket && socket.readyState === WebSocket.CONNECTING) socket.close();
    }, CONFIG.CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      window.clearTimeout(guard);
      attempt = 0;
      report('connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        onEvent?.(JSON.parse(event.data));
      } catch (err) {
        console.warn('[guardian] dropped malformed event payload', err);
      }
    });

    socket.addEventListener('error', () => { /* surfaced by the close handler */ });

    socket.addEventListener('close', () => {
      window.clearTimeout(guard);
      socket = null;
      if (closedByUs) { report('disconnected'); return; }
      scheduleRetry();
    });
  }

  function scheduleRetry(err) {
    if (err) console.info('[guardian] realtime stream unavailable:', err?.message || err);
    const ladder = CONFIG.RECONNECT_BACKOFF_MS;
    if (attempt >= ladder.length) {
      // give up rather than hammering a backend that is not there
      console.info('[guardian] realtime stream unavailable — staying on demo data.');
      report('disconnected');
      return;
    }
    const delay = ladder[attempt];
    attempt += 1;
    report('reconnecting');
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, delay);
  }

  function close() {
    closedByUs = true;
    window.clearTimeout(retryTimer);
    socket?.close();
    socket = null;
    report('disconnected');
  }

  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  return { connect, close, send, get ready() { return socket?.readyState === WebSocket.OPEN; } };
}
