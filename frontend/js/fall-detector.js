/**
 * GuardianMesh — explainable temporal fall state machine.
 *
 * It consumes observable pose/motion features only. It does not diagnose a
 * medical condition and keeps no identity or biometric profile.
 *
 * It also takes the activity context from js/activity.js, because posture on
 * its own is ambiguous: crouching, sitting, reaching to the floor and lying
 * down to rest all look like the beginning of a fall if you only measure how
 * low a body is. Activity decides whether a descent needs explaining.
 */

import { CONFIG } from './config.js';
import { ACTIVITIES } from './activity.js';

export const FALL_STATES = Object.freeze({
  NORMAL: 'NORMAL',
  INSTABILITY: 'INSTABILITY',
  RAPID_DESCENT: 'RAPID_DESCENT',
  GROUND: 'GROUND',
  IMMOBILE: 'IMMOBILE',
  POSSIBLE_DISTRESS: 'POSSIBLE_DISTRESS',
  RECOVERY: 'RECOVERY',
  /** On the floor, but arrived there under the person's own control. */
  RESTING: 'RESTING'
});

const PRESENTATION = {
  NORMAL: { status: 'normal', label: 'Normal motion', confidence: 0 },
  INSTABILITY: { status: 'observing', label: 'Instability observed', confidence: 0.42 },
  RAPID_DESCENT: { status: 'warning', label: 'Rapid downward movement', confidence: 0.58 },
  GROUND: { status: 'warning', label: 'Possible fall', confidence: 0.72 },
  IMMOBILE: { status: 'warning', label: 'Person remains on ground', confidence: 0.84 },
  POSSIBLE_DISTRESS: { status: 'critical', label: 'Possible collapse / distress', confidence: 0.93 },
  RECOVERY: { status: 'observing', label: 'Recovery movement', confidence: 0.62 },
  RESTING: { status: 'normal', label: 'Resting on the ground', confidence: 0 }
};

export function presentationForFallState(state, poseConfidence = 1) {
  const base = PRESENTATION[state] || PRESENTATION.NORMAL;
  return {
    ...base,
    confidence: base.confidence ? Math.min(base.confidence, Math.max(0, poseConfidence)) : 0
  };
}

export function createFallDetector(thresholds = CONFIG.THRESHOLDS) {
  let state = FALL_STATES.NORMAL;
  let restingMs = 0;
  let stateElapsedMs = 0;
  let uprightElapsedMs = 0;
  let descentEvidenceMs = 0;
  let instabilityEvidenceMs = 0;
  let elapsedMs = 0;
  let smallMovementActive = false;
  let smallMovementBursts = [];

  function transition(next) {
    if (next === state) return false;
    state = next;
    stateElapsedMs = 0;
    uprightElapsedMs = 0;
    return true;
  }

  /**
   * @param {object} features pose-engine features
   * @param {number} dtMs
   * @param {string} [activity] current ACTIVITIES value from js/activity.js
   */
  function update(features, dtMs, activity = ACTIVITIES.UNKNOWN) {
    const dt = Math.max(0, Math.min(Number(dtMs) || 0, 120));
    elapsedMs += dt;
    stateElapsedMs += dt;

    const downwardSpeed = Math.max(0, -(features.verticalVelocity || 0));
    const descentDistance = features.descentDistance || 0;
    // A single noisy pose frame must never look like a fall. Fast movement is
    // meaningful only when the torso also travels a minimum distance; a larger
    // multi-frame displacement can stand on its own.
    // Distance alone is not evidence of a fall: lowering yourself to the floor
    // covers the same ground as dropping to it. The descent must also have been
    // fast at some point. (Absent peak data the distance still stands, so a
    // producer that supplies no descent profile behaves as before.)
    const descentSample = (descentDistance >= thresholds.rapidDropDistance
      && (features.descentPeakSpeed ?? Infinity) >= thresholds.controlledDescentSpeed)
      || (downwardSpeed >= thresholds.rapidDropVelocity
        && descentDistance >= thresholds.rapidDropMinDistance);
    const horizontal = (features.bodyAngle || 0) >= thresholds.torsoHorizontalAngle
      || (features.boundingBoxRatio || 0) >= thresholds.horizontalBoxRatio;
    const nearGround = (features.centerY || 0) >= thresholds.groundCenterY
      && (features.boundingBoxBottom || 0) >= thresholds.groundBottomY;
    const grounded = nearGround && horizontal;
    const lowMotion = (features.motionMagnitude || 0) <= thresholds.immobileMotion;
    const recoveryMotion = (features.motionMagnitude || 0) >= thresholds.recoveryMotion;
    const upright = (features.bodyAngle || 0) < thresholds.instabilityAngle
      && (features.boundingBoxRatio || 0) < thresholds.horizontalBoxRatio
      && !nearGround;

    // Postures the person put themselves into. These never start an incident,
    // which is what keeps crouching to a cupboard, sitting down, picking
    // something off the floor and lying down out of the incident feed.
    const deliberate = activity === ACTIVITIES.REACHING_DOWN
      || activity === ACTIVITIES.CROUCHING
      || activity === ACTIVITIES.SITTING;
    const settledOnGround = activity === ACTIVITIES.LYING_SETTLED;

    uprightElapsedMs = upright ? uprightElapsedMs + dt : 0;
    descentEvidenceMs = descentSample ? descentEvidenceMs + dt : 0;
    // Posture alone is ambiguous: a person may already be sleeping, exercising,
    // or resting on the floor. Instability requires observed downward travel.
    const instabilitySample = (features.bodyAngle || 0) >= thresholds.instabilityAngle
      && descentDistance >= thresholds.instabilityMinDescent;
    instabilityEvidenceMs = instabilitySample ? instabilityEvidenceMs + dt : 0;
    const rapidDescent = descentEvidenceMs >= thresholds.rapidDropConfirmationMs;
    const instability = instabilityEvidenceMs >= thresholds.instabilityConfirmationMs;

    // Repeated small movements can add concern after a witnessed fall and
    // immobility, but never by themselves. This avoids treating sleep,
    // stretching, or an already-grounded person as an incident.
    const postFallGroundState = state === FALL_STATES.GROUND
      || state === FALL_STATES.IMMOBILE
      || state === FALL_STATES.POSSIBLE_DISTRESS;
    const smallMovement = grounded && !lowMotion && !recoveryMotion;
    smallMovementBursts = smallMovementBursts.filter(
      (time) => elapsedMs - time <= thresholds.smallMovementWindowMs
    );
    if (postFallGroundState && smallMovement && !smallMovementActive) {
      smallMovementBursts.push(elapsedMs);
    }
    smallMovementActive = postFallGroundState && smallMovement;
    if (!postFallGroundState || !grounded) smallMovementBursts = [];
    const repeatedSmallMovements = smallMovementBursts.length
      >= thresholds.smallMovementBurstCount;

    restingMs = state === FALL_STATES.RESTING ? restingMs + dt : 0;

    switch (state) {
      case FALL_STATES.NORMAL:
        // A descent the person is driving needs no explanation. Bending to a
        // low shelf pitches the torso exactly like the start of a fall does.
        if (deliberate) break;
        if (settledOnGround) transition(FALL_STATES.RESTING);
        else if (rapidDescent) transition(FALL_STATES.RAPID_DESCENT);
        else if (instability) {
          transition(FALL_STATES.INSTABILITY);
        }
        break;

      case FALL_STATES.RESTING:
        // Lying down is normal. Lying still for far longer than resting
        // explains is not, so the evidence keeps accumulating quietly.
        if (!grounded && (upright || recoveryMotion)) transition(FALL_STATES.RECOVERY);
        else if (activity === ACTIVITIES.LYING_SUDDEN) transition(FALL_STATES.GROUND);
        else if (lowMotion && restingMs >= thresholds.restingEscalationMs) {
          transition(FALL_STATES.IMMOBILE);
        }
        break;

      case FALL_STATES.INSTABILITY:
        if (deliberate) transition(FALL_STATES.NORMAL);
        else if (settledOnGround) transition(FALL_STATES.RESTING);
        else if (rapidDescent) transition(FALL_STATES.RAPID_DESCENT);
        else if (grounded && (features.descentDistance || 0) >= thresholds.rapidDropDistance * 0.7) {
          transition(FALL_STATES.GROUND);
        } else if (uprightElapsedMs >= thresholds.normaliseTimeMs
          || stateElapsedMs >= thresholds.candidateTimeoutMs) {
          transition(FALL_STATES.NORMAL);
        }
        break;

      case FALL_STATES.RAPID_DESCENT:
        if (settledOnGround) transition(FALL_STATES.RESTING);
        else if (grounded && (features.groundDurationMs || 0) >= thresholds.groundConfirmationMs) {
          transition(FALL_STATES.GROUND);
        } else if (uprightElapsedMs >= thresholds.normaliseTimeMs
          || stateElapsedMs >= thresholds.candidateTimeoutMs) {
          transition(upright ? FALL_STATES.NORMAL : FALL_STATES.INSTABILITY);
        }
        break;

      case FALL_STATES.GROUND:
        if (!grounded && (upright || recoveryMotion)) transition(FALL_STATES.RECOVERY);
        else if (settledOnGround) transition(FALL_STATES.RESTING);
        else if (lowMotion && (features.timeSinceMovementMs || 0) >= thresholds.immobilityTimeMs) {
          transition(FALL_STATES.IMMOBILE);
        }
        break;

      case FALL_STATES.IMMOBILE:
        if (!grounded && (upright || recoveryMotion)) transition(FALL_STATES.RECOVERY);
        else if (repeatedSmallMovements) transition(FALL_STATES.POSSIBLE_DISTRESS);
        else if (grounded
          && (features.groundDurationMs || 0) >= thresholds.distressTimeMs
          && (features.timeSinceMovementMs || 0) >= thresholds.distressTimeMs) {
          transition(FALL_STATES.POSSIBLE_DISTRESS);
        }
        break;

      case FALL_STATES.POSSIBLE_DISTRESS:
        if (!grounded && (upright || recoveryMotion)) transition(FALL_STATES.RECOVERY);
        break;

      case FALL_STATES.RECOVERY:
        if (settledOnGround) transition(FALL_STATES.RESTING);
        else if (grounded && lowMotion) transition(FALL_STATES.GROUND);
        else if (uprightElapsedMs >= thresholds.recoveryTimeMs) transition(FALL_STATES.NORMAL);
        break;

      default:
        transition(FALL_STATES.NORMAL);
    }

    return {
      state,
      stateElapsedMs,
      activity,
      deliberate,
      restingMs,
      rapidDescent,
      instability,
      horizontal,
      nearGround,
      grounded,
      lowMotion,
      upright,
      smallMovementBurstCount: smallMovementBursts.length,
      repeatedSmallMovements
    };
  }

  function reset() {
    state = FALL_STATES.NORMAL;
    restingMs = 0;
    stateElapsedMs = 0;
    uprightElapsedMs = 0;
    descentEvidenceMs = 0;
    instabilityEvidenceMs = 0;
    elapsedMs = 0;
    smallMovementActive = false;
    smallMovementBursts = [];
  }

  return { update, reset, get state() { return state; } };
}
