# GuardianMesh agent guide

These instructions apply to the entire repository.

## Project intent

GuardianMesh is a privacy-preserving hackathon prototype for recognizing
observable distress patterns. Preserve its non-medical wording: it detects
possible falls or distress and recommends human verification; it does not
diagnose conditions or automatically contact emergency services.

The primary contributor is Atharv Kumaria (`RUSHcitizen`). Development may run
from a computer whose local paths contain `apurvkumaria`; that is borrowed
hardware context, not contributor attribution.

## Architecture

- `frontend/` is a static vanilla-JavaScript dashboard deployed as Cloudflare
  Worker static assets.
- The default demo uses browser-side MediaPipe pose inference. Do not silently
  replace camera/model failures with simulated people.
- Scripted data is development-only and must remain behind
  `?dev=simulation`.
- `ai_cv/` contains the optional Python camera pipeline.
- `backend/` contains the optional FastAPI event service. The default browser
  inference path does not require it.
- Keep fall-detection thresholds centralized in `frontend/js/config.js` and
  temporal state transitions in `frontend/js/fall-detector.js`.
- Keep video frames local. Do not add frame uploads, facial recognition,
  identity storage, or biometric profiling.

## Working rules

- Preserve the existing visual design and module architecture unless a task
  explicitly requests a redesign.
- Use normalized image coordinates (`0..1`, origin at top-left) across frontend
  perception modules.
- Keep the application animation loop in `frontend/js/app.js`; integrate new
  per-frame work into that loop.
- Keep the default interface truthful about model, camera, and backend status.
- Do not commit secrets, access tokens, local media, build caches, or generated
  Python bytecode.
- Do not remove or overwrite unrelated contributor work when updating a branch.

## Validation

Before committing frontend changes, run:

```bash
npm test
find frontend/js -name '*.js' -print0 | xargs -0 -n1 node --check
node --check server.js
git diff --check
```

For Cloudflare packaging changes, also run a dry deployment:

```bash
npx --yes wrangler@4.131.1 deploy --dry-run
```

This must remain a dry run unless the user explicitly asks for deployment.

## Git

Use concise commit messages describing the outcome. Before pushing, fetch and
integrate remote changes safely; never force-push unless the user explicitly
requests it and the exact impact has been reviewed.
