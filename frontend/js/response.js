/**
 * GuardianMesh — response mesh (simulated).
 *
 * Activates responder nodes and surfaces recommended actions when concern
 * becomes elevated. The workflow itself is simulated; the one live call is the
 * Nearby Response lookup, which queries our own backend (never Google directly)
 * once per warning/critical incident location.
 */

import { $, el, show } from './util.js';
import { coordinatesOf, fetchNearbyHelp } from './datasource.js';

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

/** Incident statuses that trigger a nearby-response lookup. */
const NEARBY_TRIGGER_STATUSES = new Set(['warning', 'critical']);
const NEARBY_LIMIT = 5;

/** Response groups, in display order. `trusted` groups are people/desks from the registry. */
const NEARBY_GROUPS = [
  { title: 'First-aid / care locations', pick: (d) => d.first_aid, trusted: false },
  { title: 'Facility staff', pick: (d) => d.trusted?.facility_staff, trusted: true },
  { title: 'Designated responders', pick: (d) => d.trusted?.designated_responders, trusted: true },
  { title: 'Security desks', pick: (d) => d.trusted?.security_desks, trusted: true }
];

const TRUSTED_ROLE_LABELS = {
  facility_staff: 'Facility staff',
  designated_responder: 'Designated responder',
  security_desk: 'Security desk'
};

const humanize = (value) => {
  const text = String(value || '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unspecified';
};

const distanceOf = (r) => (Number.isFinite(Number(r.distance_meters)) ? Number(r.distance_meters) : Infinity);

/** Only http(s) links are rendered, so a bad maps_url can never become a script URL. */
function safeMapsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function createResponsePanel() {
  const stateEl = $('#response-state');
  const stateValue = $('#response-state-value');
  const list = $('#responder-list');
  const recList = $('#recommended-list');
  const recEmpty = $('#recommended-empty');
  const nearbyHint = $('#nearby-help-hint');
  const nearbyList = $('#nearby-help-list');
  const nearbyEmpty = $('#nearby-help-empty');
  const nearbyEmptyHint = nearbyEmpty?.querySelector('.empty-state__hint');
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

  /* -- nearby response -------------------------------------------------------
   * When an incident reaches warning/critical and its location is known
   * (incident coordinates, else its camera's), ask OUR backend -- never Google
   * directly, so no API key reaches the browser -- for nearby response options.
   * Results are cached per incident + location, so score updates and
   * re-renders never re-query the endpoint.
   */

  /** lookup key -> { status: 'loading' | 'ready' | 'failed', data? } */
  const lookups = new Map();
  let lastNearbyState = null;
  let lastBackendStatus = null;
  let renderedNearbyView = '';

  function setNearbyHint(text) {
    if (nearbyHint) nearbyHint.textContent = text;
  }

  function setNearbyEmpty(text) {
    show(nearbyEmpty, Boolean(text));
    if (nearbyEmptyHint && text) nearbyEmptyHint.textContent = text;
  }

  /** Newest warning/critical incident, preferring one whose location can be resolved. */
  function nearbyTarget(state) {
    const candidates = (state.incidents || []).filter((i) => NEARBY_TRIGGER_STATUSES.has(i.status));
    for (const incident of candidates) {
      let coords = coordinatesOf(incident);
      if (coords.lat == null) {
        coords = coordinatesOf((state.cameras || []).find((c) => c.id === incident.cameraId));
      }
      if (coords.lat != null) {
        const key = `${incident.id}@${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
        return { incident, key, ...coords };
      }
    }
    return candidates.length ? { incident: candidates[0], key: null } : null;
  }

  function startLookup(target) {
    lookups.set(target.key, { status: 'loading' });
    fetchNearbyHelp({ lat: target.lat, lng: target.lng, limit: NEARBY_LIMIT })
      .then((data) => lookups.set(target.key, { status: 'ready', data }))
      .catch((err) => {
        console.warn('[guardian] nearby-help lookup failed:', err?.message || err);
        lookups.set(target.key, { status: 'failed' });
      })
      .finally(() => {
        if (lastNearbyState) renderNearby(lastNearbyState);
      });
  }

  function buildNearbyItem(r, trusted) {
    const role = TRUSTED_ROLE_LABELS[r.category];
    // Trusted people: role + anonymous registry ID only. The registry label is
    // never shown, since it could contain a name or other personal detail.
    const label = trusted
      ? `${role || 'Trusted responder'}${r.id ? ` (${r.id})` : ''}`
      : (r.label || 'Unnamed location');
    const category = trusted ? (role || humanize(r.category)) : humanize(r.category);
    // Address / map links describe places; for trusted entries only a desk is a place.
    const isPlace = !trusted || r.category === 'security_desk';
    const address = isPlace && r.address ? String(r.address) : null;
    const mapsUrl = isPlace && r.maps_url ? safeMapsUrl(r.maps_url) : null;
    const distance = distanceOf(r);

    return el('div', { class: 'nearby-item' }, [
      el('div', { class: 'nearby-item__body' }, [
        el('span', { class: 'nearby-item__label', text: label }),
        el('span', {
          class: 'nearby-item__meta',
          text: `${category} - ${Number.isFinite(distance) ? `${Math.round(distance)} m` : 'distance unknown'}`
        }),
        address ? el('span', { class: 'nearby-item__addr', text: address }) : null
      ]),
      mapsUrl
        ? el('a', {
          class: 'nearby-item__link', href: mapsUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Maps'
        })
        : null
    ]);
  }

  function renderNearbyResults(data) {
    const groups = NEARBY_GROUPS.map((group) => {
      const picked = group.pick(data);
      const rows = (Array.isArray(picked) ? picked.slice() : [])
        .sort((a, b) => distanceOf(a) - distanceOf(b))
        .slice(0, NEARBY_LIMIT);
      let note = null;
      if (!group.trusted && data.google_places_available === false) note = 'Public location lookup unavailable';
      else if (rows.length === 0) note = 'None found nearby';

      return el('div', { class: 'nearby-group' }, [
        el('h4', { class: 'nearby-group__title', text: group.title }),
        note ? el('p', { class: 'nearby-group__note', text: note }) : null,
        ...rows.map((r) => buildNearbyItem(r, group.trusted))
      ]);
    });
    nearbyList.replaceChildren(...groups);
    setNearbyEmpty(null);
  }

  function renderNearby(state) {
    lastNearbyState = state;

    // Backend just came (back) online: give previously failed locations one fresh attempt.
    if (state.backendStatus === 'connected' && lastBackendStatus !== 'connected') {
      for (const [key, entry] of lookups) {
        if (entry.status === 'failed') lookups.delete(key);
      }
    }
    lastBackendStatus = state.backendStatus;

    const target = nearbyTarget(state);
    let entry = target?.key ? lookups.get(target.key) : null;
    if (target?.key && !entry && state.backendStatus === 'connected') {
      startLookup(target);
      entry = lookups.get(target.key);
    }

    const where = target ? (target.incident.location || target.incident.cameraId || 'a monitored area') : '';
    const view = !target ? 'idle'
      : !target.key ? `nocoords|${where}`
        : `${target.key}|${entry ? entry.status : 'offline'}|${where}`;
    if (view === renderedNearbyView) return;
    renderedNearbyView = view;

    if (!target) {
      nearbyList.replaceChildren();
      setNearbyHint('Nearby response options appear when a situation needs attention.');
      setNearbyEmpty('No active warning or critical incidents.');
      return;
    }

    const attention = `Attention may be needed near ${where}.`;
    if (!target.key) {
      nearbyList.replaceChildren();
      setNearbyHint(`${attention} Location coordinates are not available for this incident.`);
      setNearbyEmpty('Nearby response unavailable');
      return;
    }
    if (!entry || entry.status === 'failed') {
      nearbyList.replaceChildren();
      setNearbyHint(attention);
      setNearbyEmpty('Nearby response unavailable');
      return;
    }
    if (entry.status === 'loading') {
      nearbyList.replaceChildren();
      setNearbyHint(`${attention} Looking up nearby response options...`);
      setNearbyEmpty(null);
      return;
    }

    setNearbyHint(`${attention} Nearest response options, closest first.`);
    renderNearbyResults(entry.data || {});
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

  return { render, renderNearby };
}




