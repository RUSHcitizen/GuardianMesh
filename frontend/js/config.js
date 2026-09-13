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
   * Vendored YOLO26 pose model + ONNX Runtime Web.
   *
   * Both ship with the site rather than loading from a CDN: a hackathon venue
   * network is the least reliable part of the demo, and a detector that cannot
   * download itself is a detector that does not run. Paths resolve against
   * frontend/js/, so they survive being served from any sub-path.
   *
   * YOLO26 exports end-to-end (NMS-free): the model emits [1, 300, 57] rows of
   * [x1, y1, x2, y2, confidence, class, 17 x (x, y, visibility)] already sorted
   * by confidence, so the browser only has to threshold them.
   */
  POSE_MODEL: {
    modelUrl: new URL('../assets/models/yolo26n-pose.onnx', import.meta.url).href,
    runtimeUrl: new URL('../vendor/onnxruntime/ort.webgpu.bundle.min.mjs', import.meta.url).href,
    wasmRoot: new URL('../vendor/onnxruntime/', import.meta.url).href,
    /** Square letterbox size the model was exported at. Do not change alone. */
    inputSize: 640,
    /** Execution providers tried in order; the first that builds a session wins. */
    executionProviders: ['webgpu', 'wasm'],
    maxPoses: 4,
    inferenceIntervalMs: 80,
    /**
     * Deliberately low. A person lying on the ground is detected with less
     * confidence than one standing upright — they are foreshortened, partly
     * occluded, and an unusual orientation — so a threshold tuned on standing
     * people drops the person exactly when GuardianMesh needs them most.
     * Recall matters more than precision here: a spurious track costs a
     * moment of operator attention, a dropped one loses the whole incident.
     */
    minPoseDetectionConfidence: 0.35,
    minLandmarkVisibility: 0.35,
    trackMatchDistance: 0.32,
    /**
     * A track survives this long without a detection. It spans the brief
     * dropouts that happen as somebody goes down, so the temporal evidence
     * built up before a fall is not thrown away mid-incident.
     */
    trackExpireMs: 2500
  },

  /**
   * Flip to true once a backend is actually running.
   *
   * While this is false the frontend makes no backend requests. Local pose
   * inference needs none — the model and runtime are served from this origin.
   * Avoiding a reachability probe also keeps 404 noise out of the demo console.
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
    normaliseTimeMs: 900,

    /* --- Activity context (js/activity.js) ----------------------------------
     * These separate an emergency from an ordinary day. Washing up, crouching
     * to a low shelf, sitting, picking something off the floor and lying down
     * all produce descents, low motion or horizontal postures — the exact
     * signals a naive fall detector fires on.
     */

    /** An activity must hold this long before it is believed. */
    activityConfirmationMs: 500,
    /** Peak downward travel above which a descent reads as uncontrolled. */
    controlledDescentSpeed: 0.55,
    /**
     * Hip-above-feet span, divided by the person's own size: ~0.5 standing,
     * ~0.3 seated, ~0.15 in a deep crouch, ~0 lying flat. Scale-free, so it
     * works at any distance from the camera.
     */
    seatedSpan: 0.32,
    crouchSpan: 0.18,
    /** Knee angle at or above which the legs are still extended. */
    reachingKneeFlexion: 140,
    /** Foot travel at or below which the feet count as planted. */
    plantedFeetMotion: 0.05,
    /** Arm motion above which the hands are busy. */
    taskArmMotion: 0.06,
    /** Torso motion at or below which the body itself is parked. */
    taskTorsoMotion: 0.035,

    /**
     * A person who lowered themselves to the floor under their own control is
     * resting, not collapsed — but stillness that outlasts any plausible rest
     * is worth a look. This is deliberately far longer than distressTimeMs.
     */
    restingEscalationMs: 45000
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
