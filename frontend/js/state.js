/**
 * GuardianMesh — shared application state.
 *
 * One plain object plus a tiny publish/subscribe layer. No state library.
 * Every producer (Demo Mode, WebSocket, REST) mutates state through the
 * action functions below, so the UI is identical regardless of data origin.
 */

import { CONFIG } from './config.js';
import { clamp, clockLabel, round } from './util.js';

/** @type {object} */
export const guardianState = {
  // system
  systemStatus: 'online',          // online | degraded | offline
  backendStatus: 'not_required',   // connected | reconnecting | disconnected | not_required
  dataSource: 'local',             // local | live | demo(dev only)
  aiEngine: 'loading',             // loading | ready | error
  cameraStatus: 'off',             // off | starting | live | denied | error
  modelError: '',
  latencyMs: 0,
  privacyMode: 'anonymous',

  // assessment
  guardianScore: 0,
  previousScore: 0,
  confidence: 0,
  eventLabel: 'None',
  eventType: 'normal',
  focusPersonId: null,
  motionState: 'Normal',
  immobilitySeconds: 0,
  scoreTrend: [],

  // perception
  activeCamera: 'CAM-02',
  trackedPeople: [],               // normalised person records (see data/mock-events.js)
  features: {
    verticalVelocity: 0,
    motionMagnitude: 0,
    bodyAngle: 0,
    groundDurationMs: 0,
    timeSinceMovementMs: 0
  },

  // mesh + incidents + response
  cameras: [],
  sensors: [],
  incidents: [],
  timeline: [],
  responders: [],
  responseState: 'idle',
  recommendations: [],
  corroboration: [],
  corroborationResult: null,
  handoff: null
};

/* ---------------------------------------------------------------------------
   Pub/sub
   --------------------------------------------------------------------------- */

const subscribers = new Set();

/**
 * @param {(state: object, changed: string[]) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Merge a patch into state and notify subscribers with the changed keys. */
export function update(patch) {
  const changed = Object.keys(patch);
  Object.assign(guardianState, patch);
  for (const fn of subscribers) {
    try {
      fn(guardianState, changed);
    } catch (err) {
      console.error('[guardian] subscriber failed', err);
    }
  }
}

/** True when any of `keys` appears in the changed list. */
export const touched = (changed, ...keys) => keys.some((k) => changed.includes(k));

/* ---------------------------------------------------------------------------
   Actions — the single vocabulary shared by Demo Mode and the live backend
   --------------------------------------------------------------------------- */

export function setSystem(patch) {
  update(patch);
}

export function setGuardianScore(score, meta = {}) {
  const next = clamp(Number(score) || 0, 0, 10);
  const trend = guardianState.scoreTrend.concat(next).slice(-CONFIG.TREND_SAMPLES);
  update({
    previousScore: guardianState.guardianScore,
    guardianScore: next,
    scoreTrend: trend,
    ...meta
  });
}

export function setConfidence(confidence01, meta = {}) {
  update({ confidence: clamp(Number(confidence01) || 0, 0, 1), ...meta });
}

export function setAssessment(patch) {
  update(patch);
}

export function setFeatures(features) {
  update({ features: { ...guardianState.features, ...features } });
}

export function setTrackedPeople(people) {
  update({ trackedPeople: people });
}

export function upsertTrackedPerson(person) {
  const people = guardianState.trackedPeople.slice();
  const idx = people.findIndex((p) => p.trackingId === person.trackingId);
  if (idx === -1) people.push(person);
  else people[idx] = { ...people[idx], ...person };
  update({ trackedPeople: people });
}

let timelineSeq = 0;

/**
 * @param {{kind?: string, title: string, facts?: Array<{label:string,value:string}>,
 *          time?: string, timestamp?: string}} event
 */
export function addTimelineEvent(event) {
  const entry = {
    id: event.id || `TL-${String(++timelineSeq).padStart(3, '0')}`,
    kind: event.kind || 'observation',
    title: event.title,
    facts: event.facts || [],
    time: event.time || clockLabel(event.timestamp ? new Date(event.timestamp) : new Date()),
    isNew: true
  };
  const timeline = guardianState.timeline.concat(entry).slice(-CONFIG.TIMELINE_LIMIT);
  update({ timeline });
  return entry;
}

export function clearTimeline() {
  update({ timeline: [] });
}

export function upsertIncident(incident) {
  const incidents = guardianState.incidents.slice();
  const idx = incidents.findIndex((i) => i.id === incident.id);
  if (idx === -1) {
    incidents.unshift({ ...incident, isNew: true });
  } else {
    const previous = incidents[idx];
    incidents[idx] = {
      ...previous,
      ...incident,
      isNew: false,
      didEscalate: incident.status === 'critical' && previous.status !== 'critical'
    };
  }
  update({ incidents });
}

export function clearIncidents() {
  update({ incidents: [] });
}

export function setCameraStatus(cameraId, patch) {
  const cameras = guardianState.cameras.map((cam) =>
    cam.id === cameraId ? { ...cam, ...patch } : cam
  );
  update({ cameras });
}

export function setSensorStatus(sensorId, patch) {
  const sensors = guardianState.sensors.map((s) => (s.id === sensorId ? { ...s, ...patch } : s));
  update({ sensors });
}

export function setResponders(responders) {
  update({ responders });
}

export function setResponderState(responderId, state) {
  const responders = guardianState.responders.map((r) =>
    r.id === responderId ? { ...r, state } : r
  );
  update({ responders });
}

export function setResponseState(responseState, recommendations) {
  update({
    responseState,
    ...(recommendations ? { recommendations } : {})
  });
}

export function setCorroboration(entries, result) {
  update({ corroboration: entries || [], corroborationResult: result || null });
}

export function setHandoff(handoff) {
  update({ handoff: handoff || null });
}

/** Snapshot used for debugging in the console: window.guardian.snapshot() */
export function snapshot() {
  return JSON.parse(
    JSON.stringify({
      ...guardianState,
      guardianScore: round(guardianState.guardianScore, 1),
      trackedPeople: guardianState.trackedPeople.map((p) => ({
        trackingId: p.trackingId,
        cameraId: p.cameraId,
        status: p.status,
        label: p.label,
        boundingBox: p.boundingBox
      }))
    })
  );
}
