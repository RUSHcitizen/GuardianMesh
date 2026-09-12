/**
 * GuardianMesh — badges.
 *
 * Observes shared state (never mutates it) and awards achievement badges for
 * getting people help: resolving incidents, doing so quickly, and finding nearby help through Google Maps. A rescue streak is
 * shown in the header. Everything stays in this browser's localStorage; access
 * is guarded because storage can be unavailable (private windows, blocked
 * site data).
 */

import { subscribe, touched } from './state.js';
import { $, el } from './util.js';

const STORAGE_KEY = 'guardianmesh.badges.v1';
const FAST_RESCUE_MS = 20000;

const ACHIEVEMENTS = {
  first_rescue: { icon: '🛟', title: 'First Rescue', hint: 'Resolve your first incident' },
  critical_save: { icon: '🚨', title: 'Critical Save', hint: 'Resolve an incident that went critical' },
  rapid_response: { icon: '⚡', title: 'Rapid Response', hint: 'Resolve within 20 s of going critical' },
  help_found: { icon: '🗺️', title: 'Help Found', hint: 'Open a Google Maps result from Nearby Response' },
  mesh_master: { icon: '🕸️', title: 'Mesh Master', hint: 'Corroborate an event across nodes' },
  streak_3: { icon: '🔥', title: 'On Fire', hint: 'Three rescues in a row' },
  ten_rescues: { icon: '🏅', title: 'Decorated', hint: 'Ten total rescues' }
};

/* ---------------------------------------------------------------------------
   Persistence
   --------------------------------------------------------------------------- */

function defaultProgress() {
  return { streak: 0, bestStreak: 0, myRescues: 0, achievements: [] };
}

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    return { ...defaultProgress(), ...JSON.parse(raw) };
  } catch {
    return defaultProgress();
  }
}

function save(progress) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* storage unavailable: progress lives for this session only */
  }
}

/* ---------------------------------------------------------------------------
   Controller
   --------------------------------------------------------------------------- */

export function createGamification() {
  const progress = load();

  const els = {
    streak: $('#game-streak'),
    mine: $('#game-my-rescues'),
    badges: $('#achievement-grid'),
    toasts: $('#game-toasts'),
    reset: $('#btn-game-reset')
  };

  /** Per-incident bookkeeping so every badge event is counted exactly once. */
  const tracked = new Map(); // incidentId -> { status, criticalAt }
  const helpedIncidents = new Set();

  function unlock(key) {
    if (progress.achievements.includes(key)) return;
    progress.achievements.push(key);
    const a = ACHIEVEMENTS[key];
    toast(`${a.icon} ${a.title}`, 'Badge unlocked', 'achievement');
  }

  function recordRescue(record, incident) {
    progress.myRescues += 1;
    progress.streak += 1;
    progress.bestStreak = Math.max(progress.bestStreak, progress.streak);

    toast('🛟 Rescue recorded', `${incident.id} resolved`, 'rescue');
    unlock('first_rescue');
    if (record.criticalAt) {
      unlock('critical_save');
      if (performance.now() - record.criticalAt <= FAST_RESCUE_MS) unlock('rapid_response');
    }
    if (progress.streak >= 3) unlock('streak_3');
    if (progress.myRescues >= 10) unlock('ten_rescues');
  }

  /* -- state observers ---------------------------------------------------- */

  function onIncidents(state) {
    const seen = new Set();
    for (const incident of state.incidents) {
      seen.add(incident.id);
      let record = tracked.get(incident.id);
      if (!record) {
        record = { status: null, criticalAt: 0 };
        tracked.set(incident.id, record);
      }
      if (incident.status === 'critical' && !record.criticalAt) record.criticalAt = performance.now();
      if (incident.status === 'resolved' && record.status && record.status !== 'resolved') {
        recordRescue(record, incident);
      }
      record.status = incident.status;
    }
    // A cleared board (reset) drops bookkeeping; an unresolved incident that
    // vanished breaks the streak.
    for (const [id, record] of tracked) {
      if (seen.has(id)) continue;
      if (record.status && record.status !== 'resolved') progress.streak = 0;
      tracked.delete(id);
    }
    commit();
  }

  /** Help found through Google Maps for an incident (see response.js). */
  function onMapsHelp(state) {
    const incidentId = state.mapsHelp?.incidentId;
    if (!incidentId || helpedIncidents.has(incidentId)) return;
    helpedIncidents.add(incidentId);
    toast('🗺️ Nearby help found', `Google Maps result opened for ${incidentId}`, 'rescue');
    unlock('help_found');
    commit();
  }

  function onCorroboration(state) {
    if (state.corroborationResult && !progress.achievements.includes('mesh_master')) {
      unlock('mesh_master');
      commit();
    }
  }

  /* -- rendering ---------------------------------------------------------- */

  function commit() {
    save(progress);
    render();
  }

  function render() {
    if (els.streak) {
      els.streak.textContent = String(progress.streak);
      els.streak.closest('.game-streak').dataset.hot = String(progress.streak >= 2);
    }
    if (els.mine) els.mine.textContent = String(progress.myRescues);
    renderBadges();
  }

  function renderBadges() {
    if (!els.badges) return;
    els.badges.replaceChildren(...Object.entries(ACHIEVEMENTS).map(([key, a]) => {
      const earned = progress.achievements.includes(key);
      return el('li', {
        class: `badge-tile${earned ? ' badge-tile--earned' : ''}`,
        title: `${a.title} — ${a.hint}`
      }, [
        el('span', { class: 'badge-tile__icon', 'aria-hidden': 'true', text: earned ? a.icon : '🔒' }),
        el('span', { class: 'badge-tile__label', text: a.title })
      ]);
    }));
  }

  function toast(title, detail, kind) {
    if (!els.toasts) return;
    const node = el('div', { class: `game-toast game-toast--${kind}`, role: 'status' }, [
      el('strong', { text: title }),
      el('span', { text: detail })
    ]);
    els.toasts.append(node);
    window.setTimeout(() => node.classList.add('game-toast--out'), 2600);
    window.setTimeout(() => node.remove(), 3100);
  }

  /* -- wiring ------------------------------------------------------------- */

  subscribe((state, changed) => {
    if (touched(changed, 'incidents')) onIncidents(state);
    if (touched(changed, 'mapsHelp')) onMapsHelp(state);
    if (touched(changed, 'corroborationResult')) onCorroboration(state);
  });

  els.reset?.addEventListener('click', () => {
    Object.assign(progress, defaultProgress());
    commit();
    toast('Progress reset', 'Your streak and badges were cleared', 'rescue');
  });

  render();
  return { progress, render };
}
