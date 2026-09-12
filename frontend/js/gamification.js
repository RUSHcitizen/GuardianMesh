/**
 * GuardianMesh — gamification layer.
 *
 * Observes shared state (never mutates it) and turns the incident lifecycle
 * into progress: operator XP and levels, achievements, a rescue streak, and a
 * leaderboard of successful rescues per responder.
 *
 * The leaderboard is shared and lives on the backend (FastAPI, or the
 * Cloudflare edge Durable Object): resolved incidents are POSTed to
 * /api/rescues and the board is read from /api/leaderboard plus live
 * `leaderboard` WebSocket pushes. Personal XP, streak and achievements stay in
 * localStorage, as does a queue of rescues not yet accepted by the backend, so
 * nothing is lost while offline. Storage access is guarded because it can be
 * unavailable (private windows, blocked site data).
 */

import { RESPONDERS } from '../data/mock-events.js';
import { fetchLeaderboard, postRescue } from './datasource.js';
import { guardianState, subscribe, touched } from './state.js';
import { $, el, replay } from './util.js';

const STORAGE_KEY = 'guardianmesh.game.v2';
const LEADERBOARD_POLL_MS = 30000;

const XP = {
  detect: 25,          // new incident observed
  escalate: 40,        // incident reached critical and was caught
  dispatch: 30,        // responders activated
  rescue: 150,         // incident resolved with responders engaged
  fastBonus: 75,       // resolved within FAST_RESCUE_MS of going critical
};
const FAST_RESCUE_MS = 20000;

const RANKS = [
  { level: 1, title: 'Cadet' },
  { level: 3, title: 'Watcher' },
  { level: 5, title: 'Sentinel' },
  { level: 8, title: 'Guardian' },
  { level: 12, title: 'Mesh Warden' },
  { level: 18, title: 'Legend' }
];

const ACHIEVEMENTS = {
  first_rescue: { icon: '🛟', title: 'First Rescue', hint: 'Resolve your first incident' },
  critical_save: { icon: '🚨', title: 'Critical Save', hint: 'Resolve an incident that went critical' },
  rapid_response: { icon: '⚡', title: 'Rapid Response', hint: 'Resolve within 20 s of going critical' },
  mesh_master: { icon: '🕸️', title: 'Mesh Master', hint: 'Corroborate an event across nodes' },
  streak_3: { icon: '🔥', title: 'On Fire', hint: 'Three rescues in a row' },
  ten_rescues: { icon: '🏅', title: 'Decorated', hint: 'Ten total rescues' }
};

const ENGAGED_STATES = new Set(['notified', 'acknowledged', 'en_route']);

/* ---------------------------------------------------------------------------
   Persistence
   --------------------------------------------------------------------------- */

function defaultProgress() {
  // localRescues: offline tally shown until the backend board loads
  // pending: rescue submissions the backend has not yet accepted
  return { xp: 0, streak: 0, bestStreak: 0, myRescues: 0, localRescues: {}, pending: [], achievements: [] };
}

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw);
    return { ...defaultProgress(), ...parsed };
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
   Level curve: level n needs 100 * n * (n - 1) / 2 total XP (100, 300, 600 …)
   --------------------------------------------------------------------------- */

const xpForLevel = (level) => (100 * level * (level - 1)) / 2;

export function levelFor(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level += 1;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const rank = RANKS.filter((r) => r.level <= level).pop();
  return { level, rank: rank.title, into: xp - floor, span: ceil - floor };
}

/* ---------------------------------------------------------------------------
   Controller
   --------------------------------------------------------------------------- */

export function createGamification() {
  const progress = load();
  const names = Object.fromEntries(RESPONDERS.map((r) => [r.id, r.name]));

  const els = {
    level: $('#game-level'),
    rank: $('#game-rank'),
    xpFill: $('#game-xp-fill'),
    xpText: $('#game-xp-text'),
    streak: $('#game-streak'),
    board: $('#leaderboard-list'),
    total: $('#leaderboard-total'),
    sync: $('#leaderboard-sync'),
    mine: $('#game-my-rescues'),
    badges: $('#achievement-grid'),
    toasts: $('#game-toasts'),
    reset: $('#btn-game-reset')
  };

  /** Per-incident bookkeeping so every reward is granted exactly once. */
  const tracked = new Map(); // incidentId -> { status, criticalAt, engaged:Set, detected, escalated, dispatched }
  let lastRanking = [];
  let flushing = false;

  /* -- rewards ------------------------------------------------------------ */

  function grantXp(amount, reason) {
    const before = levelFor(progress.xp).level;
    progress.xp += amount;
    toast(`+${amount} XP`, reason, 'xp');
    const after = levelFor(progress.xp);
    if (after.level > before) {
      toast(`Level ${after.level}`, `Promoted to ${after.rank}`, 'level');
      replay(els.level?.closest('.game-hud'), 'game-hud--levelup');
    }
  }

  function unlock(key) {
    if (progress.achievements.includes(key)) return;
    progress.achievements.push(key);
    const a = ACHIEVEMENTS[key];
    toast(`${a.icon} ${a.title}`, 'Achievement unlocked', 'achievement');
  }

  function recordRescue(record, incident) {
    const credited = [...record.engaged];
    for (const id of credited) {
      progress.localRescues[id] = (progress.localRescues[id] || 0) + 1;
    }
    if (credited.length) {
      progress.pending.push({
        rescue_key: record.key,
        incident_id: incident.id,
        camera_id: incident.cameraId || null,
        // The scripted simulation is the only demo source. Incident IDs alone can't
        // tell: the live-backend correlator also numbers its first incident INC-001.
        source: guardianState.dataSource === 'demo' ? 'demo' : 'live',
        responders: credited.map((id) => ({ id, name: names[id] || id }))
      });
      flushPending();
    }
    progress.myRescues += 1;
    progress.streak += 1;
    progress.bestStreak = Math.max(progress.bestStreak, progress.streak);

    grantXp(XP.rescue, 'Successful rescue');
    unlock('first_rescue');
    if (record.criticalAt) {
      unlock('critical_save');
      if (performance.now() - record.criticalAt <= FAST_RESCUE_MS) {
        grantXp(XP.fastBonus, 'Rapid response bonus');
        unlock('rapid_response');
      }
    }
    if (progress.streak >= 3) unlock('streak_3');
    if (progress.myRescues >= 10) unlock('ten_rescues');
  }

  /* -- backend sync ------------------------------------------------------- */

  /** Submit queued rescues in order; anything that fails stays queued for the next attempt. */
  async function flushPending() {
    if (flushing || !progress.pending.length) return;
    flushing = true;
    try {
      while (progress.pending.length) {
        await postRescue(progress.pending[0]);
        progress.pending.shift();
        save(progress);
      }
    } catch (err) {
      console.info('[guardian] rescue queued until backend is reachable:', err?.message || err);
    } finally {
      flushing = false;
      renderSync();
    }
  }

  async function refreshLeaderboard() {
    try {
      await fetchLeaderboard();
    } catch {
      renderSync();
    }
    flushPending();
  }

  /* -- state observers ---------------------------------------------------- */

  function onIncidents(state) {
    const seen = new Set();
    for (const incident of state.incidents) {
      seen.add(incident.id);
      let record = tracked.get(incident.id);
      if (!record) {
        record = {
          // One key per incident occurrence (the demo reuses its incident ID across runs).
          key: rescueKey(incident),
          status: null, criticalAt: 0, engaged: new Set(), escalated: false, dispatched: false
        };
        tracked.set(incident.id, record);
        if (incident.status !== 'resolved') grantXp(XP.detect, `Incident ${incident.id} detected`);
      }
      if (incident.status === 'critical' && !record.escalated) {
        record.escalated = true;
        record.criticalAt = performance.now();
        grantXp(XP.escalate, 'Critical pattern caught');
      }
      if (incident.status === 'resolved' && record.status && record.status !== 'resolved') {
        // Anything engaged right now counts too: resolution may land before
        // responder states are cleared in the same tick.
        for (const r of state.responders) if (ENGAGED_STATES.has(r.state)) record.engaged.add(r.id);
        recordRescue(record, incident);
      }
      record.status = incident.status;
    }
    // A cleared board (demo reset) drops bookkeeping; an unresolved incident
    // that vanished breaks the streak.
    for (const [id, record] of tracked) {
      if (seen.has(id)) continue;
      if (record.status && record.status !== 'resolved') progress.streak = 0;
      tracked.delete(id);
    }
    commit();
  }

  function onResponders(state) {
    const engagedNow = state.responders.filter((r) => ENGAGED_STATES.has(r.state));
    if (!engagedNow.length) return;
    for (const record of tracked.values()) {
      if (record.status === 'resolved') continue;
      for (const r of engagedNow) record.engaged.add(r.id);
      if (!record.dispatched) {
        record.dispatched = true;
        grantXp(XP.dispatch, 'Responders dispatched');
      }
    }
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
    const lvl = levelFor(progress.xp);
    if (els.level) els.level.textContent = String(lvl.level);
    if (els.rank) els.rank.textContent = lvl.rank;
    if (els.xpFill) els.xpFill.style.width = `${Math.round((lvl.into / lvl.span) * 100)}%`;
    if (els.xpText) els.xpText.textContent = `${lvl.into} / ${lvl.span} XP`;
    if (els.streak) {
      els.streak.textContent = String(progress.streak);
      els.streak.closest('.game-streak').dataset.hot = String(progress.streak >= 2);
    }
    renderBoard();
    renderBadges();
  }

  function renderSync() {
    if (!els.sync) return;
    const synced = Boolean(guardianState.leaderboard);
    const queued = progress.pending.length;
    els.sync.dataset.status = synced && !queued ? 'online' : queued ? 'warning' : 'idle';
    els.sync.textContent = synced
      ? (queued ? `Synced · ${queued} queued` : 'Live · synced')
      : (queued ? `Offline · ${queued} queued` : 'Offline · local');
  }

  /** Server rows when available (every known responder listed, even at zero), else local tallies. */
  function currentCounts() {
    const counts = new Map(RESPONDERS.map((r) => [r.id, { id: r.id, name: r.name, count: 0 }]));
    const board = guardianState.leaderboard;
    if (board) {
      for (const row of board.responders) {
        counts.set(row.id, { id: row.id, name: names[row.id] || row.name || row.id, count: Number(row.rescues) || 0 });
      }
    } else {
      for (const [id, count] of Object.entries(progress.localRescues)) {
        counts.set(id, { id, name: names[id] || id, count });
      }
    }
    return [...counts.values()];
  }

  function renderBoard() {
    if (!els.board) return;
    const ranking = currentCounts()
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const previousIndex = new Map(lastRanking.map((r, i) => [r.id, i]));
    const previousCount = new Map(lastRanking.map((r) => [r.id, r.count]));
    const medals = ['🥇', '🥈', '🥉'];

    els.board.replaceChildren(...ranking.map((row, i) => {
      const moved = previousIndex.has(row.id) && previousIndex.get(row.id) > i;
      const gained = previousCount.has(row.id) && previousCount.get(row.id) < row.count;
      const classes = ['lb-row'];
      if (moved) classes.push('lb-row--up');
      if (gained) classes.push('lb-row--gain');
      return el('li', { class: classes.join(' ') }, [
        el('span', { class: 'lb-row__rank', text: medals[i] || String(i + 1) }),
        el('span', { class: 'lb-row__name', text: row.name }),
        el('span', { class: 'lb-row__count' }, [
          el('b', { text: String(row.count) }),
          el('span', { text: row.count === 1 ? ' rescue' : ' rescues' })
        ])
      ]);
    }));
    lastRanking = ranking;

    if (els.total) {
      const total = guardianState.leaderboard?.total_rescues
        ?? Object.values(progress.localRescues).reduce((sum, n) => sum + n, 0);
      els.total.textContent = `${total} ${total === 1 ? 'rescue' : 'rescues'}`;
    }
    if (els.mine) els.mine.textContent = String(progress.myRescues);
    renderSync();
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
    if (touched(changed, 'responders')) onResponders(state);
    if (touched(changed, 'corroborationResult')) onCorroboration(state);
    if (touched(changed, 'leaderboard')) renderBoard();
    if (touched(changed, 'backendStatus') && state.backendStatus === 'connected') refreshLeaderboard();
  });

  // Personal progress only: the shared leaderboard and queued submissions are kept.
  els.reset?.addEventListener('click', () => {
    const { pending, localRescues } = progress;
    Object.assign(progress, defaultProgress(), { pending, localRescues });
    commit();
    toast('Progress reset', 'Your XP, streak and badges were cleared', 'xp');
  });

  render();
  refreshLeaderboard();
  // The edge fallback has no WebSocket push, so poll as a backstop.
  window.setInterval(refreshLeaderboard, LEADERBOARD_POLL_MS);

  return { progress, render };
}

/** `INC-001@20260912T21:04:05` — stable for one occurrence, distinct across demo runs and days. */
function rescueKey(incident) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const time = String(incident.timestamp || '').replace(/[^0-9:]/g, '') || Date.now().toString(36);
  return `${incident.id}@${day}T${time}`.replace(/[^A-Za-z0-9_.:@-]/g, '-').slice(0, 120);
}
