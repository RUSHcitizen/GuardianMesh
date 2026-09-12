/**
 * GuardianMesh runtime configuration.
 * Local frontend development talks to FastAPI on :8001.
 * Production uses same-origin Cloudflare Worker API/WebSocket routes.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const IS_LOCAL_FRONTEND = typeof window !== 'undefined'
  && LOCAL_HOSTS.has(window.location.hostname)
  && window.location.port !== '8001';

export const CONFIG = {
  BACKEND_ENABLED: true,
  BACKEND_ORIGIN: IS_LOCAL_FRONTEND ? 'http://127.0.0.1:8001' : null,
  API_BASE: '/api',
  WS_PATH: '/ws',
  WS_CLIENT_ID: 'all',
  ACCESS_TOKEN: null,
  CONNECT_TIMEOUT_MS: 3000,
  RECONNECT_BACKOFF_MS: [1000, 2000, 4000, 8000, 15000],
  REQUIRE_API_PROBE: true,
  VIDEO_SOURCE_URL: null,

  SCORE_BANDS: [
    { min: 8.0, key: 'critical', label: 'Critical' },
    { min: 6.0, key: 'high', label: 'High' },
    { min: 3.0, key: 'elevated', label: 'Elevated' },
    { min: 0.0, key: 'normal', label: 'Low' }
  ],

  THRESHOLDS: {
    groundLevelY: 0.72,
    immobileMotion: 0.035,
    rapidDropVelocity: 0.55,
    bodyAngleAnomaly: 45
  },

  TIMELINE_LIMIT: 60,
  TREND_SAMPLES: 90
};

export function backendOrigin() {
  if (CONFIG.BACKEND_ORIGIN) return CONFIG.BACKEND_ORIGIN.replace(/\/$/, '');
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function apiUrl(path = '') {
  return `${backendOrigin()}${CONFIG.API_BASE}${path}`;
}

export function wsUrl() {
  const base = backendOrigin().replace(/^http/, 'ws');
  const url = `${base}${CONFIG.WS_PATH}/${encodeURIComponent(CONFIG.WS_CLIENT_ID)}`;
  return CONFIG.ACCESS_TOKEN
    ? `${url}?token=${encodeURIComponent(CONFIG.ACCESS_TOKEN)}`
    : url;
}

export function authHeaders() {
  return CONFIG.ACCESS_TOKEN
    ? { Authorization: `Bearer ${CONFIG.ACCESS_TOKEN}` }
    : {};
}
