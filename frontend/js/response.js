/**
 * GuardianMesh — response mesh (simulated).
 *
 * Activates responder nodes and surfaces recommended actions when concern
 * becomes elevated. Nothing here contacts an external service; the workflow is
 * a demonstration of what a coordinated response would look like.
 */

import { $, el, show } from './util.js';

const WORKFLOW_LABELS = {
  idle: 'Idle',
  received: 'Incident received',
  notified: 'Responder notified',
  acknowledged: 'Acknowledged',
  en_route: 'En route',
  resolved: 'Resolved'
};

const WORKFLOW_STATUS = {
  idle: 'idle',
  received: 'observing',
  notified: 'warning',
  acknowledged: 'warning',
  en_route: 'tracking',
  resolved: 'resolved'
};

/** Compact labels for the responder rows, which sit in a narrow column. */
const RESPONDER_LABELS = {
  idle: 'Idle',
  notified: 'Notified',
  acknowledged: 'Acknowledged',
  en_route: 'En route',
  resolved: 'Resolved'
};

const RESPONDER_STATUS = {
  idle: 'idle',
  notified: 'warning',
  acknowledged: 'tracking',
  en_route: 'tracking',
  resolved: 'resolved'
};

export function createResponsePanel() {
  const stateEl = $('#response-state');
  const stateValue = $('#response-state-value');
  const list = $('#responder-list');
  const recList = $('#recommended-list');
  const recEmpty = $('#recommended-empty');
  let renderedRecs = [];

  function buildResponder(responder) {
    const status = RESPONDER_STATUS[responder.state] || 'idle';
    return el('div', {
      class: `responder${responder.state !== 'idle' && responder.state !== 'resolved' ? ' responder--active' : ''}`,
      dataset: { status, id: responder.id }
    }, [
      el('span', { class: 'dot' }),
      el('div', { class: 'responder__body' }, [
        el('span', { class: 'responder__name', text: responder.name }),
        el('span', { class: 'responder__role', text: responder.role })
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        el('span', { class: 'responder__link', 'aria-hidden': 'true' }),
        el('span', {
          class: 'responder__state',
          text: (RESPONDER_LABELS[responder.state] || responder.state).toUpperCase()
        })
      ])
    ]);
  }

  function render(state) {
    const status = WORKFLOW_STATUS[state.responseState] || 'idle';
    stateEl.dataset.status = status;
    stateValue.textContent = WORKFLOW_LABELS[state.responseState] || state.responseState;

    list.replaceChildren(...state.responders.map(buildResponder));

    const recs = state.recommendations || [];
    show(recEmpty, recs.length === 0);
    const changed = recs.length !== renderedRecs.length
      || recs.some((r, i) => r !== renderedRecs[i]);
    if (changed) {
      recList.replaceChildren(...recs.map((text) =>
        el('div', { class: 'rec-item rec-item--enter' }, [
          el('span', { class: 'rec-item__mark', text: '▸' }),
          el('span', { text })
        ])
      ));
      renderedRecs = recs.slice();
    }
  }

  return { render };
}
