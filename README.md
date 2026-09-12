# GuardianMesh

**Security cameras record emergencies. GuardianMesh understands them.**

GuardianMesh is a privacy-first AI emergency awareness network. It uses ordinary
cameras (and other sensors) to recognise **observable human distress patterns over
time**, scores how concerning a situation appears, and activates a **simulated**
emergency-response workflow.

GuardianMesh recognises observable behaviour — sudden collapse, rapid vertical
displacement, abnormal body orientation, prolonged immobility, erratic movement.
**It is not a medical diagnosis system** and does not identify people.

```
CAMERA → PERSON TRACKING → POSE ESTIMATION → TEMPORAL MOVEMENT FEATURES
       → EVENT CLASSIFICATION → CONFIDENCE → GUARDIAN SEVERITY SCORE
       → INCIDENT DASHBOARD → SIMULATED RESPONSE
```

---

## Run the frontend

The dashboard is plain **HTML5 + CSS3 + vanilla JavaScript (ES modules)**. No build
step, no framework, no npm dependencies. Browsers block ES modules on `file://`, so
serve the folder over HTTP:

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

### Demo Mode

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

---

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

---

## Architecture in one line

```
Demo Mode  ─┐
            ├─→  state.js actions  ─→  subscribers  ─→  panel renderers
WebSocket  ─┘        (one vocabulary, one shared state object)
```

Both producers write through the **same action functions** (`setGuardianScore`,
`setConfidence`, `addTimelineEvent`, `upsertIncident`, `setCameraStatus`,
`setResponseState`, …), so no UI code branches on where data came from.

`js/app.js` runs a **single `requestAnimationFrame` loop** that ticks the demo,
advances the pose engine, renders the camera + overlay, eases the score gauge and
writes the live feature readouts. There are no stray timers to leak.

---

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

---

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

## Integration contract — backend teammate

Open a WebSocket at `CONFIG.WS_PATH` (default `/ws/events`) and send JSON frames.
`js/datasource.js` normalises every shape below into state actions.

```jsonc
// 1. system status
{ "type": "status", "systemStatus": "online", "latencyMs": 42, "aiEngine": "active" }

// 2. mesh nodes
{ "type": "cameras",
  "cameras": [{ "id": "CAM-02", "label": "CAM 02", "location": "Main Corridor",
                "status": "critical", "people": 3, "online": true }],
  "sensors": [{ "id": "SEN-01", "label": "SENSOR 01", "location": "Corridor Motion",
                "kind": "motion", "status": "observing", "online": true }] }

// 3. live tracks (see CV contract above)
{ "type": "tracks", "tracks": [ /* ... */ ] }

// 4. a reasoning step for the timeline
{ "type": "timeline", "event": { "kind": "warning",
    "title": "Ground-level pose detected — person has reached floor level.",
    "facts": [{ "label": "Confidence", "value": "61%" }] } }
// kind: observation | inference | warning | critical | response | resolved | system

// 5. simulated response workflow
{ "type": "response", "responseState": "notified",
  "recommendations": ["Alert designated responder"] }
// responseState: idle | received | notified | acknowledged | en_route | resolved

// 6. cross-sensor corroboration
{ "type": "corroboration",
  "entries": [{ "source": "CAM-03", "observation": "Ground-level pose", "confidence": 0.76 }],
  "result": { "label": "Possible distress pattern", "confidence": 0.94,
              "guardianScore": 8.9, "status": "critical" } }
```

### 7. The main event (anything without a recognised `type`)

```jsonc
{
  "id": "EVT-001",
  "timestamp": "2026-09-12T10:42:22.500Z",
  "trackingId": "P-02",
  "cameraId": "CAM-03",
  "location": "School Gym",
  "eventType": "fall",          // normal | pose_anomaly | rapid_displacement | fall
                                // | collapsed | immobility | distress | running
                                // | altercation | crowd_anomaly
  "confidence": 0.94,           // 0..1 (percentages 0..100 are accepted too)
  "guardianScore": 8.7,         // 0..10 — SEVERITY, never merged with confidence
  "status": "critical",         // observing | elevated | warning | critical
                                // | resolving | resolved
  "durationMs": 18000,
  "boundingBox": { "x": 0.31, "y": 0.28, "width": 0.17, "height": 0.52 },
  "keypoints": [],
  "temporalFeatures": {
    "verticalVelocity": -0.82,  // normalised units/sec, negative = downward
    "motionMagnitude": 0.08,    // normalised units/sec
    "bodyAngle": 76,            // degrees from vertical
    "groundDurationMs": 18000,
    "timeSinceMovementMs": 18000
  }
}
```

One such event updates the score, confidence, camera node, incident card **and**
the timeline.

### Turning the backend on

`CONFIG.BACKEND_ENABLED` is **false** by default, and while it is false the
frontend makes **no network requests at all** — it runs entirely on demo data.
That is deliberate: a reachability probe against a plain static server answers
404, and the browser logs that 404 to the console itself (no JavaScript can
suppress it), which is noise you do not want on a projector.

Two ways to attach a live backend:

```js
window.guardian.connect()      // console, no file edits — connects immediately
```
```js
// frontend/js/config.js — permanent
BACKEND_ENABLED: true
```

Once enabled, `GET {API_BASE}/status` is probed at boot and, when
`CONFIG.REQUIRE_API_PROBE` is true, gates whether the WebSocket is opened at all.
Set `REQUIRE_API_PROBE: false` if your stack exposes the socket without that
route. A dropped socket retries on a bounded backoff ladder and then stops,
reporting DISCONNECTED in the header rather than retrying forever.

**Confidence and Guardian Score are separate quantities and must stay separate.**
Confidence = how certain the classification is. Guardian Score = how concerning
the situation looks. Bands: 0–2.9 Low · 3.0–5.9 Elevated · 6.0–7.9 High · 8.0–10 Critical.

---

## Console helpers

```js
window.guardian.snapshot()           // current state as plain JSON
window.guardian.emit({ ... })        // inject any payload from the contracts above
window.guardian.score(7.2)           // force a Guardian Score
window.guardian.demo.start()         // .next() / .reset()
window.guardian.connect()            // retry the backend connection
```

---

## Privacy

GuardianMesh reasons over pose keypoints, body position, movement, direction,
acceleration, duration, motion magnitude, anonymous tracking IDs and event
metadata. There is no facial recognition, no name, no identity profile, and no
identity data anywhere in the event schema.

> GuardianMesh doesn't need to know who you are to know that you may need help.

The response workflow is **simulated**. Nothing in this project contacts emergency
services.
