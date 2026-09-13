/**
 * GuardianMesh — device location for the local webcam.
 *
 * In live-camera mode the camera is this device's webcam, so the device's
 * location is the camera's location. It is requested (with the browser's
 * permission prompt) only when the operator starts the webcam, kept in memory
 * for the session, and used for one purpose: the Nearby Response lookup on this
 * site's own backend. It is never stored, logged, or attached to incidents.
 *
 * The operator can also choose "Use this device's location" for an incident
 * whose camera location is unknown (simulation, video file, unregistered
 * camera); that explicit choice is tracked as `shared`.
 *
 * Status is mirrored into shared state as `deviceLocationStatus` (idle |
 * locating | ready | denied | unavailable) plus `deviceLocationShared`, so
 * panels re-render.
 */

import { update } from './state.js';

// Chrome's own timeout only starts after permission is granted, so an ignored
// prompt would otherwise leave the lookup "locating" forever.
const PROMPT_WATCHDOG_MS = 20000;

// ~11 m precision is plenty to rank nearby help and avoids sending a pin-point fix.
const round4 = (value) => Math.round(value * 1e4) / 1e4;

export function createDeviceLocation() {
  let coords = null;
  let status = 'idle';
  let pending = null;
  let generation = 0;
  let shared = false;

  function setStatus(next) {
    status = next;
    update({ deviceLocationStatus: next, deviceLocationShared: shared });
  }

  /**
   * Ask the browser for this device's position. Safe to call repeatedly.
   * @param {{explicit?: boolean}} opts explicit = the operator chose to use this
   *        device's location for incidents whose camera location is unknown.
   */
  function request({ explicit = false } = {}) {
    if (explicit && !shared) {
      shared = true;
      if (coords) setStatus('ready'); // already located: just re-render with the new choice
    }
    if (coords) return Promise.resolve(coords);
    if (pending) return pending;
    if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
      setStatus('unavailable');
      return Promise.resolve(null);
    }
    setStatus('locating');
    const requestGeneration = generation;
    pending = new Promise((resolve) => {
      const watchdog = window.setTimeout(() => {
        if (requestGeneration !== generation || status !== 'locating') return;
        generation += 1; // ignore a late answer from the abandoned prompt
        pending = null;
        setStatus('unavailable');
        resolve(null);
      }, PROMPT_WATCHDOG_MS);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          // the operator switched source (or stopped) while the prompt was open
          window.clearTimeout(watchdog);
          if (requestGeneration !== generation) return resolve(null);
          coords = { lat: round4(position.coords.latitude), lng: round4(position.coords.longitude) };
          pending = null;
          setStatus('ready');
          resolve(coords);
        },
        (error) => {
          window.clearTimeout(watchdog);
          if (requestGeneration !== generation) return resolve(null);
          pending = null;
          setStatus(error?.code === 1 ? 'denied' : 'unavailable');
          resolve(null);
        },
        { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 10000 }
      );
    });
    return pending;
  }

  /** Drop the position, e.g. when the source switches away from the webcam. */
  function forget() {
    generation += 1;
    coords = null;
    pending = null;
    const wasShared = shared;
    shared = false;
    if (status !== 'idle' || wasShared) setStatus('idle');
  }

  return {
    request,
    forget,
    get coords() { return coords; },
    get shared() { return shared; },
    get status() { return status; }
  };
}
