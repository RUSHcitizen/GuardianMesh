"""
GuardianMesh: Camera location registry

Maps camera IDs to a human-readable location and lat/lng so incidents and
camera payloads can carry coordinates (used by the frontend's nearby-response
lookup). Loaded from the JSON file named by GUARDIANMESH_CAMERAS_FILE; see
backend/cameras.example.json for the shape.

Coordinates describe where a camera is mounted — never where a person is.
"""

import json
import logging
import os
import re
from typing import Dict, Optional

logger = logging.getLogger(__name__)

_cache: Optional[Dict[str, dict]] = None
_cache_key = None


def normalize_camera_id(camera_id: str) -> str:
    """cam_02, CAM-02 and cam02 all refer to the same camera."""
    return re.sub(r"[^a-z0-9]", "", str(camera_id or "").lower())


def valid_coordinates(lat, lng) -> bool:
    return (
        isinstance(lat, (int, float)) and not isinstance(lat, bool)
        and isinstance(lng, (int, float)) and not isinstance(lng, bool)
        and -90 <= lat <= 90 and -180 <= lng <= 180
    )


def _load() -> Dict[str, dict]:
    global _cache, _cache_key
    path = os.getenv("GUARDIANMESH_CAMERAS_FILE")
    try:
        mtime = os.path.getmtime(path) if path else None
    except OSError:
        mtime = None
    key = (path, mtime)
    if _cache is not None and key == _cache_key:
        return _cache

    cameras: Dict[str, dict] = {}
    if path:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            logger.warning("Camera registry file not found: %s", path)
            data = []
        except (json.JSONDecodeError, OSError) as error:
            logger.warning("Could not read camera registry: %s", type(error).__name__)
            data = []

        if not isinstance(data, list):
            logger.warning("Camera registry must contain a JSON array; ignoring")
            data = []

        for entry in data:
            if not isinstance(entry, dict) or not entry.get("id"):
                continue
            record = {
                "id": str(entry["id"]),
                "label": entry.get("label"),
                "location": entry.get("location"),
                "lat": None,
                "lng": None,
            }
            if valid_coordinates(entry.get("lat"), entry.get("lng")):
                record["lat"] = float(entry["lat"])
                record["lng"] = float(entry["lng"])
            cameras[normalize_camera_id(entry["id"])] = record

    _cache, _cache_key = cameras, key
    return cameras


def get_camera(camera_id: str) -> Optional[dict]:
    return _load().get(normalize_camera_id(camera_id))


def all_cameras() -> Dict[str, dict]:
    return dict(_load())
