/**
 * GuardianMesh â€” simulated camera scene.
 *
 * Renders a deterministic stand-in for CCTV footage: a corridor, ambient
 * lighting and anonymous human silhouettes drawn from the SAME normalised
 * keypoints the AR overlay consumes. Because both layers read one pose source,
 * the overlay always registers exactly against the "video".
 *
 * Used when no webcam or footage is attached, so the demo never depends on
 * hardware or files being present.
 */

import { LIMB_SEGMENTS } from '../data/pose-library.js';

const SHOULDER_REF = 0.06; // shoulder span of the canonical standing pose

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let grain = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    grain = buildGrain();
  }

  function buildGrain() {
    const size = 96;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const octx = off.getContext('2d');
    const img = octx.createImageData(size, size);
    // deterministic pseudo-noise: identical every run, no Math.random
    let seed = 20260912;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = seed % 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 22;
    }
    octx.putImageData(img, 0, 0);
    return ctx.createPattern(off, 'repeat');
  }

  /* ---------------------------------------------------------------------- */

  function drawBackdrop(t) {
    const horizon = height * 0.46;
    const vpX = width * 0.53;

    // rear wall
    const wall = ctx.createLinearGradient(0, 0, 0, horizon);
    wall.addColorStop(0, '#0b141c');
    wall.addColorStop(1, '#16242f');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, width, horizon);

    // floor
    const floor = ctx.createLinearGradient(0, horizon, 0, height);
    floor.addColorStop(0, '#1a2a36');
    floor.addColorStop(0.45, '#12202a');
    floor.addColorStop(1, '#0a141c');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, width, height - horizon);

    // perspective floor lines
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let i = -6; i <= 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo(vpX, horizon);
      ctx.lineTo(vpX + i * width * 0.3, height);
      ctx.stroke();
    }
    for (let i = 1; i <= 5; i += 1) {
      const y = horizon + (height - horizon) * (i / 5) ** 1.85;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // wall skirting + doorway
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(width, horizon);
    ctx.stroke();

    // doorway recess with a lit edge so it reads as architecture, not a hole
    const doorX = width * 0.69;
    const doorW = width * 0.105;
    const doorH = height * 0.28;
    const door = ctx.createLinearGradient(doorX, horizon - doorH, doorX, horizon);
    door.addColorStop(0, 'rgba(9,17,24,0.9)');
    door.addColorStop(1, 'rgba(24,40,52,0.9)');
    ctx.fillStyle = door;
    ctx.fillRect(doorX, horizon - doorH, doorW, doorH);
    ctx.strokeStyle = 'rgba(150,196,224,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(doorX + 0.5, horizon - doorH + 0.5, doorW - 1, doorH - 1);
    ctx.fillStyle = 'rgba(180,214,236,0.05)';
    ctx.fillRect(doorX + doorW - 3, horizon - doorH, 3, doorH);

    // ceiling light pools on the floor
    for (const [cx, scale] of [[0.26, 1], [0.56, 0.86], [0.82, 0.7]]) {
      const g = ctx.createRadialGradient(
        width * cx, horizon + height * 0.26 * scale, 2,
        width * cx, horizon + height * 0.26 * scale, width * 0.19 * scale
      );
      g.addColorStop(0, 'rgba(180, 214, 236, 0.085)');
      g.addColorStop(1, 'rgba(180, 214, 236, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, horizon, width, height - horizon);
    }

    // faint lens breathing so the frame never looks like a still image
    ctx.fillStyle = `rgba(120,170,200,${0.012 + 0.006 * Math.sin(t / 2200)})`;
    ctx.fillRect(0, 0, width, height);
  }

  function drawPerson(person) {
    const kp = Object.fromEntries(person.keypoints.map((p) => [p.name, p]));
    if (!kp.left_shoulder || !kp.left_hip) return;

    const px = (p) => p.x * width;
    const py = (p) => p.y * height;
    // Use the track's own rig scale. A shoulder span would collapse the moment
    // the person lies on their side, shrinking the figure exactly when it
    // matters most.
    const scale = person.scale ?? Math.max(
      Math.hypot(kp.left_shoulder.x - kp.right_shoulder.x,
        kp.left_shoulder.y - kp.right_shoulder.y) / SHOULDER_REF, 0.4
    );

    // contact shadow beneath the lowest points
    const lowest = person.keypoints.reduce((a, b) => (b.y > a.y ? b : a));
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#04090d';
    ctx.beginPath();
    ctx.ellipse(px(lowest), py(lowest) + 3, 0.055 * width * scale,
      0.013 * height * scale + 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // figures must read clearly against a dark floor without looking lit from
    // nowhere: a mid tone with a top-down gradient and a single rim highlight
    const top = py(kp.nose || kp.left_shoulder);
    const bottom = py(person.keypoints.reduce((a, b) => (b.y > a.y ? b : a)));
    const shade = ctx.createLinearGradient(0, top, 0, bottom || top + 1);
    shade.addColorStop(0, '#40596e');
    shade.addColorStop(1, '#2a3c4d');
    const body = shade;
    const rim = 'rgba(176, 216, 240, 0.45)';

    // limbs as capsules
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [a, b, thickness] of LIMB_SEGMENTS) {
      if (!kp[a] || !kp[b]) continue;
      ctx.strokeStyle = body;
      ctx.lineWidth = thickness * height * scale * 1.7;
      ctx.beginPath();
      ctx.moveTo(px(kp[a]), py(kp[a]));
      ctx.lineTo(px(kp[b]), py(kp[b]));
      ctx.stroke();
    }

    // torso
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(px(kp.left_shoulder), py(kp.left_shoulder));
    ctx.lineTo(px(kp.right_shoulder), py(kp.right_shoulder));
    ctx.lineTo(px(kp.right_hip), py(kp.right_hip));
    ctx.lineTo(px(kp.left_hip), py(kp.left_hip));
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 0.030 * height * scale;
    ctx.strokeStyle = body;
    ctx.stroke();

    // head â€” a plain silhouette; no facial detail is rendered or required
    const headR = Math.max(0.036 * height * scale, 4);
    const neckX = (px(kp.left_shoulder) + px(kp.right_shoulder)) / 2;
    const neckY = (py(kp.left_shoulder) + py(kp.right_shoulder)) / 2;
    const hx = kp.nose ? px(kp.nose) : neckX;
    const hy = kp.nose ? py(kp.nose) : neckY - headR;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(hx, hy, headR, 0, Math.PI * 2);
    ctx.fill();

    // single rim light so the figure reads against the floor
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(hx, hy, headR, Math.PI * 0.9, Math.PI * 1.9);
    ctx.stroke();
  }

  function drawBurnIn(t) {
    const stamp = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const text = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} `
      + `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`;
    // burn-in timestamp sits top-centre, clear of every HUD element
    ctx.save();
    ctx.font = `${Math.max(10, Math.round(height * 0.021))}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(210, 232, 244, ${0.3 + 0.04 * Math.sin(t / 1400)})`;
    ctx.fillText(text, width / 2, Math.max(18, height * 0.055));
    ctx.restore();
  }

  /** @param {Array} people normalised person records from the pose engine */
  function render(people, t) {
    if (!width || !height) resize();
    ctx.clearRect(0, 0, width, height);
    drawBackdrop(t);

    // far tracks first so nearer figures overlap correctly
    const ordered = people.slice().sort((a, b) => a.boundingBox.y + a.boundingBox.height
      - (b.boundingBox.y + b.boundingBox.height));
    for (const person of ordered) drawPerson(person);

    drawBurnIn(t);
    if (grain) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = grain;
      ctx.translate((t / 90) % 96 - 96, (t / 70) % 96 - 96);
      ctx.fillRect(0, 0, width + 192, height + 192);
      ctx.restore();
    }
  }

  resize();
  return { render, resize };
}

