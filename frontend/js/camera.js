/**
 * GuardianMesh — camera stage controller.
 *
 * Owns the three stacked layers of the hero panel:
 *   scene canvas  (simulated feed)  →  <video> (webcam / file)  →  overlay canvas
 *
 * Source priority: an explicit file/webcam choice, then CONFIG.VIDEO_SOURCE_URL,
 * then the deterministic simulated scene. The overlay is source-agnostic — it
 * always draws the current tracks, so swapping the feed never touches the
 * tracking code.
 */

import { CONFIG } from './config.js';
import { createScene } from './scene.js';
import { createPoseOverlay } from './pose-overlay.js';
import { $, show } from './util.js';

export function createCamera(refs) {
  const { stage, video, sceneCanvas, overlayCanvas } = refs;
  const scene = createScene(sceneCanvas);
  const overlay = createPoseOverlay(overlayCanvas);

  const stateEl = $('#stage-state');
  const stateTitle = $('#stage-state-title');
  const stateHint = $('#stage-state-hint');
  const feedState = $('#hud-feed-state');

  let mode = 'simulated'; // simulated | webcam | file
  let stream = null;
  let fileUrl = null;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn({ mode });
  }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* -- stage states -------------------------------------------------------- */

  function showStageState(title, hint) {
    if (stateTitle) stateTitle.textContent = title;
    if (stateHint) stateHint.textContent = hint;
    show(stateEl, true);
  }
  function hideStageState() { show(stateEl, false); }

  function setFeedLabel(text, status) {
    if (!feedState) return;
    feedState.dataset.status = status;
    const dot = feedState.querySelector('.dot');
    feedState.textContent = ' ' + text;
    if (dot) feedState.prepend(dot);
  }

  /* -- sources ------------------------------------------------------------- */

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (fileUrl) {
      URL.revokeObjectURL(fileUrl);
      fileUrl = null;
    }
  }

  function useSimulated() {
    stopStream();
    video.removeAttribute('src');
    video.srcObject = null;
    video.hidden = true;
    sceneCanvas.hidden = false;
    mode = 'simulated';
    overlay.setContentSource(null);
    hideStageState();
    setFeedLabel('Simulated feed', 'active');
    emit();
  }

  async function useWebcam() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showStageState('Camera unavailable', 'This browser did not expose a capture device. Simulated feed retained.');
      window.setTimeout(hideStageState, 3200);
      return false;
    }
    try {
      showStageState('Waiting for camera', 'Requesting capture permission…');
      const next = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      stopStream();
      stream = next;
      video.srcObject = next;
      video.hidden = false;
      sceneCanvas.hidden = true;
      mode = 'webcam';
      await video.play().catch(() => {});
      overlay.setContentSource(video);
      hideStageState();
      setFeedLabel('Webcam live', 'active');
      emit();
      return true;
    } catch (err) {
      console.warn('[guardian] webcam unavailable:', err?.name || err);
      showStageState('Camera offline', 'Capture permission denied or no device present. Simulated feed retained.');
      window.setTimeout(() => { hideStageState(); useSimulated(); }, 2600);
      return false;
    }
  }

  function useVideoUrl(url, label = 'Recorded feed') {
    stopStream();
    video.srcObject = null;
    video.src = url;
    video.loop = true;
    video.hidden = false;
    sceneCanvas.hidden = true;
    mode = 'file';
    video.play().catch(() => {});
    video.addEventListener('loadedmetadata', () => overlay.setContentSource(video), { once: true });
    video.onerror = () => {
      console.warn('[guardian] video source failed, returning to simulated feed');
      showStageState('Feed unavailable', 'The video source could not be decoded. Simulated feed retained.');
      window.setTimeout(() => { hideStageState(); useSimulated(); }, 2400);
    };
    hideStageState();
    setFeedLabel(label, 'active');
    emit();
  }

  function useFile(file) {
    if (!file) return;
    fileUrl = URL.createObjectURL(file);
    useVideoUrl(fileUrl, 'Recorded feed');
  }

  /* -- stage status / rendering -------------------------------------------- */

  function setStatus(status) {
    stage.dataset.status = status;
  }

  function pulseCritical() {
    stage.classList.remove('pulse-once');
    void stage.offsetWidth;
    stage.classList.add('pulse-once');
  }

  function resize() {
    scene.resize();
    overlay.resize();
    overlay.setContentSource(mode === 'simulated' ? null : video);
  }

  function render(people, t) {
    if (mode === 'simulated') scene.render(people, t);
    overlay.render(people);
  }

  /* -- wiring -------------------------------------------------------------- */

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => resize()).observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }

  if (CONFIG.VIDEO_SOURCE_URL) useVideoUrl(CONFIG.VIDEO_SOURCE_URL, 'Recorded feed');
  else useSimulated();

  return {
    useSimulated, useWebcam, useFile, useVideoUrl,
    setStatus, pulseCritical, render, resize, onChange,
    showStageState, hideStageState,
    overlay,
    get mode() { return mode; }
  };
}
