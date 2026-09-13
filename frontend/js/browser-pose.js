/**
 * GuardianMesh — real, local browser person detection and pose estimation.
 *
 * Runs YOLO26-pose through ONNX Runtime Web on frames taken straight from the
 * camera. Both the model and the runtime are served from this origin, so the
 * detector works on a venue network that can reach nothing else.
 *
 * Privacy: frames are read into a scratch canvas, turned into a tensor, and
 * overwritten by the next frame. Nothing is recorded, stored or uploaded, and
 * only anonymous normalised keypoints ever leave this module. The model detects
 * *people*, not identities — there is no face matching and no identity profile.
 */

import { CONFIG } from './config.js';

/**
 * COCO-17 keypoint order, exactly as YOLO26-pose emits them. The index is the
 * keypoint's position in each detection row.
 */
const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
];

/** Fixed layout of every output row: box, score, class, then the keypoints. */
const SCORE_INDEX = 4;
const KEYPOINT_OFFSET = 6;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Geometry of fitting a frameWidth x frameHeight frame into a square model
 * input without distorting it: uniform scale plus symmetric grey padding.
 */
export function letterboxFor(frameWidth, frameHeight, size) {
  const scale = Math.min(size / frameWidth, size / frameHeight);
  return {
    scale,
    width: Math.round(frameWidth * scale),
    height: Math.round(frameHeight * scale),
    padX: Math.floor((size - Math.round(frameWidth * scale)) / 2),
    padY: Math.floor((size - Math.round(frameHeight * scale)) / 2)
  };
}

/**
 * Decode a YOLO26-pose output tensor into anonymous detections whose
 * coordinates are normalised (0..1) against the source frame.
 *
 * Pure on purpose: this is the one piece of model-specific arithmetic in the
 * frontend, so it is unit-tested against real model output in
 * tests/yolo-decode.test.mjs rather than only exercised in a browser.
 *
 * @param {ArrayLike<number>} data flat [1, rows, stride] output
 * @param {number[]} dims tensor dims as reported by the runtime
 * @param {{frameWidth:number, frameHeight:number, letterbox:object,
 *          minConfidence?:number, maxPoses?:number}} options
 */
export function decodeDetections(data, dims, options) {
  const { frameWidth, frameHeight, letterbox } = options;
  const minConfidence = options.minConfidence ?? 0.5;
  const maxPoses = options.maxPoses ?? 4;
  const rows = dims[dims.length - 2];
  const stride = dims[dims.length - 1];

  const toX = (px) => clamp01((px - letterbox.padX) / letterbox.scale / frameWidth);
  const toY = (py) => clamp01((py - letterbox.padY) / letterbox.scale / frameHeight);

  const detections = [];
  // Rows arrive sorted by confidence, so the first row under threshold ends it.
  for (let r = 0; r < rows; r += 1) {
    const offset = r * stride;
    if (data[offset + SCORE_INDEX] < minConfidence) break;

    const x1 = toX(data[offset]);
    const y1 = toY(data[offset + 1]);
    const x2 = toX(data[offset + 2]);
    const y2 = toY(data[offset + 3]);
    const keypoints = KEYPOINT_NAMES.map((name, index) => {
      const base = offset + KEYPOINT_OFFSET + index * 3;
      return {
        name,
        x: toX(data[base]),
        y: toY(data[base + 1]),
        confidence: clamp01(data[base + 2])
      };
    });

    detections.push({
      keypoints,
      boundingBox: {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      },
      confidence: clamp01(data[offset + SCORE_INDEX])
    });
    if (detections.length >= maxPoses) break;
  }
  return detections;
}

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
  const size = CONFIG.POSE_MODEL.inputSize;

  let ort = null;
  let session = null;
  let backend = '';
  let initPromise = null;
  let status = 'idle';
  let lastInferenceAt = -Infinity;
  let lastVideoTime = -1;
  let sequence = 0;
  const tracks = new Map();

  // Scratch buffers, allocated once. Re-allocating a 1.2M-float tensor every
  // frame is the difference between a smooth demo and a stuttering one.
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const input = new Float32Array(1 * 3 * size * size);
  const plane = size * size;
  /** Letterbox geometry of the most recent frame, for mapping results back. */
  let letterbox = { scale: 1, padX: 0, padY: 0 };

  function report(next, detail = '') {
    status = next;
    onStatus?.(next, detail);
  }

  /**
   * Decide which execution providers to try.
   *
   * WebGPU is much faster than WASM on a real GPU and much SLOWER than it on a
   * software adapter — and a browser will happily report WebGPU support that is
   * backed by SwiftShader, llvmpipe or "Microsoft Basic Render". Detecting that
   * up front costs one adapter query; discovering it by timing an inference
   * costs tens of seconds of a live demo.
   *
   * `?ep=wasm` or `?ep=webgpu` forces one, for testing or for a presenter who
   * already knows what the machine does.
   */
  async function chooseProviders() {
    const wanted = CONFIG.POSE_MODEL.executionProviders.slice();
    const forced = new URLSearchParams(window.location.search).get('ep');
    if (forced) return [forced];

    const withoutGpu = wanted.filter((provider) => provider !== 'webgpu');
    if (!wanted.includes('webgpu')) return wanted;
    if (!navigator.gpu) return withoutGpu;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return withoutGpu;
      const info = adapter.info || (adapter.requestAdapterInfo
        ? await adapter.requestAdapterInfo() : {});
      const description = [info.vendor, info.architecture, info.device, info.description]
        .filter(Boolean).join(' ').toLowerCase();
      if (adapter.isFallbackAdapter
        || /swiftshader|llvmpipe|lavapipe|software|basic render|warp/.test(description)) {
        console.warn('[guardian] WebGPU here is a software adapter'
          + (description ? ` (${description})` : '') + '; using multi-threaded WASM instead.');
        return withoutGpu;
      }
    } catch (error) {
      console.warn('[guardian] WebGPU adapter query failed; using WASM.', error);
      return withoutGpu;
    }
    return wanted;
  }

  async function initialize() {
    if (session) return true;
    if (initPromise) return initPromise;
    report('loading');
    initPromise = (async () => {
      try {
        ort = await import(CONFIG.POSE_MODEL.runtimeUrl);
        ort.env.wasm.wasmPaths = CONFIG.POSE_MODEL.wasmRoot;
        // ORT's node-assignment notices are informational; at 'warning' they
        // reach the console as errors and look like a broken demo.
        ort.env.logLevel = 'error';
        // Threads need cross-origin isolation (see frontend/_headers). Asking
        // for them without it makes ORT fail rather than quietly run on one.
        ort.env.wasm.numThreads = self.crossOriginIsolated
          ? Math.min(4, navigator.hardwareConcurrency || 4)
          : 1;

        let lastError = null;
        for (const provider of await chooseProviders()) {
          try {
            session = await ort.InferenceSession.create(CONFIG.POSE_MODEL.modelUrl, {
              executionProviders: [provider],
              graphOptimizationLevel: 'all',
              logSeverityLevel: 3
            });
            backend = provider;
            break;
          } catch (error) {
            lastError = error;
            console.warn(`[guardian] YOLO26 could not start on ${provider}.`, error);
          }
        }
        if (!session) throw lastError || new Error('No execution provider available.');

        console.info(`[guardian] YOLO26-pose ready on ${backend}`
          + (backend === 'wasm' ? ` (${ort.env.wasm.numThreads} thread(s))` : ''));
        report('ready');
        return true;
      } catch (error) {
        console.error('[guardian] YOLO26 pose model failed to load.', error);
        report('error', error?.message || String(error));
        initPromise = null;
        return false;
      }
    })();
    return initPromise;
  }

  /**
   * Draw the frame into a letterboxed square and fill the NCHW tensor.
   * Padding is YOLO's neutral grey so the borders never read as content.
   */
  function writeInputTensor() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    letterbox = letterboxFor(vw, vh, size);

    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(video, letterbox.padX, letterbox.padY, letterbox.width, letterbox.height);

    const { data } = ctx.getImageData(0, 0, size, size);
    for (let i = 0, px = 0; px < plane; px += 1, i += 4) {
      input[px] = data[i] / 255;                 // R
      input[plane + px] = data[i + 1] / 255;     // G
      input[2 * plane + px] = data[i + 2] / 255; // B
    }
  }

  /**
   * Give every detection a stable anonymous id. Matching is by proximity and
   * overlap only — nothing about a person's appearance is stored or compared,
   * so an id means "the body we were following", never "this individual".
   */
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
    }
  }

  /**
   * Inference is async, so a frame is skipped rather than queued while the
   * previous one is still running. Back-pressure keeps latency honest.
   */
  let inFlight = false;

  function processFrame(now) {
    if (!session || status !== 'ready' || inFlight) return;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    if (now - lastInferenceAt < CONFIG.POSE_MODEL.inferenceIntervalMs) return;
    if (video.currentTime === lastVideoTime) return;
    lastInferenceAt = now;
    lastVideoTime = video.currentTime;
    inFlight = true;

    const started = performance.now();
    writeInputTensor();
    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    session.run({ images: tensor }).then((result) => {
      const output = result[session.outputNames[0]];
      const detections = decodeDetections(output.data, output.dims, {
        frameWidth: video.videoWidth,
        frameHeight: video.videoHeight,
        letterbox,
        minConfidence: CONFIG.POSE_MODEL.minPoseDetectionConfidence,
        maxPoses: CONFIG.POSE_MODEL.maxPoses
      });
      assignTracks(detections, performance.now());
      onInference?.({ people: detections.length, latencyMs: performance.now() - started, backend });
    }).catch((error) => {
      console.error('[guardian] YOLO26 inference failed.', error);
      report('error', error?.message || String(error));
    }).finally(() => {
      inFlight = false;
    });
  }

  function reset() {
    for (const id of tracks.keys()) engine.removeTrack(id);
    tracks.clear();
    sequence = 0;
    lastInferenceAt = -Infinity;
    lastVideoTime = -1;
  }

  return {
    initialize, processFrame, reset,
    get status() { return status; },
    get backend() { return backend; },
    get ready() { return Boolean(session) && status === 'ready'; }
  };
}
