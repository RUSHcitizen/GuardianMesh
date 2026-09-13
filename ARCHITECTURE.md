# GuardianMesh frontend — architecture

How the command-center frontend is put together, and where to plug things in.
For how to run it and the JSON contracts, see [README.md](README.md).

Stack: HTML5, CSS3, vanilla JavaScript (ES modules). No framework or build
step. The YOLO26-pose model and the ONNX Runtime Web build are served from this
origin, so the page depends on no CDN.

---

## 1. Layer stack

```
┌─ PERCEPTION ─────────────────────────────────────────────────┐
│  camera.js ── browser-pose.js (YOLO26-pose via ONNX Runtime) │
│           └── pose-overlay.js (yellow detection boxes)       │
│  pose-engine.js → tracks + temporal feature derivation       │
│  fall-detector.js → per-person temporal state machine        │
└──────────────────────────┬───────────────────────────────────┘
                           │ person records (normalised 0..1)
┌─ REASONING / STATE ──────▼───────────────────────────────────┐
│  state.js          one plain object + pub/sub + actions      │
│  guardian-score.js severity model, band resolution           │
└──────────────────────────┬───────────────────────────────────┘
                           │ (state, changed[])
┌─ PRESENTATION ───────────▼───────────────────────────────────┐
│  system-header · timeline · incidents · mesh · response      │
└──────────────────────────────────────────────────────────────┘

┌─ PRODUCERS ──────────────────────────────────────────────────┐
│  app.js (local CV)  datasource.js ← websocket.js (backend)   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. The central idea: producers share one vocabulary

```
Local CV ───┐
WebSocket ──┴──► state.js actions ──► subscribers ──► renderers
                 setGuardianScore, setConfidence, addTimelineEvent,
                 upsertIncident, setCameraStatus, setResponseState, …
```

Both producers write through the **same action functions**. No panel renderer
branches on where data came from. There is no third, synthetic producer: the
scripted simulation and its canonical pose library were removed, so a track on
screen is always something the camera saw.

Two structural rules enforce this, and both are visible in the import graph:

1. **Only `app.js` and `datasource.js` import `state.js`.** Every panel renderer
   is a pure function of the state object handed to it; it cannot reach global
   state.
2. **The perception layer never imports `state.js`.** `pose-engine`,
   `pose-overlay`, `browser-pose` and `camera` are a self-contained subsystem
   that the render loop pulls from.

### Module graph

```
app.js ─┬─ camera.js ───────── pose-overlay.js
        ├─ browser-pose.js ─── vendor/onnxruntime + assets/models/yolo26n-pose.onnx
        ├─ pose-engine.js ──── fall-detector.js
        ├─ datasource.js ─┬─ websocket.js
        │                 └─ data/mock-events.js
        ├─ guardian-score.js ────────────── data/mock-events.js
        ├─ system-header.js
        ├─ timeline.js
        ├─ incidents.js ─── guardian-score.js   (bandFor)
        ├─ mesh.js
        ├─ response.js
        ├─ live-director.js ─── guardian-score.js
        └─ state.js

leaves: util.js, config.js, data/*.js
```

No cycles. The single cross-panel edge is `incidents.js → guardian-score.js`,
for `bandFor()`, so an incident's score chip uses the same band colour as the
gauge.

---

## 3. State and change routing

```js
update(patch)                     // shallow merge, then notify subscribers
subscribe((state, changed) => …)  // changed = array of mutated key names
touched(changed, 'incidents')     // guard helper
```

`app.js` holds the routing table. Each renderer runs only when state it
actually depends on changed:

| Renderer | Wakes on |
|---|---|
| `system-header` | systemStatus, backendStatus, aiEngine, latencyMs, cameras, incidents, trackedPeople, dataSource |
| `guardian-score` | guardianScore, previousScore, confidence, eventLabel, eventType, focusPersonId, motionState, immobilitySeconds, scoreTrend |
| `timeline` | timeline |
| `incidents` | incidents |
| `mesh` | cameras, sensors, corroboration, corroborationResult, handoff, activeCamera |
| `response` | responders, responseState, recommendations |
| data-source flag | dataSource, backendStatus |
| camera HUD label | cameras, activeCamera |

### Action vocabulary (`state.js`)

```
setSystem            setGuardianScore     setConfidence      setAssessment
setFeatures          setTrackedPeople     upsertTrackedPerson
addTimelineEvent     clearTimeline        upsertIncident     clearIncidents
setCameraStatus      setSensorStatus      setResponders      setResponderState
setResponseState     setCorroboration     setHandoff         snapshot
```

Adding a new producer means calling these — never touching a renderer.

---

## 4. One application animation loop

`app.js` owns the application `requestAnimationFrame`; YOLO26 inference,
feature derivation, overlay rendering, and panel animation all run from it.

```js
frame(now):
  pose.processFrame(now)     // interval-gated YOLO26 inference, async
                             // → engine.applyExternalTrack() per detection
  people = engine.update(dt) // derive features + advance fall state machines
  camera.render(people, now) // real media + yellow detection boxes
  panels.score.tick(dt)      // ease the gauge toward its target
  renderFeatures(people)     // → writes DOM directly (see below)
  syncState(people, now)     // → throttled to 240 ms
```

**Why some values bypass shared state.** The feature strip and HUD track count
change every frame. Pushing them through `update()` would wake the routing
table ~60×/s and re-render unrelated panels. So per-frame values are written
straight to their nodes, and only slower-moving derived values enter shared
state — gated by a track signature (`id:status`) and whole-second changes, so
identical frames cost nothing.

The same reasoning applies to the Guardian Score: state holds the **target**,
and the panel eases the displayed number toward it each frame.

---

## 5. Perception pipeline

```
camera frame → letterbox 640x640 → YOLO26-pose → decode rows → anonymous track
             match → temporal features → fall state machine
             → Guardian Score / timeline / incidents
```

### The coordinate contract

Everything crossing a module boundary is **normalised 0..1, origin top-left**.

That one contract is why the media and AR overlay stay pixel-registered.
`pose-overlay` converts to pixels against a `contentRect`
it derives from the live media, including `object-fit: cover` letterboxing, so
registration survives resize and source swaps.

`engine.applyExternalTrack()` is the seam where local YOLO26 output or an
external CV producer enters the engine. Decoding YOLO26's rows into that
contract is the one piece of model-specific arithmetic in the frontend, so it
lives in two pure exported functions (`letterboxFor`, `decodeDetections`) and is
pinned against real model output by `tests/yolo26-decode.test.mjs`.

### Camera sources

`camera.js` starts off, then accepts an explicit webcam or picked-video choice.
Failures (permission denied, no device, undecodable file) remain visible and do
not silently create simulated people. There is no simulated source to fall back
to: a dashboard that invents detections is worse than one that stops.

---

## 6. Demo controller: time-driven, not timer-driven

Steps are `{ at: ms, name, run() }` in an array, advanced by a cursor against
`performance.now() - startedAt`. There is no nested `setTimeout`.

That buys three things cheaply:

- **NEXT STEP** is `startedAt = now - steps[cursor].at`
- **RESET** is `cursor = 0` plus a state reseed — no cleanup
- a dropped frame cannot desync the sequence, because elapsed time is the
  source of truth rather than accumulated delays

Staggered moments (the critical escalation) are separate steps a few hundred
milliseconds apart, not nested callbacks, so they remain individually
inspectable and cancellable.

---

## 7. Transport and the adapter

```
backend / websocket → datasource.js → normalised event → state actions → UI
```

- `normalizeEvent()` tolerates `camelCase` or `snake_case` keys and confidence
  as 0..1 or 0..100.
- `handleGuardianEvent()` switches on frame type (`status`, `cameras`,
  `tracks`, `timeline`, `response`, `corroboration`, or the main event) and
  calls the same actions the local CV path uses.
- `websocket.js` is pure transport with a bounded backoff ladder that
  terminates and reports `DISCONNECTED` rather than retrying forever.

`CONFIG.BACKEND_ENABLED` is `false` by default, so the local browser inference
path needs no backend at all, and the status rail simply omits the Backend chip
rather than reporting a permanent, alarming "Offline". The model and runtime are
served from this origin, so the default page makes no third-party request.
Attach a separately deployed HTTPS/WSS backend with `window.guardian.connect()`
or by flipping the flag; the Backend chip appears when one is in play.

---

## 8. CSS architecture

Four stylesheets, loaded in this order — **the order is load-bearing**, since
same-specificity overrides only win from the later file:

| File | Holds |
|---|---|
| `tokens.css` | colour, spacing, type, radius, motion tokens; status resolution |
| `base.css` | reset, typography atoms, badges, buttons, empty states |
| `layout.css` | app shell, header, dashboard grid, panel chrome, media queries |
| `components.css` | camera stage, gauge, timeline, incidents, mesh, response |

Responsive rules that override a component must live in `components.css`, not
`layout.css`.

### Status resolution

`[data-status]` resolves `--status-color` and `--status-soft` **once**, in
`tokens.css`. No component branches on status: a dot, badge, mesh node, gauge
and incident stripe all just paint `var(--status-color)`. Adding a status is
one token rule.

### Layout

`.guardian-dashboard` is a CSS Grid with named areas. The camera panel is
deliberately the largest area at every breakpoint:

```
1400px+   "camera  score     timeline"     3 columns
          "mesh    incidents response"

≤1400px   "camera   score"                 2 columns
          "timeline incidents"
          "mesh     response"

≤1080px   single column, camera first, min-height 420px
```

A `max-height: 960px` pass compresses vertical rhythm for 900px-tall laptops.

---

## 8b. The live path

```
ai_cv  ──POST /api/events──►  backend  ──ws /ws/all──►  datasource.js
(MediaPipe pose →             (FastAPI,                  │
 temporal features →           SQLite,                   ├─ unwrap envelope
 event classifier →            fan-out)                  ├─ normalise
 to_dashboard_dict)                                      ├─ correlate
                                                         └─ state actions
```

Three things the adapter has to get right, all of them consequences of how the
backend and CV pipeline actually behave:

**1. The envelope.** The backend wraps every detection as
`{ type: "event", data: {…}, timestamp }`, and emits `{ type: "alert", … }` when
a score crosses a threshold. Both are unwrapped in `handleGuardianEvent`; alerts
only reach the timeline when their level *changes*.

**2. The channel.** The WebSocket route is `/ws/{client_id}` and the server fans
out to the `all` channel plus a channel named after the camera. A dashboard must
therefore subscribe as **`/ws/all`** — any other id connects successfully and
then receives nothing, which is the most confusing possible failure.

**3. Correlation.** The CV pipeline posts **once per frame (~30/s)**, each with a
unique event id. Treating those as separate incidents would spawn hundreds of
cards. `datasource.js` keys an incident by the **situation** — camera plus
tracking ID — so one fall is one card that escalates and resolves, and the
timeline records transitions rather than a per-frame log. The same pass guards
every state write, so a 30 fps stream does not re-render the dashboard 30 times
a second.

### Backend-derived state

The backend computes `state`, `overall_confidence` and `reason` server-side
rather than trusting the client, so `normalizeEvent` lets those outrank the
classifier's own `status`, `confidence` and `label`. The correlator keys off the
resulting status, which means a detection the backend scores `NORMAL` opens no
incident even when the CV classifier called that frame a possible fall — the two
can legitimately disagree, and the backend is downstream and authoritative.

### live-director.js

Demo Mode scripts when the stage turns critical and when responders activate. A
live backend streams detections and has no opinion about either, so
`live-director.js` derives them from severity — and runs **only** when
`dataSource === 'live'`, so it never fights the demo controller for the same
panels. Stage status takes the more severe of the classifier's status and the
Guardian Score band, because a classifier may still call sustained immobility a
warning after severity has reached the critical band.

Attaching a live backend also clears the locally detected cameras and people,
so the mesh and overlay show only what the backend actually reports.
Cameras the frontend has never heard of join the mesh on their first event.

### Choosing a data source

| URL | Source |
|---|---|
| `/` | Local YOLO26-pose model + live device camera |
| `/?ep=wasm` or `/?ep=webgpu` | Force an ONNX Runtime execution provider |
| `/?live` | Attach the live backend |
| `/?live&token=…` | Attach a token-protected backend |

---

## 9. Where to plug things in

| Goal | Touch |
|---|---|
| Feed real CV output | `engine.applyExternalTrack()`, or WS `type: "tracks"` |
| Feed a real backend | open `/?live`, or set `CONFIG.BACKEND_ENABLED` |
| Point at another backend | `CONFIG.BACKEND_ORIGIN` / `WS_CLIENT_ID` / `ACCESS_TOKEN` |
| Change live→UI behaviour | `js/live-director.js` |
| Change interface copy | `data/mock-events.js` |
| Change severity maths | `computeGuardianScore()` in `js/guardian-score.js` |
| Change thresholds/bands | `js/config.js` — `THRESHOLDS`, `SCORE_BANDS` |
| Swap the detector or its size | `CONFIG.POSE_MODEL` + `js/browser-pose.js` |
| Re-skin | `styles/tokens.css` |
| Add a panel | render function + one line in the `app.js` routing table |

`CONFIG` and `data/mock-events.js` — the two files most likely to churn during a
hackathon — have no imports into the rest of the system, so they can be edited
without reading anything else.

---

## 10. Invariants worth keeping

- **Guardian Score (severity) and AI Confidence (certainty) stay separate.**
  Two quantities, two components, never merged into one number.
- **Renderers stay pure.** If a panel needs data, it arrives via state; it does
  not import `state.js`.
- **One loop, no timers.** Anything periodic hangs off the `app.js` frame.
- **Normalised coordinates at every boundary.** Model pixels exist only inside
  `browser-pose.js`; screen pixels only inside `pose-overlay.js`.
- **The dashboard must work with the backend down.** Detection is local, so
  that is the normal case, not a degraded one.
- **Nothing on screen is ever synthetic.** If the camera or model fails, the
  interface says so; it never substitutes invented people.
- **Anonymous by construction.** Tracking IDs only — no identity field exists
  anywhere in the state shape or the event schema, and the language describes
  observable behaviour, never a medical diagnosis.
