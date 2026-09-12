/**
 * GuardianMesh runtime configuration.
 * Local frontend development talks to FastAPI on :8000.
 * Deployed pages use the same-origin Cloudflare Worker API/WebSocket routes.
 */

// Only the static dev servers (`npm start` on :8080, Live Server on :5500) sit
// apart from the backend. Anything else — `wrangler dev`, a deployed Worker, or
// uvicorn serving the page — answers the API on its own origin.
const LOCAL_STATIC_SERVERS = new Set(['8080', '5500']);
const IS_LOCAL_FRONTEND = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname)
  && LOCAL_STATIC_SERVERS.has(window.location.port);

export const CONFIG = {
  /**
   * The hackathon path is real browser-side inference. Scripted people remain
   * available only at /?dev=simulation so a projector can never silently show
   * synthetic detections after a camera or model failure.
   */
  DEV_SIMULATION_QUERY: 'simulation',

  /** Pinned MediaPipe Tasks runtime + model for reproducible deployments. */
  POSE_MODEL: {
    runtimeUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs',
    wasmRoot: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
    modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    maxPoses: 4,
    inferenceIntervalMs: 80,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    minLandmarkVisibility: 0.35,
    trackMatchDistance: 0.28,
    trackExpireMs: 1800
  },
  /**
   * Flip to true once a backend is actually running.
   *
   * While this is false the frontend makes no backend requests. Local pose
   * inference still fetches the pinned MediaPipe runtime and model. Avoiding a
   * reachability probe also keeps expected 404 noise out of the demo console.
   *
   * You do not have to edit this file to test a live backend: run
   * window.guardian.connect() in the console and it connects immediately.
   */
  BACKEND_ENABLED: false,

  /**
   * Where the backend lives. Locally it runs on its own port (uvicorn defaults
   * to 127.0.0.1:8000) while the frontend is served separately. Deployed pages
   * use their own origin, where worker.js serves the API (nearby help) — an HTTPS page could not reach an http:// localhost anyway.
   */
  BACKEND_ORIGIN: IS_LOCAL_FRONTEND ? 'http://127.0.0.1:8000' : null,

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

  /** How long to wait for backend/WS before returning to local inference. */
  CONNECT_TIMEOUT_MS: 2500,

  /** Reconnect backoff ladder (ms). The UI never blocks on these. Once the
   *  ladder is exhausted the socket stops retrying and the header reports
   *  DISCONNECTED; call window.guardian.connect() to try again. */
  RECONNECT_BACKOFF_MS: [1000, 2000, 4000, 8000, 15000],
  REQUIRE_API_PROBE: true,

  /**
   * Optional pre-recorded footage for the camera stage.
   * Drop a file in frontend/assets/video/ and set e.g. 'assets/video/corridor.mp4'.
   * When null, the camera remains off until the user chooses a source.
   */
  VIDEO_SOURCE_URL: null,

  SCORE_BANDS: [
    { min: 8.0, key: 'critical', label: 'Critical' },
    { min: 6.0, key: 'high', label: 'High' },
    { min: 3.0, key: 'elevated', label: 'Elevated' },
    { min: 0.0, key: 'normal', label: 'Low' }
  ],

  /**
   * Live fall detector tuning. Coordinates are normalised to the video frame,
   * velocities are normalised units/second, and angles are degrees away from
   * vertical. Keep all hackathon tuning here rather than scattering numbers.
   */
  THRESHOLDS: {
    minPoseConfidence: 0.45,
    instabilityAngle: 38,
    instabilityMinDescent: 0.06,
    instabilityConfirmationMs: 450,
    rapidDropVelocity: 0.48,
    rapidDropMinDistance: 0.075,
    rapidDropDistance: 0.16,
    rapidDropConfirmationMs: 280,
    descentWindowMs: 750,
    torsoHorizontalAngle: 52,
    groundCenterY: 0.56,
    groundBottomY: 0.82,
    horizontalBoxRatio: 0.9,
    immobileMotion: 0.045,
    recoveryMotion: 0.09,
    groundConfirmationMs: 600,
    immobilityTimeMs: 2200,
    distressTimeMs: 4800,
    smallMovementWindowMs: 4000,
    smallMovementBurstCount: 3,
    candidateTimeoutMs: 1900,
    recoveryTimeMs: 1200,
    normaliseTimeMs: 900
  },

  TIMELINE_LIMIT: 60,
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
