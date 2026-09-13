/**
 * Pins the YOLO26-pose output decoding against real model output.
 *
 * The fixture holds raw rows produced by frontend/assets/models/yolo26n-pose.onnx
 * for a known image, together with the detections they should decode to. If the
 * model is ever re-exported with a different output layout, or the letterbox
 * arithmetic drifts, this test fails instead of the dashboard quietly drawing
 * boxes in the wrong place.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decodeDetections, letterboxFor } from '../frontend/js/browser-pose.js';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/yolo26-pose-bus.json', import.meta.url)), 'utf8'));

const close = (actual, expected, what, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected}, got ${actual}`);

/* The letterbox the browser computes must match the one the fixture was made with. */
const letterbox = letterboxFor(fixture.frameWidth, fixture.frameHeight, fixture.inputSize);
close(letterbox.scale, fixture.letterbox.scale, 'letterbox scale');
assert.equal(letterbox.padX, fixture.letterbox.padX, 'letterbox padX');
assert.equal(letterbox.padY, fixture.letterbox.padY, 'letterbox padY');
assert.equal(letterbox.width, fixture.letterbox.width, 'letterbox width');
assert.equal(letterbox.height, fixture.letterbox.height, 'letterbox height');

const flat = Float32Array.from(fixture.rows.flat());
const options = {
  frameWidth: fixture.frameWidth,
  frameHeight: fixture.frameHeight,
  letterbox,
  minConfidence: 0.5,
  maxPoses: 4
};

const detections = decodeDetections(flat, fixture.dims, options);
assert.equal(detections.length, fixture.expected.length,
  `expected ${fixture.expected.length} detections, got ${detections.length}`);

detections.forEach((detection, index) => {
  const want = fixture.expected[index];
  close(detection.confidence, want.confidence, `detection ${index} confidence`);

  const box = detection.boundingBox;
  close(box.x, want.box[0], `detection ${index} box.x`);
  close(box.y, want.box[1], `detection ${index} box.y`);
  close(box.width, want.box[2], `detection ${index} box.width`);
  close(box.height, want.box[3], `detection ${index} box.height`);

  // Every coordinate must be normalised into the frame, never left in model pixels.
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1.0001
    && box.y + box.height <= 1.0001, `detection ${index} box escapes the frame`);

  assert.equal(detection.keypoints.length, 17, `detection ${index} keypoint count`);
  assert.equal(detection.keypoints[0].name, 'nose');
  assert.equal(detection.keypoints[15].name, 'left_ankle');
  assert.equal(detection.keypoints[16].name, 'right_ankle');

  const [noseX, noseY, noseV] = want.nose;
  close(detection.keypoints[0].x, noseX, `detection ${index} nose.x`);
  close(detection.keypoints[0].y, noseY, `detection ${index} nose.y`);
  close(detection.keypoints[0].confidence, noseV, `detection ${index} nose visibility`);

  const [ankleX, ankleY, ankleV] = want.leftAnkle;
  close(detection.keypoints[15].x, ankleX, `detection ${index} left_ankle.x`);
  close(detection.keypoints[15].y, ankleY, `detection ${index} left_ankle.y`);
  close(detection.keypoints[15].confidence, ankleV, `detection ${index} left_ankle visibility`);

  // A standing person must decode taller than wide; the fall detector's
  // horizontal-box signal is meaningless if this orientation is ever flipped.
  assert.ok(box.height > box.width, `detection ${index} should be taller than wide`);
});

/* Sorted rows mean decoding stops at the first sub-threshold row. */
assert.equal(decodeDetections(flat, fixture.dims, { ...options, minConfidence: 0.99 }).length, 0,
  'a high threshold should reject every row');
assert.equal(decodeDetections(flat, fixture.dims, { ...options, maxPoses: 2 }).length, 2,
  'maxPoses must cap the number of detections');

console.log(`yolo26 decode tests passed (${detections.length} detections verified)`);
