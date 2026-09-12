/**
 * GuardianMesh — runtime configuration.
 * Every integration point a teammate needs to change lives in this file.
 */

export const CONFIG = {
  /** Backend REST base. Set to null to disable probing entirely. */
  API_BASE: '/api',

  /** Realtime event stream. Resolved against the current host. */
  WS_PATH: '/ws/events',

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

export const WS_URL = (() => {
  if (typeof window === 'undefined') return null;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${CONFIG.WS_PATH}`;
})();
