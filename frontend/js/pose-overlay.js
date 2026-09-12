/**
 * GuardianMesh — AR pose overlay.
 *
 * Draws anonymous tracking graphics on a canvas above the camera stage:
 * bounding box, skeleton, tracking label, confidence, Guardian Score and a
 * motion vector. All input coordinates are NORMALISED (0..1) and converted to
 * canvas pixels against the displayed media rect, so the overlay stays
 * registered when the stage resizes or the video letterboxes.
 */

import { SKELETON_EDGES } from '../data/pose-library.js';
import { clamp, lerp } from './util.js';

const STATUS_COLORS = {
  normal:    [85, 200, 236],
  tracking:  [85, 200, 236],
  safe:      [68, 209, 159],
  observing: [245, 185, 66],
  elevated:  [245, 185, 66],
  warning:   [245, 185, 66],
  critical:  [237, 86, 86]
};

const rgba = ([r, g, b], a) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

export function createPoseOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  /** eased colour per track so status changes read as a transition, not a jump */
  const colorState = new Map();
  let width = 0;
  let height = 0;

  /** Media rect the normalised coordinates map into (handles object-fit: cover). */
  let contentRect = { x: 0, y: 0, width: 0, height: 0 };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    contentRect = { x: 0, y: 0, width, height };
  }

  /**
   * Point the overlay at the displayed media. Pass a <video> to account for
   * letterboxing/cropping; pass null for a full-bleed canvas source.
   */
  function setContentSource(videoEl) {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
      contentRect = { x: 0, y: 0, width, height };
      return;
    }
    // #guardian-video uses object-fit: cover
    const scale = Math.max(width / videoEl.videoWidth, height / videoEl.videoHeight);
    const dw = videoEl.videoWidth * scale;
    const dh = videoEl.videoHeight * scale;
    contentRect = { x: (width - dw) / 2, y: (height - dh) / 2, width: dw, height: dh };
  }

  const toX = (nx) => contentRect.x + nx * contentRect.width;
  const toY = (ny) => contentRect.y + ny * contentRect.height;

  function colorFor(person) {
    const target = STATUS_COLORS[person.status] || STATUS_COLORS.normal;
    const current = colorState.get(person.trackingId) || target.slice();
    const next = current.map((c, i) => lerp(c, target[i], 0.12));
    colorState.set(person.trackingId, next);
    return next;
  }

  /* -- primitives --------------------------------------------------------- */

  function clearPoseOverlay() {
    ctx.clearRect(0, 0, width, height);
  }

  function drawBoundingBox(person, color) {
    const b = person.boundingBox;
    const x = toX(b.x);
    const y = toY(b.y);
    const w = b.width * contentRect.width;
    const h = b.height * contentRect.height;
    const corner = Math.min(16, w * 0.32, h * 0.18);

    ctx.save();
    ctx.strokeStyle = rgba(color, 0.38);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    // four corner brackets — thin and professional, never a heavy frame
    ctx.moveTo(x, y + corner); ctx.lineTo(x, y); ctx.lineTo(x + corner, y);
    ctx.moveTo(x + w - corner, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + corner);
    ctx.moveTo(x + w, y + h - corner); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - corner, y + h);
    ctx.moveTo(x + corner, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - corner);
    ctx.stroke();
    ctx.restore();
    return { x, y, w, h };
  }

  function drawPose(keypoints, color) {
    if (!keypoints || !keypoints.length) return;
    const byName = Object.fromEntries(keypoints.map((k) => [k.name, k]));

    ctx.save();
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of SKELETON_EDGES) {
      const pa = byName[a];
      const pb = byName[b];
      if (!pa || !pb) continue;
      ctx.moveTo(toX(pa.x), toY(pa.y));
      ctx.lineTo(toX(pb.x), toY(pb.y));
    }
    ctx.stroke();

    ctx.fillStyle = rgba(color, 0.92);
    for (const k of keypoints) {
      const r = (k.confidence ?? 1) > 0.5 ? 2 : 1.4;
      ctx.beginPath();
      ctx.arc(toX(k.x), toY(k.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTrackingLabel(person, color, box) {
    const lines = [];
    lines.push({ text: person.trackingId, weight: 700, size: 11 });
    lines.push({ text: (person.label || '').toUpperCase(), weight: 600, size: 10 });

    const stats = [];
    if (person.confidence !== null && person.confidence !== undefined) {
      stats.push(`${Math.round(person.confidence * 100)}%`);
    }
    if (person.score !== null && person.score !== undefined) {
      stats.push(`SCORE ${Number(person.score).toFixed(1)}`);
    }

    ctx.save();
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    const widths = lines.map((l) => {
      ctx.font = `${l.weight} ${l.size}px ui-monospace, Menlo, monospace`;
      return ctx.measureText(l.text).width;
    });
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    const statsText = stats.join('  ·  ');
    const statsWidth = statsText ? ctx.measureText(statsText).width : 0;

    const padX = 6;
    const boxW = Math.max(...widths, statsWidth) + padX * 2;
    const boxH = statsText ? 38 : 26;

    let bx = clamp(box.x, 2, Math.max(2, width - boxW - 2));
    let by = box.y - boxH - 5;
    if (by < 2) by = Math.min(box.y + box.h + 5, height - boxH - 2);

    ctx.fillStyle = 'rgba(5, 11, 16, 0.82)';
    ctx.strokeStyle = rgba(color, 0.6);
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, boxW, boxH, 3);
    ctx.fill();
    ctx.stroke();

    // status stripe keeps state readable without relying on colour alone
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fillRect(bx, by, 2, boxH);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#f2f6f9';
    ctx.font = '700 11px ui-monospace, Menlo, monospace';
    ctx.fillText(lines[0].text, bx + padX, by + 4);
    ctx.fillStyle = rgba(color, 1);
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.fillText(lines[1].text, bx + padX, by + 17);
    if (statsText) {
      ctx.fillStyle = 'rgba(190, 208, 220, 0.9)';
      ctx.fillText(statsText, bx + padX, by + 28);
    }
    ctx.restore();
  }

  /** Short arrow showing direction + magnitude of recent movement. */
  function drawMotionVector(person, color) {
    const f = person.features || {};
    const magnitude = Math.min(Math.abs(f.verticalVelocity || 0) * 0.09, 0.14);
    if (magnitude < 0.012) return;
    const kp = Object.fromEntries(person.keypoints.map((k) => [k.name, k]));
    if (!kp.left_hip || !kp.right_hip) return;

    const ox = toX((kp.left_hip.x + kp.right_hip.x) / 2);
    const oy = toY((kp.left_hip.y + kp.right_hip.y) / 2);
    const dir = (f.verticalVelocity || 0) < 0 ? 1 : -1; // downward travel points down
    const len = magnitude * contentRect.height;

    ctx.save();
    ctx.strokeStyle = rgba(color, 0.85);
    ctx.fillStyle = rgba(color, 0.85);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox, oy + len * dir);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy + (len + 6) * dir);
    ctx.lineTo(ox - 4, oy + len * dir);
    ctx.lineTo(ox + 4, oy + len * dir);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Draw a full frame of tracking graphics. */
  function render(people) {
    clearPoseOverlay();
    for (const person of people) {
      if (!person.boundingBox) continue;
      const color = colorFor(person);
      const box = drawBoundingBox(person, color);
      drawPose(person.keypoints, color);
      drawMotionVector(person, color);
      drawTrackingLabel(person, color, box);
    }
  }

  function forget(trackingId) { colorState.delete(trackingId); }
  function reset() { colorState.clear(); clearPoseOverlay(); }

  resize();
  return { render, resize, setContentSource, clearPoseOverlay, reset, forget };
}
