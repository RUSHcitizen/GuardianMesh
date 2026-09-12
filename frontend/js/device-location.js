/**
 * GuardianMesh — device location for the local webcam.
 *
 * In live-camera mode the camera is this device's webcam, so the device's
 * location is the camera's location. It is requested (with the browser's
 * permission prompt) only when the operator starts the webcam, kept in memory
 * for the session, and used for one purpose: the Nearby Response lookup on this
 * site's own backend. It is never stored, logged, or attached to incidents.
 *
 * Status is mirrored into shared state as `deviceLocationStatus` so panels
 * re-render: idle | locating | ready | denied | unavailable.
 */

import { update } from './state.js';

// ~11 m precision is plenty to rank nearby help and avoids sending a pin-point fix.
const round4 = (value) => Math.round(value * 1e4) / 1e4;

export function createDeviceLocation() {
  let coords = null;
  let status = 'idle';
  let pending = null;
  let generation = 0;

  function setStatus(next) {
    status = next;
    update({ deviceLocationStatus: next });
  }

  /** Ask the browser for this device's position. Safe to call repeatedly. */
  function request() {
    if (coords) return Promise.resolve(coords);
    if (pending) return pending;
    if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
      setStatus('unavailable');
      return Promise.resolve(null);
    }
    setStatus('locating');
    const requestGeneration = generation;
    pending = new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          // the operator switched source (or stopped) while the prompt was open
          if (requestGeneration !== generation) return resolve(null);
          coords = { lat: round4(position.coords.latitude), lng: round4(position.coords.longitude) };
          pending = null;
          setStatus('ready');
          resolve(coords);
        },
        (error) => {
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
    if (status !== 'idle') setStatus('idle');
  }

  return {
    request,
    forget,
    get coords() { return coords; },
    get status() { return status; }
  };
}
