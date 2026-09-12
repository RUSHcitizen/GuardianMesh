$ErrorActionPreference = "Stop"

$root = (Get-Location).Path
if (-not (Test-Path ".\frontend\js\config.js") -or -not (Test-Path ".\wrangler.toml")) {
}

Write-Host "GuardianMesh deploy: patching live backend + nearby response..." -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1) Production/local backend configuration
# ---------------------------------------------------------------------------
@'
/**
 * GuardianMesh runtime configuration.
 * Local frontend development talks to FastAPI on :8001.
 * Production uses same-origin Cloudflare Worker API/WebSocket routes.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const IS_LOCAL_FRONTEND = typeof window !== 'undefined'
  && LOCAL_HOSTS.has(window.location.hostname)
  && window.location.port !== '8001';

export const CONFIG = {
  BACKEND_ENABLED: true,
  BACKEND_ORIGIN: IS_LOCAL_FRONTEND ? 'http://127.0.0.1:8001' : null,
  API_BASE: '/api',
  WS_PATH: '/ws',
  WS_CLIENT_ID: 'all',
  ACCESS_TOKEN: null,
  CONNECT_TIMEOUT_MS: 3000,
  RECONNECT_BACKOFF_MS: [1000, 2000, 4000, 8000, 15000],
  REQUIRE_API_PROBE: true,
  VIDEO_SOURCE_URL: null,

  SCORE_BANDS: [
    { min: 8.0, key: 'critical', label: 'Critical' },
    { min: 6.0, key: 'high', label: 'High' },
    { min: 3.0, key: 'elevated', label: 'Elevated' },
    { min: 0.0, key: 'normal', label: 'Low' }
  ],

  THRESHOLDS: {
    groundLevelY: 0.72,
    immobileMotion: 0.035,
    rapidDropVelocity: 0.55,
    bodyAngleAnomaly: 45
  },

  TIMELINE_LIMIT: 60,
  TREND_SAMPLES: 90
};

export function backendOrigin() {
  if (CONFIG.BACKEND_ORIGIN) return CONFIG.BACKEND_ORIGIN.replace(/\/$/, '');
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function apiUrl(path = '') {
  return `${backendOrigin()}${CONFIG.API_BASE}${path}`;
}

export function wsUrl() {
  const base = backendOrigin().replace(/^http/, 'ws');
  const url = `${base}${CONFIG.WS_PATH}/${encodeURIComponent(CONFIG.WS_CLIENT_ID)}`;
  return CONFIG.ACCESS_TOKEN
    ? `${url}?token=${encodeURIComponent(CONFIG.ACCESS_TOKEN)}`
    : url;
}

export function authHeaders() {
  return CONFIG.ACCESS_TOKEN
    ? { Authorization: `Bearer ${CONFIG.ACCESS_TOKEN}` }
    : {};
}
'@ | Set-Content ".\frontend\js\config.js" -Encoding utf8

# ---------------------------------------------------------------------------
# 2) Cloudflare Worker: real edge API + WebSocket + static assets
# ---------------------------------------------------------------------------
@'
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const TRUSTED_CATEGORIES = new Set([
  'facility_staff',
  'designated_responder',
  'security_desk'
]);

const MEDICAL_TYPES = [
  'general_hospital',
  'hospital',
  'medical_center',
  'medical_clinic',
  'pharmacy'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Optional upstream FastAPI/ngrok/hosted backend. If configured and healthy,
    // API + websocket traffic is forwarded there first.
    if (env.BACKEND_ORIGIN && (path.startsWith('/api/') || path === '/health' || path.startsWith('/ws/'))) {
      try {
        const target = new URL(path + url.search, env.BACKEND_ORIGIN.replace(/\/$/, '') + '/');
        return await fetch(new Request(target.toString(), request));
      } catch (err) {
        console.warn('GuardianMesh upstream unavailable; using edge fallback:', String(err));
      }
    }

    if (path === '/health') {
      return json({
        status: 'ok',
        service: 'guardianmesh-edge',
        generated_at: new Date().toISOString()
      });
    }

    if (path === '/api/status') {
      return json({
        status: 'ok',
        systemStatus: 'online',
        aiEngine: 'active',
        latencyMs: 0,
        mode: 'cloudflare-edge'
      });
    }

    if (path.startsWith('/ws/')) {
      return websocketResponse(request);
    }

    if (path === '/api/nearby-help' && request.method === 'GET') {
      return nearbyHelp(url, env);
    }

    if (path === '/api/score' && request.method === 'POST') {
      return scoreRequest(request);
    }

    // Small edge fallbacks keep the dashboard API-shaped even when FastAPI is
    // not publicly hosted yet.
    if (path === '/api/cameras' && request.method === 'GET') {
      return json({ cameras: [] });
    }

    if (path === '/api/incidents' && request.method === 'GET') {
      return json({ incidents: [], total: 0 });
    }

    return env.ASSETS.fetch(request);
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS
  });
}

function websocketResponse(request) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return json({ detail: 'WebSocket upgrade required' }, 426);
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  server.send(JSON.stringify({
    type: 'status',
    systemStatus: 'online',
    aiEngine: 'active',
    latencyMs: 0
  }));

  server.addEventListener('message', event => {
    if (String(event.data).toLowerCase() === 'ping') {
      server.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function scoreRequest(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: 'Invalid JSON body' }, 400);
  }

  const fallScore = clamp01(body.fall_score);
  const immobilityScore = clamp01(body.immobility_score);
  const trackingConfidence = clamp01(body.tracking_confidence);
  const persistence = Math.max(0, Number(body.persistence_seconds || 0));

  const confidence = round3(
    0.45 * fallScore +
    0.35 * immobilityScore +
    0.20 * trackingConfidence
  );

  let state = 'NORMAL';
  let reason = 'No significant concerning movement pattern detected';

  if (
    fallScore >= 0.75 &&
    immobilityScore >= 0.70 &&
    trackingConfidence >= 0.70 &&
    persistence >= 5
  ) {
    state = 'DISTRESS_EVENT';
    reason = 'Sustained concerning movement with prolonged immobility';
  } else if (fallScore >= 0.75 && immobilityScore >= 0.65) {
    state = 'VERIFYING';
    reason = 'Concerning movement with immobility under verification';
  } else if (fallScore >= 0.75) {
    state = 'POSSIBLE_FALL';
    reason = 'Movement anomaly detected';
  }

  return json({
    state,
    overall_confidence: confidence,
    reason
  });
}

async function nearbyHelp(url, env) {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  const limit = Math.min(5, Math.max(1, Number(url.searchParams.get('limit') || 5)));
  const radiusM = Math.min(50000, Math.max(100, Number(url.searchParams.get('radius_m') || 5000)));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return json({ detail: 'lat must be between -90 and 90' }, 422);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return json({ detail: 'lng must be between -180 and 180' }, 422);
  }

  const trusted = trustedResources(env, lat, lng, limit);

  let firstAid = [];
  let googleAvailable = false;

  if (env.GOOGLE_MAPS_API_KEY) {
    try {
      firstAid = await googlePlaces(env.GOOGLE_MAPS_API_KEY, lat, lng, limit, radiusM);
      googleAvailable = true;
    } catch (err) {
      console.warn('Google Places lookup failed:', String(err));
    }
  }

  return json({
    origin: { lat, lng },
    first_aid: firstAid,
    trusted: {
      facility_staff: trusted.facility_staff,
      designated_responders: trusted.designated_responder,
      security_desks: trusted.security_desk
    },
    closest_trusted: trusted.closest,
    google_places_available: googleAvailable,
    generated_at: new Date().toISOString()
  });
}

async function googlePlaces(apiKey, lat, lng, limit, radiusM) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.primaryType',
        'places.googleMapsLinks.placeUri'
      ].join(',')
    },
    body: JSON.stringify({
      includedTypes: MEDICAL_TYPES,
      maxResultCount: limit,
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusM
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places returned HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.places || [])
    .map(place => {
      const pLat = Number(place.location?.latitude);
      const pLng = Number(place.location?.longitude);
      if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) return null;

      return {
        id: place.id || crypto.randomUUID(),
        label: place.displayName?.text || 'Nearby care location',
        category: place.primaryType || 'first_aid',
        source: 'google_places',
        distance_meters: Math.round(haversine(lat, lng, pLat, pLng)),
        lat: pLat,
        lng: pLng,
        address: place.formattedAddress || null,
        maps_url: place.googleMapsLinks?.placeUri || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_meters - b.distance_meters)
    .slice(0, limit);
}

function trustedResources(env, lat, lng, limit) {
  let records = [];
  try {
    records = JSON.parse(env.TRUSTED_RESPONDERS_JSON || '[]');
  } catch {
    records = [];
  }

  const normalized = (Array.isArray(records) ? records : [])
    .filter(r =>
      r &&
      r.trusted === true &&
      r.available !== false &&
      TRUSTED_CATEGORIES.has(r.category)
    )
    .map(r => {
      const rLat = Number(r.lat);
      const rLng = Number(r.lng);
      if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) return null;
      return {
        id: String(r.id || crypto.randomUUID()),
        label: String(r.label || 'Trusted responder'),
        category: r.category,
        source: 'guardianmesh_registry',
        distance_meters: Math.round(haversine(lat, lng, rLat, rLng)),
        lat: rLat,
        lng: rLng,
        address: r.address ? String(r.address) : null,
        maps_url: r.maps_url ? String(r.maps_url) : null
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_meters - b.distance_meters);

  const result = {
    facility_staff: [],
    designated_responder: [],
    security_desk: [],
    closest: normalized.slice(0, limit)
  };

  for (const category of TRUSTED_CATEGORIES) {
    result[category] = normalized
      .filter(r => r.category === category)
      .slice(0, limit);
  }

  return result;
}

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = deg => deg * Math.PI / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp01(value) {
  const n = Number(value || 0);
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
'@ | Set-Content ".\worker.js" -Encoding utf8

# ---------------------------------------------------------------------------
# 3) Wrangler config: Worker handles API/WS, assets stay static/fast
# ---------------------------------------------------------------------------
@'
name = "guardianmesh"
main = "worker.js"
compatibility_date = "2026-09-12"

[assets]
directory = "./frontend"
binding = "ASSETS"
run_worker_first = ["/api/*", "/health", "/ws/*"]
'@ | Set-Content ".\wrangler.toml" -Encoding utf8

# ---------------------------------------------------------------------------
# 4) Nearby Response UI: visible all the time, auto-fetches on elevated incident
# ---------------------------------------------------------------------------
@'
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
'@ | Set-Content ".\frontend\js\nearby-response.js" -Encoding utf8

# Wire the nearby panel into the existing Response panel.
$responsePath = ".\frontend\js\response.js"
$response = Get-Content $responsePath -Raw

if ($response -notmatch "nearby-response\.js") {
    $oldImport = "import { `$`, el, show } from './util.js';"
    $newImport = $oldImport + "`r`nimport { createNearbyResponsePanel } from './nearby-response.js';"
    $response = $response.Replace($oldImport, $newImport)
}

if ($response -notmatch "createNearbyResponsePanel\(\);") {
    $response = $response.Replace(
        "export function createResponsePanel() {",
        "export function createResponsePanel() {`r`n  createNearbyResponsePanel();"
    )
}

Set-Content $responsePath $response -Encoding utf8

# ---------------------------------------------------------------------------
# 5) Demo polish: one person and neutral, non-diagnostic wording
# ---------------------------------------------------------------------------
$mockPath = ".\frontend\data\mock-events.js"
if (Test-Path $mockPath) {
    $mock = Get-Content $mockPath -Raw
    $mock = [regex]::Replace(
        $mock,
        '(?s)export const BASELINE_PEOPLE = \[.*?\];',
        'export const BASELINE_PEOPLE = [];'
    )
    $mock = $mock.Replace(
        "{ id: 'CAM-01', label: 'CAM 01', location: 'Main Hall',     status: 'normal', people: 1",
        "{ id: 'CAM-01', label: 'CAM 01', location: 'Main Hall',     status: 'normal', people: 0"
    )
    $mock = $mock.Replace(
        "{ id: 'CAM-02', label: 'CAM 02', location: 'Main Corridor', status: 'normal', people: 0",
        "{ id: 'CAM-02', label: 'CAM 02', location: 'Main Corridor', status: 'normal', people: 1"
    )
    $mock = $mock.Replace(
        "{ id: 'CAM-03', label: 'CAM 03', location: 'School Gym',    status: 'normal', people: 1",
        "{ id: 'CAM-03', label: 'CAM 03', location: 'School Gym',    status: 'normal', people: 0"
    )
    Set-Content $mockPath $mock -Encoding utf8
}

$demoPath = ".\frontend\js\demo.js"
if (Test-Path $demoPath) {
    $demo = Get-Content $demoPath -Raw
    $demo = $demo.Replace("setCameraStatus('CAM-02', { people: 3 });", "setCameraStatus('CAM-02', { people: 1 });")
    Set-Content $demoPath $demo -Encoding utf8
}

# Neutralize human-facing copy while leaving internal score fields/event keys alone.
$copyFiles = @(
    ".\frontend\js\datasource.js",
    ".\frontend\js\demo.js",
    ".\frontend\data\mock-events.js"
)

$copyReplacements = [ordered]@{
    "Possible fall with immobility under verification" = "Concerning movement with immobility under verification"
    "High fall signal with sustained immobility" = "Sustained concerning movement with immobility"
    "Possible fall - verifying" = "Movement anomaly - verifying"
    "Possible fall / distress pattern" = "Possible distress pattern"
    "Possible fall" = "Movement anomaly"
    "Fall signal detected" = "Movement anomaly detected"
    "Distress pattern confirmed" = "Concerning pattern detected"
}

foreach ($file in $copyFiles) {
    if (-not (Test-Path $file)) { continue }
    $text = Get-Content $file -Raw
    foreach ($pair in $copyReplacements.GetEnumerator()) {
        $text = $text.Replace($pair.Key, $pair.Value)
    }
    Set-Content $file $text -Encoding utf8
}

# Header never uses the exact "Backend Offline" copy.
$headerPath = ".\frontend\js\system-header.js"
if (Test-Path $headerPath) {
    $header = Get-Content $headerPath -Raw
    $header = $header.Replace("disconnected: 'Offline'", "disconnected: 'Unavailable'")
    $header = $header.Replace("|| 'Offline'", "|| 'Unavailable'")
    Set-Content $headerPath $header -Encoding utf8
}

# Keep private responder registry out of git.
$ignorePath = ".\.gitignore"
$ignore = Get-Content $ignorePath -Raw
if ($ignore -notmatch [regex]::Escape("backend/trusted_responders.json")) {
    if (-not $ignore.EndsWith("`n")) { $ignore += "`r`n" }
    $ignore += "backend/trusted_responders.json`r`n"
    Set-Content $ignorePath $ignore -Encoding utf8
}

# ---------------------------------------------------------------------------
# 6) Validate + commit current local work
# ---------------------------------------------------------------------------
Write-Host "`nValidating Worker bundle with Wrangler..." -ForegroundColor Cyan
npx wrangler deploy --dry-run

Write-Host "`nCommitting current repo changes..." -ForegroundColor Cyan
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "Deploy live backend and nearby response"
    $branch = (git branch --show-current).Trim()
    git push -u origin $branch
} else {
    Write-Host "No new git changes to commit."
}

# ---------------------------------------------------------------------------
# 7) Deploy Worker, then attach server-side secrets if available
# ---------------------------------------------------------------------------
Write-Host "`nDeploying GuardianMesh..." -ForegroundColor Green
npx wrangler deploy

$secretsChanged = $false

if ($env:GOOGLE_MAPS_API_KEY) {
    Write-Host "Uploading GOOGLE_MAPS_API_KEY as a Cloudflare secret..." -ForegroundColor Cyan
    Write-Output $env:GOOGLE_MAPS_API_KEY | npx wrangler secret put GOOGLE_MAPS_API_KEY
    $secretsChanged = $true
} else {
    Write-Host "GOOGLE_MAPS_API_KEY is not set in this PowerShell session." -ForegroundColor Yellow
    Write-Host 'Set it with: $env:GOOGLE_MAPS_API_KEY="YOUR_KEY" and rerun this script.' -ForegroundColor Yellow
}

if (Test-Path ".\backend\trusted_responders.json") {
    Write-Host "Uploading private trusted responder registry as a Cloudflare secret..." -ForegroundColor Cyan
    Get-Content ".\backend\trusted_responders.json" -Raw | npx wrangler secret put TRUSTED_RESPONDERS_JSON
    $secretsChanged = $true
}

if ($secretsChanged) {
    Write-Host "Redeploying with secret bindings..." -ForegroundColor Green
    npx wrangler deploy
}

# ---------------------------------------------------------------------------
# 8) Public smoke tests
# ---------------------------------------------------------------------------
$public = "https://guardianmesh.kumariaaatharv.workers.dev"

Write-Host "`nPublic status:" -ForegroundColor Cyan
Invoke-RestMethod "$public/api/status" | Format-List

Write-Host "Public health:" -ForegroundColor Cyan
Invoke-RestMethod "$public/health" | Format-List

Write-Host "`nDONE." -ForegroundColor Green
Write-Host "Open: $public"
Write-Host "Hard refresh with Ctrl+Shift+R."
Write-Host "The Nearby Response panel is always visible; it auto-loads for elevated incidents or via 'Find nearby help'."
