/**
 * Behaviour table for the activity classifier and the fall states it gates.
 *
 * Each case is an ordinary thing a person does that produces fall-shaped
 * signals — a descent, a low body, a horizontal posture, or stillness. The
 * point of every assertion is that GuardianMesh does NOT open an incident for
 * it, while still opening one for the real thing.
 */

import assert from 'node:assert/strict';
import { ACTIVITIES, classifyPosture, createActivityMonitor } from '../frontend/js/activity.js';
import { createFallDetector, FALL_STATES } from '../frontend/js/fall-detector.js';
import { computeGuardianScore } from '../frontend/js/guardian-score.js';
import { CONFIG } from '../frontend/js/config.js';

/** An upright person, standing still, nothing happening. */
const base = {
  verticalVelocity: 0,
  descentDistance: 0,
  descentPeakSpeed: 0,
  bodyAngle: 5,
  boundingBoxRatio: 0.35,
  centerY: 0.45,
  boundingBoxBottom: 0.88,
  motionMagnitude: 0.02,
  groundDurationMs: 0,
  timeSinceMovementMs: 0,
  armMotion: 0.01,
  legMotion: 0.01,
  torsoMotion: 0.01,
  feetTravel: 0.005,
  kneeFlexion: 175,
  hipToAnkleSpan: 0.5,
  bodyScale: 0.5
};

const POSTURES = {
  /** Hands busy at a counter or sink; torso and feet parked. */
  stationaryTask: {
    armMotion: 0.14, legMotion: 0.01, torsoMotion: 0.012, feetTravel: 0.004,
    motionMagnitude: 0.05
  },
  /** Bent at the waist to pick something up: legs straight, feet planted. */
  reachingDown: {
    bodyAngle: 62, descentDistance: 0.14, descentPeakSpeed: 0.3,
    centerY: 0.58, boundingBoxBottom: 0.9, boundingBoxRatio: 0.7,
    kneeFlexion: 162, hipToAnkleSpan: 0.42, feetTravel: 0.01, motionMagnitude: 0.07
  },
  /** Down on the haunches at a low shelf: torso upright over folded legs. */
  crouching: {
    bodyAngle: 16, descentDistance: 0.16, descentPeakSpeed: 0.32,
    centerY: 0.62, boundingBoxBottom: 0.93, boundingBoxRatio: 0.62,
    kneeFlexion: 55, hipToAnkleSpan: 0.12, feetTravel: 0.012, motionMagnitude: 0.05
  },
  /** Sitting down: mid-height, torso upright, legs folded and still. */
  sitting: {
    bodyAngle: 12, descentDistance: 0.18, descentPeakSpeed: 0.3,
    centerY: 0.6, boundingBoxBottom: 0.92, boundingBoxRatio: 0.6,
    kneeFlexion: 95, hipToAnkleSpan: 0.28, legMotion: 0.01, motionMagnitude: 0.02
  },
  /** Lying down on purpose: horizontal on the floor, but lowered gently. */
  lyingSettled: {
    bodyAngle: 78, boundingBoxRatio: 2.2, centerY: 0.84, boundingBoxBottom: 0.97,
    descentDistance: 0.34, descentPeakSpeed: 0.28, hipToAnkleSpan: 0.04,
    kneeFlexion: 168, motionMagnitude: 0.02
  },
  /** The real thing: same end posture, reached fast. */
  lyingSudden: {
    bodyAngle: 80, boundingBoxRatio: 2.3, centerY: 0.85, boundingBoxBottom: 0.98,
    descentDistance: 0.36, descentPeakSpeed: 1.5, hipToAnkleSpan: 0.04,
    kneeFlexion: 170, motionMagnitude: 0.02
  }
};

const featuresFor = (name, extra = {}) => ({ ...base, ...POSTURES[name], ...extra });

/* ---- 1. Each posture classifies as itself ------------------------------- */

const expectations = [
  ['stationaryTask', ACTIVITIES.STATIONARY_TASK],
  ['reachingDown', ACTIVITIES.REACHING_DOWN],
  ['crouching', ACTIVITIES.CROUCHING],
  ['sitting', ACTIVITIES.SITTING],
  ['lyingSettled', ACTIVITIES.LYING_SETTLED],
  ['lyingSudden', ACTIVITIES.LYING_SUDDEN]
];
for (const [posture, expected] of expectations) {
  assert.equal(classifyPosture(featuresFor(posture)), expected,
    `${posture} should classify as ${expected}`);
}
assert.equal(classifyPosture(base), ACTIVITIES.STANDING);
assert.equal(classifyPosture({ ...base, motionMagnitude: 0.2 }), ACTIVITIES.WALKING);

/* The one distinction the whole design rests on: identical end posture,
   different descent speed, opposite verdict. */
assert.notEqual(classifyPosture(featuresFor('lyingSettled')),
  classifyPosture(featuresFor('lyingSudden')),
  'descent speed alone must separate lying down from going down');

/* ---- 2. The monitor holds an activity before believing it --------------- */
{
  // dt is clamped per frame (as in the engine), so time is fed in real steps.
  const monitor = createActivityMonitor();
  const step = 100;
  monitor.update(base, step);
  const early = monitor.update(featuresFor('crouching'), step);
  assert.notEqual(early.activity, ACTIVITIES.CROUCHING,
    'a single noisy frame must not flip the activity');
  let later;
  for (let t = 0; t < CONFIG.THRESHOLDS.activityConfirmationMs + step * 2; t += step) {
    later = monitor.update(featuresFor('crouching'), step);
  }
  assert.equal(later.activity, ACTIVITIES.CROUCHING);
  assert.ok(later.settled, 'crouching is a posture the person chose');
}
{
  // A collapse is believed immediately — being slow here is not symmetric.
  const monitor = createActivityMonitor();
  const first = monitor.update(featuresFor('lyingSudden'), 60);
  assert.equal(first.activity, ACTIVITIES.LYING_SUDDEN);
}

/* ---- 3. Deliberate postures never become an incident -------------------- */

function run(posture, seconds, { detector = createFallDetector(), monitor = createActivityMonitor() } = {}) {
  const features = featuresFor(posture);
  let result;
  for (let t = 0; t < seconds * 1000; t += 100) {
    const grounded = features.centerY >= CONFIG.THRESHOLDS.groundCenterY
      && features.boundingBoxBottom >= CONFIG.THRESHOLDS.groundBottomY
      && (features.bodyAngle >= CONFIG.THRESHOLDS.torsoHorizontalAngle
        || features.boundingBoxRatio >= CONFIG.THRESHOLDS.horizontalBoxRatio);
    const frame = {
      ...features,
      groundDurationMs: grounded ? t : 0,
      timeSinceMovementMs: features.motionMagnitude <= CONFIG.THRESHOLDS.immobileMotion ? t : 0
    };
    const context = monitor.update(frame, 100);
    result = detector.update(frame, 100, context.activity);
    result.score = computeGuardianScore(frame, result.state);
  }
  return result;
}

for (const posture of ['stationaryTask', 'reachingDown', 'crouching', 'sitting']) {
  const result = run(posture, 20);
  assert.notEqual(result.state, FALL_STATES.GROUND, `${posture} must not reach GROUND`);
  assert.notEqual(result.state, FALL_STATES.IMMOBILE, `${posture} must not reach IMMOBILE`);
  assert.notEqual(result.state, FALL_STATES.POSSIBLE_DISTRESS,
    `${posture} must never reach POSSIBLE_DISTRESS`);
  assert.ok(result.score < 3, `${posture} must stay below the Elevated band, got ${result.score}`);
}

/* Lying down deliberately: on the floor, still, for 30 s — and still normal. */
{
  const result = run('lyingSettled', 30);
  assert.equal(result.state, FALL_STATES.RESTING);
  assert.ok(result.score < 3,
    `resting must stay below the Elevated band, got ${result.score}`);
}

/* But stillness that outlasts any plausible rest is still worth a look. By
   then the person has also been motionless for longer than distressTimeMs, so
   landing straight on POSSIBLE_DISTRESS is correct rather than premature. */
{
  const result = run('lyingSettled', (CONFIG.THRESHOLDS.restingEscalationMs / 1000) + 8);
  assert.ok([FALL_STATES.IMMOBILE, FALL_STATES.POSSIBLE_DISTRESS].includes(result.state),
    `resting must eventually escalate rather than be ignored forever, got ${result.state}`);
}

/* The latch: a real collapse must not re-label itself as "lying down" once the
   descent speed has aged out of the feature window. */
{
  const monitor = createActivityMonitor();
  const fast = featuresFor('lyingSudden');
  for (let t = 0; t < 600; t += 100) monitor.update(fast, 100);
  assert.equal(monitor.activity, ACTIVITIES.LYING_SUDDEN);
  // Same posture, but the descent evidence is gone from the window.
  const settled = { ...fast, descentPeakSpeed: 0, descentDistance: 0 };
  let latched;
  for (let t = 0; t < 4000; t += 100) latched = monitor.update(settled, 100);
  assert.equal(latched.activity, ACTIVITIES.LYING_SUDDEN,
    'a collapse must not quietly become "lying down" and cancel its own incident');
}

/* ---- 4. The real thing still escalates ---------------------------------- */
{
  const result = run('lyingSudden', 12);
  assert.equal(result.state, FALL_STATES.POSSIBLE_DISTRESS,
    'an abrupt collapse followed by stillness must still reach distress');
  assert.ok(result.score >= 8,
    `a real collapse must reach the Critical band, got ${result.score}`);
}

/* A person who crouches and THEN collapses is not excused by the crouch. */
{
  const detector = createFallDetector();
  const monitor = createActivityMonitor();
  run('crouching', 6, { detector, monitor });
  const result = run('lyingSudden', 12, { detector, monitor });
  assert.equal(result.state, FALL_STATES.POSSIBLE_DISTRESS,
    'a benign activity must not immunise a person against a later collapse');
}

/* ---- 5. Feet out of shot (a desk webcam) -------------------------------- */

/* Unknown must never invent a benign explanation... */
{
  const bentNoFeet = { ...featuresFor('reachingDown'), hipToAnkleSpan: null };
  assert.notEqual(classifyPosture(bentNoFeet), ACTIVITIES.REACHING_DOWN,
    'without the feet in shot, a bend cannot be distinguished from a fall');
  assert.notEqual(classifyPosture({ ...featuresFor('crouching'), hipToAnkleSpan: null }),
    ACTIVITIES.CROUCHING, 'a crouch needs the feet in shot to be believed');
}

/* ...and must never block a real fall. This is the important half: a webcam
   that sees only head and torso must still detect somebody going down. */
{
  const collapseNoFeet = { ...featuresFor('lyingSudden'), hipToAnkleSpan: null };
  assert.equal(classifyPosture(collapseNoFeet), ACTIVITIES.LYING_SUDDEN,
    'a collapse must be detected even with the feet out of frame');

  const detector = createFallDetector();
  const monitor = createActivityMonitor();
  let result;
  for (let t = 0; t < 12000; t += 100) {
    const frame = {
      ...collapseNoFeet,
      groundDurationMs: t,
      timeSinceMovementMs: t
    };
    result = detector.update(frame, 100, monitor.update(frame, 100).activity);
  }
  assert.equal(result.state, FALL_STATES.POSSIBLE_DISTRESS,
    'feet out of shot must not prevent an incident');
}

console.log('activity tests passed (6 postures, 4 gated from incidents, 2 escalation paths)');
