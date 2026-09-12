/**
 * GuardianMesh â€” system header status rail.
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
    const onlineCameras = state.cameras.filter((c) => c.online !== false).length;
    const activeIncidents = state.incidents.filter((i) => i.status !== 'resolved').length;
    const criticalIncidents = state.incidents.filter((i) => i.status === 'critical').length;
    const backendStatus = { connected: 'online', reconnecting: 'observing', disconnected: 'offline' }[state.backendStatus] || 'offline';
    const backendLabel = { connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Unavailable' }[state.backendStatus] || 'Unavailable';

    rail.replaceChildren(
      stat('System', state.systemStatus === 'online' ? 'Online' : 'Degraded',
        state.systemStatus === 'online' ? 'online' : 'observing'),
      stat('Cameras', `${onlineCameras} / ${state.cameras.length}`,
        onlineCameras === state.cameras.length ? 'online' : 'observing'),
      stat('AI engine', state.aiEngine === 'active' ? 'Active' : 'Unavailable',
        state.aiEngine === 'active' ? 'tracking' : 'offline'),
      stat('Backend', backendLabel, backendStatus),
      stat('People', String(state.trackedPeople.length), 'tracking'),
      stat('Incidents', String(activeIncidents),
        criticalIncidents ? 'critical' : activeIncidents ? 'observing' : 'online'),
      stat('Latency', `${Math.round(state.latencyMs)} ms`,
        state.latencyMs < 120 ? 'online' : 'observing', true),
      stat('Privacy', 'Anonymous', 'online', true)
    );
  }

  return { render };
}


