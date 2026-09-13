/**
 * GuardianMesh — pose & temporal-feature engine.
 *
 * Holds one record per anonymous track and derives the temporal movement
 * features the reasoning layer uses: vertical velocity, motion magnitude, body
 * angle, descent distance, ground duration and time since movement.
 *
 * Every track originates from real computer vision — the in-browser YOLO26
 * pose model, or a backend CV service — and arrives through
 * `applyExternalTrack()`. The engine has no synthetic pose source: temporal
 * reasoning is applied to observed keypoints or to nothing at all.
 */

import { CONFIG } from './config.js';
import { createFallDetector, presentationForFallState } from './fall-detector.js';
import { clamp, lerp } from './util.js';

const MOTION_SMOOTHING = 0.18;

export function createPoseEngine() {
  /** @type {Map<string, object>} */
  const tracks = new Map();
  let clock = 0;

  function createTrack(trackingId, cameraId) {
    tracks.set(trackingId, {
      trackingId,
      cameraId: cameraId || 'CAM-LIVE',

      // presentation metadata shown by the detection overlay
      status: 'normal',
      label: 'Normal motion',
      confidence: null,
      score: null,

      // derived signals
      features: {
        verticalVelocity: 0,
        motionMagnitude: 0,
        bodyAngle: 0,
        groundDurationMs: 0,
        timeSinceMovementMs: 0,
        centerY: 0,
        headY: 0,
        shoulderY: 0,
        hipY: 0,
        boundingBoxRatio: 0,
        boundingBoxBottom: 0,
        descentDistance: 0,
        aspectRatioChange: 0,
        groundSignal: false,
        smallMovementBurstCount: 0
      },
      _prev: null,
      _history: [],
      _smoothMotion: 0,
      _fallDetector: createFallDetector(),
      fallState: 'NORMAL',
      poseConfidence: 0,
      assessmentSource: 'local',
      keypoints: [],
      boundingBox: { x: 0, y: 0, width: 0, height: 0 }
    });
    return tracks.get(trackingId);
  }

  function removeTrack(id) { tracks.delete(id); }
  function has(id) { return tracks.has(id); }
  function get(id) { return tracks.get(id); }
  function reset() { tracks.clear(); clock = 0; }

  /** Update the overlay metadata (status colour, label, confidence, score). */
  function setMeta(id, meta) {
    const track = tracks.get(id);
    if (track) Object.assign(track, meta);
  }

  function boundsOf(points) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const padX = 0.018, padTop = 0.042, padBottom = 0.014;
    return {
      x: minX - padX,
      y: minY - padTop,
      width: (maxX - minX) + padX * 2,
      height: (maxY - minY) + padTop + padBottom
    };
  }

  const midpoint = (a, b) => a && b
    ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    : a || b || null;

  /** Derive temporal features from consecutive observed keypoint samples. */
  function deriveFeatures(track, points, dtMs) {
    const byName = Object.fromEntries(points.map((p) => [p.name, p]));
    const hips = midpoint(byName.left_hip, byName.right_hip);
    const shoulders = midpoint(byName.left_shoulder, byName.right_shoulder);
    if (!hips || !shoulders) return track.features;
    const hipY = hips.y;
    const shoulderY = shoulders.y;
    const centerY = (hipY + shoulderY) / 2;
    const headPoints = [byName.nose, byName.left_ear, byName.right_ear].filter(Boolean);
    const headY = headPoints.length
      ? headPoints.reduce((sum, p) => sum + p.y, 0) / headPoints.length
      : shoulderY;

    // Torso angle away from vertical, 0deg upright -> ~90deg horizontal
    const dx = hips.x - shoulders.x;
    const dy = hipY - shoulderY;
    const len = Math.hypot(dx, dy) || 1e-6;
    const bodyAngle = Math.acos(clamp(Math.abs(dy) / len, 0, 1)) * (180 / Math.PI);

    const dt = Math.max(dtMs, 1) / 1000;
    let verticalVelocity = 0;
    let motion = 0;

    if (track._prev) {
      // image-space y grows downward; report world-vertical (negative = falling)
      verticalVelocity = -((centerY - track._prev.centerY) / dt);
      let sum = 0;
      let count = 0;
      for (const p of points) {
        const prev = track._prev.byName[p.name];
        if (prev && (p.confidence ?? 1) >= CONFIG.POSE_MODEL.minLandmarkVisibility) {
          sum += Math.hypot(p.x - prev.x, p.y - prev.y);
          count += 1;
        }
      }
      motion = count ? (sum / count) / dt : 0;
    }

    track._smoothMotion = lerp(track._smoothMotion, motion, MOTION_SMOOTHING);
    track._prev = { centerY, byName };

    const b = track.boundingBox || boundsOf(points);
    const ratio = b.height > 1e-5 ? b.width / b.height : 0;
    track._history.push({ t: clock, centerY, headY, shoulderY, hipY, ratio });
    const cutoff = clock - CONFIG.THRESHOLDS.descentWindowMs;
    track._history = track._history.filter((sample) => sample.t >= cutoff);
    const baseline = track._history.reduce((best, sample) =>
      sample.centerY < best.centerY ? sample : best, track._history[0]);

    const f = track.features;
    f.verticalVelocity = verticalVelocity;
    f.motionMagnitude = track._smoothMotion;
    f.bodyAngle = bodyAngle;
    f.centerY = centerY;
    f.headY = headY;
    f.shoulderY = shoulderY;
    f.hipY = hipY;
    f.boundingBoxRatio = ratio;
    f.boundingBoxBottom = b.y + b.height;
    f.descentDistance = Math.max(0, centerY - (baseline?.centerY ?? centerY));
    f.aspectRatioChange = Math.max(0, ratio - (baseline?.ratio ?? ratio));
    f.groundSignal = f.centerY >= CONFIG.THRESHOLDS.groundCenterY
      && f.boundingBoxBottom >= CONFIG.THRESHOLDS.groundBottomY
      && (bodyAngle >= CONFIG.THRESHOLDS.torsoHorizontalAngle
        || ratio >= CONFIG.THRESHOLDS.horizontalBoxRatio);
    return f;
  }

  function advanceDurations(track, dtMs) {
    const f = track.features;
    f.groundDurationMs = f.groundSignal ? f.groundDurationMs + dtMs : 0;
    f.timeSinceMovementMs = track._smoothMotion <= CONFIG.THRESHOLDS.immobileMotion
      ? f.timeSinceMovementMs + dtMs
      : 0;
  }

  function advance(track, dtMs) {
    advanceDurations(track, dtMs);
    if (track.assessmentSource !== 'local') return;
    const assessment = track._fallDetector.update(track.features, dtMs);
    track.features.smallMovementBurstCount = assessment.smallMovementBurstCount;
    track.fallState = assessment.state;
    const presentation = presentationForFallState(assessment.state, track.poseConfidence);
    track.status = presentation.status;
    track.label = presentation.label;
    track.confidence = presentation.confidence;
  }

  /**
   * Advance every tracked person and return normalised person records.
   * @param {number} dtMs elapsed milliseconds since the previous call
   */
  function update(dtMs) {
    const dt = clamp(dtMs, 0, 120);
    clock += dt;
    const out = [];
    for (const track of tracks.values()) {
      advance(track, dt);
      out.push(record(track));
    }
    return out;
  }

  function record(track) {
    // CV tracks have no rig scale, so estimate one from the bounding box
    const b = track.boundingBox || { width: 0, height: 0 };
    return {
      trackingId: track.trackingId,
      cameraId: track.cameraId,
      scale: Math.max(b.height, b.width, 0.12) / 0.58,
      status: track.status,
      label: track.label,
      confidence: track.confidence,
      score: track.score,
      fallState: track.fallState,
      poseConfidence: track.poseConfidence,
      boundingBox: track.boundingBox,
      keypoints: track.keypoints,
      features: { ...track.features }
    };
  }

  /**
   * Feed real CV output into the engine. Keypoints must be normalised 0..1.
   * Features are derived here when the producer does not supply them.
   * @param {{trackingId:string, cameraId?:string, boundingBox?:object,
   *          keypoints:Array<{name:string,x:number,y:number,confidence?:number}>,
   *          status?:string, label?:string, confidence?:number, score?:number,
   *          poseConfidence?:number, features?:object}} payload
   * @param {number} dtMs
   */
  function applyExternalTrack(payload, dtMs = 33) {
    const track = tracks.get(payload.trackingId)
      || createTrack(payload.trackingId, payload.cameraId);
    track.cameraId = payload.cameraId || track.cameraId;
    // A producer that ships its own verdict owns the presentation; otherwise
    // the local temporal state machine derives it from the features below.
    track.assessmentSource = payload.status !== undefined || payload.score !== undefined
      ? 'producer'
      : 'local';
    if (payload.poseConfidence !== undefined) track.poseConfidence = payload.poseConfidence;
    if (payload.status) track.status = payload.status;
    if (payload.label) track.label = payload.label;
    if (payload.confidence !== undefined) track.confidence = payload.confidence;
    if (payload.score !== undefined) track.score = payload.score;

    if (Array.isArray(payload.keypoints) && payload.keypoints.length) {
      track.keypoints = payload.keypoints;
      track.boundingBox = payload.boundingBox || boundsOf(payload.keypoints);
      if (payload.features) Object.assign(track.features, payload.features);
      else deriveFeatures(track, payload.keypoints, dtMs);
    } else if (payload.boundingBox) {
      track.boundingBox = payload.boundingBox;
      if (payload.features) Object.assign(track.features, payload.features);
    }
    return track;
  }

  return {
    removeTrack, reset, has, get, setMeta,
    update, applyExternalTrack,
    get size() { return tracks.size; },
    get tracks() { return Array.from(tracks.values()); }
  };
}
