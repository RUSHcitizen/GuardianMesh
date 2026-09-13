# Test fixtures

## `yolo26-pose-bus.json`

Real output from `frontend/assets/models/yolo26n-pose.onnx` for
`bus.jpg` from the Ultralytics assets, letterboxed to 640×640. It pins the
decoding in `frontend/js/browser-pose.js`: the output layout
(`[x1, y1, x2, y2, confidence, class, 17 × (x, y, visibility)]`), the COCO-17
keypoint order, and the mapping from letterboxed model pixels back to
normalised frame coordinates.

Regenerate it only when the model itself is re-exported:

```bash
pip install ultralytics onnx onnxslim onnxruntime
python - <<'PY'
from ultralytics import YOLO
YOLO("yolo26n-pose.pt").export(format="onnx", imgsz=640, opset=17, simplify=True, dynamic=False, nms=False)
PY
```

Then run the model over a known image and record the raw rows together with the
normalised detections they should produce. Expected coordinates are clamped to
`[0, 1]`, exactly as `decodeDetections()` does, so a body partly out of frame
yields a box that stops at the edge.
