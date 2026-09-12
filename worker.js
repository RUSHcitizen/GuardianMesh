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
