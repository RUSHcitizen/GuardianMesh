/**
 * GuardianMesh — system header status rail.
 */

import { $, el } from './util.js';

export function createSystemHeader() {
  const rail = $('#status-rail');

  function stat(label, value, status, optional) {
    return el('div', { class: 'stat', dataset: optional ? { optional: 'true' } : {} }, [
      status ? el('span', { class: 'dot', dataset: { status } }) : null,
      el('div', { class: 'stat__body' }, [
        el('span', { class: 'stat__label', text: label }),
        el('span', {
          class: 'stat__value',
          text: value,
          dataset: status ? { status } : {}
        })
      ])
    ]);
  }

  function render(state) {
    const activeIncidents = state.incidents.filter((i) => i.status !== 'resolved').length;
    const criticalIncidents = state.incidents.filter((i) => i.status === 'critical').length;
    // Detection runs entirely in this browser, so there is normally no backend
    // to report on and a permanent "Backend: Offline" chip is just alarming
    // noise. The chip appears only when a backend is actually in play.
    const usingBackend = ['connected', 'reconnecting', 'disconnected'].includes(state.backendStatus);
    const backendStatus = {
      connected: 'online', reconnecting: 'observing', disconnected: 'offline'
    }[state.backendStatus];
    const backendLabel = {
      connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Offline'
    }[state.backendStatus];
    const model = {
      loading: ['Model loading', 'observing'], ready: ['Model ready', 'tracking'],
      error: ['Model error', 'offline'], active: ['Model ready', 'tracking'],
      unavailable: ['Model error', 'offline']
    }[state.aiEngine] || ['Model loading', 'observing'];
    const camera = {
      off: ['Camera off', 'offline'], starting: ['Starting', 'observing'], live: ['Camera live', 'online'],
      denied: ['Permission denied', 'offline'], error: ['Camera error', 'offline']
    }[state.cameraStatus] || ['Camera off', 'offline'];

    rail.replaceChildren(...[
      stat('System', state.systemStatus === 'online' ? 'Online' : 'Degraded',
        state.systemStatus === 'online' ? 'online' : 'observing'),
      stat('Camera', camera[0], camera[1]),
      stat('AI engine', model[0], model[1]),
      usingBackend ? stat('Backend', backendLabel, backendStatus) : null,
      stat('People', String(state.trackedPeople.length), 'tracking'),
      stat('Incidents', String(activeIncidents),
        criticalIncidents ? 'critical' : activeIncidents ? 'observing' : 'online'),
      stat('Inference', state.latencyMs ? `${Math.round(state.latencyMs)} ms` : 'Waiting',
        state.latencyMs && state.latencyMs < 120 ? 'online' : 'observing', true),
      stat('Privacy', 'Anonymous', 'online', true)
    ].filter(Boolean));
  }

  return { render };
}
