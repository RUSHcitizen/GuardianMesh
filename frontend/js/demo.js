/**
 * GuardianMesh — Demo Mode controller.
 *
 * A deterministic, backend-independent incident story. Every step is a pure
 * function of elapsed time, driven from the single animation loop in app.js,
 * so there are no stray timers to leak and RESET always returns the interface
 * to a known state.
 *
 * Narrative (the 30-second pitch):
 *   normal motion → rapid vertical displacement → orientation change →
 *   ground-level pose → low motion → prolonged immobility → confidence and
 *   Guardian Score rise → critical distress pattern → incident → mesh
 *   corroboration → simulated response → movement resumed → resolved.
 */

import {
  BASELINE_PEOPLE, CAMERAS, CORROBORATION, HANDOFF, INCIDENT_TEMPLATE,
  RECOMMENDATIONS, RESPONDERS, SENSORS, SUBJECT
} from '../data/mock-events.js';
import {
  addTimelineEvent, clearIncidents, clearTimeline, guardianState, setAssessment,
  setConfidence, setCorroboration, setGuardianScore, setHandoff, setResponders,
  setResponderState, setResponseState, setCameraStatus, setSensorStatus,
  setTrackedPeople, update, upsertIncident
} from './state.js';
import { clockLabel } from './util.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Reset mesh, responders and people to the baseline "all clear" posture. */
export function seedBaseline(ctx) {
  const { engine, camera } = ctx;

  engine.reset();
  for (const person of BASELINE_PEOPLE) engine.addTrack(person);
  engine.addTrack(SUBJECT);
  engine.setMeta(SUBJECT.trackingId, {
    status: 'normal', label: 'Normal motion', confidence: null, score: null
  });

  update({
    cameras: clone(CAMERAS),
    sensors: clone(SENSORS),
    responders: clone(RESPONDERS),
    incidents: [],
    timeline: [],
    corroboration: [],
    corroborationResult: null,
    handoff: null,
    recommendations: [],
    responseState: 'idle',
    guardianScore: 1.1,
    previousScore: 1.1,
    scoreTrend: [1.1],
    confidence: 0,
    eventType: 'normal',
    eventLabel: 'Normal motion',
    focusPersonId: null,
    motionState: 'Normal',
    immobilitySeconds: 0,
    activeCamera: 'CAM-02'
  });

  camera?.setStatus('normal');
  setCameraBadge('normal', 'Normal');
}

function setCameraBadge(status, label) {
  const badge = document.getElementById('camera-badge');
  if (!badge) return;
  badge.dataset.status = status;
  badge.textContent = label;
}

function fact(label, value) { return { label, value }; }

/** Live immobility duration (seconds) derived by the pose engine, so every
 *  figure the demo prints matches what the feature strip is actually showing. */
const imm = () => Math.max(0, Math.round(guardianState.immobilitySeconds));

export function createDemo(ctx) {
  const { engine, camera } = ctx;
  const subjectId = SUBJECT.trackingId;

  const meta = (patch) => engine.setMeta(subjectId, patch);
  const body = (state, ms) => engine.setBodyState(subjectId, state, ms);

  // Merge over whatever the incident already is, so a partial update (e.g. just
  // a response state) never silently reverts status, label or event type.
  const incident = (patch) => {
    const existing = guardianState.incidents.find((i) => i.id === INCIDENT_TEMPLATE.id);
    const base = existing || INCIDENT_TEMPLATE;
    upsertIncident({
      ...base,
      ...patch,
      id: INCIDENT_TEMPLATE.id,
      timestamp: existing?.timestamp || patch.timestamp || clockLabel(new Date(), false)
    });
  };

  /* ---------------------------------------------------------------------- */
  /* The script. `at` is milliseconds from START DEMO.                       */
  /* ---------------------------------------------------------------------- */

  const steps = [
    {
      at: 0,
      name: 'System normal',
      run() {
        seedBaseline(ctx);
        setGuardianScore(1.1, { eventLabel: 'Normal motion', eventType: 'normal' });
        addTimelineEvent({
          kind: 'system',
          title: 'GuardianMesh online — 4 camera nodes, 2 sensor nodes. Anonymous pose tracking active.',
          facts: [fact('Privacy', 'Identity not required')]
        });
      }
    },
    {
      at: 2000,
      name: 'Track established',
      run() {
        meta({ status: 'tracking', label: 'Normal motion' });
        setAssessment({ focusPersonId: subjectId });
        setGuardianScore(1.2);
        setCameraStatus('CAM-02', { people: 1 });
        addTimelineEvent({
          kind: 'observation',
          title: 'Anonymous track P-02 established on CAM-02 — normal gait, upright posture.',
          facts: [fact('Track', 'P-02'), fact('Camera', 'CAM-02')]
        });
      }
    },
    {
      at: 3200,
      name: 'Movement anomaly',
      run() {
        body('stumble', 420);
        meta({ status: 'observing', label: 'Motion anomaly', confidence: 0.28 });
        setGuardianScore(2.8, { eventType: 'rapid_displacement', eventLabel: 'Rapid vertical displacement' });
        setConfidence(0.28);
        setCameraStatus('CAM-02', { status: 'observing', score: 2.8 });
        camera.setStatus('observing');
        setCameraBadge('observing', 'Observing');
        addTimelineEvent({
          kind: 'observation',
          title: 'Rapid vertical displacement detected — abrupt change in movement pattern.',
          facts: [fact('Vertical velocity', '-0.82 u/s'), fact('Confidence', '28%')]
        });
      }
    },
    {
      at: 4400,
      name: 'Orientation change',
      run() {
        body('falling', 520);
        meta({ label: 'Pose anomaly', confidence: 0.42, score: 3.7 });
        setGuardianScore(3.7, { eventType: 'pose_anomaly', eventLabel: 'Pose anomaly' });
        setConfidence(0.42);
        addTimelineEvent({
          kind: 'inference',
          title: 'Torso orientation changed 71° from vertical — body no longer upright.',
          facts: [fact('Body angle', '71°'), fact('Confidence', '42%')]
        });
      }
    },
    {
      at: 5600,
      name: 'Ground-level pose',
      run() {
        body('ground', 560);
        meta({ status: 'warning', label: 'Movement anomaly', confidence: 0.61, score: 4.6 });
        setGuardianScore(4.6, { eventType: 'fall', eventLabel: 'Movement anomaly' });
        setConfidence(0.61);
        setCameraStatus('CAM-02', { status: 'warning', score: 4.6 });
        setCameraBadge('warning', 'Elevated');
        incident({
          status: 'elevated',
          label: 'Movement anomaly — pattern under observation',
          eventType: 'fall',
          confidence: 0.61,
          guardianScore: 4.6,
          immobilitySeconds: 0,
          responseState: 'Monitoring — no responder dispatched'
        });
        setResponseState('received', RECOMMENDATIONS.elevated);
        addTimelineEvent({
          kind: 'warning',
          title: 'Ground-level pose detected — person has reached floor level.',
          facts: [fact('Event', 'Movement anomaly'), fact('Confidence', '61%'), fact('Score', '4.6')]
        });
      }
    },
    {
      at: 7200,
      name: 'Low motion',
      run() {
        body('ground_still', 900);
        meta({ confidence: 0.66, score: 5.8 });
        setGuardianScore(5.8);
        setConfidence(0.66);
        setAssessment({ motionState: 'Minimal' });
        addTimelineEvent({
          kind: 'observation',
          title: 'Movement dropped below threshold — motion magnitude minimal.',
          facts: [fact('Motion', '0.02'), fact('Score', '5.8')]
        });
      }
    },
    {
      at: 10200,
      name: 'Low motion persists',
      run() {
        meta({ confidence: 0.72, score: 6.5 });
        setGuardianScore(6.5);
        setConfidence(0.72);
        incident({
          status: 'warning',
          label: 'Movement anomaly — person remaining on the ground',
          confidence: 0.72,
          guardianScore: 6.5,
          immobilitySeconds: imm(),
          responseState: 'Monitoring — gathering temporal evidence'
        });
        addTimelineEvent({
          kind: 'inference',
          title: `Low motion sustained for ${imm()} s — person remaining on the ground.`,
          facts: [fact('Immobility', `${imm()} s`), fact('Confidence', '72%'), fact('Score', '6.5')]
        });
      }
    },
    {
      at: 14200,
      name: 'Prolonged immobility',
      run() {
        meta({ confidence: 0.84, score: 7.6 });
        setGuardianScore(7.6, { eventType: 'immobility', eventLabel: 'Prolonged immobility' });
        setConfidence(0.84);
        setCameraStatus('CAM-03', { status: 'observing' });
        setSensorStatus('SEN-01', { status: 'observing' });
        setCorroboration([CORROBORATION.entries[0]], null);
        incident({
          status: 'warning',
          label: 'Prolonged immobility after ground-level pose',
          eventType: 'immobility',
          confidence: 0.84,
          guardianScore: 7.6,
          immobilitySeconds: imm(),
          responseState: 'Responder review suggested'
        });
        addTimelineEvent({
          kind: 'warning',
          title: `Prolonged immobility detected — ${imm()} s with no meaningful movement.`,
          facts: [fact('Immobility', `${imm()} s`), fact('Confidence', '84%'), fact('Score', '7.6')]
        });
      }
    },

    /* ----- critical moment, deliberately staggered ------------------------ */
    {
      at: 18000,
      name: 'Critical — tracking state',
      run() {
        meta({ status: 'critical', label: 'Possible distress pattern', confidence: 0.94, score: 8.7 });
        camera.setStatus('critical');
        camera.pulseCritical();
        setCameraBadge('critical', 'Critical');
      }
    },
    {
      at: 18180,
      name: 'Critical — score',
      run() {
        setGuardianScore(8.7, { eventType: 'distress', eventLabel: 'Possible distress pattern' });
        setConfidence(0.94);
      }
    },
    {
      at: 18360,
      name: 'Critical — timeline',
      run() {
        addTimelineEvent({
          kind: 'critical',
          title: 'Concerning pattern detected — sustained immobility following a ground-level pose.',
          facts: [fact('Confidence', '94%'), fact('Immobility', `${imm()} s`)]
        });
        addTimelineEvent({
          kind: 'critical',
          title: 'Guardian Score → 8.7 (Critical).',
          facts: [fact('Previous', '7.6'), fact('Band', 'Critical')]
        });
      }
    },
    {
      at: 18540,
      name: 'Critical — incident',
      run() {
        incident({
          status: 'critical',
          label: 'Movement anomaly / distress pattern',
          eventType: 'distress',
          confidence: 0.94,
          guardianScore: 8.7,
          immobilitySeconds: imm(),
          durationSeconds: imm(),
          responseState: 'Responder recommended'
        });
      }
    },
    {
      at: 18760,
      name: 'Critical — mesh corroboration',
      run() {
        setCameraStatus('CAM-02', { status: 'critical', score: 8.7 });
        setCameraStatus('CAM-03', { status: 'warning' });
        setCorroboration(CORROBORATION.entries, CORROBORATION.result);
        setHandoff(HANDOFF);
        addTimelineEvent({
          kind: 'inference',
          title: 'Event corroborated across mesh nodes — CAM-02, CAM-03 and motion sensor agree.',
          facts: [fact('Correlated confidence', '94%'), fact('Correlated score', '8.9')]
        });
      }
    },
    {
      at: 19000,
      name: 'Critical — response activated',
      run() {
        setResponseState('notified', RECOMMENDATIONS.critical);
        setResponderState('RSP-SEC', 'notified');
        setResponderState('RSP-AID', 'notified');
        setResponderState('RSP-DES', 'notified');
        addTimelineEvent({
          kind: 'response',
          title: 'Response workflow activated — security, first aid and designated responder notified (simulated).',
          facts: [fact('Incident', 'INC-001'), fact('Mode', 'Simulated')]
        });
      }
    },
    {
      at: 22000,
      name: 'Acknowledged',
      run() {
        setResponseState('acknowledged');
        setResponderState('RSP-SEC', 'acknowledged');
        setResponderState('RSP-AID', 'acknowledged');
        incident({
          status: 'critical',
          label: 'Movement anomaly / distress pattern',
          confidence: 0.94,
          guardianScore: 8.7,
          immobilitySeconds: imm(),
          responseState: 'Responder acknowledged'
        });
        addTimelineEvent({
          kind: 'response',
          title: 'Security desk acknowledged the incident (simulated).',
          facts: [fact('Response', 'Acknowledged')]
        });
      }
    },
    {
      at: 24500,
      name: 'En route',
      run() {
        setResponseState('en_route');
        setResponderState('RSP-SEC', 'en_route');
        setResponderState('RSP-AID', 'en_route');
        incident({ responseState: 'Responder en route', immobilitySeconds: imm() });
        addTimelineEvent({
          kind: 'response',
          title: 'Responder en route to Main Corridor (simulated dispatch).',
          facts: [fact('Response', 'En route')]
        });
      }
    },

    /* ----- de-escalation --------------------------------------------------- */
    {
      at: 27500,
      name: 'Movement resumed',
      run() {
        body('recovering', 900);
        meta({ status: 'warning', label: 'Movement resumed', confidence: 0.7, score: 6.0 });
        setGuardianScore(6.0, { eventLabel: 'Movement resumed', eventType: 'immobility' });
        setConfidence(0.7);
        setAssessment({ motionState: 'Resuming' });
        camera.setStatus('observing');
        setCameraBadge('warning', 'Elevated');
        setCameraStatus('CAM-02', { status: 'warning', score: 6.0 });
        incident({
          status: 'resolving',
          label: 'Movement resumed — concern decreasing',
          confidence: 0.7,
          guardianScore: 6.0,
          immobilitySeconds: 0,
          responseState: 'Responder on site — monitoring'
        });
        addTimelineEvent({
          kind: 'observation',
          title: 'Movement resumed — motion magnitude rising, person self-repositioning.',
          facts: [fact('Motion', 'Increasing'), fact('Score', '8.7 → 6.0')]
        });
      }
    },
    {
      at: 30000,
      name: 'Concern decreasing',
      run() {
        body('seated', 900);
        meta({ status: 'observing', label: 'Recovering', confidence: 0.5, score: 3.3 });
        setGuardianScore(3.3);
        setConfidence(0.5);
        setCameraStatus('CAM-02', { status: 'observing', score: 3.3 });
        setCameraStatus('CAM-03', { status: 'normal' });
        setSensorStatus('SEN-01', { status: 'normal' });
        incident({ guardianScore: 3.3, confidence: 0.5, responseState: 'Person responsive — monitoring' });
        addTimelineEvent({
          kind: 'inference',
          title: 'Sustained voluntary movement — distress indicators decaying.',
          facts: [fact('Score', '6.0 → 3.3'), fact('Band', 'Elevated')]
        });
      }
    },
    {
      at: 32500,
      name: 'Event resolved',
      run() {
        body('standing', 1000);
        meta({ status: 'normal', label: 'Normal motion', confidence: null, score: null });
        setGuardianScore(1.8, { eventType: 'normal', eventLabel: 'Normal motion' });
        setConfidence(0);
        setAssessment({ motionState: 'Normal' });
        camera.setStatus('normal');
        setCameraBadge('normal', 'Normal');
        setCameraStatus('CAM-02', { status: 'normal', score: 1.8 });
        incident({
          status: 'resolved',
          label: 'Movement anomaly / distress pattern — resolved',
          guardianScore: 1.8,
          confidence: 0,
          responseState: 'Event resolved — no further action'
        });
        setResponseState('resolved', ['Incident archived — no further action required']);
        for (const r of RESPONDERS) setResponderState(r.id, 'resolved');
        setCorroboration(CORROBORATION.entries, {
          ...CORROBORATION.result,
          label: 'Correlated event resolved',
          status: 'resolved'
        });
        addTimelineEvent({
          kind: 'resolved',
          title: 'Event resolved — Guardian Score returning to baseline.',
          facts: [fact('Score', '3.3 → 1.8'), fact('Status', 'Resolved')]
        });
      }
    },
    {
      at: 35000,
      name: 'Monitoring resumed',
      run() {
        setGuardianScore(1.1);
        addTimelineEvent({
          kind: 'system',
          title: 'Monitoring resumed — all mesh nodes clear.',
          facts: [fact('Nodes', '6 / 6 online')]
        });
      }
    }
  ];

  /* ---------------------------------------------------------------------- */

  let running = false;
  let startedAt = 0;
  let cursor = 0;
  const listeners = new Set();

  const notify = () => listeners.forEach((fn) => fn(status()));

  function status() {
    return {
      running,
      finished: cursor >= steps.length,
      stepIndex: cursor,
      stepCount: steps.length,
      nextStep: steps[cursor]?.name ?? null
    };
  }

  function start() {
    reset();
    running = true;
    startedAt = performance.now();
    cursor = 0;
    notify();
  }

  /** Jump the clock forward so the next scripted step fires immediately. */
  function next() {
    if (!running) {
      start();
      return;
    }
    const step = steps[cursor];
    if (!step) return;
    startedAt = performance.now() - step.at;
  }

  function reset() {
    running = false;
    cursor = 0;
    startedAt = 0;
    seedBaseline(ctx);
    clearIncidents();
    clearTimeline();
    setResponders(clone(RESPONDERS));
    setResponseState('idle', []);
    setCorroboration([], null);
    setHandoff(null);
    camera.setStatus('normal');
    setCameraBadge('normal', 'Normal');
    notify();
  }

  /** Driven from the app's single animation loop. */
  function tick(now) {
    if (!running) return;
    const elapsed = now - startedAt;
    let fired = false;
    while (cursor < steps.length && steps[cursor].at <= elapsed) {
      try {
        steps[cursor].run();
      } catch (err) {
        console.error('[guardian] demo step failed:', steps[cursor].name, err);
      }
      cursor += 1;
      fired = true;
    }
    if (cursor >= steps.length) {
      running = false;
      fired = true;
    }
    if (fired) notify();
  }

  function onStatus(fn) { listeners.add(fn); fn(status()); return () => listeners.delete(fn); }

  return { start, next, reset, tick, onStatus, status, get running() { return running; } };
}

export { guardianState };








