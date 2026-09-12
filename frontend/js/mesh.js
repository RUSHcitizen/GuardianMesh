/**
 * GuardianMesh — mesh panel: camera/sensor nodes, cross-sensor corroboration
 * and anonymous cross-camera handoff.
 *
 * The mesh is what separates GuardianMesh from a single-camera fall detector:
 * independent nodes contribute evidence, and the correlated result carries a
 * higher event confidence than any single node.
 */

import { $, el, pct, show } from './util.js';

const STATE_LABELS = {
  normal: 'Clear',
  observing: 'Observing',
  warning: 'Elevated',
  critical: 'Critical',
  offline: 'Offline'
};

export function createMeshPanel() {
  const grid = $('#node-grid');
  const summary = $('#mesh-summary');
  const corrList = $('#corr-list');
  const corrEmpty = $('#corr-empty');
  const corrResult = $('#corr-result');
  const corrLabel = $('#corr-result-label');
  const corrConf = $('#corr-result-conf');
  const corrScore = $('#corr-result-score');
  const handoff = $('#handoff');

  function buildNode(node, isPrimary) {
    const status = node.online === false ? 'offline' : node.status;
    return el('div', {
      class: `node${isPrimary ? ' node--active' : ''}`,
      dataset: { status, id: node.id },
      role: 'listitem',
      'aria-label': `${node.label}, ${node.location}, ${STATE_LABELS[status] || status}`
    }, [
      el('div', { class: 'node__head' }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'node__id', text: node.label })
      ]),
      el('span', { class: 'node__loc', text: node.location }),
      el('div', { class: 'node__foot' }, [
        el('span', { class: 'node__state', text: STATE_LABELS[status] || status }),
        el('span', {
          class: 'node__count',
          text: node.kind
            ? node.kind.toUpperCase()
            : `${node.people ?? 0} tracked`
        })
      ])
    ]);
  }

  function renderNodes(state) {
    const nodes = [
      ...state.cameras.map((c) => buildNode(c, c.id === state.activeCamera)),
      ...state.sensors.map((s) => buildNode(s, false))
    ];
    grid.replaceChildren(...nodes);

    const all = [...state.cameras, ...state.sensors];
    const online = all.filter((n) => n.online !== false).length;
    const alerting = state.cameras.filter((c) => c.status === 'critical' || c.status === 'warning').length;
    summary.textContent = `${all.length} nodes · ${online} online${alerting ? ` · ${alerting} alerting` : ''}`;
  }

  function renderCorroboration(state) {
    const entries = state.corroboration;
    show(corrEmpty, entries.length === 0);

    corrList.replaceChildren(...entries.map((entry) => {
      const bar = el('span', { class: 'corr__bar' }, [el('i')]);
      const row = el('div', { class: 'corr' }, [
        el('span', { class: 'corr__src', text: entry.source }),
        el('span', { class: 'corr__obs', text: entry.observation, title: entry.observation }),
        el('span', { class: 'corr__conf', text: pct(entry.confidence) }),
        bar
      ]);
      // width is set after insertion so the bar animates from zero
      window.requestAnimationFrame(() => {
        bar.firstChild.style.width = pct(entry.confidence);
      });
      return row;
    }));

    const result = state.corroborationResult;
    show(corrResult, Boolean(result));
    if (result) {
      corrResult.dataset.status = result.status || 'tracking';
      corrLabel.textContent = result.label;
      corrConf.textContent = pct(result.confidence);
      corrScore.textContent = Number(result.guardianScore).toFixed(1);
    }
  }

  function renderHandoff(state) {
    const h = state.handoff;
    if (!h) {
      handoff.replaceChildren(
        el('span', { text: 'No cross-camera handoff' }),
        el('span', { class: 'handoff__tag', text: 'Identity not required' })
      );
      return;
    }
    handoff.replaceChildren(
      el('b', { text: h.from }),
      el('span', { class: 'handoff__arrow', text: '→' }),
      el('b', { text: h.trackingId }),
      el('span', { class: 'handoff__arrow', text: '→' }),
      el('b', { text: h.to }),
      el('span', { text: h.note }),
      el('span', { class: 'handoff__tag', text: 'Anonymous handoff' })
    );
  }

  function render(state) {
    renderNodes(state);
    renderCorroboration(state);
    renderHandoff(state);
  }

  return { render };
}

