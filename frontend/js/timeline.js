/**
 * GuardianMesh — AI reasoning timeline.
 *
 * The visual proof that GuardianMesh reasons ACROSS TIME rather than
 * classifying a single frame. Entries are appended, never rewritten, and new
 * entries animate in once.
 */

import { $, el, show } from './util.js';

const KIND_LABELS = {
  observation: 'Observation',
  inference: 'Inference',
  warning: 'Warning',
  critical: 'Critical',
  response: 'Response',
  resolved: 'Resolved',
  system: 'System'
};

export function createTimeline() {
  const list = $('#event-timeline');
  const empty = $('#timeline-empty');
  const count = $('#timeline-count');
  const scroll = $('#timeline-scroll');
  let renderedIds = new Set();

  function buildItem(event) {
    const facts = (event.facts || []).map((f) =>
      el('span', { class: 'tl-fact' }, [`${f.label} `, el('b', { text: f.value })])
    );

    return el('li', {
      class: `tl-item${event.isNew ? ' tl-item--enter' : ''}`,
      dataset: { kind: event.kind, id: event.id }
    }, [
      el('span', { class: 'tl-item__time', text: event.time }),
      el('span', { class: 'tl-item__rail' }, [el('span', { class: 'tl-item__node' })]),
      el('div', { class: 'tl-item__body' }, [
        el('span', { class: 'tl-item__kind', text: KIND_LABELS[event.kind] || event.kind }),
        el('span', { class: 'tl-item__title', text: event.title }),
        facts.length ? el('div', { class: 'tl-item__facts' }, facts) : null
      ])
    ]);
  }

  function render(state) {
    const events = state.timeline;
    show(empty, events.length === 0);
    count.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;

    if (events.length === 0) {
      list.replaceChildren();
      renderedIds = new Set();
      return;
    }

    const ids = new Set(events.map((e) => e.id));
    // full rebuild only when entries were trimmed or cleared
    const needsRebuild = list.childElementCount > events.length
      || Array.from(renderedIds).some((id) => !ids.has(id));

    if (needsRebuild) {
      list.replaceChildren(...events.map(buildItem));
    } else {
      for (const event of events) {
        if (renderedIds.has(event.id)) continue;
        list.append(buildItem(event));
      }
    }
    renderedIds = ids;
    // keep the newest reasoning step in view
    scroll.scrollTop = scroll.scrollHeight;
  }

  return { render };
}
