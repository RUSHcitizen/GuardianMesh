/**
 * GuardianMesh — application bootstrap.
 *
 * One animation loop drives real browser pose inference, temporal features,
 * state actions, and the existing dashboard renderers. The scripted story is
 * available only at /?dev=simulation.
 */

import { createBrowserPose } from './browser-pose.js';
import { createCamera } from './camera.js';
import { CONFIG } from './config.js';
import { createDataSource } from './datasource.js';
import { createDemo, seedBaseline } from './demo.js';
import { computeGuardianScore, createScorePanel } from './guardian-score.js';
import { createIncidentFeed } from './incidents.js';
import { createLiveDirector } from './live-director.js';
import { createMeshPanel } from './mesh.js';
import { createPoseEngine } from './pose-engine.js';
import { createResponsePanel } from './response.js';
import { createSystemHeader } from './system-header.js';
import { createTimeline } from './timeline.js';
import { RESPONDERS } from '../data/mock-events.js';
import {
  addTimelineEvent, clearIncidents, clearTimeline, guardianState, setAssessment,
  setConfidence, setFeatures, setGuardianScore, setResponders, setResponseState,
  setTrackedPeople, snapshot, subscribe, touched, update, upsertIncident
} from './state.js';
import { $, clamp, clockLabel, round } from './util.js';

const params = new URLSearchParams(window.location.search);
const devSimulation = params.get('dev') === CONFIG.DEV_SIMULATION_QUERY;
const clone = (value) => JSON.parse(JSON.stringify(value));

const engine = createPoseEngine();
const camera = createCamera({
  stage: $('#camera-stage'),
  video: $('#guardian-video'),
  sceneCanvas: $('#scene-canvas'),
  overlayCanvas: $('#pose-overlay')
}, { allowSimulation: devSimulation });

const panels = {
  header: createSystemHeader(), score: createScorePanel(), timeline: createTimeline(),
  incidents: createIncidentFeed(), mesh: createMeshPanel(), response: createResponsePanel()
};
const dataSource = createDataSource({ engine });
const demo = createDemo({ engine, camera });
const liveDirector = createLiveDirector({ camera });

const poseDetector = createBrowserPose({
  video: camera.video,
  engine,
  onStatus(status, detail) {
    update({ aiEngine: status, systemStatus: status === 'error' ? 'degraded' : 'online', modelError: detail || '' });
    if (status === 'error') {
      camera.showStageState('AI model error', detail || 'MediaPipe Pose Landmarker could not load.');
    }
  },
  onInference({ latencyMs }) {
    if (Math.abs(latencyMs - guardianState.latencyMs) >= 1) update({ latencyMs });
  }
});

/* State -> existing UI routing. */
subscribe((state, changed) => {
  if (touched(changed, 'systemStatus', 'backendStatus', 'aiEngine', 'cameraStatus',
    'latencyMs', 'cameras', 'incidents', 'trackedPeople', 'dataSource')) panels.header.render(state);
  if (touched(changed, 'guardianScore', 'previousScore', 'confidence', 'eventLabel',
    'eventType', 'focusPersonId', 'motionState', 'immobilitySeconds', 'scoreTrend')) panels.score.sync(state);
  if (touched(changed, 'timeline')) panels.timeline.render(state);
  if (touched(changed, 'incidents')) panels.incidents.render(state);
  if (touched(changed, 'cameras', 'sensors', 'corroboration', 'corroborationResult',
    'handoff', 'activeCamera')) panels.mesh.render(state);
  if (touched(changed, 'responders', 'responseState', 'recommendations')) panels.response.render(state);
  if (touched(changed, 'dataSource', 'backendStatus', 'aiEngine', 'cameraStatus')) renderDataSourceFlag(state);
});

function renderAll() {
  panels.header.render(guardianState);
  panels.score.sync(guardianState);
  panels.timeline.render(guardianState);
  panels.incidents.render(guardianState);
  panels.mesh.render(guardianState);
  panels.response.render(guardianState);
  renderDataSourceFlag(guardianState);
}

function renderDataSourceFlag(state) {
  const flag = $('#datasource-flag');
  const label = $('#datasource-label');
  if (!flag || !label) return;
  if (state.backendStatus === 'connected') {
    flag.dataset.status = 'online';
    label.textContent = 'Live backend';
  } else if (devSimulation) {
    flag.dataset.status = demo.running ? 'observing' : 'idle';
    label.textContent = demo.running ? 'DEV simulation running' : 'DEV simulation';
  } else if (state.aiEngine === 'error') {
    flag.dataset.status = 'offline';
    label.textContent = 'Local AI error';
  } else if (state.cameraStatus === 'live') {
    flag.dataset.status = 'online';
    label.textContent = 'Local AI · camera live';
  } else {
    flag.dataset.status = state.aiEngine === 'loading' ? 'observing' : 'idle';
    label.textContent = state.aiEngine === 'loading' ? 'Loading local AI' : 'Local AI ready';
  }
}

/* Live feature strip. */
const featureEls = {
  vvel: $('#feat-vvel'), motion: $('#feat-motion'), angle: $('#feat-angle'),
  ground: $('#feat-ground'), immobility: $('#feat-immobility')
};
const hudTracks = $('#hud-tracks');
const hudCameraId = $('#hud-camera-id');
const hudCameraLoc = $('#hud-camera-loc');

function setFeature(node, text, unit, status) {
  if (!node) return;
  node.firstChild.nodeValue = text;
  const unitEl = node.querySelector('.feature__unit');
  if (unitEl && unit) unitEl.textContent = unit;
  if (status) node.dataset.status = status;
  else delete node.dataset.status;
}

function renderFeatures(people) {
  const focus = people.find((p) => p.trackingId === guardianState.focusPersonId)
    || people.find((p) => p.fallState && p.fallState !== 'NORMAL') || people[0];
  if (hudTracks) hudTracks.querySelector('strong').textContent = String(people.length);
  if (!focus) {
    setFeature(featureEls.vvel, '0.00', 'u/s');
    setFeature(featureEls.motion, '0.00');
    setFeature(featureEls.angle, '0', '°');
    setFeature(featureEls.ground, '0.0', 's');
    setFeature(featureEls.immobility, '0.0', 's');
    return;
  }
  const f = focus.features;
  const dropping = f.verticalVelocity < -CONFIG.THRESHOLDS.rapidDropVelocity;
  const vvel = Math.abs(f.verticalVelocity) < 0.005 ? 0 : f.verticalVelocity;
  setFeature(featureEls.vvel, vvel.toFixed(2), 'u/s', dropping ? 'critical' : null);
  setFeature(featureEls.motion, f.motionMagnitude.toFixed(3), '',
    f.motionMagnitude < CONFIG.THRESHOLDS.immobileMotion ? 'warning' : null);
  setFeature(featureEls.angle, Math.round(f.bodyAngle).toString(), '°',
    f.bodyAngle >= CONFIG.THRESHOLDS.torsoHorizontalAngle ? 'warning' : null);
  setFeature(featureEls.ground, (f.groundDurationMs / 1000).toFixed(1), 's',
    f.groundDurationMs >= CONFIG.THRESHOLDS.immobilityTimeMs ? 'warning' : null);
  setFeature(featureEls.immobility, (f.timeSinceMovementMs / 1000).toFixed(1), 's',
    f.timeSinceMovementMs >= CONFIG.THRESHOLDS.distressTimeMs ? 'critical'
      : f.timeSinceMovementMs >= CONFIG.THRESHOLDS.immobilityTimeMs ? 'warning' : null);
}

/* Browser inference -> state actions -> existing subscribers. */
const stateRank = {
  NORMAL: 0, RECOVERY: 1, INSTABILITY: 2, RAPID_DESCENT: 3,
  GROUND: 4, IMMOBILE: 5, POSSIBLE_DISTRESS: 6
};
const incidentByTrack = new Map();
const incidentStartedAt = new Map();
const previousFallState = new Map();
let incidentSeq = 0;
let lastSync = 0;
let lastSignature = '';

function incidentStatus(person) {
  if (person.fallState === 'POSSIBLE_DISTRESS') return 'critical';
  if (person.fallState === 'RECOVERY') return 'resolving';
  return 'warning';
}

function upsertLocalIncident(person, score) {
  let id = incidentByTrack.get(person.trackingId);
  if (!id) {
    id = `INC-LIVE-${String(++incidentSeq).padStart(2, '0')}`;
    incidentByTrack.set(person.trackingId, id);
    incidentStartedAt.set(person.trackingId, Date.now());
  }
  upsertIncident({
    id,
    trackingId: person.trackingId,
    eventType: person.fallState === 'POSSIBLE_DISTRESS' ? 'distress' : 'fall',
    label: person.label,
    cameraId: person.cameraId,
    location: 'Live demo area',
    confidence: person.confidence || 0,
    guardianScore: score,
    status: incidentStatus(person),
    durationSeconds: Math.round((Date.now() - incidentStartedAt.get(person.trackingId)) / 1000),
    immobilitySeconds: Math.floor(Math.min(person.features.groundDurationMs,
      person.features.timeSinceMovementMs) / 1000),
    responseState: person.fallState === 'POSSIBLE_DISTRESS'
      ? 'Human verification recommended'
      : person.fallState === 'RECOVERY' ? 'Recovery observed — monitoring' : 'Verifying fall pattern',
    timestamp: clockLabel(new Date(incidentStartedAt.get(person.trackingId)), false)
  });
}

function handleFallTransition(person, previous, score) {
  const facts = [
    { label: 'Track', value: person.trackingId },
    { label: 'Score', value: score.toFixed(1) }
  ];
  if (previous === undefined) {
    addTimelineEvent({
      kind: 'observation',
      title: `${person.trackingId} established — anonymous body tracking active.`,
      facts
    });
    return;
  }
  const entries = {
    RAPID_DESCENT: ['warning', 'Rapid downward movement detected.'],
    GROUND: ['warning', 'Possible fall detected — person reached a horizontal ground-level posture.'],
    IMMOBILE: ['inference', 'Person remains on ground with low movement.'],
    POSSIBLE_DISTRESS: ['critical', 'Possible collapse / distress — sustained immobility after a fall.'],
    RECOVERY: ['resolved', 'Recovery movement detected — person is rising from the ground.']
  };
  const entry = entries[person.fallState];
  if (entry) addTimelineEvent({ kind: entry[0], title: entry[1], facts });

  if (person.fallState === 'NORMAL' && incidentByTrack.has(person.trackingId)) {
    const id = incidentByTrack.get(person.trackingId);
    upsertIncident({
      id, status: 'resolved', label: 'Possible fall — resolved after recovery',
      guardianScore: score, confidence: 0, immobilitySeconds: 0,
      responseState: 'Event resolved — returned to normal posture'
    });
    addTimelineEvent({ kind: 'resolved', title: `${person.trackingId} returned to normal upright movement.`, facts });
    incidentByTrack.delete(person.trackingId);
    incidentStartedAt.delete(person.trackingId);
  }
}

function updateLocalCamera(people, status, score) {
  const cameras = guardianState.cameras.map((entry) => entry.id === 'CAM-LIVE'
    ? { ...entry, people, status, score, online: guardianState.cameraStatus === 'live' }
    : entry);
  update({ cameras });
}

function syncState(people, now) {
  if (now - lastSync < 160) return;
  lastSync = now;
  const signature = people.map((p) => `${p.trackingId}:${p.fallState || p.status}`).join('|');
  if (signature !== lastSignature) {
    lastSignature = signature;
    setTrackedPeople(people.map((p) => ({
      trackingId: p.trackingId, cameraId: p.cameraId, status: p.status,
      label: p.label, boundingBox: p.boundingBox
    })));
  }
  if (guardianState.dataSource !== 'local') return;

  const scored = people.map((person) => {
    const score = computeGuardianScore(person.features, person.fallState);
    person.score = score;
    engine.setMeta(person.trackingId, { score });
    const previous = previousFallState.get(person.trackingId);
    if (previous !== person.fallState) handleFallTransition(person, previous, score);
    previousFallState.set(person.trackingId, person.fallState);
    if (['GROUND', 'IMMOBILE', 'POSSIBLE_DISTRESS', 'RECOVERY'].includes(person.fallState)) {
      upsertLocalIncident(person, score);
    }
    return { person, score };
  });

  const current = scored.find(({ person }) => person.trackingId === guardianState.focusPersonId);
  const strongest = scored.slice().sort((a, b) =>
    (stateRank[b.person.fallState] - stateRank[a.person.fallState]) || b.score - a.score)[0];
  const focus = current && stateRank[current.person.fallState] >= stateRank.GROUND
    && (!strongest || current.score >= strongest.score - 1) ? current : strongest;
  const activeIncident = guardianState.incidents.some((incident) => incident.status !== 'resolved');

  if (!focus) {
    if (!activeIncident && guardianState.guardianScore !== 0) {
      setGuardianScore(0, { eventType: 'normal', eventLabel: 'No person detected', focusPersonId: null });
      setConfidence(0);
      setAssessment({ motionState: 'No person', immobilitySeconds: 0 });
    }
    updateLocalCamera(0, activeIncident ? 'observing' : 'normal', guardianState.guardianScore);
    return;
  }

  const { person, score } = focus;
  const immobilitySeconds = Math.floor(Math.min(person.features.groundDurationMs,
    person.features.timeSinceMovementMs) / 1000);
  if (Math.abs(score - guardianState.guardianScore) >= 0.1
    || guardianState.focusPersonId !== person.trackingId
    || guardianState.eventLabel !== person.label) {
    setGuardianScore(score, {
      eventType: person.fallState === 'NORMAL' ? 'normal'
        : person.fallState === 'POSSIBLE_DISTRESS' ? 'distress' : 'fall',
      eventLabel: person.label,
      focusPersonId: person.trackingId
    });
  }
  if (Math.abs((person.confidence || 0) - guardianState.confidence) >= 0.01) {
    setConfidence(person.confidence || 0);
  }
  setFeatures(person.features);
  setAssessment({
    motionState: person.features.motionMagnitude <= CONFIG.THRESHOLDS.immobileMotion ? 'Minimal' : 'Active',
    immobilitySeconds
  });
  updateLocalCamera(people.length, person.status, score);
  camera.setStatus(person.status);
}

/* The application's only animation loop. */
let previousFrame = performance.now();
function frame(now) {
  const dt = clamp(now - previousFrame, 0, 120);
  previousFrame = now;
  if (devSimulation) demo.tick(now);
  if (!devSimulation && guardianState.cameraStatus === 'live') poseDetector.processFrame(now);
  const people = engine.update(dt);
  syncState(people, now);
  camera.render(people, now);
  panels.score.tick(dt);
  renderFeatures(people);
  window.requestAnimationFrame(frame);
}

/* Controls. */
const btnStart = $('#btn-demo-start');
const btnStep = $('#btn-demo-step');
const btnReset = $('#btn-demo-reset');
const sourceButtons = {
  simulated: $('#src-simulated'), webcam: $('#src-webcam'), file: $('#src-file')
};
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*';
fileInput.hidden = true;
document.body.append(fileInput);

function markSource(mode) {
  for (const [key, btn] of Object.entries(sourceButtons)) {
    btn?.setAttribute('aria-pressed', String(key === mode));
  }
}

function clearLocalAssessment({ stopCamera = false } = {}) {
  if (stopCamera) camera.useOff();
  poseDetector.reset();
  engine.reset();
  incidentByTrack.clear();
  incidentStartedAt.clear();
  previousFallState.clear();
  incidentSeq = 0;
  lastSignature = '';
  clearIncidents();
  clearTimeline();
  panels.score.reset();
  setResponders(clone(RESPONDERS));
  setResponseState('idle', []);
  update({
    trackedPeople: [], guardianScore: 0, previousScore: 0, scoreTrend: [], confidence: 0,
    eventType: 'normal', eventLabel: 'No person detected', focusPersonId: null,
    motionState: 'No person', immobilitySeconds: 0,
    cameras: [{
      id: 'CAM-LIVE', label: 'CAM LIVE', location: 'Live demo area', status: 'normal',
      people: 0, score: 0, online: camera.status === 'live', primary: true
    }],
    sensors: [], corroboration: [], corroborationResult: null, handoff: null,
    activeCamera: 'CAM-LIVE'
  });
  camera.setStatus(stopCamera ? 'offline' : 'normal', stopCamera ? 'Camera off' : 'Normal');
}

async function startLiveCamera() {
  if (camera.status === 'live' && camera.mode === 'webcam') {
    clearLocalAssessment({ stopCamera: true });
    return;
  }
  btnStart.disabled = true;
  update({ dataSource: 'local', backendStatus: 'not_required', cameraStatus: 'starting' });
  const modelReady = await poseDetector.initialize();
  if (!modelReady) {
    btnStart.disabled = false;
    return;
  }
  const cameraReady = await camera.useWebcam();
  btnStart.disabled = false;
  if (cameraReady) {
    clearLocalAssessment();
    update({ cameraStatus: 'live', aiEngine: 'ready', systemStatus: 'online' });
    addTimelineEvent({
      kind: 'system',
      title: 'Live camera active — MediaPipe pose inference is running locally in this browser.',
      facts: [{ label: 'Privacy', value: 'Frames stay on device' }]
    });
  }
}

btnStart.addEventListener('click', () => {
  if (devSimulation) {
    if (demo.running) demo.reset();
    else demo.start();
  } else startLiveCamera();
});
btnStep.addEventListener('click', () => demo.next());
btnReset.addEventListener('click', () => {
  liveDirector.reset();
  if (devSimulation) {
    panels.score.reset();
    demo.reset();
  } else clearLocalAssessment({ stopCamera: true });
});

demo.onStatus((status) => {
  if (!devSimulation) return;
  btnStart.textContent = status.running ? 'Restart DEV Simulation' : 'Start DEV Simulation';
  btnStep.disabled = status.running && status.finished;
  btnStep.title = status.nextStep ? `Next: ${status.nextStep}` : 'Simulation complete';
  renderDataSourceFlag(guardianState);
});

sourceButtons.simulated.hidden = !devSimulation;
btnStep.hidden = !devSimulation;
sourceButtons.simulated.addEventListener('click', () => camera.useSimulated());
sourceButtons.webcam.addEventListener('click', () => startLiveCamera());
sourceButtons.file.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  if (!fileInput.files?.[0]) return;
  update({ dataSource: 'local', backendStatus: 'not_required', cameraStatus: 'starting' });
  if (!await poseDetector.initialize()) return;
  poseDetector.reset();
  engine.reset();
  camera.useFile(fileInput.files[0]);
});
camera.onChange(({ mode, status }) => {
  markSource(mode);
  update({ cameraStatus: status });
  btnStart.textContent = !devSimulation && status === 'live' && mode === 'webcam'
    ? 'Stop Camera' : devSimulation ? btnStart.textContent : 'Start Live Camera';
});

$('#btn-timeline-clear').addEventListener('click', () => clearTimeline());
subscribe((state, changed) => {
  if (!touched(changed, 'cameras', 'activeCamera')) return;
  const active = state.cameras.find((entry) => entry.id === state.activeCamera);
  if (!active) return;
  hudCameraId.textContent = active.id;
  hudCameraLoc.textContent = active.location;
});
window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (event.key === 'd' || event.key === 'D') {
    if (devSimulation) demo.start();
    else startLiveCamera();
  } else if (event.key === 'r' || event.key === 'R') btnReset.click();
  else if (devSimulation && (event.key === 'n' || event.key === 'N')) demo.next();
});
window.addEventListener('resize', () => camera.resize());

/* Boot. */
if (devSimulation) {
  seedBaseline({ engine, camera });
  camera.useSimulated();
  update({ dataSource: 'demo', backendStatus: 'not_required', aiEngine: 'ready', cameraStatus: 'live' });
} else {
  update({
    systemStatus: 'online', backendStatus: 'not_required', dataSource: 'local',
    aiEngine: 'loading', cameraStatus: 'off', latencyMs: 0
  });
  clearLocalAssessment({ stopCamera: true });
}
renderAll();
camera.resize();
window.requestAnimationFrame(frame);
if (!devSimulation) poseDetector.initialize();
if (params.has('live')) dataSource.connect({ force: true, token: params.get('token') || undefined });

window.guardian = {
  snapshot, demo, engine, camera, poseDetector, dataSource,
  emit: (payload) => dataSource.handleGuardianEvent(payload),
  score: (value) => update({ previousScore: guardianState.guardianScore, guardianScore: round(value, 1) }),
  connect: (token) => dataSource.connect({ force: true, token }),
  disconnect: () => dataSource.disconnect(),
  startCamera: startLiveCamera
};
window.__GUARDIAN_BOOTED__ = true;
console.info('%c GuardianMesh ', 'background:#55c8ec;color:#071018;font-weight:700',
  devSimulation ? 'DEV simulation enabled explicitly via ?dev=simulation.'
    : 'local pose model loading — press Start Live Camera when ready.');
