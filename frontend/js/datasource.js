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

import { CONFIG, apiUrl, authHeaders, wsUrl } from './config.js';
import { EVENT_LABELS } from '../data/mock-events.js';
import {
  addTimelineEvent, guardianState, setAssessment, setCameraStatus, setConfidence, setCorroboration,
  setGuardianScore, setLeaderboard, setResponseState, update, upsertIncident
} from './state.js';
import { createEventSocket } from './websocket.js';
import { clockLabel } from './util.js';

/**
 * Normalise any backend payload into the canonical Guardian event.
 * Unknown fields are preserved; missing fields get safe defaults.
 */
export function normalizeEvent(raw = {}) {
  const eventType = raw.eventType || raw.type || 'normal';
  return {
    id: raw.id || `EVT-${Date.now()}`,
    timestamp: raw.timestamp || new Date().toISOString(),
    trackingId: raw.trackingId || raw.track_id || null,
    cameraId: raw.cameraId || raw.camera_id || null,
    location: raw.location || '',
    ...coordinatesOf(raw),
    eventType,
    label: raw.label || EVENT_LABELS[eventType] || eventType,
    confidence: clamp01(raw.confidence),
    guardianScore: Number(raw.guardianScore ?? raw.guardian_score ?? 0),
    status: raw.status || 'observing',
    durationMs: Number(raw.durationMs ?? raw.duration_ms ?? 0),
    boundingBox: raw.boundingBox || raw.bounding_box || null,
    keypoints: raw.keypoints || [],
    temporalFeatures: raw.temporalFeatures || raw.temporal_features || null
  };
}

/**
 * Pull a lat/lng pair off a backend payload (incident or camera). Accepts
 * lat/lng, latitude/longitude, or either shape nested under `coordinates`/`geo`.
 * Returns {lat, lng} or {} when no valid pair is present.
 */
export function coordinatesOf(raw) {
  if (!raw || typeof raw !== 'object') return {};
  for (const src of [raw, raw.coordinates, raw.geo]) {
    if (!src || typeof src !== 'object') continue;
    const lat = Number(src.lat ?? src.latitude);
    const lng = Number(src.lng ?? src.lon ?? src.longitude);
    if (src.lat == null && src.latitude == null) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return {};
}

/**
 * GET {API_BASE}/nearby-help for a location. Same backend origin as every
 * other REST call; throws when the backend is unconfigured or unreachable.
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

/** GET {API_BASE}/leaderboard — successful rescues per responder. */
export async function fetchLeaderboard() {
  const res = await fetch(apiUrl('/leaderboard'), { headers: authHeaders() });
  if (!res.ok) throw new Error(`leaderboard request failed: ${res.status}`);
  const data = await res.json();
  setLeaderboard(data);
  return data;
}

/**
 * POST {API_BASE}/rescues. Idempotent server-side per rescue_key + responder,
 * so a retried submission never double-counts.
 */
export async function postRescue(rescue) {
  const res = await fetch(apiUrl('/rescues'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(rescue)
  });
  if (!res.ok) throw new Error(`rescue submission failed: ${res.status}`);
  const data = await res.json();
  setLeaderboard(data.leaderboard);
  return data;
}

/** cam_02, CAM-02 and cam02 all name the same camera. */
const cameraKey = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map a backend camera ID onto the ID the dashboard already uses for that camera. */
function resolveCameraId(id) {
  if (!id) return null;
  const match = guardianState.cameras.find((c) => cameraKey(c.id) === cameraKey(id));
  return match ? match.id : id;
}

/**
 * Backend distress states (backend_server.py compute_score) mapped onto the
 * dashboard vocabulary. Wording stays neutral: it describes a movement
 * pattern, never a conclusion about what happened to a person.
 */
const BACKEND_STATES = {
  NORMAL: { status: 'normal', eventType: 'normal', label: 'Normal motion' },
  POSSIBLE_FALL: { status: 'warning', eventType: 'fall', label: 'Concerning movement pattern' },
  VERIFYING: { status: 'warning', eventType: 'immobility', label: 'Concerning movement pattern - verifying' },
  DISTRESS_EVENT: { status: 'critical', eventType: 'distress', label: 'Attention may be needed' }
};

/**
 * Translate the backend's WebSocket `event` payload into the canonical event.
 * One incident per camera + anonymous track, so repeated detections update a
 * single card (and a single nearby-response lookup) instead of creating new ones.
 */
export function fromBackendEvent(data) {
  if (!data || typeof data !== 'object') return null;
  const mapped = BACKEND_STATES[String(data.state || '').toUpperCase()];
  if (!mapped) return null;

  const cameraId = resolveCameraId(data.cameraId || data.camera_id);
  const personId = Number(data.person_id);
  const trackingId = data.trackingId
    || (Number.isInteger(personId) ? `P-${String(personId + 1).padStart(2, '0')}` : null);
  const camera = guardianState.cameras.find((c) => c.id === cameraId);
  const confidence = data.overall_confidence ?? data.confidence ?? 0;

  return {
    // keypoints / boundingBox / temporalFeatures pass through when the CV client sent them
    keypoints: data.keypoints,
    boundingBox: data.boundingBox,
    temporalFeatures: data.temporalFeatures,
    id: `INC-${cameraId || 'camera'}-${trackingId || 'track'}`,
    timestamp: data.timestamp,
    trackingId,
    cameraId,
    location: data.location || camera?.location || '',
    ...coordinatesOf(data),
    eventType: mapped.eventType,
    label: mapped.label,
    status: mapped.status,
    confidence,
    guardianScore: Number(data.guardianScore ?? Number(confidence) * 10),
    durationMs: Number(data.durationMs ?? Number(data.persistence_seconds || 0) * 1000)
  };
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
    update({
      backendStatus: status,
      dataSource: status === 'connected' ? 'live' : 'demo',
      aiEngine: status === 'connected' ? 'active' : 'active'
    });
    live = status === 'connected';
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

      case 'leaderboard':
        setLeaderboard(payload.data);
        return;

      case 'corroboration':
        setCorroboration(payload.entries || [], payload.result || null);
        return;

      case 'event': {
        // backend_server.py envelope: { type: 'event', data: {...}, timestamp }
        const event = fromBackendEvent(payload.data);
        if (!event) return;
        if (event.eventType === 'normal') resolveIncident(event.id);
        applyEvent(normalizeEvent(event));
        return;
      }

      // Alerts duplicate the event that triggered them (already applied above);
      // their raw text is not shown so dashboard wording stays neutral.
      case 'alert':
      case 'pong':
        return;

      default:
        applyEvent(normalizeEvent(payload));
    }
  }

  /** Mark a live incident resolved once its track returns to normal motion. */
  function resolveIncident(id) {
    const existing = guardianState.incidents.find((i) => i.id === id);
    if (!existing || existing.status === 'resolved') return;
    upsertIncident({ ...existing, status: 'resolved', responseState: 'Resolved' });
    addTimelineEvent({
      kind: 'resolved',
      title: `Movement returned to normal - ${existing.trackingId || 'track'} on ${existing.cameraId || 'camera'}.`
    });
  }

  /** Merge backend camera records (location + coordinates) into the mesh. */
  function mergeCameras(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const cameras = guardianState.cameras.slice();
    for (const raw of list) {
      const id = raw?.id || raw?.camera_id;
      if (!id) continue;
      const coords = coordinatesOf(raw);
      const idx = cameras.findIndex((c) => cameraKey(c.id) === cameraKey(id));
      if (idx >= 0) {
        cameras[idx] = { ...cameras[idx], ...(raw.location ? { location: raw.location } : {}), ...coords };
      } else {
        cameras.push({
          id, label: raw.label || id, location: raw.location || '', status: 'normal',
          people: 0, score: 0, online: Boolean(raw.is_active), ...coords
        });
      }
    }
    update({ cameras });
  }

  async function loadCameras() {
    try {
      const res = await fetch(apiUrl('/cameras'), { headers: authHeaders() });
      if (res.ok) mergeCameras((await res.json()).cameras);
    } catch {
      /* camera coordinates are optional; incidents carry their own */
    }
  }

  /** A perception/classification event: drives score, confidence and incidents. */
  function applyEvent(event) {
    if (event.trackingId) update({ focusPersonId: event.trackingId });
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

    if (event.guardianScore) {
      setGuardianScore(event.guardianScore, {
        eventType: event.eventType,
        eventLabel: event.label,
        focusPersonId: event.trackingId
      });
    }
    if (event.confidence) setConfidence(event.confidence);
    if (event.cameraId) {
      setCameraStatus(resolveCameraId(event.cameraId), { status: event.status, score: event.guardianScore });
    }
    if (event.eventType !== 'normal') {
      setAssessment({ focusPersonId: event.trackingId });
      const incidentId = event.id.startsWith('INC') ? event.id : `INC-${event.id}`;
      const previous = guardianState.incidents.find((i) => i.id === incidentId);
      upsertIncident({
        id: incidentId,
        trackingId: event.trackingId,
        eventType: event.eventType,
        label: event.label,
        cameraId: event.cameraId,
        location: event.location,
        // only when present, so a later update without coordinates keeps them
        ...(event.lat != null ? { lat: event.lat, lng: event.lng } : {}),
        confidence: event.confidence,
        guardianScore: event.guardianScore,
        status: event.status,
        durationSeconds: Math.round(event.durationMs / 1000),
        immobilitySeconds: Math.round((event.temporalFeatures?.groundDurationMs ?? 0) / 1000),
        responseState: event.responseState || 'Monitoring',
        timestamp: clockLabel(new Date(event.timestamp), false)
      });
      // Live detectors emit many events per incident; log only new or changed statuses.
      if (previous && previous.status === event.status) return;
      addTimelineEvent({
        kind: event.status === 'critical' ? 'critical' : 'observation',
        title: `${event.label} — ${event.trackingId || 'unknown track'} on ${event.cameraId || 'unknown camera'}.`,
        facts: [
          { label: 'Confidence', value: `${Math.round(event.confidence * 100)}%` },
          { label: 'Score', value: Number(event.guardianScore).toFixed(1) }
        ]
      });
    }
  }

  /**
   * Probe REST (optional) then open the realtime stream. Never throws.
   * @param {{force?: boolean}} opts force bypasses CONFIG.BACKEND_ENABLED, so
   *        window.guardian.connect() works without editing config.js.
   */
  async function connect({ force = false } = {}) {
    if (!CONFIG.BACKEND_ENABLED && !force) {
      // Stay fully offline: no fetch, no socket, nothing for the browser to log.
      console.info('[guardian] running on demo data (CONFIG.BACKEND_ENABLED is false). '
        + 'Run window.guardian.connect() to attach a live backend.');
      setBackendStatus('disconnected');
      return;
    }

    // A second connect() (e.g. window.guardian.connect()) must not leave the old socket streaming.
    socket?.close();
    socket = null;
    setBackendStatus('connecting');
    let reachable = !CONFIG.REQUIRE_API_PROBE || force;

    if (CONFIG.API_BASE) {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), CONFIG.CONNECT_TIMEOUT_MS);
        const res = await fetch(apiUrl('/status'), { headers: authHeaders(), signal: controller.signal });
        window.clearTimeout(timer);
        if (res.ok) {
          reachable = true;
          handleGuardianEvent({ type: 'status', ...(await res.json()) });
        }
      } catch {
        /* handled below */
      }
    }

    if (!reachable) {
      console.info('[guardian] backend not reachable — demo data source active. '
        + 'Run window.guardian.connect() to retry once your backend is up.');
      setBackendStatus('disconnected');
      return;
    }

    loadCameras();

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

  function disconnect() { socket?.close(); }

  return { connect, disconnect, handleGuardianEvent, normalizeEvent, get live() { return live; } };
}
