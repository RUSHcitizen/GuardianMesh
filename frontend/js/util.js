/** Small DOM + math helpers. Intentionally dependency-free. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, places = 2) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** Cubic ease-in-out — used for pose interpolation and value animation. */
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Create an element with attributes, dataset, and children in one call. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace a node's children with a new list (avoids innerHTML string blobs). */
export function replaceChildren(parent, nodes) {
  parent.replaceChildren(...[].concat(nodes).filter(Boolean));
}

export function show(node, visible) {
  if (node) node.hidden = !visible;
}

/** Re-trigger a one-shot CSS animation class. */
export function replay(node, className) {
  if (!node) return;
  node.classList.remove(className);
  void node.offsetWidth; // force reflow so the animation restarts
  node.classList.add(className);
}

/** hh:mm:ss.mmm clock label from a Date (or now). */
export function clockLabel(date = new Date(), withMs = true) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withMs ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}

export function formatSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0 s';
  if (sec < 60) return `${Math.floor(sec)} s`;
  return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
}

export function pct(value01, places = 0) {
  return `${(clamp(value01, 0, 1) * 100).toFixed(places)}%`;
}
