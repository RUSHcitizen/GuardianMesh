# GuardianMesh: complete system guide

This document explains the current GuardianMesh repository from camera input to
dashboard output. It is written for teammates who need to understand, present,
tune, test, or extend the project.

> GuardianMesh is a hackathon prototype for recognizing **observable movement
> patterns** that may indicate a fall or distress. It does not identify people,
> read emotions, diagnose a heart attack, or replace human judgment.

## 1. What the system actually is

GuardianMesh has two usable perception paths:

1. **Default browser path:** a webcam or video runs through MediaPipe Pose
   Landmarker inside the browser. JavaScript derives motion/posture features,
   advances a temporal fall state machine, calculates the Guardian Score, and
   updates the dashboard directly. This is the normal Cloudflare demo path.
2. **Optional Python/backend path:** OpenCV and MediaPipe run in a separate
   Python process. That process derives another set of temporal features and
   scores, sends metadata to FastAPI, and FastAPI stores and broadcasts it to a
   dashboard opened with `?live`.

The Cloudflare Worker serves the frontend and provides edge endpoints for
health, score calculation, nearby help, cameras, and the rescue leaderboard. It
can proxy API and WebSocket traffic to a separately hosted FastAPI server.

The Qwen2.5-Coder-14B-based model described in the README and Claude Opus 5 were
used in the **software-development process**. Neither is in the live inference
loop. Live perception uses MediaPipe landmarks plus transparent mathematical
features, thresholds, and state transitions.

## 2. End-to-end picture

```text
DEFAULT BROWSER PATH

webcam/video
    |
    v
MediaPipe Pose Landmarker (runs in browser; up to 4 poses)
    |
    v
17 selected anonymous body landmarks + bounding box
    |
    v
anonymous track matching (PERSON 01, PERSON 02, ...)
    |
    v
temporal features
  - torso center and body angle
  - vertical velocity and descent distance
  - whole-body motion
  - horizontal/ground posture
  - ground and no-movement timers
    |
    v
per-person fall state machine
NORMAL -> RAPID_DESCENT -> GROUND -> IMMOBILE -> POSSIBLE_DISTRESS
                              \-> RECOVERY -> NORMAL
    |
    +--> Guardian Score and confidence
    +--> yellow detection box and optional critical auto-focus
    +--> timeline and one correlated incident per person
    +--> simulated human-response recommendations
    +--> nearby-help lookup and rescue gamification


OPTIONAL PYTHON/BACKEND PATH

camera/file/RTSP -> OpenCV -> MediaPipe Pose -> Python temporal features
    -> Python fall/event scores -> five-frame smoothing
    -> POST /api/events (metadata only) -> FastAPI + SQLite
    -> WebSocket /ws/all -> frontend adapter -> same dashboard state/renderers
```

## 3. Default browser perception path

### 3.1 Camera input

`frontend/js/camera.js` owns three visual layers: a development scene canvas,
the real `<video>` element, and the overlay canvas.

- The page starts with the camera **off**.
- **Start Live Camera** calls `navigator.mediaDevices.getUserMedia()` with an
  ideal resolution of 1280 x 720 and audio disabled.
- **Video Test** uses a user-selected local video through an object URL.
- The simulated feed is unavailable on the normal page. It is enabled only by
  `?dev=simulation`.
- Permission denial, a missing camera, a decode failure, or a model failure is
  shown to the user. It never silently substitutes fake people.
- All three visual layers receive the same transform. When a critical track is
  present, the stage zooms 1.6x around that body so an operator can inspect it.

Camera permission requires a secure context. A Cloudflare HTTPS deployment and
`localhost` qualify; an ordinary HTTP page on another host does not.

### 3.2 Pose model

`frontend/js/browser-pose.js` dynamically loads:

- MediaPipe Tasks Vision `1.0.1` from jsDelivr;
- the matching WebAssembly files from jsDelivr; and
- the float16 Pose Landmarker Lite model from Google's model storage.

The model runs in `VIDEO` mode. It tries the GPU delegate first and falls back
to CPU if GPU initialization fails. Important settings are:

| Setting | Current value |
|---|---:|
| Maximum poses | 4 |
| Minimum pose detection confidence | 0.50 |
| Minimum pose presence confidence | 0.50 |
| Minimum MediaPipe tracking confidence | 0.50 |
| GuardianMesh minimum accepted pose confidence | 0.45 |
| Inference interval | 80 ms (at most about 12.5 runs/second) |
| Track expiry | 1,800 ms unseen |

MediaPipe produces 33 landmarks. GuardianMesh keeps these 17 body points:

```text
nose, left/right eye, left/right ear,
left/right shoulder, elbow, wrist,
left/right hip, knee, ankle
```

Each point is `{name, x, y, confidence}`. `x` and `y` are normalized to `0..1`,
with `(0,0)` at the image's top-left. Confidence is the smaller of MediaPipe's
visibility and presence values.

### 3.3 Bounding box

Points with confidence at least `0.35` define the box when six or more are
visible; otherwise all selected points are used. The smallest and largest x/y
coordinates form the box, then small proportional padding is added. The result
is also normalized:

```json
{"x": 0.25, "y": 0.12, "width": 0.22, "height": 0.74}
```

`frontend/js/pose-overlay.js` converts this box into displayed pixels after
accounting for `object-fit: cover`. It deliberately draws only a yellow box,
anonymous tracking ID, state label, confidence, and score. It does not display
a face identity or skeleton.

### 3.4 Anonymous multi-person tracking

MediaPipe pose results do not carry a durable person ID, so the browser matches
each new detection to an existing anonymous track.

For every possible old/new box pair:

```text
cost = 0.75 * centroid_distance + 0.25 * (1 - box_IoU)
```

The lowest-cost unused track is selected only when normalized centroid distance
is at most `0.28`. Unmatched detections become `PERSON 01`, `PERSON 02`, and so
on. A track is removed after 1.8 seconds without a match. IDs are temporary
session labels, not identities, and are reset when the camera/session resets.

## 4. Browser temporal features and body-angle math

`frontend/js/pose-engine.js` turns consecutive landmarks into features for each
anonymous track.

Let:

```text
S = midpoint(left_shoulder, right_shoulder)
H = midpoint(left_hip, right_hip)
C = midpoint(S, H)                    # torso center
dx = H.x - S.x
dy = H.y - S.y
```

### Body angle

```text
body_angle = acos(|dy| / sqrt(dx^2 + dy^2)) * 180 / pi
```

- `0 degrees` means the shoulder-to-hip line is vertical.
- `90 degrees` means it is horizontal.
- The absolute value makes leaning left and right equivalent.
- It is a 2D image measurement, not a 3D medical posture assessment.

### Torso height values

- `shoulderY = S.y`
- `hipY = H.y`
- `centerY = C.y`
- `headY` is the average y of the nose and two ears that are present.

Because y increases toward the bottom of the image, a larger `centerY` means the
torso has moved downward in the frame.

### Vertical velocity

```text
vertical_velocity = -(current_centerY - previous_centerY) / elapsed_seconds
```

The minus sign produces this convention:

- negative = downward;
- positive = upward; and
- magnitude is normalized image-heights per second (`u/s` in the UI).

### Whole-body motion magnitude

For each sufficiently visible landmark, the engine finds its normalized 2D
distance from the previous sample. Raw motion is the mean of those distances
divided by elapsed seconds. It is exponentially smoothed:

```text
smoothed_motion = 0.82 * previous + 0.18 * raw_motion
```

Using the whole selected body makes mouth/face movement much less important
than movement of the torso and limbs.

### Descent distance

The engine retains a 750 ms history. Its baseline is the sample with the
smallest `centerY` (the highest recent torso position):

```text
descent_distance = max(0, current_centerY - highest_recent_centerY)
```

This requires actual torso displacement across time rather than trusting one
instantaneous velocity value.

### Shape and ground signals

```text
bounding_box_ratio  = box_width / box_height
bounding_box_bottom = box_y + box_height
```

A track is considered **near ground** only when:

```text
centerY >= 0.56 AND bounding_box_bottom >= 0.82
```

It is considered **horizontal** when:

```text
body_angle >= 52 degrees OR bounding_box_ratio >= 0.90
```

The `groundSignal` is true only when both near-ground and horizontal are true.
This combination is important: standing still, chewing, sitting, or moving an
arm does not by itself mean a fall.

### Timers

- `groundDurationMs` increases while `groundSignal` is true; otherwise it resets.
- `timeSinceMovementMs` increases while smoothed motion is at most `0.045`;
  otherwise it resets.
- State-machine time steps are capped at 120 ms so a frozen browser tab cannot
  instantly manufacture several seconds of evidence when it resumes.

## 5. Browser fall state machine

`frontend/js/fall-detector.js` owns one independent state machine per track.
The current thresholds live in `frontend/js/config.js`.

### Evidence gates

A frame is a **descent sample** when either:

```text
descent_distance >= 0.16
```

or both:

```text
downward_speed >= 0.48 u/s
descent_distance >= 0.075
```

Descent must remain supported for 280 ms before it becomes a confirmed rapid
descent. A single noisy landmark frame therefore cannot elevate the system.

An **instability sample** requires all of:

```text
body_angle >= 38 degrees
AND (descent_distance >= 0.06 OR near_ground)
```

It must persist for 450 ms. A lean without descent/ground evidence is not enough.

### States and transitions

| State | How it is entered | What can happen next |
|---|---|---|
| `NORMAL` | Initial/recovered state | Confirmed descent -> `RAPID_DESCENT`; confirmed instability -> `INSTABILITY` |
| `INSTABILITY` | 450 ms of leaning plus descent/ground evidence | Rapid descent -> `RAPID_DESCENT`; grounded with enough descent -> `GROUND`; upright for 900 ms or candidate lasts 1.9 s -> `NORMAL` |
| `RAPID_DESCENT` | 280 ms of meaningful downward movement | Grounded for 600 ms -> `GROUND`; upright for 900 ms or candidate lasts 1.9 s -> `NORMAL`/`INSTABILITY` |
| `GROUND` | Fall candidate reaches a horizontal, near-bottom posture | Low motion for 2.2 s -> `IMMOBILE`; non-ground/upright or recovery motion -> `RECOVERY` |
| `IMMOBILE` | Confirmed ground posture plus 2.2 s with motion <= 0.045 | Both ground time and no-movement time reach 4.8 s -> `POSSIBLE_DISTRESS`; recovery -> `RECOVERY` |
| `POSSIBLE_DISTRESS` | Sustained post-fall immobility | Movement away from grounded posture -> `RECOVERY` |
| `RECOVERY` | Rising or renewed movement after a ground state | Upright for 1.2 s -> `NORMAL`; grounded and still again -> `GROUND` |

`recoveryMotion` is `0.09`. “Upright” means angle below 38 degrees, box ratio
below 0.90, and not near ground.

### Labels and confidence

The state maps to an explainable label and base confidence:

| State | UI label | Base confidence |
|---|---|---:|
| `NORMAL` | Normal motion | 0.00 |
| `INSTABILITY` | Instability observed | 0.42 |
| `RAPID_DESCENT` | Rapid downward movement | 0.58 |
| `GROUND` | Possible fall | 0.72 |
| `IMMOBILE` | Person remains on ground | 0.84 |
| `POSSIBLE_DISTRESS` | Possible collapse / distress | 0.93 |
| `RECOVERY` | Recovery movement | 0.62 |

The displayed confidence is capped by the current pose confidence. Confidence
means certainty in the observed movement classification; it is not severity.

## 6. Browser Guardian Score

`frontend/js/guardian-score.js` calculates severity from 0 to 10. Before state
floors/caps, the score is:

```text
score = 0.8
      + clamp(downward_speed / 0.48, 0, 1) * 1.8
      + clamp(descent_distance / 0.16, 0, 1) * 1.2
      + clamp((abs(body_angle) - 38) / (90 - 38), 0, 1) * 1.4
      + clamp(ground_time / 4800, 0, 1) * 1.8
      + clamp(no_movement_time / 4800, 0, 1) * 2.3
        * clamp(ground_time / 2200, 0, 1)
```

During `NORMAL` or `RECOVERY`, active motion subtracts up to `1.1` points:

```text
subtract clamp(motion_magnitude / 0.25, 0, 1) * 1.1
```

State floors prevent a confirmed sequence from looking safe just because the
initial downward motion ended:

| State | Minimum score |
|---|---:|
| `NORMAL` | 0.0 |
| `INSTABILITY` | 2.6 |
| `RAPID_DESCENT` | 4.4 |
| `GROUND` | 5.5 |
| `IMMOBILE` | 7.0 |
| `POSSIBLE_DISTRESS` | 8.6 |
| `RECOVERY` | 3.0 |

False-positive caps are then applied: `NORMAL` cannot exceed 1.9 and
`INSTABILITY` cannot exceed 2.9. Therefore raw pose jitter cannot reach the
Elevated band until the temporal detector confirms a fall-shaped sequence.

Score bands are:

| Score | Band |
|---|---|
| 0.0-2.9 | Low |
| 3.0-5.9 | Elevated |
| 6.0-7.9 | High |
| 8.0-10.0 | Critical |

## 7. How local results become dashboard incidents

`frontend/js/app.js` owns the single application animation loop:

```text
process a MediaPipe frame when due
-> update pose engine and every track's timers/state
-> synchronize meaningful changes into shared state every 160 ms
-> render camera/overlay
-> animate Guardian Score
-> update live feature values
-> request the next animation frame
```

For multiple people, the UI focuses the highest fall state, then the highest
score. A current ground-level focus is kept unless another person is clearly
more concerning, reducing visual jumping between tracks.

Timeline entries are emitted on meaningful state transitions. A local incident
is opened only at `GROUND`, `IMMOBILE`, `POSSIBLE_DISTRESS`, or `RECOVERY`, not
for every movement frame. Each anonymous tracking ID keeps one incident card.
When that person returns to `NORMAL`, the incident becomes resolved.

`frontend/js/state.js` is one plain object with a small publish/subscribe layer.
All dashboard producers use the same actions, such as `setGuardianScore`,
`setConfidence`, `addTimelineEvent`, and `upsertIncident`. Panels re-render only
when the state keys they use change.

`frontend/js/live-director.js` turns severity into a **simulated workflow**:

- High score band -> incident received;
- Critical score band -> selected responder rows become notified; and
- resolved incident -> responder rows and recommendations become resolved.

It does not actually call emergency services or message responders.

## 8. Optional Python AI/CV path

The canonical packaged Python modules are under `ai_cv/`. Same-named files at
the repository root are legacy copies and are not all identical; run modules as
`python -m ai_cv...` to avoid importing the wrong copy.

### 8.1 Capture and pose estimation

`ai_cv/guardian_mesh_inference.py` accepts a webcam index, video path, or RTSP
URL through OpenCV. OpenCV BGR frames are converted to RGB before inference.

`ai_cv/pose_tracker.py` uses the classic `mp.solutions.pose` API from MediaPipe
`0.10.8`, model complexity 1 by default, and MediaPipe's internal landmark
smoothing. It reads each selected joint by its explicit MediaPipe index (for
example shoulders `11/12`, hips `23/24`, and ankles `27/28`), builds
pixel-coordinate keypoints and a box, and assigns a temporary numeric
`person_id`. Pose confidence is the mean confidence of the shoulders and hips,
so a briefly hidden wrist or ankle does not discard an otherwise reliable
torso observation.

The code performs centroid/IoU track association and removes a track after 30
missed frames by default. However, the classic MediaPipe Pose API used here
returns one pose per frame. Despite older “multi-person” comments, this Python
path is effectively single-person unless its detector is replaced. The browser
Pose Landmarker path is the current multi-pose implementation.

After a detection is associated with an existing track, GuardianMesh applies
exponential smoothing to matched keypoints. `smoothing_alpha` controls how much
of the current observation is used; its default `0.7` keeps 70% of the new point
and 30% of the previous point. The bounding box is recomputed from the smoothed
points. For the most trustworthy current demo, use the browser path, which is
the default and supports multiple people.

### 8.2 Python temporal features

After at least three frames for a tracked person,
`ai_cv/temporal_features.py` computes:

- **center-of-mass velocity:** confidence-weighted mean of visible point
  positions; consecutive Euclidean distances divided by frame height;
- **body velocity:** mean of those recent velocities;
- **max velocity:** largest recent value;
- **motion variance:** variance of recent velocities;
- **acceleration:** mean absolute difference between consecutive velocities;
- **horizontal offset:** shoulder-center displacement from frame center,
  normalized to `-1..1`;
- **vertical drop:** linear-regression slope of nose y over history, divided by
  frame height; positive in the implementation means downward;
- **body angle:** absolute angle of the hip-to-shoulder vector from vertical;
- **arm raise ratio:** relative wrist height above the shoulders;
- **static frames:** consecutive recent center-of-mass velocities below `0.05`;
- **immobility score:** `min(1, static_frames / 30)`;
- **ground contact confidence:** fraction of visible wrists/ankles inside the
  bottom 15% of the frame; and
- **hand position:** `up`, `mid`, `down`, `touching_ground`, or `unknown`.

### 8.3 Python fall score

The Python `FallDetector` builds five normalized signals:

```text
body_angle_signal = min(1, body_angle / 75)
vertical_drop_signal = clamp(vertical_drop * 2, 0, 1)
impact_signal = max_recent_velocity
                * (1 - body_velocity / max(max_velocity, 0.01))
ground_signal = ground_contact_confidence
immobility_signal = immobility_score
```

Then:

```text
fall_score = 0.25 * body_angle_signal
           + 0.30 * ground_signal
           + 0.20 * vertical_drop_signal
           + 0.15 * impact_signal
           + 0.10 * immobility_signal

immobility_final = 0.50 * immobility_score
                  + 0.30 * (1 - min(1, body_velocity * 10))
                  + 0.20 * ground_contact_confidence
```

Its signal-consistency confidence is `1 - variance(signals)/0.25`, clipped to
`0.3..1.0`. Event confidence combines 70% of that value with 30% pose confidence.

### 8.4 Python event classification and smoothing

`ai_cv/event_classifier.py` selects in this order:

1. `AGGRESSIVE` when body velocity is over 0.3 and arm raise ratio over 0.6;
2. `CONFIRMED_FALL` when fall score is over 0.75 and immobility over 0.60;
3. `POSSIBLE_FALL` when fall score is over 0.50;
4. `IMMOBILITY` when immobility is over 0.80 and fall score is below 0.50;
5. `DISTRESS` when at least two rule-based lean/angle/ground-still signals are
   present; otherwise `NORMAL`.

`RealtimeProcessor` averages each person's last five fall scores and emits an
alert only when the smoothed value exceeds the configured threshold. The main
pipeline's CLI default is 0.50. It sends one below-threshold follow-up when an
alerting person returns to normal so the dashboard can resolve the incident.

The Python dashboard payload normalizes coordinates and maps severity to a
0-10 score as:

```text
guardianScore = clamp(7 * fall_score + 3 * immobility_score, 0, 10)
```

Only JSON metadata is posted. Raw frames are not sent. Annotated video is saved
only when both an output path and the explicit `--allow-recording` flag are used.

## 9. FastAPI backend

`backend/backend_server.py` provides event ingestion, scoring, persistence,
camera metadata, nearby help, WebSocket fan-out, and the rescue leaderboard.

### Backend score

The backend does not trust a client's claimed state or overall confidence. It
recomputes:

```text
overall_confidence = 0.45 * fall_score
                   + 0.35 * immobility_score
                   + 0.20 * tracking_confidence
```

Then:

| Backend state | Exact gate |
|---|---|
| `DISTRESS_EVENT` | fall >= 0.75, immobility >= 0.70, tracking >= 0.70, persistence >= 5 s |
| `VERIFYING` | fall >= 0.75 and immobility >= 0.65 |
| `POSSIBLE_FALL` | fall >= 0.75 |
| `NORMAL` | otherwise |

The frontend maps these server states to normal, observing, warning, and
critical respectively. Server state outranks a client-provided label.

Current limitation: the Python `to_dashboard_dict()` does not include
`persistence_seconds`, so FastAPI receives its default `0.0`. Consequently the
Python-to-FastAPI stream can reach `VERIFYING` but cannot reach
`DISTRESS_EVENT` unless a client is updated to send persistence. The browser's
local state machine does not have this limitation.

### Storage and streaming

- Default database: `guardianmesh.db` through SQLite; `DATABASE_URL` can point
  to another SQLAlchemy database.
- Every ingested frame/event currently creates an incident row with scores,
  derived state/reason, timestamp, anonymous numeric person ID, and camera
  mounting location.
- WebSocket `/ws/all` receives every camera; `/ws/{camera_id}` receives that
  camera. Messages use `{type: "event", data: {...}}` envelopes.
- The frontend correlates repeated per-frame backend events by
  `cameraId + trackingId`, producing one UI incident rather than hundreds.
- When `GUARDIANMESH_ACCESS_TOKEN` is set, non-public HTTP routes require
  `Authorization: Bearer ...` and WebSockets require `?token=...`.
- `/health` and `/api/status` remain public health probes.

### Other backend endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/events` | Store raw CV metrics, recompute backend state, broadcast metadata |
| `POST /api/score` | Run the same backend score without storing an incident |
| `GET /api/incidents` | Query stored incident metadata |
| `POST /api/incidents/{id}/acknowledge` | Mark an incident reviewed |
| `GET /api/cameras` | Combine camera registry entries with recently active cameras |
| `GET /api/cameras/{id}` | Camera status and recent incidents |
| `GET /api/nearby-help` | Public care locations plus configured trusted resources |
| `GET /api/leaderboard` | Rescue counts per responder |
| `POST /api/rescues` | Idempotently credit responders for a resolved incident |

## 10. Nearby help and camera locations

Coordinates always describe a **camera mounting location**, never a tracked
person's precise position.

The camera registry comes from `GUARDIANMESH_CAMERAS_FILE` in FastAPI or
`CAMERAS_JSON` in Cloudflare. IDs are normalized so `cam_02`, `CAM-02`, and
`cam02` match.

Nearby help combines:

- public hospitals, medical centers/clinics, and pharmacies from Google Places
  when `GOOGLE_MAPS_API_KEY` exists; and
- trusted facility staff, designated responders, and security desks from a
  private configured registry.

Distance is the Haversine great-circle distance between coordinates. Google
failure is non-fatal; configured trusted resources are still returned. The
browser never receives the Google API key. For privacy, trusted people's names
are not rendered; the UI shows their role and registry ID. This is a lookup and
recommendation feature, not automatic dispatch.

## 11. Cloudflare Worker

`wrangler.toml` configures `worker.js` plus `frontend/` static assets.
`run_worker_first` routes `/api/*`, `/health`, and `/ws/*` through the Worker;
other requests go to static assets through the `ASSETS` binding.

If `BACKEND_ORIGIN` is configured, the Worker first proxies API/health/WebSocket
requests to that FastAPI origin. Exceptions and upstream 5xx responses use the
edge fallback. Upstream 4xx responses are returned as-is.

The edge fallback provides:

- `/health` and `/api/status`;
- `/api/score` with the same state gates as FastAPI;
- `/api/nearby-help`;
- `/api/cameras` from `CAMERAS_JSON`;
- an empty `/api/incidents` response;
- a WebSocket that reports status and answers `ping`, but does not ingest or
  broadcast CV events; and
- `/api/leaderboard` and `/api/rescues` through a SQLite-backed Durable Object.

Important: the edge fallback does **not** implement `POST /api/events`. Live
Python event ingestion therefore requires a working `BACKEND_ORIGIN`. The
default browser camera path remains fully functional without it because its
assessment happens locally.

## 12. Frontend backend adapter

`frontend/js/datasource.js` accepts both camelCase dashboard fields and legacy
snake_case Python fields. When rich scoring is missing it derives
`guardianScore = 7*fall + 3*immobility`. A backend `state`, when present, is
authoritative.

When connected, it:

1. optionally probes `/api/status`;
2. loads the camera registry;
3. connects to `/ws/all` with `ws://` or `wss://` chosen from the origin;
4. resets local/fixture tracks so fake and live people cannot mix;
5. applies incoming tracks/events to the same pose engine and shared state; and
6. uses bounded reconnect delays of 1, 2, 4, 8, and 15 seconds.

Repeated events are correlated by camera plus anonymous track. State changes,
not every frame, create timeline entries. An incoming normal state resolves the
existing situation.

## 13. Dashboard panels

- **System header:** truthful camera, model, backend, people, incident, latency,
  and privacy state.
- **Live Guardian Feed:** real video, yellow anonymous boxes, state label,
  feature strip, and critical auto-focus.
- **Guardian Score:** severity, confidence, possible event, focus track,
  immobility, motion state, and trend.
- **AI Reasoning Timeline:** human-readable state transitions and evidence.
- **Guardian Mesh:** cameras/sensors, event corroboration, and anonymous handoff.
- **Incidents:** one evolving card per correlated situation.
- **Response Mesh:** simulated responder workflow, recommendations, and live
  nearby-resource lookup when coordinates exist.
- **Gamification:** local operator XP, levels, streak, and achievements plus a
  shared rescue leaderboard.

Gamification stores personal progress and an offline rescue queue in browser
`localStorage`. A resolved incident can credit engaged responders through
`POST /api/rescues`. The server key combines rescue occurrence and responder,
so retries do not double-count.

## 14. Privacy and safety boundary

What is processed or stored:

| Data | Browser default | Python/FastAPI path |
|---|---|---|
| Raw frames | Memory only | Local process memory; optional explicit recording only |
| Pose landmarks | Browser memory | Python memory; normalized landmarks may be event metadata |
| Face identity | Not computed | Not computed |
| Anonymous tracking ID | Session memory | Metadata/database numeric ID |
| Incident scores/state | Browser memory | SQLite metadata and WebSocket messages |
| Camera location | Optional registry metadata | Optional registry/database metadata |
| Gamification | Browser localStorage | Rescue credits in SQLite/Durable Object |

GuardianMesh cannot determine why somebody fell, whether somebody is having a
heart attack, whether a person is conscious, or whether emergency services are
required. “Possible distress” means the observed sequence matched descent,
ground posture, and sustained low movement. A human must verify it.

## 15. False positives, false negatives, and camera setup

The system is intentionally less sensitive to chewing/talking and one-frame
jitter. Regression tests cover standing still, chewing/talking noise, crouching,
stumbling/recovery, and fall/collapse-like movement.

Detection can still fail when:

- the shoulders or hips are hidden;
- the whole body or floor area is outside the frame;
- lighting, blur, loose clothing, or occlusion damages landmarks;
- the camera moves or is extremely tilted;
- a person is already lying down when tracking begins, so there is no descent;
- normalized “near bottom of frame” thresholds do not match camera placement;
- multiple bodies overlap or track IDs swap; or
- an unusual but harmless movement matches the same geometry.

For a reliable demo, mount the camera still, include the person's full body and
visible floor, use even lighting, keep the subject large enough for clear
landmarks, and rehearse with safe controlled movement. Do not perform an unsafe
real fall; use a padded setup or a recorded test clip.

## 16. Running each mode

### Browser-only demo (recommended)

```bash
npm start
```

Open `http://localhost:8080/`, press **Start Live Camera**, allow camera access,
and remain fully visible. A backend is not required.

### Explicit development simulation

Open:

```text
http://localhost:8080/?dev=simulation
```

This is synthetic test data and must not be presented as live camera inference.

### Full local Python/backend path

From the repository root, with a compatible Python environment:

```bash
pip install -r requirements/requirements.txt
python -m uvicorn backend.backend_server:app --host 127.0.0.1 --port 8000
```

In another terminal:

```bash
npm start
```

In another terminal:

```bash
python -m ai_cv.guardian_mesh_inference \
  --source 0 \
  --camera_id cam_01 \
  --no_viz \
  --api_url http://127.0.0.1:8000
```

Then open `http://localhost:8080/?live`. If a backend token is configured, pass
`--api-token` to Python and use `?live&token=...` in the dashboard.

### Cloudflare

Validate without deploying:

```bash
npx --yes wrangler@4.131.1 deploy --dry-run
```

Deploy only when authorized:

```bash
npx wrangler deploy
```

The PowerShell helper `deploy_guardianmesh.ps1` performs syntax checks, a dry
run, optional secret upload, deployment, and optional public smoke tests.

Cloudflare configuration values/secrets may include:

- `BACKEND_ORIGIN` — hosted FastAPI origin for live ingestion/streaming;
- `GOOGLE_MAPS_API_KEY` — server-side Google Places key;
- `TRUSTED_RESPONDERS_JSON` — trusted-resource registry; and
- `CAMERAS_JSON` — camera names, mounting locations, and coordinates.

## 17. Testing and tuning

Browser detector regression tests:

```bash
npm test
```

JavaScript validation:

```bash
find frontend/js -name '*.js' -print0 | xargs -0 -n1 node --check
node --check server.js
node --check worker.js
git diff --check
```

Python syntax validation:

```bash
python -m py_compile ai_cv/*.py backend/*.py
```

`ai_cv/evaluate_pipeline.py` evaluates labeled videos and reports binary event
accuracy, precision, recall, F1, fall ROC-AUC, and score MAE/RMSE. Its annotation
file maps video filenames to per-frame event labels and target fall/immobility
scores.

Tune the browser thresholds only in `frontend/js/config.js`, and add or update a
scenario in `tests/fall-detector.test.mjs` for every behavior change. Thresholds
are camera-geometry dependent; evaluation on representative staged footage is
more meaningful than tuning against one person's one demo.

## 18. File ownership map

| Area | Primary files |
|---|---|
| Browser model and tracking | `frontend/js/browser-pose.js` |
| Browser temporal features | `frontend/js/pose-engine.js` |
| Browser fall states | `frontend/js/fall-detector.js` |
| Thresholds/endpoints | `frontend/js/config.js` |
| Guardian Score | `frontend/js/guardian-score.js` |
| App orchestration | `frontend/js/app.js` |
| Camera/overlay | `frontend/js/camera.js`, `frontend/js/pose-overlay.js` |
| Shared UI state | `frontend/js/state.js` |
| Backend event adapter | `frontend/js/datasource.js`, `frontend/js/websocket.js` |
| Incidents/timeline/mesh | `frontend/js/incidents.js`, `timeline.js`, `mesh.js` |
| Response/nearby help | `frontend/js/response.js`, `backend/nearby_help.py` |
| Gamification | `frontend/js/gamification.js` |
| Python pose/features/classifier | `ai_cv/pose_tracker.py`, `temporal_features.py`, `event_classifier.py` |
| Python runner | `ai_cv/guardian_mesh_inference.py` |
| FastAPI/backend score | `backend/backend_server.py` |
| Camera registry | `backend/camera_registry.py` |
| Cloudflare edge | `worker.js`, `wrangler.toml` |
| Validation | `tests/fall-detector.test.mjs`, `ai_cv/evaluate_pipeline.py` |

## 19. One-sentence presentation summary

GuardianMesh converts locally computed anonymous body landmarks into explainable
motion and posture features, requires a sustained fall-shaped sequence before
escalating, and gives a human operator evidence, context, and nearby-response
options without trying to identify or medically diagnose the person.
