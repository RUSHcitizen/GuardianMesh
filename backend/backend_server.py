"""
GuardianMesh: Backend Server
FastAPI server for event ingestion, storage, and real-time WebSocket streaming.
 
Run from the repository root with:
    python -m uvicorn backend.backend_server:app --reload --host 127.0.0.1 --port 8000

Endpoints:
    POST /api/events               - Ingest event from CV pipeline
    WebSocket /ws/{client_id}      - Subscribe to real-time events ("all" = every camera)
    GET /api/cameras               - List cameras (registry + recently active)
    GET /api/cameras/{camera_id}   - Get camera + recent incidents
    GET /api/incidents             - Query incidents (with filters)
    POST /api/incidents/{id}/acknowledge - Mark incident as reviewed
    GET /api/nearby-help           - Nearby first-aid + trusted responders
"""

from fastapi import FastAPI, WebSocket, HTTPException, Query, Depends
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, func, inspect, text, Column, String, Float, DateTime, Integer, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from sqlalchemy.sql import desc
from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime, timedelta, timezone
import asyncio
import json
import logging
from typing import Dict, List, Optional, Set
from collections import defaultdict, deque
import os

from backend.camera_registry import all_cameras, get_camera, normalize_camera_id, valid_coordinates
from backend.nearby_help import get_nearby_help
 
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================================
# DISTRESS SCORING (shared by /api/events and /api/score)
# ============================================================================

def compute_score(
    fall_score: float,
    immobility_score: float,
    tracking_confidence: float,
    persistence_seconds: float = 0.0,
) -> dict:
    """
    Derive distress state, confidence, and human-readable reason from
    raw CV metrics. Same logic as python-engine/main.py's /score endpoint.
    """
    overall_confidence = round(
        0.45 * fall_score + 0.35 * immobility_score + 0.20 * tracking_confidence,
        3,
    )

    if (
        fall_score >= 0.75
        and immobility_score >= 0.70
        and tracking_confidence >= 0.70
        and persistence_seconds >= 5
    ):
        state = "DISTRESS_EVENT"
        reason = "Sustained stillness after unusual motion — camera focused on subject for review"
    elif fall_score >= 0.75 and immobility_score >= 0.65:
        state = "VERIFYING"
        reason = "Unusual motion detected — verifying with continued monitoring"
    elif fall_score >= 0.75:
        state = "POSSIBLE_FALL"
        reason = "Unusual motion detected — monitoring closely"
    else:
        state = "NORMAL"
        reason = "No unusual activity detected"

    return {
        "state": state,
        "overall_confidence": overall_confidence,
        "reason": reason,
    }


# ============================================================================
# DATABASE SETUP
# ============================================================================
 
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./guardianmesh.db")
ACCESS_TOKEN = os.getenv("GUARDIANMESH_ACCESS_TOKEN")
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "GUARDIANMESH_ALLOWED_ORIGINS",
        # 8080 = `npm start` (server.js), 5500 = VS Code Live Server
        "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5500,http://127.0.0.1:5500"
    ).split(",")
    if origin.strip()
]
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
 
 
class IncidentModel(Base):
    """Database model for incidents"""
    __tablename__ = "incidents"
    
    id = Column(String, primary_key=True)
    camera_id = Column(String, index=True)
    event_type = Column(String)
    fall_score = Column(Float)
    immobility_score = Column(Float)
    tracking_confidence = Column(Float)
    persistence_seconds = Column(Float, default=0.0)
    overall_confidence = Column(Float)
    state = Column(String, index=True, nullable=True)
    reason = Column(String, nullable=True)
    timestamp = Column(DateTime, index=True)
    acknowledged = Column(Boolean, default=False)
    acknowledged_at = Column(DateTime, nullable=True)
    person_id = Column(Integer, nullable=True)
    # Camera mounting location at the time of the event (never a person's position)
    location = Column(String, nullable=True)
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)


class RescueModel(Base):
    """One responder credited for one successfully resolved incident."""
    __tablename__ = "rescues"

    # "<rescue_key>|<responder_id>" makes repeated submissions idempotent
    id = Column(String, primary_key=True)
    rescue_key = Column(String, index=True)
    incident_id = Column(String, index=True)
    responder_id = Column(String, index=True)
    responder_name = Column(String, nullable=True)
    camera_id = Column(String, nullable=True)
    source = Column(String, default="live")
    created_at = Column(DateTime, index=True)


Base.metadata.create_all(bind=engine)


def _add_missing_columns():
    """create_all() never alters existing tables; add columns introduced later."""
    existing = {col["name"] for col in inspect(engine).get_columns("incidents")}
    added = {"location": "VARCHAR", "lat": "FLOAT", "lng": "FLOAT"}
    with engine.begin() as conn:
        for name, sql_type in added.items():
            if name not in existing:
                conn.execute(text(f"ALTER TABLE incidents ADD COLUMN {name} {sql_type}"))
                logger.info("Added incidents.%s column", name)


_add_missing_columns()


def to_utc_naive(value: datetime) -> datetime:
    """Store every timestamp as naive UTC so comparisons and ordering are consistent."""
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def utc_iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def resolve_location(camera_id: str, lat=None, lng=None, location=None) -> dict:
    """Coordinates from the event when valid, otherwise from the camera registry."""
    camera = get_camera(camera_id) or {}
    if not valid_coordinates(lat, lng):
        lat, lng = camera.get("lat"), camera.get("lng")
    return {
        "location": location or camera.get("location"),
        "lat": lat,
        "lng": lng,
    }
 
 
def get_db():
    """Dependency for database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
 
 
# ============================================================================
# PYDANTIC MODELS (API Schemas)
# ============================================================================
 
class EventInput(BaseModel):
    """Event from CV pipeline"""
    model_config = ConfigDict(
        extra="allow",
        json_schema_extra={
            "example": {
                "camera_id": "cam_02",
                "event_type": "possible_fall",
                "fall_score": 0.91,
                "immobility_score": 0.86,
                "tracking_confidence": 0.94,
                "overall_confidence": 0.88,
                "timestamp": "2026-09-12T10:22:16-07:00",
                "person_id": 1
            }
        }
    )
    camera_id: str
    fall_score: float
    immobility_score: float
    tracking_confidence: float
    persistence_seconds: float = 0.0
    timestamp: str
    person_id: Optional[int] = None
    # Backward-compatible: older/existing CV clients may still send these.
    # The backend recomputes both server-side rather than trusting the client.
    event_type: Optional[str] = None
    overall_confidence: Optional[float] = None
    # Optional camera coordinates; the camera registry fills them in when absent.
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    location: Optional[str] = None

class EventOutput(BaseModel):
    """Event for API response"""
    id: str
    camera_id: str
    event_type: str
    fall_score: float
    immobility_score: float
    tracking_confidence: float
    overall_confidence: float
    timestamp: datetime
    person_id: Optional[int]
    acknowledged: bool
    
    model_config = ConfigDict(from_attributes=True)
 
 
class ScoreRequest(BaseModel):
    """Raw metrics for one-off scoring via /api/score"""
    camera_id: Optional[str] = None
    fall_score: float
    immobility_score: float
    tracking_confidence: float
    persistence_seconds: float = 0.0


class IncidentSummary(BaseModel):
    """Summary of recent incidents for a camera"""
    camera_id: str
    last_update: datetime
    recent_events: List[EventOutput]
    event_count_24h: int
    critical_count: int  # fall_score > 0.75
 
 
class CameraStatus(BaseModel):
    """Status of a camera"""
    camera_id: str
    last_heartbeat: datetime
    is_active: bool
    recent_incidents: IncidentSummary
 
 
# ============================================================================
# REAL-TIME EVENT MANAGER (WebSocket Broadcasting)
# ============================================================================
 
class ConnectionManager:
    """Manage WebSocket connections and broadcast events"""
    
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = defaultdict(set)
        self.camera_activity: Dict[str, datetime] = {}
        self.event_buffer: Dict[str, deque] = defaultdict(lambda: deque(maxlen=100))
        # Strong references so fire-and-forget broadcasts are not garbage-collected mid-send
        self._tasks: Set[asyncio.Task] = set()

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task
    
    async def connect(self, client_id: str, websocket: WebSocket):
        """Register new WebSocket client"""
        await websocket.accept()
        self.active_connections[client_id].add(websocket)
        logger.info(f"Client connected: {client_id} (total: {len(self.active_connections[client_id])})")
    
    def disconnect(self, client_id: str, websocket: WebSocket):
        """Unregister WebSocket client"""
        self.active_connections[client_id].discard(websocket)
        if not self.active_connections[client_id]:
            del self.active_connections[client_id]
        logger.info(f"Client disconnected: {client_id}")
    
    async def broadcast_event(self, event_data: dict):
        """
        Broadcast event to all connected clients.
        
        Sends to:
        - "all" clients (dashboard, admin views)
        - camera-specific clients (cam-specific viewers)
        """
        camera_id = event_data.get("camera_id")
        
        # Record activity
        self.camera_activity[camera_id] = datetime.now(timezone.utc)
        self.event_buffer[camera_id].append(event_data)
        
        # Prepare message
        message = json.dumps({
            "type": "event",
            "data": event_data,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        # Send to all subscribers
        for client_id in {"all", camera_id}:
            if client_id in self.active_connections:
                disconnected = set()
                for websocket in list(self.active_connections[client_id]):
                    try:
                        await websocket.send_text(message)
                    except Exception as e:
                        logger.warning(f"Failed to send to {client_id}: {e}")
                        disconnected.add(websocket)
                
                # Clean up dead connections
                for ws in disconnected:
                    self.disconnect(client_id, ws)
    
    async def broadcast_all(self, message_type: str, data: dict):
        """Send a non-camera message (e.g. leaderboard) to every "all" subscriber."""
        message = json.dumps({
            "type": message_type,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        for websocket in list(self.active_connections.get("all", ())):
            try:
                await websocket.send_text(message)
            except Exception:
                self.disconnect("all", websocket)

    async def send_alert(self, camera_id: str, alert_level: str, message: str):
        """Send alert notification"""
        alert_msg = json.dumps({
            "type": "alert",
            "camera_id": camera_id,
            "level": alert_level,  # "critical", "high", "medium"
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        for client_id in {"all", camera_id}:
            if client_id in self.active_connections:
                for websocket in list(self.active_connections[client_id]):
                    try:
                        await websocket.send_text(alert_msg)
                    except Exception:
                        pass

    def get_camera_status(self, camera_id: str) -> dict:
        """Get current status of camera, including registry location/coordinates"""
        last_event = self.camera_activity.get(camera_id)
        # .get() so status lookups don't create empty buffers for unknown IDs
        recent_events = list(self.event_buffer.get(camera_id, ()))
        registry = get_camera(camera_id) or {}

        return {
            "camera_id": camera_id,
            "id": camera_id,
            "label": registry.get("label") or camera_id,
            "location": registry.get("location"),
            "lat": registry.get("lat"),
            "lng": registry.get("lng"),
            "is_active": last_event is not None,
            "last_heartbeat": last_event or datetime.now(timezone.utc),
            "recent_events": recent_events[-10:],  # Last 10
            "event_count_recent": len(recent_events)
        }
 
 
# Global connection manager
manager = ConnectionManager()
 
# ============================================================================
# FASTAPI APP
# ============================================================================
 
app = FastAPI(
    title="GuardianMesh Backend",
    description="Real-time safety event detection & monitoring",
    version="1.0.0"
)
 
# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=bool(ACCESS_TOKEN),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_access_token(request, call_next):
    """Protect HTTP event data when a deployment token is configured."""
    public_paths = {"/", "/health", "/api/status"}
    # CORS preflights never carry the Authorization header; let CORSMiddleware answer them.
    if ACCESS_TOKEN and request.method != "OPTIONS" and request.url.path not in public_paths:
        authorization = request.headers.get("authorization", "")
        if authorization != f"Bearer {ACCESS_TOKEN}":
            return JSONResponse(
                status_code=401,
                content={"detail": "Authorization required"},
            )
    return await call_next(request)
 
 
# ============================================================================
# API ENDPOINTS
# ============================================================================
 
@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve basic dashboard"""
    return """
    <html>
    <head>
        <title>GuardianMesh Dashboard</title>
        <style>
            body { font-family: sans-serif; margin: 20px; }
            h1 { color: #333; }
            .status { padding: 10px; margin: 10px 0; border-radius: 4px; }
            .active { background: #d4edda; color: #155724; }
            .inactive { background: #f8d7da; color: #721c24; }
            .event { padding: 10px; margin: 5px 0; border-left: 3px solid #007bff; }
            .critical { border-left-color: #dc3545; }
            .high { border-left-color: #fd7e14; }
            .medium { border-left-color: #0dcaf0; }
        </style>
    </head>
    <body>
        <h1>🛡️ GuardianMesh Backend</h1>
        <p>Status: <strong>Online</strong></p>
        <p>API: <code>POST /api/events</code></p>
        <p>WebSocket: <code>WS /ws/all</code> (append <code>?token=...</code> when a token is configured)</p>
        <div id="events"></div>

        <script>
            // "all" receives every camera's broadcasts; other client IDs only get their own camera.
            const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
            const token = new URLSearchParams(window.location.search).get("token");
            const ws = new WebSocket(proto + window.location.host + "/ws/all" + (token ? "?token=" + encodeURIComponent(token) : ""));

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                const eventsDiv = document.getElementById("events");

                if (msg.type === "event") {
                    const e = msg.data;
                    const row = document.createElement("div");
                    row.className = "event " + (e.fall_score > 0.75 ? "critical" : "high");
                    const title = document.createElement("strong");
                    // textContent, never innerHTML: these fields come from API clients
                    title.textContent = String(e.state || e.event_type);
                    row.append(title, " - " + e.camera_id + " @ " + e.timestamp);
                    row.append(document.createElement("br"),
                        "Fall: " + Number(e.fall_score).toFixed(2) +
                        ", Immobility: " + Number(e.immobility_score).toFixed(2));
                    eventsDiv.prepend(row);
                    if (eventsDiv.children.length > 20) eventsDiv.removeChild(eventsDiv.lastChild);
                }
            };
        </script>
    </body>
    </html>
    """
 
 
@app.post("/api/events", response_model=dict)
async def ingest_event(event: EventInput, db: Session = Depends(get_db)):
    """
    Ingest event from CV pipeline.
    
    Called by `ai_cv.guardian_mesh_inference` for each detection.
    """
    # Generate incident ID
    incident_id = f"{event.camera_id}_{int(datetime.now(timezone.utc).timestamp()*1000)}"

    # Parse timestamp
    try:
        event_dt = datetime.fromisoformat(event.timestamp.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        event_dt = datetime.now(timezone.utc)
    event_dt = to_utc_naive(event_dt)

    place = resolve_location(event.camera_id, event.lat, event.lng, event.location)

    # Derive state/confidence/reason from raw metrics rather than trusting
    # whatever the client supplied for event_type/overall_confidence.
    score = compute_score(
        fall_score=event.fall_score,
        immobility_score=event.immobility_score,
        tracking_confidence=event.tracking_confidence,
        persistence_seconds=event.persistence_seconds,
    )
    state = score["state"]
    overall_confidence = score["overall_confidence"]
    reason = score["reason"]
    event_type = event.event_type or state.lower()

    # Store in database
    incident = IncidentModel(
        id=incident_id,
        camera_id=event.camera_id,
        event_type=event_type,
        fall_score=event.fall_score,
        immobility_score=event.immobility_score,
        tracking_confidence=event.tracking_confidence,
        persistence_seconds=event.persistence_seconds,
        overall_confidence=overall_confidence,
        state=state,
        reason=reason,
        timestamp=event_dt,
        person_id=event.person_id,
        location=place["location"],
        lat=place["lat"],
        lng=place["lng"],
    )
    db.add(incident)
    db.commit()

    logger.info(
        f"Event: {event_type} | State: {state} | "
        f"Fall: {event.fall_score:.2f} | "
        f"Immob: {event.immobility_score:.2f} | "
        f"Conf: {overall_confidence:.2f}"
    )

    # Broadcast to connected clients (include backend-derived fields)
    broadcast_payload = event.model_dump()
    broadcast_payload.update({
        "event_type": event_type,
        "overall_confidence": overall_confidence,
        "state": state,
        "reason": reason,
        "incident_id": incident_id,
        **place,
    })
    manager.spawn(manager.broadcast_event(broadcast_payload))

    # Trigger alerts based on backend-derived state. Critical alerts are
    # reserved strictly for confirmed DISTRESS_EVENT.
    if state == "DISTRESS_EVENT":
        alert_msg = f"🚨 Distress signal confirmed on {event.camera_id} — auto-focusing on subject"
        manager.spawn(
            manager.send_alert(event.camera_id, "critical", alert_msg)
        )
    elif state == "VERIFYING":
        alert_msg = f"⚠️ Possible incident on {event.camera_id} — verifying"
        manager.spawn(
            manager.send_alert(event.camera_id, "high", alert_msg)
        )
    elif state == "POSSIBLE_FALL":
        alert_msg = f"⚠️ Unusual motion on {event.camera_id} — monitoring"
        manager.spawn(
            manager.send_alert(event.camera_id, "medium", alert_msg)
        )

    return {
        "status": "received",
        "incident_id": incident_id,
        "state": state,
        "overall_confidence": overall_confidence,
        "reason": reason,
    }
 
 
@app.post("/api/score")
async def score(req: ScoreRequest):
    """
    Compute distress state/confidence/reason from raw CV metrics without
    storing an incident. Useful for testing the scoring logic directly.
    Uses the exact same compute_score() function as /api/events.
    """
    return compute_score(
        fall_score=req.fall_score,
        immobility_score=req.immobility_score,
        tracking_confidence=req.tracking_confidence,
        persistence_seconds=req.persistence_seconds,
    )


@app.get("/api/nearby-help")
async def nearby_help(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int = Query(5, ge=1, le=5),
    radius_m: int = Query(5000, ge=100, le=50000),
):
    """
    Nearby-help lookup: public first-aid-capable locations (Google Places)
    plus trusted internal responders (facility staff, designated responders,
    security desks). Google Places covers public locations only — it cannot
    identify private staff or verify anyone as a trusted responder; that
    comes solely from the local trusted-responder registry.
    """
    return await get_nearby_help(lat=lat, lng=lng, limit=limit, radius_m=radius_m)


def camera_matches(camera_id: str):
    """SQL filter matching a camera regardless of ID spelling (cam_02 == CAM-02)."""
    column = func.replace(func.replace(func.replace(func.lower(IncidentModel.camera_id), "_", ""), "-", ""), " ", "")
    return column == normalize_camera_id(camera_id)


def incident_to_dict(inc: IncidentModel) -> dict:
    """API shape for a stored incident, including camera location/coordinates."""
    place = {"location": inc.location, "lat": inc.lat, "lng": inc.lng}
    if not valid_coordinates(inc.lat, inc.lng):
        # Rows stored before coordinates existed fall back to the current registry
        place = resolve_location(inc.camera_id, location=inc.location)
    return {
        "id": inc.id,
        "camera_id": inc.camera_id,
        "event_type": inc.event_type,
        "state": inc.state,
        "reason": inc.reason,
        "fall_score": inc.fall_score,
        "immobility_score": inc.immobility_score,
        "tracking_confidence": inc.tracking_confidence,
        "persistence_seconds": inc.persistence_seconds,
        "overall_confidence": inc.overall_confidence,
        "person_id": inc.person_id,
        "timestamp": utc_iso(inc.timestamp),
        "acknowledged": inc.acknowledged,
        "acknowledged_at": utc_iso(inc.acknowledged_at),
        **place,
    }


@app.get("/api/cameras")
async def list_cameras(db: Session = Depends(get_db)):
    """List cameras: every registry camera plus any camera seen in recent incidents"""
    recent_camera_ids = db.query(IncidentModel.camera_id)\
        .order_by(desc(IncidentModel.timestamp))\
        .limit(1000)\
        .all()

    # Deduplicate across ID spellings (cam_02 / CAM-02), preferring the registry's ID.
    camera_ids: Dict[str, str] = {key: cam["id"] for key, cam in all_cameras().items()}
    for (camera_id,) in recent_camera_ids:
        if camera_id:
            camera_ids.setdefault(normalize_camera_id(camera_id), camera_id)

    cameras = [manager.get_camera_status(camera_id) for camera_id in sorted(camera_ids.values())]

    return {
        "cameras": cameras,
        "total": len(cameras)
    }
 
 
@app.get("/api/cameras/{camera_id}")
async def get_camera_incidents(
    camera_id: str,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db)
):
    """Get camera status and recent incidents"""
    
    # Query incidents
    incidents = db.query(IncidentModel)\
        .filter(camera_matches(camera_id))\
        .order_by(desc(IncidentModel.timestamp))\
        .limit(limit)\
        .all()
    
    # Count critical events (last 24h). Timestamps are stored as naive UTC.
    critical_count = db.query(IncidentModel).filter(
        camera_matches(camera_id),
        IncidentModel.fall_score > 0.75,
        IncidentModel.timestamp > to_utc_naive(datetime.now(timezone.utc) - timedelta(hours=24))
    ).count()

    # Get camera status
    status = manager.get_camera_status(camera_id)

    return {
        "camera_id": camera_id,
        "label": status["label"],
        "location": status["location"],
        "lat": status["lat"],
        "lng": status["lng"],
        "is_active": status["is_active"],
        "last_heartbeat": status["last_heartbeat"],
        "incidents": [incident_to_dict(inc) for inc in incidents],
        "critical_count_24h": critical_count
    }
 
 
@app.get("/api/incidents")
async def query_incidents(
    camera_id: Optional[str] = None,
    event_type: Optional[str] = None,
    min_confidence: float = Query(0.5, ge=0, le=1),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db)
):
    """Query incidents with filters"""
    
    query = db.query(IncidentModel)
    
    if camera_id:
        query = query.filter(camera_matches(camera_id))
    
    if event_type:
        query = query.filter(IncidentModel.event_type == event_type)
    
    query = query.filter(IncidentModel.overall_confidence >= min_confidence)
    
    incidents = query.order_by(desc(IncidentModel.timestamp)).limit(limit).all()
    
    return {
        "incidents": [incident_to_dict(inc) for inc in incidents],
        "total": len(incidents)
    }
 
 
@app.post("/api/incidents/{incident_id}/acknowledge")
async def acknowledge_incident(
    incident_id: str,
    db: Session = Depends(get_db)
):
    """Mark incident as reviewed by operator"""
    
    incident = db.query(IncidentModel).filter(
        IncidentModel.id == incident_id
    ).first()
    
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    
    incident.acknowledged = True
    incident.acknowledged_at = to_utc_naive(datetime.now(timezone.utc))
    db.commit()
    
    return {"status": "acknowledged", "incident_id": incident_id}
 
 
# ============================================================================
# RESCUE LEADERBOARD
# ============================================================================

ID_PATTERN = r"^[A-Za-z0-9_.:@-]{1,120}$"


class RescueResponder(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    name: Optional[str] = Field(default=None, max_length=60)


class RescueInput(BaseModel):
    rescue_key: str = Field(pattern=ID_PATTERN)
    incident_id: str = Field(pattern=ID_PATTERN)
    camera_id: Optional[str] = Field(default=None, max_length=60)
    source: str = Field(default="live", pattern=r"^(live|demo)$")
    responders: List[RescueResponder] = Field(min_length=1, max_length=10)


def leaderboard_snapshot(db: Session, limit: int = 20) -> dict:
    rows = (
        db.query(
            RescueModel.responder_id,
            func.max(RescueModel.responder_name),
            func.count(RescueModel.id),
            func.max(RescueModel.created_at),
        )
        .group_by(RescueModel.responder_id)
        .order_by(desc(func.count(RescueModel.id)), RescueModel.responder_id)
        .limit(limit)
        .all()
    )
    total = db.query(func.count(func.distinct(RescueModel.rescue_key))).scalar() or 0
    return {
        "responders": [
            {
                "id": responder_id,
                "name": name or responder_id,
                "rescues": count,
                "last_rescue_at": utc_iso(last),
            }
            for responder_id, name, count, last in rows
        ],
        "total_rescues": total,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/leaderboard")
async def get_leaderboard(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Successful rescues per responder, most first."""
    return leaderboard_snapshot(db, limit)


@app.post("/api/rescues")
async def record_rescue(rescue: RescueInput, db: Session = Depends(get_db)):
    """
    Credit responders for a resolved incident. Idempotent per
    (rescue_key, responder): re-sending the same rescue changes nothing.
    """
    now = to_utc_naive(datetime.now(timezone.utc))
    credited = []
    for responder in rescue.responders:
        row_id = f"{rescue.rescue_key}|{responder.id}"
        if db.get(RescueModel, row_id):
            continue
        db.add(RescueModel(
            id=row_id,
            rescue_key=rescue.rescue_key,
            incident_id=rescue.incident_id,
            responder_id=responder.id,
            responder_name=responder.name,
            camera_id=rescue.camera_id,
            source=rescue.source,
            created_at=now,
        ))
        credited.append(responder.id)
    db.commit()

    snapshot = leaderboard_snapshot(db)
    if credited:
        manager.spawn(manager.broadcast_all("leaderboard", snapshot))
    return {"status": "recorded", "credited": credited, "leaderboard": snapshot}


# ============================================================================
# WEBSOCKET ENDPOINT
# ============================================================================
 
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket endpoint for real-time event streaming.
    
    Usage:
        const ws = new WebSocket("ws://127.0.0.1:8000/ws/all");
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            console.log(msg);  // { type: "event", data: {...} }
        };
    """
    if ACCESS_TOKEN and websocket.query_params.get("token") != ACCESS_TOKEN:
        await websocket.close(code=1008, reason="Authorization required")
        return

    await manager.connect(client_id, websocket)
    
    try:
        while True:
            # Keep connection alive, receive heartbeats
            data = await websocket.receive_text()
            logger.debug(f"Message from {client_id}: {data}")
    except Exception as e:
        logger.warning(f"WebSocket error for {client_id}: {e}")
    finally:
        manager.disconnect(client_id, websocket)
 
 
# ============================================================================
# HEALTH CHECK
# ============================================================================
 
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "active_clients": sum(len(clients) for clients in manager.active_connections.values()),
        "active_cameras": len(manager.camera_activity)
    }


@app.get("/api/status")
async def api_status():
    """Frontend command-center status probe."""
    return await health_check()
 
 
if __name__ == "__main__":
    import uvicorn
    # 8000 matches the local-dev BACKEND_ORIGIN in frontend/js/config.js
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
 