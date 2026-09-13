# GuardianMesh

Privacy-preserving AI for recognizing human distress.
Detect the emergency. Not the identity.

Privacy-first early warning for observable distress patterns in physical spaces.
This repository is split by team ownership:

- `ai_cv/` - camera capture, pose tracking, temporal features, event classification, and the normalized frontend event adapter.
- `backend/` - FastAPI event ingestion, protected WebSocket streaming, and incident storage.
- `frontend/` - command-center UI owned by the frontend team when merged.

The system processes camera frames locally. It sends event metadata only; it does not send or store raw frames by default. GuardianMesh is not a medical diagnosis system and every alert requires human verification.

For the complete camera-to-dashboard explanation, formulas, thresholds, data
flows, deployment model, limitations, and test procedures, read
**[SYSTEM_GUIDE.md](SYSTEM_GUIDE.md)**.

## Why we built GuardianMesh

GuardianMesh began with our grandparents. We worry about them all the time:
whether they might fall, become distressed, or need help when nobody is close
enough to notice. Thinking about that problem helped us brainstorm a system that
could recognize observable warning signs early while still respecting their
privacy. That concern is why we built GuardianMesh—to help families know when
someone may need a human check-in without identifying, recording, or diagnosing
the person.

## Model training and development

We initially tried to reduce development costs by training, iterating on, and
using our own **Qwen2.5-Coder-Pi-14B** model for part of the coding. Training
was a serious part of the experiment: we repeatedly evaluated its output
against the reliability and software-engineering demands of GuardianMesh. The
model helped with some development work, but its code quality and reliability
were not good enough to complete the entire system. Hardware restrictions also
prevented us from upgrading to a larger local model. We therefore moved the
remaining software-development work to **Claude Opus 5** to reach the quality
the project required. The experiment was still valuable—it taught us where our
training approach worked, where it failed, and why rigorous evaluation matters
as much as training itself.

## Computer vision model

GuardianMesh's live-camera path runs **YOLO26-pose** (`yolo26n-pose`) in the
browser through **ONNX Runtime Web**. It detects up to four people at once and
returns 17 anonymous COCO body keypoints for each, plus a person bounding box.
GuardianMesh then applies its own explainable temporal logic to those keypoints:
downward movement, torso angle, ground-level posture, immobility, recovery, and
repeated small post-fall movements.

YOLO26 exports end-to-end (NMS-free), so the model emits already-sorted
`[x1, y1, x2, y2, confidence, class, 17 x (x, y, visibility)]` rows and the
browser only has to threshold them. Both the model (~12 MB) and the runtime ship
from this origin under `frontend/assets/models/` and `frontend/vendor/onnxruntime/`
— a hackathon venue network is the least reliable part of any demo, and a
detector that cannot download itself is a detector that does not run.

The optional Python camera pipeline still uses MediaPipe Pose 0.10.8 and is
effectively single-person; it is a separate, optional path and is not what the
browser demo runs. Neither camera path uses Qwen or Claude for live video
analysis. Qwen2.5-Coder-Pi-14B and Claude Opus 5 were part of the
software-development process; no generative AI model watches the camera feed.
Frames remain local, and the system does not perform facial recognition,
identity matching, or medical diagnosis.

| Where | Model | Settings | Code |
|---|---|---|---|
| Browser (default) | YOLO26-pose (`yolo26n-pose.onnx`) | 640x640, up to 4 people, 17 COCO keypoints | `frontend/js/browser-pose.js`, `frontend/js/config.js` |
| Python pipeline (optional) | MediaPipe Pose (`mp.solutions.pose`) | `model_complexity=1` (full model), one person | `ai_cv/pose_tracker.py` |

**Execution provider.** The browser prefers WebGPU and falls back to
multi-threaded WASM. It deliberately *rejects* WebGPU backed by a software
adapter (SwiftShader, llvmpipe, "Basic Render"): a browser will happily report
WebGPU support that is slower than WASM by two orders of magnitude. Force one
with `?ep=wasm` or `?ep=webgpu`. Threads need cross-origin isolation, which
`frontend/_headers` and `worker.js` both set.

**Licence note.** Ultralytics YOLO26 is AGPL-3.0. That suits this repository,
which is source-available, but it is worth knowing before reusing the model in a
closed-source product.

The detector is the only computer vision model. Everything after pose estimation
is rule-based, with hand-set thresholds rather than a trained classifier:

- **Browser:** `frontend/js/fall-detector.js` is a temporal state machine
  (instability, rapid descent, ground, immobility, possible distress, recovery)
  tuned in `CONFIG.THRESHOLDS`.
- **Python:** `ai_cv/temporal_features.py` and `ai_cv/event_classifier.py`
  combine weighted motion, posture and immobility signals.
- **Backend:** `compute_score` in `backend/backend_server.py` maps fall,
  immobility and tracking scores to `NORMAL`, `POSSIBLE_FALL`, `VERIFYING` or
  `DISTRESS_EVENT` with fixed thresholds.

PyTorch and torchvision are listed as optional in `requirements/requirements.txt`
but are not imported anywhere; scikit-learn is used only by
`ai_cv/evaluate_pipeline.py` to compute accuracy metrics on labelled videos.

---

# Frontend — command center

Plain **HTML5 + CSS3 + vanilla JavaScript (ES modules)**. No framework, no build
step or installed frontend dependencies. The YOLO26 model and the ONNX runtime
are served from this origin, so the page needs no CDN.
Architecture write-up: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

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

## Live camera demo

| Action | How |
|---|---|
| Start / stop | **START LIVE CAMERA** button, or press <kbd>D</kbd> |
| Reset everything | **RESET** button, or press <kbd>R</kbd> |

**START LIVE CAMERA** requests the actual device camera and runs YOLO26-pose
locally in the browser. Frames stay on the device. Anonymous keypoints feed
temporal fall detection, Guardian Score, timeline, incidents, and the response
workflow. A backend is not required.

Everyone in frame is tracked independently, so more than one person can be
assessed at the same time and anybody who falls or shows a distress pattern is
picked up — not just a designated subject.

Camera or model failures stay visible. There is no synthetic feed and no
scripted story to fall back on: every track on screen came from the camera, or
there are no tracks at all.

## Deploying the dashboard (Cloudflare)

The command center is static — HTML, CSS and ES modules, no build step, no
dependencies — so deploying it is just serving `frontend/`.

`wrangler.toml` configures this as an **assets-only Worker** (Workers Static
Assets): no `main`, just `[assets] directory = "./frontend"`. That matches the
deploy command this project runs, `npx wrangler deploy`, which is the Workers
command. Validated against wrangler 4.131.1:

```
✨ Read 32 files from the assets directory .../frontend
```

**Workers or Pages — the config and the deploy command must agree.** They are
two different products with two different commands:

| Target | `wrangler.toml` | Deploy command | URL |
|---|---|---|---|
| Workers (current) | `[assets] directory = "./frontend"` | `npx wrangler deploy` | `*.workers.dev` |
| Pages | `pages_build_output_dir = "frontend"` | `npx wrangler pages deploy frontend` | `*.pages.dev` |

Mixing them is what produced `It seems that you have run wrangler deploy on a
Pages project` — a Pages-shaped config being deployed with the Workers command.

**Why `requirements.txt` is not in the repository root.** Cloudflare installs any
dependency manifest it finds in the build root, so a root `requirements.txt` made
every deploy of a *static page* try to install the CV/ML stack (opencv,
mediapipe, torch) — and fail:

```
ERROR: Could not find a version that satisfies the requirement mediapipe==0.10.8
       (from versions: 0.10.30, ... 1.0.1)
```

Moving it to `requirements/requirements.txt` removes the trigger, so the build
installs nothing and finishes in seconds. The file's contents are unchanged.

**Do not fix that by raising the mediapipe pin.** `0.10.8` is the last release
that still exposes the `mp.solutions` API `ai_cv/pose_tracker.py` is built on —
verified: `0.10.30` and `1.0.1` both drop it and crash the tracker at startup.
Raising the pin would trade a visible build failure for a silent runtime one.

**What gets deployed.** The YOLO26 model and the ONNX runtime are deployed with
the site and inference runs locally in the browser. The FastAPI backend is not part
of this static Worker, so the header accurately says **Backend: Not required**.
`?live` remains available only when a separately deployed HTTPS/WSS backend is
configured; an HTTPS page cannot connect to `http://127.0.0.1:8000`.

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
│   ├── camera.js            camera stage: webcam / video file, error states
│   ├── browser-pose.js      YOLO26-pose via ONNX Runtime Web + anonymous multi-person tracking
│   ├── fall-detector.js     temporal fall state machine
│   ├── pose-engine.js       temporal feature derivation over observed keypoints
│   ├── pose-overlay.js      yellow anonymous person-detection boxes
│   ├── guardian-score.js    Guardian Score panel + live severity model
│   ├── timeline.js          AI reasoning timeline
│   ├── incidents.js         incident feed + filters
│   ├── mesh.js              camera/sensor nodes, corroboration, anonymous handoff
│   ├── response.js          simulated response mesh + recommended response
│   ├── system-header.js     system health rail
│   ├── datasource.js        backend adapter: normalises events into state actions
│   └── websocket.js         vanilla WebSocket transport with bounded backoff
├── data/
│   └── mock-events.js       interface copy + the simulated responder roster
├── assets/
│   ├── models/              yolo26n-pose.onnx (the detector, served from this origin)
│   └── video/               drop demo footage here (see CONFIG.VIDEO_SOURCE_URL)
└── vendor/onnxruntime/      pinned ONNX Runtime Web build + its wasm binary
```

## Camera / video integration

Lives in **`js/camera.js`** and **`js/browser-pose.js`**:

1. **Webcam** (default demo) — `getUserMedia` frames go straight to YOLO26.
   Permission and model failures remain visible; nothing is simulated in their place.
2. **Video test** — pick a local recording to exercise the same real inference
   path, or set `CONFIG.VIDEO_SOURCE_URL = 'assets/video/corridor.mp4'` in
   `js/config.js` to load footage on boot.

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
    // COCO-17 names, see js/browser-pose.js → KEYPOINT_NAMES
  ],
  status: "warning",               // normal | tracking | observing | warning | critical
  label: "Possible fall",          // shown on the AR label
  confidence: 0.94,                // 0..1, classification certainty
  score: 8.7                       // optional Guardian Score badge on the overlay
});
```

* `keypoints[].name` must use the COCO-17 names in `js/browser-pose.js`.
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
python3.9 -m pip install -r requirements/requirements.txt
```

On Windows, if the complete install tries to compile `greenlet`, install the server wheels separately:

```powershell
python3.9 -m pip install --only-binary=:all: fastapi==0.115.6 uvicorn==0.34.0 sqlalchemy==2.0.36 pydantic==2.10.4 greenlet==3.0.3
```

## Run the backend

From the repository root (port 8000 is what `frontend/js/config.js` uses for local development):

```powershell
$env:GUARDIANMESH_ACCESS_TOKEN = "use-a-long-random-token"            # optional
$env:GUARDIANMESH_CAMERAS_FILE = "backend\cameras.json"                # optional, see below
$env:GUARDIANMESH_TRUSTED_RESPONDERS_FILE = "backend\trusted_responders.json"  # optional
$env:GOOGLE_MAPS_API_KEY = "..."                                        # optional
python -m uvicorn backend.backend_server:app --host 127.0.0.1 --port 8000
```

`/health` and `/api/status` expose service status. When a token is configured, event data requires `Authorization: Bearer <token>` and the WebSocket endpoint is `/ws/all?token=<token>` (`all` receives every camera; any other client ID receives only that camera's events).

### Camera locations

Incidents, WebSocket events and `/api/cameras` carry `location`, `lat` and `lng` for the camera that produced them. Coordinates come from the event itself when the CV client sends them (`--lat/--lng`), otherwise from the camera registry: copy `backend/cameras.example.json` to `backend/cameras.json` and point `GUARDIANMESH_CAMERAS_FILE` at it. Camera IDs match regardless of spelling (`cam_02` = `CAM-02`). These coordinates drive the dashboard's Nearby Response lookup; they describe where a camera is mounted, never where a person is.

Existing SQLite databases are upgraded automatically on startup (the `location`, `lat` and `lng` columns are added if missing).

## Run camera inference

With a visible local camera window, from the repository root:

```powershell
python -m ai_cv.guardian_mesh_inference --source 0 --camera_id cam_01
```

Headless, metadata-only mode:

```powershell
python -m ai_cv.guardian_mesh_inference `
  --source 0 `
  --camera_id cam_01 `
  --no_viz `
  --api_url http://127.0.0.1:8000 `
  --api-token $env:GUARDIANMESH_ACCESS_TOKEN
```

Add `--lat 47.6 --lng -122.3 --location "Main Corridor"` to send camera coordinates with each event instead of relying on the registry. Press `q` to stop visible mode. Recording is disabled unless `--allow-recording` is explicitly supplied.

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
| `http://localhost:8080/` | Local YOLO26-pose model + live device camera |
| `http://localhost:8080/?ep=wasm` | Same, forcing the WASM execution provider |
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

### Cloudflare deployment

`worker.js` serves `frontend/` and edge fallbacks for `/api/status`, `/api/nearby-help`, `/api/score`, `/api/cameras` and `/ws/*`. Set `BACKEND_ORIGIN` to forward API/WebSocket traffic to a hosted FastAPI backend (falls back to the edge handlers if it is unreachable or returns 5xx). Secrets: `GOOGLE_MAPS_API_KEY`, `TRUSTED_RESPONDERS_JSON`, `CAMERAS_JSON` (same shapes as the example files in `backend/`). Deploy with `deploy_guardianmesh.ps1`.

## Validation

```powershell
python -m py_compile ai_cv/*.py backend/*.py
```

Run the camera against a short video file with `--no_viz --max_frames 120` when a webcam is unavailable. The evaluator in `ai_cv/evaluate_pipeline.py` is for labeled datasets and is separate from the live path.

## Contributor attribution

Work from this development environment that may appear attributed to
`apurvkumaria` was actually contributed by **Atharv Kumaria**, GitHub
**[@RUSHcitizen](https://github.com/RUSHcitizen)**. Atharv used his father Apurv
Kumaria's laptop because Atharv's own laptop had hardware limitations. The local
username identifies the borrowed computer, not the author of those contributions.
