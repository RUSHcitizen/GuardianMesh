/**
 * GuardianMesh â€” Guardian Score panel.
 *
 * The Guardian Score answers "how concerning does this situation look?".
 * AI Confidence answers "how certain is the classification?". They are
 * rendered as two separate quantities and are never combined.
 */

import { CONFIG } from './config.js';
import { BAND_CAPTIONS } from '../data/mock-events.js';
import { $, clamp, formatSeconds, round } from './util.js';

export function bandFor(score) {
  return CONFIG.SCORE_BANDS.find((b) => score >= b.min) || CONFIG.SCORE_BANDS.at(-1);
}

/**
 * Live severity model used when the frontend derives its own score from
 * temporal features (no backend score present). Deliberately additive and
 * explainable â€” each term maps to an observable behaviour, not a diagnosis.
 *
 * @param {{verticalVelocity:number, motionMagnitude:number, bodyAngle:number,
 *          groundDurationMs:number, timeSinceMovementMs:number}} f
 * @returns {number} 0..10
 */
export function computeGuardianScore(f) {
  const T = CONFIG.THRESHOLDS;
  let score = 0.8; // baseline presence of a tracked person

  // abrupt downward travel
  const drop = Math.max(0, -(f.verticalVelocity || 0));
  score += clamp(drop / T.rapidDropVelocity, 0, 1) * 2.0;

  // abnormal body orientation
  score += clamp((Math.abs(f.bodyAngle || 0) - T.bodyAngleAnomaly) / (90 - T.bodyAngleAnomaly), 0, 1) * 1.6;

  // time spent at ground level
  score += clamp((f.groundDurationMs || 0) / 12000, 0, 1) * 2.2;

  // sustained minimal movement, weighted by how long the person has been at
  // ground level â€” standing still is not the same signal as lying still
  const groundFactor = clamp((f.groundDurationMs || 0) / 2000, 0, 1);
  score += clamp((f.timeSinceMovementMs || 0) / 16000, 0, 1) * 2.8 * groundFactor;

  // active movement pulls concern back down
  score -= clamp((f.motionMagnitude || 0) / 0.25, 0, 1) * 1.4;

  return clamp(round(score, 1), 0, 10);
}

export function createScorePanel() {
  const gauge = $('#score-gauge');
  const fill = $('#gauge-fill');
  const valueEl = $('#score-value');
  const bandEl = $('#score-band');
  const captionEl = $('#score-caption');
  const deltaEl = $('#score-delta');
  const trendEl = $('#score-trend');
  const trendLine = $('#trend-line');
  const trendArea = $('#trend-area');
  const confValue = $('#confidence-value');
  const confFill = $('#confidence-fill');
  const confNote = $('#confidence-note');
  const roEvent = $('#ro-event');
  const roPerson = $('#ro-person');
  const roImmobility = $('#ro-immobility');
  const roMotion = $('#ro-motion');

  let displayed = 0;
  let target = 0;
  let currentBand = 'normal';

  function applyBand(score) {
    const band = bandFor(score);
    if (band.key !== currentBand) {
      currentBand = band.key;
      gauge.dataset.status = band.key;
      trendEl.dataset.status = band.key;
      bandEl.textContent = band.label;
      bandEl.dataset.status = band.key;
      captionEl.textContent = BAND_CAPTIONS[band.key];
    }
  }

  function renderTrend(samples) {
    if (!samples.length) {
      trendLine.setAttribute('d', '');
      trendArea.setAttribute('d', '');
      return;
    }
    // a single sample still draws a flat baseline rather than an empty box
    const series = samples.length === 1 ? [samples[0], samples[0]] : samples;
    const n = series.length;
    const points = series.map((s, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 50 - (clamp(s, 0, 10) / 10) * 44;
      return [round(x, 2), round(y, 2)];
    });
    const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
    trendLine.setAttribute('d', line);
    trendArea.setAttribute('d', `${line} L100 54 L0 54 Z`);
  }

  /** Called on every state change. */
  function sync(state) {
    target = state.guardianScore;

    const delta = round(state.guardianScore - state.previousScore, 1);
    if (Math.abs(delta) >= 0.1) {
      deltaEl.dataset.dir = delta > 0 ? 'up' : 'down';
      deltaEl.textContent = `${delta > 0 ? 'â–²' : 'â–¼'} ${delta > 0 ? '+' : ''}${delta.toFixed(1)} Â· ${state.previousScore.toFixed(1)} â†’ ${state.guardianScore.toFixed(1)}`;
    } else if (state.guardianScore === 0) {
      deltaEl.dataset.dir = 'flat';
      deltaEl.textContent = '';
    }

    renderTrend(state.scoreTrend);

    const confPct = Math.round(state.confidence * 100);
    confValue.textContent = `${confPct}%`;
    confFill.style.width = `${confPct}%`;
    confNote.textContent = state.confidence > 0
      ? `Certainty that the observed pattern is â€œ${state.eventLabel}â€.`
      : 'Classification certainty for the current pattern.';

    roEvent.textContent = state.eventLabel || 'None';
    roEvent.dataset.status = state.eventType === 'normal' ? 'normal' : bandFor(state.guardianScore).key;
    roPerson.textContent = state.focusPersonId || 'â€”';
    roImmobility.textContent = formatSeconds(state.immobilitySeconds);
    roMotion.textContent = state.motionState;
    roMotion.dataset.status = state.motionState === 'Minimal' ? 'warning' : 'normal';
  }

  /** Frame tick â€” eases the displayed number and the gauge sweep. */
  function tick(dtMs) {
    if (Math.abs(displayed - target) < 0.005) {
      displayed = target;
    } else {
      const k = 1 - Math.exp(-dtMs / 240);
      displayed += (target - displayed) * k;
    }
    const shown = round(displayed, 1);
    valueEl.textContent = shown.toFixed(1);
    fill.setAttribute('stroke-dasharray', `${clamp(displayed / 10, 0, 1) * 100} 100`);
    applyBand(displayed);
  }

  function reset() {
    displayed = 0;
    target = 0;
    currentBand = null;
    deltaEl.textContent = '';
    renderTrend([]);
    applyBand(0);
  }

  applyBand(0);
  return { sync, tick, reset };
}

