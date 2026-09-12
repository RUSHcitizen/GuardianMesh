/**
 * GuardianMesh — real, local browser pose inference.
 *
 * MediaPipe receives video frames directly in the browser. Only anonymous
 * normalized landmarks are passed into GuardianMesh; frames are never uploaded.
 */

import { CONFIG } from './config.js';

const LANDMARKS = {
  nose: 0,
  left_eye: 2,
  right_eye: 5,
  left_ear: 7,
  right_ear: 8,
  left_shoulder: 11,
  right_shoulder: 12,
  left_elbow: 13,
  right_elbow: 14,
  left_wrist: 15,
  right_wrist: 16,
  left_hip: 23,
  right_hip: 24,
  left_knee: 25,
  right_knee: 26,
  left_ankle: 27,
  right_ankle: 28
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function boundsOf(keypoints) {
  const visible = keypoints.filter((p) => p.confidence >= CONFIG.POSE_MODEL.minLandmarkVisibility);
  const points = visible.length >= 6 ? visible : keypoints;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const padX = Math.max(0.015, (maxX - minX) * 0.09);
  const padY = Math.max(0.02, (maxY - minY) * 0.07);
  return {
    x: clamp01(minX - padX),
    y: clamp01(minY - padY),
    width: clamp01(maxX + padX) - clamp01(minX - padX),
    height: clamp01(maxY + padY) - clamp01(minY - padY)
  };
}

const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function createBrowserPose({ video, engine, onStatus, onInference }) {
  let landmarker = null;
  let initPromise = null;
  let status = 'idle';
  let lastInferenceAt = -Infinity;
  let lastVideoTime = -1;
  let lastTimestamp = 0;
  let sequence = 0;
  const tracks = new Map();

  function report(next, detail = '') {
    status = next;
    onStatus?.(next, detail);
  }

  async function initialize() {
    if (landmarker) return true;
    if (initPromise) return initPromise;
    report('loading');
    initPromise = (async () => {
      try {
        const vision = await import(CONFIG.POSE_MODEL.runtimeUrl);
        const fileset = await vision.FilesetResolver.forVisionTasks(CONFIG.POSE_MODEL.wasmRoot);
        const options = {
          baseOptions: {
            modelAssetPath: CONFIG.POSE_MODEL.modelUrl,
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: CONFIG.POSE_MODEL.maxPoses,
          minPoseDetectionConfidence: CONFIG.POSE_MODEL.minPoseDetectionConfidence,
          minPosePresenceConfidence: CONFIG.POSE_MODEL.minPosePresenceConfidence,
          minTrackingConfidence: CONFIG.POSE_MODEL.minTrackingConfidence,
          outputSegmentationMasks: false
        };
        try {
          landmarker = await vision.PoseLandmarker.createFromOptions(fileset, options);
        } catch (gpuError) {
          console.warn('[guardian] MediaPipe GPU delegate unavailable; retrying on CPU.', gpuError);
          delete options.baseOptions.delegate;
          landmarker = await vision.PoseLandmarker.createFromOptions(fileset, options);
        }
        report('ready');
        return true;
      } catch (error) {
        console.error('[guardian] MediaPipe Pose Landmarker failed to load.', error);
        report('error', error?.message || String(error));
        initPromise = null;
        return false;
      }
    })();
    return initPromise;
  }

  function toDetection(landmarks) {
    const keypoints = Object.entries(LANDMARKS).map(([name, index]) => {
      const p = landmarks[index];
      return {
        name,
        x: clamp01(p?.x),
        y: clamp01(p?.y),
        confidence: clamp01(Math.min(p?.visibility ?? 1, p?.presence ?? 1))
      };
    });
    const boundingBox = boundsOf(keypoints);
    const confidence = keypoints
      .filter((p) => ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'].includes(p.name))
      .reduce((sum, p) => sum + p.confidence, 0) / 4;
    return { keypoints, boundingBox, confidence };
  }

  function assignTracks(detections, now) {
    const unmatched = new Set(tracks.keys());
    const ordered = detections.slice().sort((a, b) => b.confidence - a.confidence);

    for (const detection of ordered) {
      const center = centerOf(detection.boundingBox);
      let bestId = null;
      let bestCost = Infinity;
      for (const id of unmatched) {
        const previous = tracks.get(id);
        const pc = centerOf(previous.boundingBox);
        const distance = Math.hypot(center.x - pc.x, center.y - pc.y);
        const cost = distance * 0.75 + (1 - iou(detection.boundingBox, previous.boundingBox)) * 0.25;
        if (distance <= CONFIG.POSE_MODEL.trackMatchDistance && cost < bestCost) {
          bestCost = cost;
          bestId = id;
        }
      }
      if (!bestId) bestId = `PERSON ${String(++sequence).padStart(2, '0')}`;
      unmatched.delete(bestId);
      const previous = tracks.get(bestId);
      tracks.set(bestId, { ...detection, lastSeenAt: now });
      engine.applyExternalTrack({
        trackingId: bestId,
        cameraId: 'CAM-LIVE',
        keypoints: detection.keypoints,
        boundingBox: detection.boundingBox,
        poseConfidence: detection.confidence
      }, previous ? Math.max(1, now - previous.lastSeenAt) : CONFIG.POSE_MODEL.inferenceIntervalMs);
    }

    for (const [id, track] of tracks) {
      if (now - track.lastSeenAt <= CONFIG.POSE_MODEL.trackExpireMs) continue;
      tracks.delete(id);
      engine.removeTrack(id);
      engine.forget?.(id);
    }
  }

  function processFrame(now) {
    if (!landmarker || status !== 'ready' || !video || video.readyState < 2) return;
    if (now - lastInferenceAt < CONFIG.POSE_MODEL.inferenceIntervalMs) return;
    if (video.currentTime === lastVideoTime) return;
    lastInferenceAt = now;
    lastVideoTime = video.currentTime;
    lastTimestamp = Math.max(lastTimestamp + 1, Math.round(now));
    const started = performance.now();
    try {
      const result = landmarker.detectForVideo(video, lastTimestamp);
      const detections = (result.landmarks || []).map(toDetection)
        .filter((d) => d.confidence >= CONFIG.THRESHOLDS.minPoseConfidence);
      assignTracks(detections, now);
      onInference?.({ people: detections.length, latencyMs: performance.now() - started });
    } catch (error) {
      console.error('[guardian] MediaPipe video inference failed.', error);
      report('error', error?.message || String(error));
    }
  }

  function reset() {
    for (const id of tracks.keys()) engine.removeTrack(id);
    tracks.clear();
    sequence = 0;
    lastInferenceAt = -Infinity;
    lastVideoTime = -1;
    lastTimestamp = 0;
  }

  return {
    initialize, processFrame, reset,
    get status() { return status; },
    get ready() { return Boolean(landmarker) && status === 'ready'; }
  };
}
