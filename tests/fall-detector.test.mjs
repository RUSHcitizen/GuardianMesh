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

// A fall requires a temporal sequence and escalates only after remaining down.
{
  const detector = createFallDetector();
  detector.update({ ...base, verticalVelocity: -0.72, descentDistance: 0.18, bodyAngle: 34 }, 100);
  assert.equal(detector.state, FALL_STATES.RAPID_DESCENT);

  updateFor(detector, 600, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: elapsed, timeSinceMovementMs: 0, motionMagnitude: 0.12
  }));
  assert.equal(detector.state, FALL_STATES.GROUND);

  updateFor(detector, 1800, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: 600 + elapsed, timeSinceMovementMs: elapsed, motionMagnitude: 0.01
  }));
  assert.equal(detector.state, FALL_STATES.IMMOBILE);

  updateFor(detector, 2000, (elapsed) => ({
    bodyAngle: 76, boundingBoxRatio: 1.45, centerY: 0.72, boundingBoxBottom: 0.96,
    groundDurationMs: 2400 + elapsed, timeSinceMovementMs: 1800 + elapsed, motionMagnitude: 0.01
  }));
  assert.equal(detector.state, FALL_STATES.POSSIBLE_DISTRESS);
  assert.ok(computeGuardianScore({
    ...base, bodyAngle: 76, boundingBoxRatio: 1.45, groundDurationMs: 4400,
    timeSinceMovementMs: 3800, motionMagnitude: 0.01
  }, detector.state) >= 8.6);

  detector.update({ ...base, motionMagnitude: 0.16 }, 100);
  assert.equal(detector.state, FALL_STATES.RECOVERY);
  updateFor(detector, 1300, () => ({ motionMagnitude: 0.08 }));
  assert.equal(detector.state, FALL_STATES.NORMAL);
}

console.log('fall-detector tests passed');
