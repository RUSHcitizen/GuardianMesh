/**
 * GuardianMesh — nearby response panel.
 * Uses camera/incident coordinates when available, otherwise browser location
 * with user permission. Coordinates are sent only to the backend lookup.
 */

import { apiUrl, authHeaders } from './config.js';
import { guardianState, subscribe, touched } from './state.js';
import { el } from './util.js';

const ACTIVE = new Set(['elevated', 'warning', 'critical']);
let created = false;

export function createNearbyResponsePanel() {
  if (created) return;
  created = true;

  const body = document.querySelector('.response-panel .panel__body');
  if (!body) return;

  const status = el('span', {
    class: 'panel__sub',
    text: 'Ready — waiting for a concerning movement pattern'
  });

  const findButton = el('button', {
    class: 'btn btn--sm btn--ghost',
    type: 'button',
    text: 'Find nearby help'
  });

  const header = el('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px'
  }, [
    el('div', {}, [
      el('h3', { class: 'subsection__title', text: 'Nearby Response' }),
      status
    ]),
    findButton
  ]);

  const groups = el('div', { class: 'nearby-response__groups' });
  const section = el('div', {
    class: 'recommended nearby-response',
    style: 'margin-top:16px'
  }, [header, groups]);

  const disclaimer = body.querySelector('.disclaimer');
  body.insertBefore(section, disclaimer || null);

  let lastKey = '';
  let requestSeq = 0;

  findButton.addEventListener('click', () => refresh(null, true));

  subscribe((state, changed) => {
    if (!touched(changed, 'incidents', 'cameras', 'backendStatus')) return;

    const incident = state.incidents.find(i =>
      i.status !== 'resolved' && ACTIVE.has(i.status)
    );

    if (!incident) {
      if (!groups.children.length) {
        status.textContent = state.backendStatus === 'connected'
          ? 'Ready — activates automatically when attention may be needed'
          : 'Connecting to nearby response service…';
      }
      return;
    }

    const key = `${incident.id}:${incident.status}:${incident.cameraId || ''}`;
    if (key !== lastKey) {
      lastKey = key;
      refresh(incident, false);
    }
  });

  async function refresh(incident, manual) {
    const seq = ++requestSeq;
    status.textContent = 'Locating nearby response options…';
    findButton.disabled = true;

    try {
      const coords = await resolveCoords(incident);
      if (seq !== requestSeq) return;

      if (!coords) {
        status.textContent = 'Location permission is needed to rank nearby response options';
        return;
      }

      const url = new URL(apiUrl('/nearby-help'));
      url.searchParams.set('lat', String(coords.lat));
      url.searchParams.set('lng', String(coords.lng));
      url.searchParams.set('limit', '5');
      url.searchParams.set('radius_m', '5000');

      const response = await fetch(url, { headers: authHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (seq !== requestSeq) return;

      renderResults(data);
      status.textContent = data.google_places_available
        ? 'Nearest response options ranked by distance'
        : 'Trusted responders loaded · public location lookup unavailable';
    } catch (err) {
      console.warn('[guardian] nearby response lookup unavailable:', err);
      status.textContent = manual
        ? 'Nearby response unavailable right now'
        : 'Nearby response will retry on the next relevant event';
    } finally {
      if (seq === requestSeq) findButton.disabled = false;
    }
  }

  async function resolveCoords(incident) {
    const direct = coordsFrom(incident);
    if (direct) return direct;

    const camera = guardianState.cameras.find(c => c.id === incident?.cameraId);
    const cameraCoords = coordsFrom(camera);
    if (cameraCoords) return cameraCoords;

    if (!navigator.geolocation) return null;

    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        position => resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        }),
        () => resolve(null),
        { enableHighAccuracy: false, maximumAge: 30000, timeout: 7000 }
      );
    });
  }

  function coordsFrom(record) {
    if (!record) return null;
    const lat = Number(record.lat ?? record.latitude);
    const lng = Number(record.lng ?? record.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  function renderResults(data) {
    const trusted = data.trusted || {};
    const specs = [
      ['First aid / care', data.first_aid || []],
      ['Facility staff', trusted.facility_staff || []],
      ['Designated responders', trusted.designated_responders || []],
      ['Security desks', trusted.security_desks || []]
    ];

    groups.replaceChildren(...specs.map(([title, items]) => buildGroup(title, items)));
  }

  function buildGroup(title, items) {
    const list = el('div', {
      class: 'responders',
      style: 'margin-top:6px'
    });

    if (!items.length) {
      list.append(el('div', {
        class: 'empty-state',
        style: 'padding:10px 0'
      }, [
        el('span', {
          class: 'empty-state__hint',
          text: `No ${title.toLowerCase()} configured nearby.`
        })
      ]));
    } else {
      for (const item of items.slice(0, 5)) list.append(buildItem(item));
    }

    return el('div', { style: 'margin-top:12px' }, [
      el('h4', { class: 'subsection__title', text: title }),
      list
    ]);
  }

  function buildItem(item) {
    const distance = Number(item.distance_meters);
    const meta = [
      Number.isFinite(distance) ? `${Math.round(distance)} m` : null,
      item.address || null
    ].filter(Boolean).join(' · ');

    const actions = [];
    if (item.maps_url) {
      actions.push(el('a', {
        class: 'btn btn--sm btn--ghost',
        href: item.maps_url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Open in Maps'
      }));
    }

    return el('div', {
      class: 'responder',
      dataset: { status: 'tracking' }
    }, [
      el('span', { class: 'dot' }),
      el('div', { class: 'responder__body' }, [
        el('span', { class: 'responder__name', text: item.label || 'Nearby resource' }),
        el('span', {
          class: 'responder__role',
          text: meta || String(item.category || '').replace(/_/g, ' ')
        })
      ]),
      el('div', { style: 'display:flex;gap:6px;align-items:center' }, actions)
    ]);
  }
}
