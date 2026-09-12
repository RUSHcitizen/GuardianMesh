/**
 * GuardianMesh — runtime configuration.
 * Every integration point a teammate needs to change lives in this file.
 */

export const CONFIG = {
  /**
   * Flip to true once a backend is actually running.
   *
   * While this is false the frontend makes NO network requests at all: it runs
   * entirely on demo data. That is deliberate. A reachability probe against a
   * plain static server answers 404, and the browser logs that 404 to the
   * console itself — no JavaScript can suppress it — which is noise nobody
   * wants on a projector during a demo.
   *
   * You do not have to edit this file to test a live backend: run
   * window.guardian.connect() in the console and it connects immediately.
   */
  BACKEND_ENABLED: false,

  /**
   * Where the backend lives. It runs on its own port (uvicorn defaults to
   * 127.0.0.1:8000) while the frontend is served separately, so this must be
   * absolute. Set to null to use the page's own origin instead — useful if
   * you put both behind one reverse proxy.
   */
  BACKEND_ORIGIN: 'http://127.0.0.1:8000',

  /** REST base, resolved against BACKEND_ORIGIN. */
  API_BASE: '/api',

  /** WebSocket route prefix. The backend endpoint is /ws/{client_id}. */
  WS_PATH: '/ws',

  /**
   * WebSocket client id. The backend fans events out to the "all" channel and
   * to a channel named after the camera, so a dashboard MUST subscribe as
   * "all" — any other id receives nothing.
   */
  WS_CLIENT_ID: 'all',

  /**
   * Matches GUARDIANMESH_ACCESS_TOKEN on the backend. When the backend has a
   * token configured, REST needs `Authorization: Bearer <token>` and the
   * socket needs `?token=<token>`. Leave null when the backend is unprotected;
   * you can also pass it at runtime: window.guardian.connect('<token>').
   */
  ACCESS_TOKEN: null,

  /** How long to wait for backend/WS before declaring the demo the data source. */
  CONNECT_TIMEOUT_MS: 2500,

  /** Reconnect backoff ladder (ms). The UI never blocks on these. Once the
   *  ladder is exhausted the socket stops retrying and the header reports
   *  DISCONNECTED; call window.guardian.connect() to try again. */
  RECONNECT_BACKOFF_MS: [1000, 2000, 4000, 8000, 15000],

  /**
   * Only open the WebSocket if GET {API_BASE}/status answers first.
   * Keeps the console clean during offline demos. Set to false if your
   * backend exposes the event stream without a REST status route.
   */
  REQUIRE_API_PROBE: true,

  /**
   * Optional pre-recorded footage for the camera stage.
   * Drop a file in frontend/assets/video/ and set e.g. 'assets/video/corridor.mp4'.
   * When null, the deterministic simulated scene is used instead.
   */
  VIDEO_SOURCE_URL: null,

  /** Guardian Score band thresholds (lower bound, inclusive). */
  SCORE_BANDS: [
    { min: 8.0, key: 'critical', label: 'Critical' },
    { min: 6.0, key: 'high', label: 'High' },
    { min: 3.0, key: 'elevated', label: 'Elevated' },
    { min: 0.0, key: 'normal', label: 'Low' }
  ],

  /** Feature thresholds used by the live scoring engine (js/guardian-score.js). */
  THRESHOLDS: {
    groundLevelY: 0.72,        // normalised hip Y below which a pose reads as ground-level
    immobileMotion: 0.035,     // motion magnitude under which movement counts as minimal
    rapidDropVelocity: 0.55,   // normalised units/sec of downward hip travel
    bodyAngleAnomaly: 45       // degrees from vertical
  },

  /** Maximum timeline entries kept in memory/DOM. */
  TIMELINE_LIMIT: 60,

  /** Samples retained for the score sparkline. */
  TREND_SAMPLES: 90
};

/** Origin the backend is reached on — explicit, or the page's own. */
export function backendOrigin() {
  if (CONFIG.BACKEND_ORIGIN) return CONFIG.BACKEND_ORIGIN.replace(/\/$/, '');
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Absolute REST URL, e.g. apiUrl('/status'). */
export function apiUrl(path = '') {
  return `${backendOrigin()}${CONFIG.API_BASE}${path}`;
}

/** Absolute WebSocket URL including the client id and optional token. */
export function wsUrl() {
  const base = backendOrigin().replace(/^http/, 'ws');
  const url = `${base}${CONFIG.WS_PATH}/${encodeURIComponent(CONFIG.WS_CLIENT_ID)}`;
  return CONFIG.ACCESS_TOKEN
    ? `${url}?token=${encodeURIComponent(CONFIG.ACCESS_TOKEN)}`
    : url;
}

/** Headers for REST calls, carrying the bearer token when one is configured. */
export function authHeaders() {
  return CONFIG.ACCESS_TOKEN
    ? { Authorization: `Bearer ${CONFIG.ACCESS_TOKEN}` }
    : {};
}
