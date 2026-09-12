# GuardianMesh

Privacy-first early warning for observable distress patterns in physical spaces.
This repository is split by team ownership:

- `ai_cv/` - camera capture, pose tracking, temporal features, event classification, and the normalized frontend event adapter.
- `backend/` - FastAPI event ingestion, protected WebSocket streaming, and incident storage.
- `frontend/` - command-center UI owned by the frontend team when merged.

The system processes camera frames locally. It sends event metadata only; it does not send or store raw frames by default. GuardianMesh is not a medical diagnosis system and every alert requires human verification.

## Install

Use Python 3.9+:

```powershell
python3.9 -m pip install -r requirements.txt
```

On Windows, if the complete install tries to compile `greenlet`, install the server wheels separately:

```powershell
python3.9 -m pip install --only-binary=:all: fastapi==0.115.6 uvicorn==0.34.0 sqlalchemy==2.0.36 pydantic==2.10.4 greenlet==3.0.3
```

## Run the backend

```powershell
$env:GUARDIANMESH_ACCESS_TOKEN = "use-a-long-random-token"
python3.9 -m uvicorn backend.backend_server:app --host 127.0.0.1 --port 8000
```

`/health` and `/api/status` expose service status. Event data requires `Authorization: Bearer <token>` when the token is configured. The WebSocket endpoint is `/ws/events?token=<token>`.

## Run camera inference

With a visible local camera window:

```powershell
python3.9 -m ai_cv.guardian_mesh_inference --source 0 --camera_id cam_01
```

Headless, metadata-only mode:

```powershell
python3.9 -m ai_cv.guardian_mesh_inference `
  --source 0 `
  --camera_id cam_01 `
  --no_viz `
  --api_url http://127.0.0.1:8000 `
  --api-token $env:GUARDIANMESH_ACCESS_TOKEN
```

Press `q` to stop visible mode. Recording is disabled unless `--allow-recording` is explicitly supplied.

## Frontend contract

Each CV event includes the legacy API fields plus the command-center fields:

- `trackingId`: anonymous ID such as `P-02`
- `cameraId`, `eventType`, `label`, `status`
- `confidence`: classification certainty from 0 to 1
- `guardianScore`: concern severity from 0 to 10
- `boundingBox`: normalized `{x, y, width, height}`
- `keypoints`: normalized COCO-style points
- `temporalFeatures`: vertical velocity, motion, body angle, ground duration, and time since movement

Confidence and severity remain separate quantities. The frontend can consume these fields through the backend WebSocket without receiving frames.

## Validation

```powershell
python3.9 -m py_compile ai_cv/*.py backend/*.py
```

Run the camera against a short video file with `--no_viz --max_frames 120` when a webcam is unavailable. The evaluator in `ai_cv/evaluate_pipeline.py` is for labeled datasets and is separate from the live path.
