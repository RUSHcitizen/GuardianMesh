/**
 * GuardianMesh — data source adapter.
 *
 *   backend / websocket  →  guardianDataSource  →  normalised guardian event
 *                                              →  state actions  →  UI
 *
 * Demo Mode and the live backend write through the SAME state actions, so no
 * UI code branches on where data came from. If the backend is absent the UI
 * reports it and Demo Mode remains fully functional.
 */

import { CONFIG, apiUrl, authHeaders, backendOrigin, wsUrl } from './config.js';
import { EVENT_LABELS } from '../data/mock-events.js';
import {
  addTimelineEvent, guardianState, setCameraStatus, setConfidence, setCorroboration,
  setGuardianScore, setResponseState, update, upsertIncident
} from './state.js';
import { createEventSocket } from './websocket.js';
import { clockLabel } from './util.js';

/**
 * Normalise any backend payload into the canonical Guardian event.
 * Unknown fields are preserved; missing fields get safe defaults.
 */
export function normalizeEvent(raw = {}) {
  const eventType = raw.eventType || raw.event_type || raw.type || 'normal';
  // The CV pipeline sends the command-center fields alongside its legacy
  // snake_case ones; fall back to the legacy pair if the rich fields are absent.
  // overall_confidence is recomputed by the backend and outranks the value the
  // CV client supplied for itself
  const confidence = raw.overall_confidence ?? raw.confidence;
  const state = raw.state || null;
  const guardianScore = raw.guardianScore ?? raw.guardian_score
    ?? (raw.fall_score !== undefined
      ? clamp01(raw.fall_score) * 7 + clamp01(raw.immobility_score) * 3
      : 0);
  const trackingId = raw.trackingId || raw.track_id
    || (raw.person_id !== undefined && raw.person_id !== null
      ? `P-${String(Number(raw.person_id) + 1).padStart(2, '0')}`
      : null);

  return {
    id: raw.id || `EVT-${Date.now()}`,
    timestamp: raw.timestamp || new Date().toISOString(),
    trackingId,
    cameraId: raw.cameraId || raw.camera_id || null,
    location: raw.location || '',
    ...coordinatesOf(raw),
    eventType,
    label: LABEL_FOR_STATE[state] || raw.label || EVENT_LABELS[eventType] || eventType,
    confidence: clamp01(confidence),
    guardianScore: Number(guardianScore) || 0,
    state,
    reason: raw.reason || null,
    status: STATUS_FOR_STATE[state] || raw.status || 'observing',
    durationMs: Number(raw.durationMs ?? raw.duration_ms ?? 0),
    boundingBox: raw.boundingBox || raw.bounding_box || null,
    keypoints: raw.keypoints || [],
    temporalFeatures: raw.temporalFeatures || raw.temporal_features || null
  };
}

/**
 * The backend derives a distress state server-side (compute_score) rather than
 * trusting the client, so when `state` is present it outranks the classifier's
 * own status. Ordered by severity.
 */
const STATUS_FOR_STATE = {
  NORMAL: 'normal',
  POSSIBLE_FALL: 'observing',
  VERIFYING: 'warning',
  DISTRESS_EVENT: 'critical'
};

const LABEL_FOR_STATE = {
  NORMAL: 'Normal motion',
  POSSIBLE_FALL: 'Possible fall',
  VERIFYING: 'Possible fall — verifying',
  DISTRESS_EVENT: 'Possible distress pattern'
};

const RESPONSE_FOR_STATUS = {
  normal: 'Monitoring',
  observing: 'Monitoring — gathering temporal evidence',
  elevated: 'Monitoring — gathering temporal evidence',
  warning: 'Responder review suggested',
  critical: 'Responder recommended',
  resolved: 'Event resolved — no further action'
};

const TIMELINE_KIND_FOR_STATUS = {
  normal: 'observation',
  observing: 'observation',
  elevated: 'inference',
  warning: 'warning',
  critical: 'critical',
  resolved: 'resolved'
};

/**
 * Pull a lat/lng pair off a backend payload (incident or camera). Accepts
 * lat/lng, latitude/longitude, or either shape nested under `coordinates`/`geo`.
 * Returns {lat, lng} or {} when no valid pair is present. Coordinates describe
 * where a camera is mounted, never where a person is.
 */
export function coordinatesOf(raw) {
  if (!raw || typeof raw !== 'object') return {};
  for (const src of [raw, raw.coordinates, raw.geo]) {
    if (!src || typeof src !== 'object') continue;
    if (src.lat == null && src.latitude == null) continue;
    const lat = Number(src.lat ?? src.latitude);
    const lng = Number(src.lng ?? src.lon ?? src.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return {};
}

/**
 * GET {API_BASE}/nearby-help for a location. Throws when the backend is
 * unconfigured or unreachable; callers treat that as "unavailable".
 */
export async function fetchNearbyHelp({ lat, lng, limit = 5 }) {
  if (!CONFIG.API_BASE) throw new Error('API_BASE not configured');
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng), limit: String(limit) });
  const controller = new AbortController();
  // Backend allows ~4 s for the public lookup; leave headroom beyond that.
  const timer = window.setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${apiUrl('/nearby-help')}?${params}`, {
      headers: authHeaders(),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`nearby-help request failed: ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * GET {API_BASE}/cameras — registry cameras with location and coordinates.
 * Returns [] when the backend is unreachable.
 */
export async function fetchCameras() {
  try {
    const res = await fetch(apiUrl('/cameras'), { headers: authHeaders() });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.cameras) ? body.cameras : [];
  } catch {
    return [];
  }
}

function clamp01(v) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? Math.min(n / 100, 1) : Math.max(n, 0);
}

export function createDataSource({ engine }) {
  let socket = null;
  let live = false;

  function setBackendStatus(status) {
    const becameLive = status === 'connected' && !live;
    update({
      backendStatus: status,
      dataSource: status === 'connected' ? 'live' : 'local'
    });
    live = status === 'connected';
    if (becameLive) goLive();
  }

  /**
   * Hand the overlay over to the backend. The simulated baseline people are
   * dropped so the stage shows only tracks the CV pipeline is actually
   * reporting — otherwise fake figures walk around beside live ones.
   */
  function goLive() {
    engine.reset();
    situations.clear();
    update({
      // seeded demo nodes are cleared so the mesh shows only what the backend
      // actually reports; cameras re-appear as their first events arrive
      cameras: [],
      sensors: [],
      trackedPeople: [],
      focusPersonId: null,
      guardianScore: 0,
      previousScore: 0,
      confidence: 0,
      scoreTrend: [],
      eventType: 'normal',
      eventLabel: 'Awaiting events',
      incidents: [],
      timeline: []
    });
    addTimelineEvent({
      kind: 'system',
      title: 'Live backend attached — streaming events from the CV pipeline.',
      facts: [{ label: 'Source', value: 'Live' }]
    });
  }

  /** Apply one normalised guardian event to shared state. */
  function handleGuardianEvent(payload) {
    if (!payload || typeof payload !== 'object') return;

    switch (payload.type) {
      case 'status':
        update({
          systemStatus: payload.systemStatus || 'online',
          latencyMs: payload.latencyMs ?? 42,
          aiEngine: payload.aiEngine || 'active'
        });
        return;

      case 'cameras':
        if (Array.isArray(payload.cameras)) update({ cameras: payload.cameras });
        if (Array.isArray(payload.sensors)) update({ sensors: payload.sensors });
        return;

      case 'tracks':
        for (const track of payload.tracks || []) engine.applyExternalTrack(track);
        return;

      case 'timeline':
        addTimelineEvent(payload.event || payload);
        return;

      case 'response':
        setResponseState(payload.responseState || 'idle', payload.recommendations);
        return;

      case 'corroboration':
        setCorroboration(payload.entries || [], payload.result || null);
        return;

      case 'pong':
        return;

      // The FastAPI backend wraps every CV detection as
      // { type: "event", data: {...}, timestamp }. Unwrap before normalising.
      case 'event':
        applyEvent(normalizeEvent(payload.data || {}));
        return;

      case 'alert':
        applyAlert(payload);
        return;

      default:
        applyEvent(normalizeEvent(payload));
    }
  }

  /**
   * Threshold alerts. The backend emits one per qualifying frame, so only a
   * change in level is worth a timeline entry.
   */
  let lastAlertLevel = new Map();
  function applyAlert(payload) {
    const camera = payload.camera_id || payload.cameraId;
    const level = payload.level || 'high';
    if (lastAlertLevel.get(camera) === level) return;
    lastAlertLevel.set(camera, level);
    const message = String(payload.message || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '')
      .trim();
    addTimelineEvent({
      kind: level === 'critical' ? 'critical' : 'warning',
      title: message ? `Backend threshold alert — ${message}` : `Threshold alert raised on ${camera}.`,
      facts: [{ label: 'Camera', value: camera || '—' }, { label: 'Level', value: level }]
    });
  }

  /**
   * Event correlator.
   *
   * The CV pipeline posts once per frame (~30/s), each with a unique event id.
   * Treating those as separate incidents would spawn hundreds of cards, so an
   * incident is keyed by the SITUATION — a tracked person on a camera — and the
   * stream updates that one card as it escalates or resolves. The same guard
   * keeps the timeline to genuine transitions rather than a per-frame log.
   */
  const situations = new Map();
  let incidentSeq = 0;
  const keyOf = (e) => `${e.cameraId || 'CAM'}:${e.trackingId || 'P'}`;

  function correlate(event) {
    const key = keyOf(event);
    let situation = situations.get(key);

    // `status` already reflects the backend's own distress state where it sent
    // one, so a detection the scorer rates as normal opens no incident — even
    // if the CV classifier labelled that frame a possible fall.
    if (event.status === 'normal' || event.eventType === 'normal') {
      if (!situation) return null;
      // the situation returned to baseline: close it out once
      situations.delete(key);
      return { ...situation, closing: true };
    }

    if (!situation) {
      incidentSeq += 1;
      situation = {
        id: `INC-${String(incidentSeq).padStart(3, '0')}`,
        key,
        startedAt: Date.now(),
        status: null,
        eventType: null
      };
      situations.set(key, situation);
    }
    return situation;
  }

  /** A perception/classification event: drives score, confidence and incidents. */
  function applyEvent(event) {
    // 1. perception — always forwarded, the overlay needs every frame
    if (event.keypoints?.length || event.boundingBox) {
      engine.applyExternalTrack({
        trackingId: event.trackingId,
        cameraId: event.cameraId,
        boundingBox: event.boundingBox,
        keypoints: event.keypoints,
        status: event.status,
        label: event.label,
        confidence: event.confidence,
        score: event.guardianScore,
        features: event.temporalFeatures
          ? {
            verticalVelocity: event.temporalFeatures.verticalVelocity ?? 0,
            motionMagnitude: event.temporalFeatures.motionMagnitude ?? 0,
            bodyAngle: event.temporalFeatures.bodyAngle ?? 0,
            groundDurationMs: event.temporalFeatures.groundDurationMs ?? 0,
            timeSinceMovementMs: event.temporalFeatures.timeSinceMovementMs
              ?? event.temporalFeatures.groundDurationMs ?? 0
          }
          : null
      });
    }

    // 2. assessment — written only when a rendered value actually moved, so a
    //    30 fps stream does not re-render the dashboard 30 times a second
    const state = guardianState;
    const scoreMoved = Math.abs(event.guardianScore - state.guardianScore) >= 0.1;
    const confMoved = Math.abs(event.confidence - state.confidence) >= 0.01;
    const focusMoved = Boolean(event.trackingId) && event.trackingId !== state.focusPersonId;
    const labelMoved = event.label !== state.eventLabel;

    if (scoreMoved || labelMoved || focusMoved) {
      setGuardianScore(event.guardianScore, {
        eventType: event.eventType,
        eventLabel: event.label,
        ...(event.trackingId ? { focusPersonId: event.trackingId } : {})
      });
    }
    if (confMoved) setConfidence(event.confidence);

    if (event.cameraId) {
      const camera = state.cameras.find((c) => c.id === event.cameraId);
      if (!camera) {
        // A live camera the mesh has not seen before joins the mesh rather than
        // being dropped: the backend names cameras (cam_02), the frontend's
        // seed data does not have to know them in advance.
        update({
          cameras: state.cameras.concat({
            id: event.cameraId,
            label: String(event.cameraId).replace(/[_-]/g, ' ').toUpperCase(),
            location: event.location || 'Live camera',
            ...coordinatesOf(event),
            status: event.status,
            people: 1,
            score: event.guardianScore,
            online: true
          })
        });
      } else if (camera.status !== event.status
        || Math.abs((camera.score ?? 0) - event.guardianScore) >= 0.1) {
        setCameraStatus(event.cameraId, { status: event.status, score: event.guardianScore });
      }
      // the hero panel should name the camera that is actually reporting
      if (state.activeCamera !== event.cameraId) update({ activeCamera: event.cameraId });
    }

    // 3. incident + timeline — one situation per tracked person per camera
    const situation = correlate(event);
    if (!situation) return;

    const immobilitySeconds = Math.round(
      (event.temporalFeatures?.timeSinceMovementMs
        ?? event.temporalFeatures?.groundDurationMs ?? 0) / 1000
    );

    if (situation.closing) {
      upsertIncident({
        id: situation.id,
        status: 'resolved',
        label: `${situation.label || 'Event'} — resolved`,
        guardianScore: event.guardianScore,
        confidence: event.confidence,
        responseState: 'Event resolved — no further action'
      });
      addTimelineEvent({
        kind: 'resolved',
        title: `${event.trackingId || 'Track'} returned to normal motion on ${event.cameraId || 'camera'}.`,
        facts: [{ label: 'Score', value: event.guardianScore.toFixed(1) }]
      });
      return;
    }

    const transitioned = situation.status !== event.status
      || situation.eventType !== event.eventType;

    if (!situation.timestamp) {
      situation.timestamp = clockLabel(new Date(event.timestamp), false);
    }

    upsertIncident({
      id: situation.id,
      trackingId: event.trackingId,
      eventType: event.eventType,
      label: event.label,
      cameraId: event.cameraId,
      location: event.location || cameraLocation(event.cameraId),
      // only when present, so a later event without coordinates keeps them
      ...(event.lat != null ? { lat: event.lat, lng: event.lng } : {}),
      confidence: event.confidence,
      guardianScore: event.guardianScore,
      status: event.status,
      reason: event.reason,
      durationSeconds: Math.round((Date.now() - situation.startedAt) / 1000),
      immobilitySeconds,
      responseState: RESPONSE_FOR_STATUS[event.status] || 'Monitoring',
      timestamp: situation.timestamp
    });

    if (transitioned) {
      situation.status = event.status;
      situation.eventType = event.eventType;
      situation.label = event.label;
      addTimelineEvent({
        kind: TIMELINE_KIND_FOR_STATUS[event.status] || 'observation',
        title: event.reason
          ? `${event.label} — ${event.reason.charAt(0).toLowerCase()}${event.reason.slice(1)} `
            + `(${event.trackingId || 'unknown track'} on ${event.cameraId || 'unknown camera'}).`
          : `${event.label} — ${event.trackingId || 'unknown track'} on ${event.cameraId || 'unknown camera'}.`,
        facts: [
          { label: 'Confidence', value: `${Math.round(event.confidence * 100)}%` },
          { label: 'Score', value: Number(event.guardianScore).toFixed(1) },
          ...(event.state ? [{ label: 'State', value: event.state.replace(/_/g, ' ') }] : []),
          ...(immobilitySeconds ? [{ label: 'Immobility', value: `${immobilitySeconds} s` }] : [])
        ]
      });
    }
  }

  function cameraLocation(cameraId) {
    return guardianState.cameras.find((c) => c.id === cameraId)?.location || '';
  }

  /**
   * Probe REST (optional) then open the realtime stream. Never throws.
   * @param {{force?: boolean}} opts force bypasses CONFIG.BACKEND_ENABLED, so
   *        window.guardian.connect() works without editing config.js.
   */
  async function connect({ force = false, token } = {}) {
    if (token) CONFIG.ACCESS_TOKEN = token;
    if (!CONFIG.BACKEND_ENABLED && !force) {
      // Stay fully offline: no fetch, no socket, nothing for the browser to log.
      console.info('[guardian] running on demo data (CONFIG.BACKEND_ENABLED is false). '
        + 'Run window.guardian.connect() to attach a live backend.');
      update({ backendStatus: 'not_required', dataSource: 'local' });
      return;
    }

    // A page served over HTTPS cannot reach an http:// backend: the browser
    // blocks it as mixed content, with no useful error on the page. Say so
    // rather than leaving the operator watching a dashboard that never fills.
    if (typeof window !== 'undefined'
      && window.location.protocol === 'https:'
      && backendOrigin().startsWith('http://')) {
      console.warn(`[guardian] cannot reach ${backendOrigin()} from an HTTPS page — `
        + 'browsers block mixed content. Serve the backend over HTTPS, or open the '
        + 'dashboard over http:// for a local backend. Staying on demo data.');
      setBackendStatus('disconnected');
      return;
    }

    // A second connect() (e.g. window.guardian.connect()) must not leave the old socket streaming.
    socket?.close();
    socket = null;
    setBackendStatus('connecting');
    // An explicit choice to connect is never overridden by the probe: the probe
    // is subject to CORS, the WebSocket is not, so a blocked /api/status must
    // not stop live events from arriving.
    let reachable = force || CONFIG.BACKEND_ENABLED || !CONFIG.REQUIRE_API_PROBE;

    if (CONFIG.API_BASE) {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), CONFIG.CONNECT_TIMEOUT_MS);
        const res = await fetch(apiUrl('/status'), {
          signal: controller.signal,
          headers: authHeaders()
        });
        window.clearTimeout(timer);
        if (res.ok) {
          reachable = true;
          handleGuardianEvent({ type: 'status', ...(await res.json()) });
          await loadCameras();
        } else if (res.status === 401 || res.status === 403) {
          console.warn('[guardian] backend rejected the request — set CONFIG.ACCESS_TOKEN '
            + 'or call window.guardian.connect("<token>").');
        }
      } catch {
        console.info('[guardian] /api/status not readable (backend down, or its CORS '
          + 'allow-list does not include this origin). The WebSocket is not subject to '
          + 'CORS, so live events may still arrive.');
      }
    }

    if (!reachable) {
      console.info('[guardian] backend not reachable — demo data source active. '
        + 'Run window.guardian.connect() to retry once your backend is up.');
      setBackendStatus('disconnected');
      return;
    }

    socket = createEventSocket({
      url: wsUrl(),
      onEvent: handleGuardianEvent,
      onStatus: (status) => {
        if (status === 'connected') setBackendStatus('connected');
        else if (status === 'reconnecting' || status === 'connecting') setBackendStatus('reconnecting');
        else setBackendStatus('disconnected');
      }
    });
    socket.connect();
  }

  /**
   * Seed the mesh panel from the backend's camera list. The backend reports
   * activity, not geography, so a camera it has never seen keeps whatever
   * location label the frontend already holds.
   */
  async function loadCameras() {
    try {
      const res = await fetch(apiUrl('/cameras'), { headers: authHeaders() });
      if (!res.ok) return;
      const body = await res.json();
      const known = guardianState.cameras;
      const merged = (body.cameras || []).map((cam) => {
        const id = cam.camera_id || cam.cameraId || cam.id;
        const existing = known.find((c) => c.id === id);
        return {
          id,
          label: existing?.label || cam.label || String(id).toUpperCase().replace('_', ' '),
          // the backend's camera registry knows geography; prefer it when set
          location: cam.location || existing?.location || 'Unassigned',
          ...coordinatesOf(existing),
          ...coordinatesOf(cam),
          status: existing?.status || 'normal',
          people: existing?.people ?? 0,
          score: existing?.score ?? 0,
          online: cam.is_active !== false
        };
      });
      // keep frontend-configured cameras the backend has not seen yet
      const extra = known.filter((c) => !merged.some((m) => m.id === c.id));
      if (merged.length) update({ cameras: merged.concat(extra) });
    } catch {
      /* mesh keeps its configured cameras */
    }
  }

  function disconnect() { socket?.close(); }

  return {
    connect, disconnect, handleGuardianEvent, normalizeEvent, loadCameras,
    get live() { return live; }
  };
}
