# GuardianMesh

Privacy-first early warning for observable distress patterns in physical spaces.
This repository is split by team ownership:

- `ai_cv/` - camera capture, pose tracking, temporal features, event classification, and the normalized frontend event adapter.
- `backend/` - FastAPI event ingestion, protected WebSocket streaming, and incident storage.
- `frontend/` - command-center UI owned by the frontend team when merged.

The system processes camera frames locally. It sends event metadata only; it does not send or store raw frames by default. GuardianMesh is not a medical diagnosis system and every alert requires human verification.

---

# Frontend — command center

Plain **HTML5 + CSS3 + vanilla JavaScript (ES modules)**. No framework, no build
step, no runtime dependencies. Architecture write-up: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Run the frontend

```bash
npm start                 # → http://localhost:8080
# or, identically:
node server.js
node server.js 3000       # custom port
```

`npm start` installs nothing — `package.json` has no dependencies; it just runs
`server.js`.

Any static server works equally well:

```bash
cd frontend && python3 -m http.server 8080     # → http://localhost:8080
```

**Open:** <http://localhost:8080/> (serves `frontend/index.html`)

Targets 1920×1080 and 1440×900; degrades to two columns under 1400px and a single
column under 1080px.

## Demo Mode

| Action | How |
|---|---|
| Start / restart | **START DEMO** button, or press <kbd>D</kbd> |
| Advance one step | **NEXT STEP** button, or press <kbd>N</kbd> |
| Reset everything | **RESET** button, or press <kbd>R</kbd> |

Demo Mode is deterministic and **requires no backend**. It runs a full ~35 s
incident: normal motion → rapid vertical displacement → orientation change →
ground-level pose → low motion → prolonged immobility → rising confidence and
Guardian Score → critical distress pattern → incident → mesh corroboration →
simulated response → movement resumed → resolved.

RESET cancels the sequence, clears incidents/timeline/corroboration, resets the
score, restores every camera and responder node, and returns the stage to normal.

## Project layout

```
server.js                    zero-dependency static server
frontend/
├── index.html               the single command-center screen
├── styles/
│   ├── tokens.css           colour / spacing / type / motion tokens
│   ├── base.css             reset, typography atoms, badges, buttons, empty states
│   ├── layout.css           app shell, header, dashboard grid, panel chrome, media queries
│   └── components.css       camera stage, score gauge, timeline, incidents, mesh, response
├── js/
│   ├── app.js               bootstrap, state→UI routing, single animation loop, controls
│   ├── state.js             shared state object + pub/sub + action vocabulary
│   ├── config.js            endpoints, thresholds, score bands, video source
│   ├── util.js              DOM/math helpers
│   ├── camera.js            camera stage: simulated / webcam / video file, error states
│   ├── scene.js             simulated CCTV scene renderer (canvas)
│   ├── pose-engine.js       pose interpolation + temporal feature derivation
│   ├── pose-overlay.js      AR overlay: bounding boxes, skeletons, labels, motion vectors
│   ├── guardian-score.js    Guardian Score panel + live severity model
│   ├── timeline.js          AI reasoning timeline
│   ├── incidents.js         incident feed + filters
│   ├── mesh.js              camera/sensor nodes, corroboration, anonymous handoff
│   ├── response.js          simulated response mesh + recommended response
│   ├── system-header.js     system health rail
│   ├── demo.js              deterministic Demo Mode controller
│   ├── datasource.js        backend adapter: normalises events into state actions
│   └── websocket.js         vanilla WebSocket transport with bounded backoff
├── data/
│   ├── mock-events.js       ALL demo data: cameras, sensors, responders, copy, corroboration
│   ├── pose-library.js      canonical poses, skeleton edges, body states
│   └── (demo sequence lives in js/demo.js as timed steps)
└── assets/video/            drop demo footage here (see CONFIG.VIDEO_SOURCE_URL)
```

## Camera / video integration

Lives in **`js/camera.js`**. Three sources, selectable from the buttons on the
stage, with automatic fallback:

1. **Simulated** (default) — `js/scene.js` draws a deterministic corridor scene
   from the same keypoints the overlay uses, so the demo never depends on
   hardware or media files.
2. **Webcam** — `getUserMedia`; permission denial or a missing device shows a
   professional "Camera offline" state and falls back to simulated.
3. **Video file** — pick a file at runtime, or set
   `CONFIG.VIDEO_SOURCE_URL = 'assets/video/corridor.mp4'` in `js/config.js` to
   load footage on boot.

The overlay is source-agnostic: `overlay.setContentSource(videoEl)` computes the
displayed media rect (including `object-fit: cover` letterboxing) so normalised
coordinates always land in the right pixels, at any size.

## Integration contract — CV / AI teammate

Send tracks with **normalised coordinates (0..1, origin top-left)**. Either push
them over the WebSocket (`type: "tracks"`) or call the engine directly:

```js
window.guardian.engine.applyExternalTrack({
  trackingId: "P-02",              // anonymous ID only — never a name
  cameraId: "CAM-02",
  boundingBox: { x: 0.31, y: 0.28, width: 0.17, height: 0.52 },
  keypoints: [
    { name: "left_shoulder", x: 0.42, y: 0.31, confidence: 0.97 }
    // COCO-17 names, see data/pose-library.js → KEYPOINT_NAMES
  ],
  status: "warning",               // normal | tracking | observing | warning | critical
  label: "Possible fall",          // shown on the AR label
  confidence: 0.94,                // 0..1, classification certainty
  score: 8.7                       // optional Guardian Score badge on the overlay
});
```

* `keypoints[].name` must use the COCO-17 names in `data/pose-library.js`.
* If you omit `boundingBox`, it is derived from the keypoints.
* If you omit `features`, the engine derives vertical velocity, motion magnitude,
  body angle, ground duration and time-since-movement from consecutive samples.
* Missing keypoints are fine — edges with a missing endpoint are skipped.

## Console helpers

```js
window.guardian.snapshot()           // current state as plain JSON
window.guardian.emit({ ... })        // inject any payload from the contracts above
window.guardian.score(7.2)           // force a Guardian Score
window.guardian.demo.start()         // .next() / .reset()
window.guardian.connect()            // retry the backend connection
```

---

# Backend and AI/CV

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

The frontend consumes exactly these fields. The full JSON shape the adapter
normalises, including every accepted WebSocket frame type, is documented in
[ARCHITECTURE.md](ARCHITECTURE.md) and implemented in `frontend/js/datasource.js`.

### Wiring the frontend to this backend

The three parts are wired and verified end to end:

```
ai_cv (MediaPipe pose → temporal features → event classifier)
  └─ POST /api/events ─→ backend (FastAPI, SQLite, WebSocket fan-out)
                           └─ ws://…/ws/all ─→ frontend command center
```

**Run all three:**

```powershell
# 1. backend
python3.9 -m uvicorn backend.backend_server:app --host 127.0.0.1 --port 8000

# 2. frontend
npm start                         # http://localhost:8080

# 3. camera inference
python3.9 -m ai_cv.guardian_mesh_inference --source 0 --camera_id cam_01 \
  --no_viz --api_url http://127.0.0.1:8000
```

Then open **<http://localhost:8080/?live>**.

| URL | Data source |
|---|---|
| `http://localhost:8080/` | Demo Mode — makes no network requests at all |
| `http://localhost:8080/?live` | Attaches the live backend |
| `http://localhost:8080/?live&token=…` | Attaches a token-protected backend |

No file edits are needed to switch. `window.guardian.connect('<token>')` does the
same thing from the console, and `CONFIG.BACKEND_ENABLED: true` in
`frontend/js/config.js` makes live the default.

**Backend-derived scoring**

The backend recomputes `state`, `overall_confidence` and `reason` from the raw CV
metrics rather than trusting the client (`compute_score`). The frontend treats
those as authoritative:

| Backend `state` | Dashboard status |
|---|---|
| `NORMAL` | no incident opened — even if the CV labelled that frame a possible fall |
| `POSSIBLE_FALL` | observing |
| `VERIFYING` | warning |
| `DISTRESS_EVENT` | critical |

The backend's `reason` ("High fall signal with sustained immobility") is shown on
the incident card and woven into the timeline entry, so the dashboard explains
its escalation in the backend's own words.

**What the frontend does with the stream**

- The backend wraps each detection as `{ type: "event", data: {…} }`; the adapter
  unwraps it. `{ type: "alert", … }` frames become timeline entries on level change.
- It subscribes as **`/ws/all`**. The backend fans out to the `all` channel and to
  a channel named after the camera, so any other client id receives nothing.
- The CV pipeline posts **once per frame (~30/s)**. The adapter correlates by
  *situation* (camera + tracking ID), so a fall is one incident card that escalates
  and resolves — not hundreds of cards — and the timeline records transitions only.
- Cameras the frontend has never heard of (`cam_07`) join the mesh automatically on
  their first event.
- Attaching a live backend clears the seeded demo cameras and people, so the mesh
  and overlay show only what the backend is actually reporting.
- The legacy `fall_score` / `immobility_score` / `overall_confidence` fields are
  accepted as a fallback when the command-center fields are absent.

**Two operational notes**

- **CORS** — `GUARDIANMESH_ALLOWED_ORIGINS` now includes `:8080` and `:5500` by
  default. The WebSocket is not subject to CORS, so live events still arrive even
  if the REST probe is blocked.
- **Token** — when `GUARDIANMESH_ACCESS_TOKEN` is set, the frontend sends
  `Authorization: Bearer <token>` on REST and `?token=<token>` on the socket.

## Validation

```powershell
python3.9 -m py_compile ai_cv/*.py backend/*.py
```

Run the camera against a short video file with `--no_viz --max_frames 120` when a webcam is unavailable. The evaluator in `ai_cv/evaluate_pipeline.py` is for labeled datasets and is separate from the live path.
