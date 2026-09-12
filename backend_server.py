"""
GuardianMesh: Backend Server
FastAPI server for event ingestion, storage, and real-time WebSocket streaming.
 
Run with:
    uvicorn backend.backend_server:app --reload --host 127.0.0.1 --port 8000
 
Endpoints:
    POST /api/events               - Ingest event from CV pipeline
    WebSocket /ws/{client_id}      - Subscribe to real-time events
    GET /api/cameras               - List active cameras
    GET /api/cameras/{camera_id}   - Get camera + recent incidents
    GET /api/incidents             - Query incidents (with filters)
    POST /api/incidents/{id}/acknowledge - Mark incident as reviewed
"""
 
from fastapi import FastAPI, WebSocket, HTTPException, Query, Depends
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, String, Float, DateTime, Integer, Boolean
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.sql import desc
from pydantic import BaseModel, ConfigDict
from datetime import datetime, timezone
import asyncio
import json
import logging
from typing import Dict, List, Optional, Set
from collections import defaultdict, deque
import os
 
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
        reason = "High fall signal with sustained immobility"
    elif fall_score >= 0.75 and immobility_score >= 0.65:
        state = "VERIFYING"
        reason = "Possible fall with immobility under verification"
    elif fall_score >= 0.75:
        state = "POSSIBLE_FALL"
        reason = "Fall signal detected"
    else:
        state = "NORMAL"
        reason = "No significant distress pattern detected"

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
ALLOWED_ORIGINS = os.getenv(
    "GUARDIANMESH_ALLOWED_ORIGINS",
    "http://localhost:5500,http://127.0.0.1:5500"
).split(",")
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
 
 
Base.metadata.create_all(bind=engine)
 
 
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
        for client_id in ["all", camera_id]:
            if client_id in self.active_connections:
                disconnected = set()
                for websocket in self.active_connections[client_id]:
                    try:
                        await websocket.send_text(message)
                    except Exception as e:
                        logger.warning(f"Failed to send to {client_id}: {e}")
                        disconnected.add(websocket)
                
                # Clean up dead connections
                for ws in disconnected:
                    self.disconnect(client_id, ws)
    
    async def send_alert(self, camera_id: str, alert_level: str, message: str):
        """Send alert notification"""
        alert_msg = json.dumps({
            "type": "alert",
            "camera_id": camera_id,
            "level": alert_level,  # "critical", "high", "medium"
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
        
        for client_id in ["all", camera_id]:
            if client_id in self.active_connections:
                for websocket in self.active_connections[client_id]:
                    try:
                        await websocket.send_text(alert_msg)
                    except Exception:
                        pass
    
    def get_camera_status(self, camera_id: str) -> dict:
        """Get current status of camera"""
        last_event = self.camera_activity.get(camera_id)
        recent_events = list(self.event_buffer[camera_id])
        
        return {
            "camera_id": camera_id,
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
    public_paths = {"/health", "/api/status"}
    if ACCESS_TOKEN and request.url.path not in public_paths:
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
        <p>WebSocket: <code>WS /ws/{client_id}</code></p>
        <div id="events"></div>
        
        <script>
            // Connect to WebSocket
            const ws = new WebSocket("ws://" + window.location.host + "/ws/dashboard");
            
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                const eventsDiv = document.getElementById("events");
                
                if (msg.type === "event") {
                    const e = msg.data;
                    const level = e.fall_score > 0.75 ? "critical" : "high";
                    const html = `
                        <div class="event ${level}">
                            <strong>${e.event_type}</strong> - 
                            ${e.camera_id} @ ${e.timestamp}
                            <br/>Fall: ${e.fall_score.toFixed(2)}, 
                            Immobility: ${e.immobility_score.toFixed(2)}
                        </div>
                    `;
                    eventsDiv.innerHTML = html + eventsDiv.innerHTML;
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
    except:
        event_dt = datetime.now(timezone.utc)

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
        person_id=event.person_id
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
    })
    asyncio.create_task(
        manager.broadcast_event(broadcast_payload)
    )

    # Trigger alerts based on backend-derived state. Critical alerts are
    # reserved strictly for confirmed DISTRESS_EVENT.
    if state == "DISTRESS_EVENT":
        alert_msg = f"🚨 CRITICAL FALL DETECTED on {event.camera_id}"
        asyncio.create_task(
            manager.send_alert(event.camera_id, "critical", alert_msg)
        )
    elif state == "VERIFYING":
        alert_msg = f"⚠️ Possible fall under verification on {event.camera_id}"
        asyncio.create_task(
            manager.send_alert(event.camera_id, "high", alert_msg)
        )
    elif state == "POSSIBLE_FALL":
        alert_msg = f"⚠️ Possible fall on {event.camera_id}"
        asyncio.create_task(
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


@app.get("/api/cameras")
async def list_cameras(db: Session = Depends(get_db)):
    """List all active cameras"""
    # Get unique cameras from recent incidents
    recent_incidents = db.query(IncidentModel)\
        .order_by(desc(IncidentModel.timestamp))\
        .limit(1000)\
        .all()
    
    camera_ids = set(inc.camera_id for inc in recent_incidents)
    
    cameras = []
    for camera_id in camera_ids:
        status = manager.get_camera_status(camera_id)
        cameras.append(status)
    
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
        .filter(IncidentModel.camera_id == camera_id)\
        .order_by(desc(IncidentModel.timestamp))\
        .limit(limit)\
        .all()
    
    # Count critical events (last 24h)
    from datetime import timedelta
    critical_count = db.query(IncidentModel).filter(
        IncidentModel.camera_id == camera_id,
        IncidentModel.fall_score > 0.75,
        IncidentModel.timestamp > datetime.now(timezone.utc) - timedelta(hours=24)
    ).count()
    
    # Get camera status
    status = manager.get_camera_status(camera_id)
    
    return {
        "camera_id": camera_id,
        "is_active": status["is_active"],
        "last_heartbeat": status["last_heartbeat"],
        "incidents": [
            {
                "id": inc.id,
                "event_type": inc.event_type,
                "fall_score": inc.fall_score,
                "immobility_score": inc.immobility_score,
                "timestamp": inc.timestamp.isoformat(),
                "acknowledged": inc.acknowledged
            }
            for inc in incidents
        ],
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
        query = query.filter(IncidentModel.camera_id == camera_id)
    
    if event_type:
        query = query.filter(IncidentModel.event_type == event_type)
    
    query = query.filter(IncidentModel.overall_confidence >= min_confidence)
    
    incidents = query.order_by(desc(IncidentModel.timestamp)).limit(limit).all()
    
    return {
        "incidents": [
            {
                "id": inc.id,
                "camera_id": inc.camera_id,
                "event_type": inc.event_type,
                "fall_score": inc.fall_score,
                "overall_confidence": inc.overall_confidence,
                "timestamp": inc.timestamp.isoformat(),
                "acknowledged": inc.acknowledged
            }
            for inc in incidents
        ],
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
    incident.acknowledged_at = datetime.now(timezone.utc)
    db.commit()
    
    return {"status": "acknowledged", "incident_id": incident_id}
 
 
# ============================================================================
# WEBSOCKET ENDPOINT
# ============================================================================
 
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket endpoint for real-time event streaming.
    
    Usage:
        const ws = new WebSocket("ws://localhost:8000/ws/dashboard");
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
 