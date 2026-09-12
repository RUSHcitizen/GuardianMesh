# Demo footage

Drop a clip here (e.g. `corridor.mp4`) and point the frontend at it:

```js
// frontend/js/config.js
VIDEO_SOURCE_URL: 'assets/video/corridor.mp4'
```

You can also load a clip at runtime without editing anything — click **VIDEO FILE**
on the camera stage and pick a file.

If no footage and no webcam are available, the stage falls back to the
deterministic simulated scene (`frontend/js/scene.js`), so the demo always runs.

Video files are git-ignored; keep large media out of the repository.
