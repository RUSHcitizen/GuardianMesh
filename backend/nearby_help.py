"""
GuardianMesh: Nearby-help lookup

Combines two independent sources into one response:
- Public first-aid-capable locations from Google Places API (New). This is
  public map data only — it cannot identify private staff or verify anyone
  as a trusted responder.
- Trusted internal responders (facility staff, designated responders,
  security desks) from a locally-configured registry file, matched by
  straight-line (Haversine) distance.

Google Places failures are non-fatal: trusted responders are always returned
even if the public lookup times out or is unreachable.
"""

import asyncio
import json
import logging
import math
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)

GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
GOOGLE_PLACES_TIMEOUT_SECONDS = 4
GOOGLE_PLACES_FIELD_MASK = (
    "places.id,places.displayName,places.formattedAddress,"
    "places.location,places.primaryType,places.googleMapsUri"
)
GOOGLE_PLACES_INCLUDED_TYPES = [
    "hospital",
    "general_hospital",
    "medical_center",
    "medical_clinic",
    "pharmacy",
]

TRUSTED_CATEGORIES = {"facility_staff", "designated_responder", "security_desk"}

# Response bucket each trusted category is grouped under.
CATEGORY_RESPONSE_KEYS = {
    "facility_staff": "facility_staff",
    "designated_responder": "designated_responders",
    "security_desk": "security_desks",
}


def haversine_distance_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two lat/lng points, in meters."""
    earth_radius_m = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * earth_radius_m * math.asin(math.sqrt(a))


def _load_trusted_responders_raw() -> List[dict]:
    """Read and loosely validate the trusted-responder registry file."""
    path = os.getenv("GUARDIANMESH_TRUSTED_RESPONDERS_FILE")
    if not path:
        return []

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        logger.warning("Trusted responder file not found: %s", path)
        return []
    except (json.JSONDecodeError, OSError) as error:
        logger.warning("Could not read trusted responder file: %s", type(error).__name__)
        return []

    if not isinstance(data, list):
        logger.warning("Trusted responder file must contain a JSON array; ignoring")
        return []

    valid = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        if entry.get("category") not in TRUSTED_CATEGORIES:
            continue
        if not entry.get("trusted") or not entry.get("available"):
            continue
        if not isinstance(entry.get("lat"), (int, float)) or not isinstance(entry.get("lng"), (int, float)):
            continue
        valid.append(entry)
    return valid


def _normalize_trusted(entry: dict, distance_m: float) -> dict:
    return {
        "id": entry.get("id"),
        "label": entry.get("label"),
        "category": entry.get("category"),
        "source": "guardianmesh_registry",
        "distance_meters": round(distance_m),
        "lat": entry["lat"],
        "lng": entry["lng"],
        "address": None,
        "maps_url": None,
    }


def get_trusted_nearby(lat: float, lng: float, limit: int) -> Tuple[Dict[str, List[dict]], List[dict]]:
    """
    Returns (by_category, closest_overall):
    - by_category groups up to `limit` trusted responders per category,
      sorted ascending by distance.
    - closest_overall merges every trusted category and returns the nearest
      5 responders total, regardless of category.
    """
    responders = _load_trusted_responders_raw()

    scored = [
        (haversine_distance_meters(lat, lng, entry["lat"], entry["lng"]), entry)
        for entry in responders
    ]
    scored.sort(key=lambda pair: pair[0])

    by_category: Dict[str, List[dict]] = {key: [] for key in CATEGORY_RESPONSE_KEYS.values()}
    for distance_m, entry in scored:
        response_key = CATEGORY_RESPONSE_KEYS[entry["category"]]
        if len(by_category[response_key]) < limit:
            by_category[response_key].append(_normalize_trusted(entry, distance_m))

    closest_overall = [_normalize_trusted(entry, distance_m) for distance_m, entry in scored[:5]]

    return by_category, closest_overall


def _fetch_google_places_sync(lat: float, lng: float, limit: int, radius_m: float) -> Tuple[List[dict], bool]:
    """
    Blocking Google Places (New) searchNearby call. Never raises — network
    or API failures are reported via the returned availability flag so
    trusted responders can still be served.
    """
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        logger.info("GOOGLE_MAPS_API_KEY not set; skipping Google Places lookup")
        return [], False

    body = json.dumps({
        "includedTypes": GOOGLE_PLACES_INCLUDED_TYPES,
        "maxResultCount": limit,
        "rankPreference": "DISTANCE",
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": radius_m,
            }
        },
    }).encode("utf-8")

    request = urllib.request.Request(
        GOOGLE_PLACES_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=GOOGLE_PLACES_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        # Never log the request/response bodies or headers here — the API
        # key travels in a header and must never reach the logs.
        logger.warning("Google Places lookup failed: %s", type(error).__name__)
        return [], False

    places = []
    for place in payload.get("places", []):
        location = place.get("location") or {}
        place_lat = location.get("latitude")
        place_lng = location.get("longitude")
        if place_lat is None or place_lng is None:
            continue
        places.append({
            "id": place.get("id"),
            "label": (place.get("displayName") or {}).get("text"),
            "category": place.get("primaryType") or "first_aid",
            "source": "google_places",
            "distance_meters": round(haversine_distance_meters(lat, lng, place_lat, place_lng)),
            "lat": place_lat,
            "lng": place_lng,
            "address": place.get("formattedAddress"),
            "maps_url": place.get("googleMapsUri"),
        })

    places.sort(key=lambda p: p["distance_meters"])
    return places[:limit], True


async def get_nearby_help(lat: float, lng: float, limit: int, radius_m: float) -> dict:
    """Build the full nearby-help response: public first-aid + trusted registry."""
    first_aid, google_places_available = await asyncio.to_thread(
        _fetch_google_places_sync, lat, lng, limit, radius_m
    )
    trusted_by_category, closest_trusted = get_trusted_nearby(lat, lng, limit)

    return {
        "origin": {"lat": lat, "lng": lng},
        "first_aid": first_aid,
        "trusted": trusted_by_category,
        "closest_trusted": closest_trusted,
        "google_places_available": google_places_available,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
