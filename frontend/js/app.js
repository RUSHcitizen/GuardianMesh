/**
 * GuardianMesh — application bootstrap.
 *
 * Wires the perception layer (pose engine + camera stage), the reasoning
 * readouts (Guardian Score, timeline), and the operational panels (incidents,
 * mesh, response) to one shared state object, driven by a single animation
 * loop. Data can come from Demo Mode or a live backend; the UI is identical.
 */

import { createCamera } from './camera.js';
import { createDataSource } from './datasource.js';
import { createDemo, seedBaseline } from './demo.js';
import { createIncidentFeed } from './incidents.js';
import { createMeshPanel } from './mesh.js';
import { createPoseEngine } from './pose-engine.js';
import { createResponsePanel } from './response.js';
import { createScorePanel } from './guardian-score.js';
import { createSystemHeader } from './system-header.js';
import { createTimeline } from './timeline.js';
import {
  clearTimeline, guardianState, setAssessment, setTrackedPeople, snapshot,
  subscribe, touched, update
} from './state.js';
import { $, clamp, round } from './util.js';

/* -------------------------------------------------------------------------
   Composition
   ------------------------------------------------------------------------- */

const engine = createPoseEngine();

const camera = createCamera({
  stage: $('#camera-stage'),
  video: $('#guardian-video'),
  sceneCanvas: $('#scene-canvas'),
  overlayCanvas: $('#pose-overlay')
});

const panels = {
  header: createSystemHeader(),
  score: createScorePanel(),
  timeline: createTimeline(),
  incidents: createIncidentFeed(),
  mesh: createMeshPanel(),
  response: createResponsePanel()
};

const dataSource = createDataSource({ engine });
const demo = createDemo({ engine, camera });

/* -------------------------------------------------------------------------
   State → UI routing
   Each renderer runs only when the state it depends on actually changed.
   ------------------------------------------------------------------------- */

subscribe((state, changed) => {
  if (touched(changed, 'systemStatus', 'backendStatus', 'aiEngine', 'latencyMs',
    'cameras', 'incidents', 'trackedPeople', 'dataSource')) {
    panels.header.render(state);
  }
  if (touched(changed, 'guardianScore', 'previousScore', 'confidence', 'eventLabel',
    'eventType', 'focusPersonId', 'motionState', 'immobilitySeconds', 'scoreTrend')) {
    panels.score.sync(state);
  }
  if (touched(changed, 'timeline')) panels.timeline.render(state);
  if (touched(changed, 'incidents')) panels.incidents.render(state);
  if (touched(changed, 'cameras', 'sensors', 'corroboration', 'corroborationResult',
    'handoff', 'activeCamera')) {
    panels.mesh.render(state);
  }
  if (touched(changed, 'responders', 'responseState', 'recommendations')) {
    panels.response.render(state);
  }
  if (touched(changed, 'dataSource', 'backendStatus')) renderDataSourceFlag(state);
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
  const live = state.backendStatus === 'connected';
  flag.dataset.status = live ? 'online' : state.backendStatus === 'reconnecting' ? 'observing' : 'idle';
  label.textContent = live ? 'Live backend' : demo.running ? 'Demo running' : 'Demo data';
}

/* -------------------------------------------------------------------------
   Live perception readouts
   Written straight to the DOM every frame: they change too often to route
   through shared state without thrashing the other panels.
   ------------------------------------------------------------------------- */

const featureEls = {
  vvel: $('#feat-vvel'),
  motion: $('#feat-motion'),
  angle: $('#feat-angle'),
  ground: $('#feat-ground'),
  immobility: $('#feat-immobility')
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
    || people.find((p) => p.status !== 'normal')
    || people[0];

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
  const dropping = f.verticalVelocity < -0.4;
  // avoid rendering "-0.00" when the value is simply at rest
  const vvel = Math.abs(f.verticalVelocity) < 0.005 ? 0 : f.verticalVelocity;
  setFeature(featureEls.vvel, vvel.toFixed(2), 'u/s', dropping ? 'critical' : null);
  setFeature(featureEls.motion, f.motionMagnitude.toFixed(3), '',
    f.motionMagnitude < 0.035 ? 'warning' : null);
  setFeature(featureEls.angle, Math.round(f.bodyAngle).toString(), '°',
    f.bodyAngle > 45 ? 'warning' : null);
  setFeature(featureEls.ground, (f.groundDurationMs / 1000).toFixed(1), 's',
    f.groundDurationMs > 3000 ? 'warning' : null);
  setFeature(featureEls.immobility, (f.timeSinceMovementMs / 1000).toFixed(1), 's',
    f.timeSinceMovementMs > 10000 ? 'critical' : f.timeSinceMovementMs > 4000 ? 'warning' : null);
}

/** Push slower-moving derived values into shared state (throttled). */
let lastSync = 0;
let lastSignature = '';
let lastImmobility = -1;

function syncState(people, now) {
  if (now - lastSync < 240) return;
  lastSync = now;

  const signature = people.map((p) => `${p.trackingId}:${p.status}`).join('|');
  if (signature !== lastSignature) {
    lastSignature = signature;
    setTrackedPeople(people.map((p) => ({
      trackingId: p.trackingId,
      cameraId: p.cameraId,
      status: p.status,
      label: p.label,
      boundingBox: p.boundingBox
    })));
  }

  // "Immobility" is an assessment, not a raw feature: a person standing still
  // is not immobile in the concerning sense, so it is gated on ground level.
  const focus = people.find((p) => p.trackingId === guardianState.focusPersonId);
  const seconds = focus
    ? Math.floor(Math.min(focus.features.timeSinceMovementMs, focus.features.groundDurationMs) / 1000)
    : 0;
  if (seconds !== lastImmobility) {
    lastImmobility = seconds;
    setAssessment({ immobilitySeconds: seconds });
  }
}

/* -------------------------------------------------------------------------
   Single animation loop
   ------------------------------------------------------------------------- */

let previousFrame = performance.now();

function frame(now) {
  const dt = clamp(now - previousFrame, 0, 120);
  previousFrame = now;

  demo.tick(now);
  const people = engine.update(dt);
  camera.render(people, now);
  panels.score.tick(dt);
  renderFeatures(people);
  syncState(people, now);

  window.requestAnimationFrame(frame);
}

/* -------------------------------------------------------------------------
   Controls
   ------------------------------------------------------------------------- */

const btnStart = $('#btn-demo-start');
const btnStep = $('#btn-demo-step');
const btnReset = $('#btn-demo-reset');

btnStart.addEventListener('click', () => {
  if (demo.running) demo.reset();
  else demo.start();
});
btnStep.addEventListener('click', () => demo.next());
btnReset.addEventListener('click', () => {
  panels.score.reset();
  demo.reset();
  lastImmobility = -1;
  lastSignature = '';
});

demo.onStatus((status) => {
  btnStart.textContent = status.running ? 'Restart Demo' : 'Start Demo';
  btnStep.disabled = status.running && status.finished;
  btnStep.title = status.nextStep ? `Next: ${status.nextStep}` : 'Demo complete';
  renderDataSourceFlag(guardianState);
});

$('#btn-timeline-clear').addEventListener('click', () => clearTimeline());

// camera source selection
const sourceButtons = {
  simulated: $('#src-simulated'),
  webcam: $('#src-webcam'),
  file: $('#src-file')
};
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*';
fileInput.hidden = true;
document.body.append(fileInput);

function markSource(mode) {
  for (const [key, btn] of Object.entries(sourceButtons)) {
    btn.setAttribute('aria-pressed', String(key === mode));
  }
}

sourceButtons.simulated.addEventListener('click', () => camera.useSimulated());
sourceButtons.webcam.addEventListener('click', () => camera.useWebcam());
sourceButtons.file.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) camera.useFile(fileInput.files[0]);
});
camera.onChange(({ mode }) => markSource(mode));

// keep the HUD camera label in sync with the active node
subscribe((state, changed) => {
  if (!touched(changed, 'cameras', 'activeCamera')) return;
  const active = state.cameras.find((c) => c.id === state.activeCamera);
  if (!active) return;
  hudCameraId.textContent = active.id;
  hudCameraLoc.textContent = active.location;
});

// keyboard shortcuts for presenting without reaching for the mouse
window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return;
  if (event.key === 'd' || event.key === 'D') demo.start();
  else if (event.key === 'r' || event.key === 'R') btnReset.click();
  else if (event.key === 'n' || event.key === 'N') demo.next();
});

window.addEventListener('resize', () => camera.resize());

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

seedBaseline({ engine, camera });
update({ latencyMs: 38 });
renderAll();
camera.resize();
window.requestAnimationFrame(frame);

// Optional live backend. Failure is expected during offline demos and is
// reported in the header rather than breaking anything.
dataSource.connect();

// Small console surface for debugging during the hackathon.
window.guardian = {
  snapshot, demo, engine, camera, dataSource,
  emit: (payload) => dataSource.handleGuardianEvent(payload),
  score: (v) => update({ previousScore: guardianState.guardianScore, guardianScore: round(v, 1) })
};
window.__GUARDIAN_BOOTED__ = true;
console.info('%c GuardianMesh ', 'background:#55c8ec;color:#071018;font-weight:700',
  'command center ready — press D to start the demo, R to reset, N to step.');
