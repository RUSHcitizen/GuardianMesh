import assert from 'node:assert/strict';
import { createFallDetector, FALL_STATES } from '../frontend/js/fall-detector.js';
import { computeGuardianScore } from '../frontend/js/guardian-score.js';

const base = {
  verticalVelocity: 0,
  descentDistance: 0,
  bodyAngle: 5,
  boundingBoxRatio: 0.35,
  centerY: 0.45,
  boundingBoxBottom: 0.88,
  motionMagnitude: 0.02,
  groundDurationMs: 0,
  timeSinceMovementMs: 0
};

function updateFor(detector, durationMs, patch, stepMs = 100) {
  let result;
  for (let elapsed = stepMs; elapsed <= durationMs; elapsed += stepMs) {
    result = detector.update({ ...base, ...patch(elapsed) }, stepMs);
  }
  return result;
}

// Standing still is not distress: ground posture gates immobility.
{
  const detector = createFallDetector();
  const result = updateFor(detector, 5000, (elapsed) => ({ timeSinceMovementMs: elapsed }));
  assert.equal(result.state, FALL_STATES.NORMAL);
  assert.ok(computeGuardianScore({ ...base, timeSinceMovementMs: 5000 }, result.state) < 3);
}

// Chewing/talking can create noisy face landmarks and a single bad pose frame.
// Neither ordinary upper-body motion nor that one-frame jump may elevate.
{
  const detector = createFallDetector();
  updateFor(detector, 2000, (elapsed) => ({
    bodyAngle: 9 + (elapsed % 300) / 30,
    motionMagnitude: 0.08,
    verticalVelocity: elapsed === 1000 ? -0.7 : 0,
    descentDistance: elapsed === 1000 ? 0.09 : 0
  }));
  assert.equal(detector.state, FALL_STATES.NORMAL);
  assert.ok(computeGuardianScore({
    ...base, verticalVelocity: -0.7, descentDistance: 0.09, motionMagnitude: 0.08
  }, detector.state) < 3);
}

// A crouch may be observed but returns to normal without becoming an incident.
{
  const detector = createFallDetector();
  updateFor(detector, 400, () => ({
    descentDistance: 0.08, bodyAngle: 18, centerY: 0.61, boundingBoxBottom: 0.94,
    boundingBoxRatio: 0.55, motionMagnitude: 0.08
  }));
  assert.notEqual(detector.state, FALL_STATES.POSSIBLE_DISTRESS);
  updateFor(detector, 1200, () => ({ motionMagnitude: 0.05 }));
  assert.equal(detector.state, FALL_STATES.NORMAL);
}

// A stumble/lean without a ground-level horizontal posture returns to normal.
{
  const detector = createFallDetector();
  updateFor(detector, 400, () => ({
    verticalVelocity: -0.52, descentDistance: 0.08, bodyAngle: 44,
    centerY: 0.52, boundingBoxBottom: 0.78, motionMagnitude: 0.14
  }));
  assert.equal(detector.state, FALL_STATES.RAPID_DESCENT);
  updateFor(detector, 2200, () => ({ motionMagnitude: 0.1 }));
  assert.equal(detector.state, FALL_STATES.NORMAL);
}

// Already resting on the floor is not a detected fall without a preceding
// descent. This can be exercise, stretching, or another ordinary activity.
{
  const detector = createFallDetector();
  const incidentStates = new Set([
    FALL_STATES.GROUND,
    FALL_STATES.IMMOBILE,
    FALL_STATES.POSSIBLE_DISTRESS
  ]);

  for (let elapsed = 100; elapsed <= 8000; elapsed += 100) {
    const result = detector.update({
      ...base,
      bodyAngle: 78,
      boundingBoxRatio: 1.5,
      centerY: 0.74,
      boundingBoxBottom: 0.97,
      groundDurationMs: elapsed,
      timeSinceMovementMs: elapsed,
      motionMagnitude: 0.01
    }, 100);
    assert.equal(incidentStates.has(result.state), false);
  }
}

// A fall/collapse-like example requires a temporal sequence and escalates only
// after remaining down. Pose-only inference does not diagnose a heart attack.
{
  const detector = createFallDetector();
  detector.update({ ...base, verticalVelocity: -0.72, descentDistance: 0.18, bodyAngle: 42 }, 100);
  detector.update({ ...base, verticalVelocity: -0.72, descentDistance: 0.2, bodyAngle: 48 }, 100);
  detector.update({ ...base, verticalVelocity: -0.68, descentDistance: 0.22, bodyAngle: 55 }, 100);
  assert.equal(detector.state, FALL_STATES.RAPID_DESCENT);

  updateFor(detector, 700, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: elapsed, timeSinceMovementMs: 0, motionMagnitude: 0.12
  }));
  assert.equal(detector.state, FALL_STATES.GROUND);

  updateFor(detector, 2400, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: 700 + elapsed, timeSinceMovementMs: elapsed, motionMagnitude: 0.01
  }));
  assert.equal(detector.state, FALL_STATES.IMMOBILE);

  updateFor(detector, 2500, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: 3100 + elapsed, timeSinceMovementMs: 2400 + elapsed, motionMagnitude: 0.01
  }));
  assert.equal(detector.state, FALL_STATES.POSSIBLE_DISTRESS);
  assert.ok(computeGuardianScore({
    ...base, bodyAngle: 76, boundingBoxRatio: 1.45, groundDurationMs: 5600,
    timeSinceMovementMs: 4900, motionMagnitude: 0.01
  }, detector.state) >= 8.6);

  detector.update({ ...base, motionMagnitude: 0.16 }, 100);
  assert.equal(detector.state, FALL_STATES.RECOVERY);
  updateFor(detector, 1300, () => ({ motionMagnitude: 0.08 }));
  assert.equal(detector.state, FALL_STATES.NORMAL);
}

console.log('fall-detector tests passed');
