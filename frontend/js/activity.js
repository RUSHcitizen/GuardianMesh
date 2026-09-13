/**
 * GuardianMesh — observable activity context.
 *
 * The fall state machine answers "is this person going down?". This answers
 * "what does this person appear to be doing?", which is what separates an
 * emergency from an ordinary day. Washing up, crouching to a low shelf, sitting
 * down, picking something off the floor and lying down to rest all produce
 * descents, low motion or horizontal postures — the exact signals a naive fall
 * detector fires on.
 *
 * Everything here is an OBSERVATION OF BODY GEOMETRY, never a diagnosis and
 * never an identity. "Stationary task" means arms moving while the torso and
 * feet stay put. It does not mean "washing dishes", and the interface never
 * claims to know what the task is.
 */

import { CONFIG } from './config.js';

export const ACTIVITIES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  WALKING: 'WALKING',
  STANDING: 'STANDING',
  STATIONARY_TASK: 'STATIONARY_TASK',
  REACHING_DOWN: 'REACHING_DOWN',
  CROUCHING: 'CROUCHING',
  SITTING: 'SITTING',
  LYING_SETTLED: 'LYING_SETTLED',
  LYING_SUDDEN: 'LYING_SUDDEN'
});

/**
 * How each activity is described, and whether it explains away a posture that
 * would otherwise look like a fall.
 *
 * `settled` marks postures a person reached under their own control. Those
 * never start an incident on their own — but they do not silence the system
 * either: a settled posture still escalates if the person then stops moving
 * for far longer than resting explains (see fall-detector's RESTING state).
 */
export const ACTIVITY_INFO = Object.freeze({
  UNKNOWN:         { label: 'Assessing movement', settled: false },
  WALKING:         { label: 'Walking',            settled: false },
  STANDING:        { label: 'Standing',           settled: false },
  STATIONARY_TASK: { label: 'Stationary task',    settled: false },
  REACHING_DOWN:   { label: 'Reaching down',      settled: true },
  CROUCHING:       { label: 'Crouching',          settled: true },
  SITTING:         { label: 'Sitting',            settled: true },
  LYING_SETTLED:   { label: 'Lying down',         settled: true },
  LYING_SUDDEN:    { label: 'Went down suddenly', settled: false }
});

export const activityLabel = (activity) =>
  (ACTIVITY_INFO[activity] || ACTIVITY_INFO.UNKNOWN).label;

export const isSettled = (activity) =>
  Boolean((ACTIVITY_INFO[activity] || ACTIVITY_INFO.UNKNOWN).settled);

/**
 * Classify one frame of posture. Pure, so the whole table of behaviours can be
 * unit-tested without a camera.
 *
 * @param {object} f features from pose-engine
 * @returns {string} one of ACTIVITIES
 */
export function classifyPosture(f, thresholds = CONFIG.THRESHOLDS) {
  const T = thresholds;
  const horizontal = (f.bodyAngle || 0) >= T.torsoHorizontalAngle
    || (f.boundingBoxRatio || 0) >= T.horizontalBoxRatio;
  const atGroundLevel = (f.centerY || 0) >= T.groundCenterY
    && (f.boundingBoxBottom || 0) >= T.groundBottomY;

  // How far the hips sit above the feet, divided by the person's own size.
  // Roughly 0.5 standing, 0.3 seated, 0.15 in a deep crouch, at or below 0
  // lying flat. This is what tells a body that has gone DOWN from one that has
  // merely FOLDED FORWARD, which no measure of height-in-frame can do.
  //
  // It is null when the feet are out of shot. Unknown must never invent a
  // benign explanation, and must never block a fall: so a missing span rules
  // OUT "reaching down" and "crouching", and leaves the horizontal-on-the-floor
  // test to stand on its own.
  const span = Number.isFinite(f.hipToAnkleSpan) ? f.hipToAnkleSpan : null;
  const spanKnown = span !== null;
  const folded = spanKnown && span <= T.seatedSpan;
  const collapsedSpan = spanKnown ? span <= T.crouchSpan : true;

  const knee = f.kneeFlexion ?? 180;
  const legsExtended = knee >= T.reachingKneeFlexion;
  const feetPlanted = (f.feetTravel || 0) <= T.plantedFeetMotion;

  // Bent at the waist with the legs still straight and the feet where they
  // were: the person leaned down to something. Checked FIRST because in a
  // low camera view this posture also reads as horizontal and near the floor
  // — the hips being high is the only thing that separates it from lying down.
  if (spanKnown && !folded && legsExtended && feetPlanted
    && (f.bodyAngle || 0) >= T.instabilityAngle) {
    return ACTIVITIES.REACHING_DOWN;
  }

  if (horizontal && atGroundLevel && collapsedSpan) {
    // Controlled or abrupt is decided by how fast the body actually travelled,
    // not by where it ended up. Both end horizontal on the floor.
    return (f.descentPeakSpeed || 0) >= T.controlledDescentSpeed
      ? ACTIVITIES.LYING_SUDDEN
      : ACTIVITIES.LYING_SETTLED;
  }

  // Torso still roughly upright but the body is low: the legs are folded.
  if (folded && !horizontal) {
    return collapsedSpan ? ACTIVITIES.CROUCHING : ACTIVITIES.SITTING;
  }

  // Upright from here down.
  const arms = f.armMotion || 0;
  const torso = f.torsoMotion || 0;
  if (arms >= T.taskArmMotion && torso <= T.taskTorsoMotion && feetPlanted) {
    return ACTIVITIES.STATIONARY_TASK;
  }
  if ((f.motionMagnitude || 0) >= T.recoveryMotion) return ACTIVITIES.WALKING;
  if ((f.motionMagnitude || 0) <= T.immobileMotion) return ACTIVITIES.STANDING;
  return ACTIVITIES.UNKNOWN;
}

/**
 * Per-track activity tracker. A single frame is noisy — a wrist crossing the
 * torso, one bad pose — so an activity has to hold before it is believed, and
 * the previous one is kept until it does.
 */
export function createActivityMonitor(thresholds = CONFIG.THRESHOLDS) {
  let activity = ACTIVITIES.UNKNOWN;
  let candidate = ACTIVITIES.UNKNOWN;
  let candidateMs = 0;
  let activityMs = 0;

  function update(features, dtMs) {
    const dt = Math.max(0, Math.min(Number(dtMs) || 0, 120));
    let observed = classifyPosture(features, thresholds);

    // Once a descent has been seen as abrupt, the person is still on the floor
    // because of that event. Descent speed ages out of the feature window
    // within a second, so without this latch a real collapse would quietly
    // re-label itself "lying down" and cancel its own incident. Only getting
    // up — leaving the lying posture entirely — clears it.
    if (activity === ACTIVITIES.LYING_SUDDEN && observed === ACTIVITIES.LYING_SETTLED) {
      observed = ACTIVITIES.LYING_SUDDEN;
    }

    if (observed === candidate) candidateMs += dt;
    else { candidate = observed; candidateMs = dt; }

    // A posture that reads as a sudden collapse is believed immediately: the
    // cost of being slow there is not symmetric with the cost of being slow
    // about noticing somebody sat down.
    const confirmMs = candidate === ACTIVITIES.LYING_SUDDEN
      ? 0
      : thresholds.activityConfirmationMs;

    if (candidate !== activity && candidateMs >= confirmMs) {
      activity = candidate;
      activityMs = candidateMs;
    } else if (candidate === activity) {
      activityMs += dt;
    }

    return {
      activity,
      label: activityLabel(activity),
      settled: isSettled(activity),
      activityMs,
      observed
    };
  }

  function reset() {
    activity = ACTIVITIES.UNKNOWN;
    candidate = ACTIVITIES.UNKNOWN;
    candidateMs = 0;
    activityMs = 0;
  }

  return { update, reset, get activity() { return activity; } };
}
