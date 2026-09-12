/**
 * GuardianMesh — camera stage controller.
 *
 * Owns the three stacked layers of the hero panel:
 *   scene canvas  (simulated feed)  →  <video> (webcam / file)  →  overlay canvas
 *
 * Live camera errors remain visible and never fall back to simulation. The
 * deterministic scene is reachable only through the explicit DEV flag.
 */

import { CONFIG } from './config.js';
import { createScene } from './scene.js';
import { createPoseOverlay } from './pose-overlay.js';
import { $, show, clamp } from './util.js';

export function createCamera(refs, { allowSimulation = false } = {}) {
  const { stage, video, sceneCanvas, overlayCanvas } = refs;
  const scene = createScene(sceneCanvas);
  const overlay = createPoseOverlay(overlayCanvas);

  // Layers that must zoom together so the auto-focus stays visually registered.
  const focusLayers = [sceneCanvas, video, overlayCanvas];
  for (const layer of focusLayers) {
    layer.style.transition = 'transform 500ms ease, transform-origin 500ms ease';
  }
  let focusedTrackId = null;

  const stateEl = $('#stage-state');
  const stateTitle = $('#stage-state-title');
  const stateHint = $('#stage-state-hint');
  const feedState = $('#hud-feed-state');

  let mode = 'off'; // off | simulated(dev only) | webcam | file
  let cameraStatus = 'off';
  let lastError = '';
  let stream = null;
  let fileUrl = null;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn({ mode, status: cameraStatus, error: lastError });
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

  function useOff() {
    stopStream();
    video.pause();
    video.removeAttribute('src');
    video.srcObject = null;
    video.hidden = true;
    sceneCanvas.hidden = true;
    mode = 'off';
    cameraStatus = 'off';
    lastError = '';
    overlay.reset();
    overlay.setContentSource(null);
    showStageState('Camera off', 'Press Start Live Camera to begin local pose detection.');
    setFeedLabel('Camera off', 'offline');
    emit();
  }

  function useSimulated() {
    if (!allowSimulation) {
      console.warn('[guardian] simulated feed is disabled outside /?dev=simulation.');
      return false;
    }
    stopStream();
    video.removeAttribute('src');
    video.srcObject = null;
    video.hidden = true;
    sceneCanvas.hidden = false;
    mode = 'simulated';
    cameraStatus = 'live';
    lastError = '';
    overlay.setContentSource(null);
    hideStageState();
    setFeedLabel('Simulated feed', 'active');
    clearFocus();
    emit();
    return true;
  }

  async function useWebcam() {
    if (!navigator.mediaDevices?.getUserMedia) {
      mode = 'off';
      cameraStatus = 'error';
      lastError = 'Camera capture is unavailable in this browser.';
      showStageState('Camera unavailable', lastError);
      setFeedLabel('Camera error', 'offline');
      emit();
      return false;
    }
    try {
      cameraStatus = 'starting';
      lastError = '';
      showStageState('Waiting for camera', 'Requesting capture permission…');
      setFeedLabel('Requesting camera', 'observing');
      emit();
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
      cameraStatus = 'live';
      lastError = '';
      overlay.setContentSource(video);
      hideStageState();
      setFeedLabel('Webcam live', 'active');
      clearFocus();
      emit();
      return true;
    } catch (err) {
      console.error('[guardian] webcam unavailable:', err);
      stopStream();
      video.hidden = true;
      sceneCanvas.hidden = true;
      mode = 'off';
      cameraStatus = err?.name === 'NotAllowedError' ? 'denied' : 'error';
      lastError = cameraStatus === 'denied'
        ? 'Camera permission was denied. Allow camera access in the browser and try again.'
        : 'No usable camera was found. Check the device and try again.';
      showStageState(cameraStatus === 'denied' ? 'Camera permission denied' : 'Camera error', lastError);
      setFeedLabel(cameraStatus === 'denied' ? 'Permission denied' : 'Camera error', 'offline');
      emit();
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
    cameraStatus = 'starting';
    lastError = '';
    video.play().catch(() => {});
    video.addEventListener('loadedmetadata', () => {
      overlay.setContentSource(video);
      cameraStatus = 'live';
      hideStageState();
      setFeedLabel(label, 'active');
      emit();
    }, { once: true });
    video.onerror = () => {
      console.error('[guardian] selected video source could not be decoded.');
      cameraStatus = 'error';
      lastError = 'The selected video could not be decoded.';
      showStageState('Feed unavailable', lastError);
      setFeedLabel('Video error', 'offline');
      emit();
    };
    showStageState('Loading video', 'Preparing the selected video for local pose detection…');
    setFeedLabel('Loading video', 'observing');
    clearFocus();
    emit();
  }

  function useFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    useVideoUrl(url, 'Recorded feed');
    fileUrl = url;
  }

  /* -- stage status / rendering -------------------------------------------- */

  const STAGE_LABELS = {
    normal: 'Normal', observing: 'Observing', elevated: 'Elevated',
    warning: 'Elevated', critical: 'Critical', offline: 'Offline'
  };

  /** Set the stage state and the panel badge together. */
  function setStatus(status, label) {
    stage.dataset.status = status;
    const badge = document.getElementById('camera-badge');
    if (badge) {
      badge.dataset.status = status;
      badge.textContent = label || STAGE_LABELS[status] || status;
    }
  }

  function pulseCritical() {
    stage.classList.remove('pulse-once');
    void stage.offsetWidth;
    stage.classList.add('pulse-once');
  }

  /* -- auto-focus ------------------------------------------------------------
   * Rather than asserting a diagnosis ("fall detected" / person down), the
   * stage responds to a critical status by zooming the feed toward the
   * tracked person's body so an operator can visually verify what's
   * happening. Clears itself the moment nobody is in a critical state.
   */

  function clearFocus() {
    if (focusedTrackId === null) return;
    focusedTrackId = null;
    for (const layer of focusLayers) {
      layer.style.transform = '';
      layer.style.transformOrigin = '';
    }
    stage.classList.remove('stage--focused');
  }

  function focusOnBody(person) {
    const b = person.boundingBox;
    if (!b) { clearFocus(); return; }
    focusedTrackId = person.trackingId;
    const originX = clamp((b.x + b.width / 2) * 100, 4, 96);
    const originY = clamp((b.y + b.height / 2) * 100, 4, 96);
    for (const layer of focusLayers) {
      layer.style.transformOrigin = `${originX}% ${originY}%`;
      layer.style.transform = 'scale(1.6)';
    }
    stage.classList.add('stage--focused');
  }

  function resize() {
    scene.resize();
    overlay.resize();
    overlay.setContentSource(mode === 'simulated' ? null : video);
  }

  function render(people, t) {
    if (mode === 'simulated') scene.render(people, t);
    overlay.render(people);

    const critical = people.find((p) => p.status === 'critical' && p.boundingBox);
    if (critical) focusOnBody(critical);
    else clearFocus();
  }

  /* -- wiring -------------------------------------------------------------- */

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => resize()).observe(stage);
  } else {
    window.addEventListener('resize', resize);
  }

  if (CONFIG.VIDEO_SOURCE_URL) useVideoUrl(CONFIG.VIDEO_SOURCE_URL, 'Recorded feed');
  else useOff();

  return {
    useOff, useSimulated, useWebcam, useFile, useVideoUrl,
    setStatus, pulseCritical, render, resize, onChange,
    showStageState, hideStageState,
    overlay,
    get mode() { return mode; },
    get status() { return cameraStatus; },
    get video() { return video; }
  };
}
