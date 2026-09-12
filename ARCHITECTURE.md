# GuardianMesh frontend — architecture

How the command-center frontend is put together, and where to plug things in.
For how to run it and the JSON contracts, see [README.md](README.md).

Stack: HTML5, CSS3, vanilla JavaScript (ES modules). No framework, no build
step, no runtime dependencies.

---

## 1. Layer stack

```
┌─ PERCEPTION ─────────────────────────────────────────────────┐
│  camera.js ── scene.js        (simulated feed)               │
│           └── pose-overlay.js (AR tracking graphics)         │
│  pose-engine.js → tracks, pose interpolation, temporal       │
│                   feature derivation                          │
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
│  demo.js (scripted)      datasource.js ← websocket.js (live) │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. The central idea: two producers, one vocabulary

```
Demo Mode  ─┐
            ├──► state.js actions ──► subscribers ──► renderers
WebSocket  ─┘    setGuardianScore, setConfidence, addTimelineEvent,
                 upsertIncident, setCameraStatus, setResponseState, …
```

Both producers write through the **same action functions**. No UI code branches
on where data came from, so Demo Mode exercises the real path rather than a
parallel mock — if the dashboard works in Demo Mode, it works on live data.

Two structural rules enforce this, and both are visible in the import graph:

1. **Only `app.js`, `demo.js` and `datasource.js` import `state.js`.** Every
   panel renderer is a pure function of the state object handed to it; it
   cannot reach global state.
2. **The perception layer never imports `state.js`.** `pose-engine`,
   `pose-overlay`, `scene` and `camera` are a self-contained subsystem that the
   render loop pulls from.

### Module graph

```
app.js ─┬─ camera.js ─┬─ scene.js ──────── data/pose-library.js
        │             └─ pose-overlay.js ─ data/pose-library.js
        ├─ pose-engine.js ───────────────── data/pose-library.js
        ├─ demo.js ──────────────────────── data/mock-events.js
        ├─ datasource.js ─┬─ websocket.js
        │                 └─ data/mock-events.js
        ├─ guardian-score.js ────────────── data/mock-events.js
        ├─ system-header.js
        ├─ timeline.js
        ├─ incidents.js ─── guardian-score.js   (bandFor)
        ├─ mesh.js
        ├─ response.js
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

## 4. One animation loop, and a deliberate bypass

`app.js` owns a single `requestAnimationFrame`. **Nothing else in the codebase
owns a timer**, which is why RESET is reliable: there is nothing to leak.

```js
frame(now):
  demo.tick(now)             // fire any steps whose `at` has elapsed
  people = engine.update(dt) // advance poses, derive temporal features
  camera.render(people, now) // simulated scene (if active) + AR overlay
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
body state   →  pose interpolation  →  placement      →  feature derivation
walking          lerp between           anchor +          verticalVelocity
standing         canonical poses;       scale about       motionMagnitude
stumble          cycles loop            the feet          bodyAngle
falling                                                   groundDurationMs
ground / still                                            timeSinceMovementMs
recovering
seated
```

### The coordinate contract

Everything crossing a module boundary is **normalised 0..1, origin top-left**.

That one contract is why the simulated scene and the AR overlay stay
pixel-registered — they read the same keypoints — and it is the same contract
the CV service fills. `pose-overlay` converts to pixels against a `contentRect`
it derives from the live media, including `object-fit: cover` letterboxing, so
registration survives resize and source swaps.

`engine.applyExternalTrack()` is the seam where real CV output replaces the
simulation. Feature derivation runs identically on top of either, so the UI
cannot tell the difference.

### Camera sources

`camera.js` resolves, in priority order: an explicit runtime choice (webcam or
picked file) → `CONFIG.VIDEO_SOURCE_URL` → the deterministic simulated scene.
Every failure path (permission denied, no device, undecodable file) shows a
stage state and falls back, so the demo never depends on hardware.

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
  calls the same actions Demo Mode uses.
- `websocket.js` is pure transport with a bounded backoff ladder that
  terminates and reports `DISCONNECTED` rather than retrying forever.

`CONFIG.BACKEND_ENABLED` is `false` by default: the frontend then makes **no
network requests at all**. A probe against a static server answers 404, and the
browser logs that 404 itself — no JavaScript can suppress it. Attach a backend
with `window.guardian.connect()` or by flipping the flag.

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

## 9. Where to plug things in

| Goal | Touch |
|---|---|
| Feed real CV output | `engine.applyExternalTrack()`, or WS `type: "tracks"` |
| Feed a real backend | `CONFIG.BACKEND_ENABLED`, then WS frames |
| Change the demo story | `js/demo.js` — the steps array |
| Change any demo value | `data/mock-events.js` |
| Change severity maths | `computeGuardianScore()` in `js/guardian-score.js` |
| Change thresholds/bands | `js/config.js` — `THRESHOLDS`, `SCORE_BANDS` |
| Add a pose or body state | `data/pose-library.js` |
| Re-skin | `styles/tokens.css` |
| Add a panel | render function + one line in the `app.js` routing table |

The two files most likely to churn during a hackathon — the demo script and the
mock data — have zero imports into the rest of the system, so they can be
edited without reading anything else.

---

## 10. Invariants worth keeping

- **Guardian Score (severity) and AI Confidence (certainty) stay separate.**
  Two quantities, two components, never merged into one number.
- **Renderers stay pure.** If a panel needs data, it arrives via state; it does
  not import `state.js`.
- **One loop, no timers.** Anything periodic hangs off the `app.js` frame.
- **Normalised coordinates at every boundary.** Pixels exist only inside
  `scene.js` and `pose-overlay.js`.
- **Demo Mode must work with the backend down.** That is the acceptance test
  for any transport change.
- **Anonymous by construction.** Tracking IDs only — no identity field exists
  anywhere in the state shape or the event schema, and the language describes
  observable behaviour, never a medical diagnosis.
