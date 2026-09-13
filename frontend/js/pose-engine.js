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
import { ACTIVITIES, createActivityMonitor } from './activity.js';
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
        smallMovementBurstCount: 0,
        // posture and activity signals (see js/activity.js)
        armMotion: 0,
        legMotion: 0,
        torsoMotion: 0,
        feetTravel: 0,
        kneeFlexion: 180,
        // null until the feet are actually visible — see the note in activity.js
        hipToAnkleSpan: null,
        descentPeakSpeed: 0,
        bodyScale: 0.5
      },
      _prev: null,
      _history: [],
      _smoothMotion: 0,
      _smoothArm: 0,
      _smoothLeg: 0,
      _smoothTorso: 0,
      _smoothFeet: 0,
      _fallDetector: createFallDetector(),
      _activity: createActivityMonitor(),
      activity: ACTIVITIES.UNKNOWN,
      activityLabel: 'Assessing movement',
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

  /** Keypoint groups whose motion is tracked separately (see below). */
  const ARM_POINTS = ['left_elbow', 'right_elbow', 'left_wrist', 'right_wrist'];
  const LEG_POINTS = ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
  const TORSO_POINTS = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];
  const FOOT_POINTS = ['left_ankle', 'right_ankle'];

  const visible = (p) => p && (p.confidence ?? 1) >= CONFIG.POSE_MODEL.minLandmarkVisibility;

  /** Mean per-point displacement of a named group, in normalised units/second. */
  function groupSpeed(names, byName, prev, dt) {
    let sum = 0;
    let count = 0;
    for (const name of names) {
      const now = byName[name];
      const was = prev?.[name];
      if (!visible(now) || !visible(was)) continue;
      sum += Math.hypot(now.x - was.x, now.y - was.y);
      count += 1;
    }
    return count ? (sum / count) / dt : null;
  }

  /**
   * Interior angle at the knee, in degrees: 180 is a straight leg, smaller is
   * more bent. Separates a crouch (bent knees, upright torso) from bending at
   * the waist (straighter knees, pitched torso) — two postures that look
   * almost identical if you only measure how low the body's centre is.
   */
  function kneeFlexionOf(byName) {
    const angles = [];
    for (const side of ['left', 'right']) {
      const hip = byName[`${side}_hip`];
      const knee = byName[`${side}_knee`];
      const ankle = byName[`${side}_ankle`];
      if (!visible(hip) || !visible(knee) || !visible(ankle)) continue;
      const ax = hip.x - knee.x, ay = hip.y - knee.y;
      const bx = ankle.x - knee.x, by = ankle.y - knee.y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-5 || lb < 1e-5) continue;
      angles.push(Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1)) * (180 / Math.PI));
    }
    return angles.length ? angles.reduce((a, b) => a + b, 0) / angles.length : null;
  }

  const meanY = (names, byName) => {
    const ys = names.map((n) => byName[n]).filter(visible).map((p) => p.y);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };

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

    // Motion split by body part. A person at a sink is nearly still from the
    // hips down while their arms move constantly; a fall moves everything at
    // once. One averaged motion number cannot tell those apart.
    const prevByName = track._prev?.byName;
    const arm = groupSpeed(ARM_POINTS, byName, prevByName, dt);
    const leg = groupSpeed(LEG_POINTS, byName, prevByName, dt);
    const torso = groupSpeed(TORSO_POINTS, byName, prevByName, dt);
    const feet = groupSpeed(FOOT_POINTS, byName, prevByName, dt);
    if (arm !== null) track._smoothArm = lerp(track._smoothArm, arm, MOTION_SMOOTHING);
    if (leg !== null) track._smoothLeg = lerp(track._smoothLeg, leg, MOTION_SMOOTHING);
    if (torso !== null) track._smoothTorso = lerp(track._smoothTorso, torso, MOTION_SMOOTHING);
    if (feet !== null) track._smoothFeet = lerp(track._smoothFeet, feet, MOTION_SMOOTHING);

    track._prev = { centerY, byName };

    const b = track.boundingBox || boundsOf(points);
    const ratio = b.height > 1e-5 ? b.width / b.height : 0;
    track._history.push({ t: clock, centerY, headY, shoulderY, hipY, ratio });
    const cutoff = clock - CONFIG.THRESHOLDS.descentWindowMs;
    track._history = track._history.filter((sample) => sample.t >= cutoff);
    const baseline = track._history.reduce((best, sample) =>
      sample.centerY < best.centerY ? sample : best, track._history[0]);
    // Fastest downward travel inside the window. A fall spikes; sitting or
    // lying down deliberately stays gentle even over the same total distance.
    let peakDescent = 0;
    for (let i = 1; i < track._history.length; i += 1) {
      const span = (track._history[i].t - track._history[i - 1].t) / 1000;
      if (span <= 0) continue;
      const speed = (track._history[i].centerY - track._history[i - 1].centerY) / span;
      if (speed > peakDescent) peakDescent = speed;
    }

    const ankleY = meanY(FOOT_POINTS, byName);
    const bodyScale = Math.max(b.height, b.width, 0.05);
    const knee = kneeFlexionOf(byName);

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
    f.armMotion = track._smoothArm;
    f.legMotion = track._smoothLeg;
    f.torsoMotion = track._smoothTorso;
    f.feetTravel = track._smoothFeet;
    f.descentPeakSpeed = peakDescent;
    f.bodyScale = bodyScale;
    if (knee !== null) f.kneeFlexion = knee;
    // Scale-free "how far are the hips above the feet": ~0.5 standing, ~0.3
    // seated, ~0.15 crouching, at or below 0 lying flat. Works at any distance
    // because it is divided by the person's own size. Stays null when the feet
    // are out of shot (a desk webcam often sees only head and torso) so that
    // activity.js can treat it as unknown rather than assume "standing".
    f.hipToAnkleSpan = ankleY !== null ? (ankleY - hipY) / bodyScale : null;
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

    // Activity first: the fall state machine needs to know whether a descent
    // is something the person is doing or something happening to them.
    const context = track._activity.update(track.features, dtMs);
    track.activity = context.activity;
    track.activityLabel = context.label;

    const assessment = track._fallDetector.update(track.features, dtMs, context.activity);
    track.features.smallMovementBurstCount = assessment.smallMovementBurstCount;
    track.fallState = assessment.state;
    const presentation = presentationForFallState(assessment.state, track.poseConfidence);
    track.status = presentation.status;
    // With nothing concerning happening, say what the person appears to be
    // doing rather than a flat "Normal motion" — it is more informative and it
    // shows the operator the system is reading the scene, not just idling.
    track.label = assessment.state === 'NORMAL' ? context.label : presentation.label;
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
      activity: track.activity,
      activityLabel: track.activityLabel,
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
