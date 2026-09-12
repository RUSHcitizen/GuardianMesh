/**
 * GuardianMesh — incident feed.
 *
 * Incident cards are rendered from data; nothing is hard-coded in HTML.
 * Filters are presentation-only and never mutate the incident list.
 */

import { $, $$, el, replay, show } from './util.js';
import { bandFor } from './guardian-score.js';

const STATUS_LABELS = {
  observing: 'Observing',
  elevated: 'Elevated',
  warning: 'Warning',
  critical: 'Critical',
  resolving: 'Resolving',
  resolved: 'Resolved'
};

const ACTIVE_STATUSES = new Set(['observing', 'elevated', 'warning', 'critical', 'resolving']);

export function createIncidentFeed() {
  const list = $('#incident-list');
  const empty = $('#incident-empty');
  const emptyTitle = empty.querySelector('.empty-state__title');
  const emptyHint = empty.querySelector('.empty-state__hint');
  const filters = $('#incident-filters');
  let activeFilter = 'all';
  let lastState = null;

  filters.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-filter]');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    $$('button[data-filter]', filters).forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn))
    );
    if (lastState) render(lastState);
  });

  function matches(incident) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'active') return ACTIVE_STATUSES.has(incident.status);
    if (activeFilter === 'critical') return incident.status === 'critical';
    if (activeFilter === 'resolved') return incident.status === 'resolved';
    return true;
  }

  function metric(label, value, status) {
    return el('div', { class: 'incident__metric' }, [
      el('span', { class: 'label', text: label }),
      el('span', { class: 'value', text: value, dataset: status ? { status } : {} })
    ]);
  }

  function buildCard(incident) {
    const scoreBand = bandFor(incident.guardianScore).key;
    const classes = ['incident'];
    if (incident.isNew) classes.push('incident--enter');
    if (incident.didEscalate) classes.push('incident--escalate');

    return el('article', {
      class: classes.join(' '),
      dataset: { status: incident.status, id: incident.id }
    }, [
      el('div', { class: 'incident__head' }, [
        el('span', { class: 'badge', dataset: { status: incident.status },
          text: STATUS_LABELS[incident.status] || incident.status }),
        el('span', { class: 'incident__id', text: incident.id })
      ]),
      el('h3', { class: 'incident__label', text: incident.label }),
      el('div', { class: 'incident__where' }, [
        el('span', {}, ['Track ', el('b', { text: incident.trackingId })]),
        el('span', {}, ['Camera ', el('b', { text: incident.cameraId })]),
        el('span', { text: incident.location }),
        el('span', {}, ['at ', el('b', { text: incident.timestamp || '—' })])
      ]),
      el('div', { class: 'incident__metrics' }, [
        metric('Confidence', `${Math.round((incident.confidence || 0) * 100)}%`, 'tracking'),
        metric('Guardian Score', Number(incident.guardianScore || 0).toFixed(1), scoreBand),
        metric('Immobility', `${Math.round(incident.immobilitySeconds || 0)} s`,
          incident.immobilitySeconds > 10 ? 'warning' : null)
      ]),
      el('div', { class: 'incident__status', dataset: { status: incident.status } }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'label', text: 'Status' }),
        el('strong', { text: incident.responseState || '—' })
      ])
    ]);
  }

  function render(state) {
    lastState = state;
    const visible = state.incidents.filter(matches);
    const hasAny = state.incidents.length > 0;

    if (visible.length === 0) {
      list.replaceChildren();
      emptyTitle.textContent = hasAny ? 'No matching incidents' : 'No active incidents';
      emptyHint.textContent = hasAny
        ? 'No incidents match the selected filter.'
        : 'All monitored areas are clear.';
      show(empty, true);
      return;
    }

    show(empty, false);
    const cards = visible.map(buildCard);
    list.replaceChildren(...cards);

    // replay the escalation flourish once, on the card that just escalated
    visible.forEach((incident, i) => {
      if (incident.didEscalate) replay(cards[i], 'incident--escalate');
    });
  }

  return { render };
}

