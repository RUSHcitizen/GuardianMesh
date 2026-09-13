/**
 * GuardianMesh — response mesh (simulated).
 *
 * Activates responder nodes and surfaces recommended actions when concern
 * becomes elevated. The workflow itself is simulated; the one live call is the
 * Nearby Response lookup, which queries our own backend (never Google directly)
 * once per warning/critical incident location.
 */

import { $, el, show } from './util.js';
import { coordinatesOf, fetchCameras, fetchNearbyHelp } from './datasource.js';
import { recordMapsHelp } from './state.js';

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

/** cam_02, CAM-02 and cam02 all name the same camera. */
const cameraKey = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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

/** The browser webcam's camera ID (see app.js clearLocalAssessment). */
const LOCAL_WEBCAM_ID = 'CAM-LIVE';

/**
 * @param {{deviceLocation?: ReturnType<import('./device-location.js').createDeviceLocation>}} deps
 *   deviceLocation supplies coordinates for the local webcam, whose location is this device's.
 */
export function createResponsePanel({ deviceLocation = null } = {}) {
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
  /** Registry camera coordinates by camera key; null until fetched (at most once per connection). */
  let registryCoords = null;
  let registryRequested = false;
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
      // The webcam is this device, so its location wins for webcam incidents.
      if (coords.lat == null && incident.cameraId === LOCAL_WEBCAM_ID && deviceLocation?.coords) {
        coords = deviceLocation.coords;
      }
      if (coords.lat == null) {
        coords = coordinatesOf((state.cameras || []).find((c) => c.id === incident.cameraId));
      }
      if (coords.lat == null && registryCoords) {
        coords = registryCoords.get(cameraKey(incident.cameraId)) || {};
      }
      // Other cameras only fall back to it when the operator explicitly chose to share it.
      if (coords.lat == null && deviceLocation?.shared && deviceLocation.coords) {
        coords = deviceLocation.coords;
      }
      if (coords.lat != null) {
        const key = `${incident.id}@${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
        return { incident, key, ...coords };
      }
    }
    return candidates.length ? { incident: candidates[0], key: null } : null;
  }

  /**
   * The browser-inference path never loads the backend's camera list, so an
   * incident there has no coordinates. Ask the camera registry once — only when
   * an incident actually needs a lookup, so an idle demo makes no requests.
   */
  function loadRegistryCoords() {
    registryRequested = true;
    fetchCameras().then((cameras) => {
      registryCoords = new Map();
      for (const cam of cameras) {
        const coords = coordinatesOf(cam);
        if (coords.lat != null) registryCoords.set(cameraKey(cam.id || cam.camera_id), coords);
      }
      if (lastNearbyState) {
        renderedNearbyView = '';
        renderNearby(lastNearbyState);
      }
    });
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

  function buildNearbyItem(r, trusted, incidentId) {
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

    let link = null;
    if (mapsUrl) {
      link = el('a', {
        class: 'nearby-item__link', href: mapsUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open in Maps'
      });
      // Opening a Google Places result is the operator getting help for this incident.
      if (r.source === 'google_places' && incidentId) {
        link.addEventListener('click', () => recordMapsHelp(incidentId));
      }
    }

    return el('div', { class: 'nearby-item' }, [
      el('div', { class: 'nearby-item__body' }, [
        el('span', { class: 'nearby-item__label', text: label }),
        el('span', {
          class: 'nearby-item__meta',
          text: `${category} - ${Number.isFinite(distance) ? `${Math.round(distance)} m` : 'distance unknown'}`
        }),
        address ? el('span', { class: 'nearby-item__addr', text: address }) : null
      ]),
      link
    ]);
  }

  function renderNearbyResults(data, incidentId) {
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
        ...rows.map((r) => buildNearbyItem(r, group.trusted, incidentId))
      ]);
    });
    nearbyList.replaceChildren(...groups);
    setNearbyEmpty(null);
  }

  function renderNearby(state) {
    lastNearbyState = state;

    // Backend just came (back) online: give previously failed lookups one fresh attempt.
    if (state.backendStatus === 'connected' && lastBackendStatus !== 'connected') {
      for (const [key, entry] of lookups) {
        if (entry.status === 'failed') lookups.delete(key);
      }
      registryRequested = false;
    }
    lastBackendStatus = state.backendStatus;

    const target = nearbyTarget(state);
    if (target && !target.key && !registryRequested) loadRegistryCoords();
    // One REST call per incident + location. It is attempted whether or not the
    // realtime stream is attached (the deployed Worker answers it on the page's
    // own origin); a failure is cached, so an offline backend is never spammed.
    let entry = target?.key ? lookups.get(target.key) : null;
    if (target?.key && !entry && state.backendStatus !== 'connecting') {
      startLookup(target);
      entry = lookups.get(target.key);
    }

    const where = target ? (target.incident.location || target.incident.cameraId || 'a monitored area') : '';
    const view = !target ? 'idle'
      : !target.key ? `nocoords|${where}|${state.deviceLocationStatus || 'idle'}|${Boolean(state.deviceLocationShared)}|${Boolean(registryCoords)}`
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
      const locationStatus = deviceLocation ? deviceLocation.status : 'idle';
      if (locationStatus === 'locating') {
        nearbyList.replaceChildren();
        setNearbyHint(`${attention} Getting this device's location...`);
        setNearbyEmpty(null);
        return;
      }
      if (registryRequested && !registryCoords) {
        nearbyList.replaceChildren();
        setNearbyHint(`${attention} Looking up this camera's location...`);
        setNearbyEmpty(null);
        return;
      }
      if (!deviceLocation) {
        nearbyList.replaceChildren();
        setNearbyHint(`${attention} Location coordinates are not available for this incident.`);
        setNearbyEmpty('Nearby response unavailable');
        return;
      }
      // Never a dead end: the operator can always choose to use this device's
      // location (first time, after a denial, or when the prompt went unanswered).
      const useDevice = el('button', {
        class: 'btn btn--sm', type: 'button', text: "Use this device's location"
      });
      useDevice.addEventListener('click', () => deviceLocation.request({ explicit: true }));
      nearbyList.replaceChildren(useDevice);
      setNearbyHint(locationStatus === 'denied'
        ? `${attention} Location access is blocked. Allow location for this site in the browser, then retry.`
        : locationStatus === 'unavailable'
          ? `${attention} This device's location could not be determined. Try again?`
          : `${attention} This camera's location isn't known. Use this device's location to find nearby help.`);
      setNearbyEmpty(null);
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
    renderNearbyResults(entry.data || {}, target.incident.id);
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
