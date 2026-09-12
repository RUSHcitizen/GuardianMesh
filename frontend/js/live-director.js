/**
 * GuardianMesh — live director.
 *
 * In Demo Mode the scripted sequence decides when the camera stage turns
 * critical and when the response mesh activates. A live backend has no opinion
 * about either: it streams detections, not operational decisions. This module
 * derives those from severity so the dashboard behaves identically on live
 * data, and it runs ONLY when the data source is live so it never fights the
 * demo controller for the same panels.
 */

import { RECOMMENDATIONS, RESPONDERS } from '../data/mock-events.js';
import { bandFor } from './guardian-score.js';
import { setResponderState, setResponseState, subscribe, touched } from './state.js';

/** Responder set engaged at each workflow stage. */
const DISPATCH = {
  notified: ['RSP-SEC', 'RSP-AID', 'RSP-DES'],
  received: ['RSP-SEC']
};

export function createLiveDirector({ camera }) {
  let lastStage = null;
  let lastStageStatus = null;

  /** Map the current assessment onto a workflow stage. */
  function stageFor(state) {
    const active = state.incidents.filter((i) => i.status !== 'resolved');
    if (!active.length) return state.incidents.length ? 'resolved' : 'idle';
    const band = bandFor(state.guardianScore).key;
    if (band === 'critical') return 'notified';
    if (band === 'high') return 'received';
    return 'idle';
  }

  const SEVERITY = { normal: 0, observing: 1, elevated: 2, warning: 3, critical: 4 };
  const BAND_STATUS = { normal: 'normal', elevated: 'observing', high: 'warning', critical: 'critical' };

  /**
   * Stage status takes the MORE SEVERE of the classifier's status and the
   * Guardian Score band. A classifier may label sustained immobility a warning
   * while severity has already reached the critical band; the stage should not
   * under-report urgency in that case.
   */
  function stageStatusFor(state) {
    const active = state.incidents.filter((i) => i.status !== 'resolved');
    if (!active.length) return 'normal';
    const fromIncidents = active.reduce(
      (worst, i) => (SEVERITY[i.status] ?? 1) > (SEVERITY[worst] ?? 0) ? i.status : worst,
      'observing'
    );
    const fromScore = BAND_STATUS[bandFor(state.guardianScore).key] || 'observing';
    return (SEVERITY[fromScore] ?? 0) > (SEVERITY[fromIncidents] ?? 0) ? fromScore : fromIncidents;
  }

  function apply(state) {
    if (state.dataSource !== 'live' && state.dataSource !== 'local') return;

    const stageStatus = stageStatusFor(state);
    if (stageStatus !== lastStageStatus) {
      const escalated = stageStatus === 'critical' && lastStageStatus !== 'critical';
      lastStageStatus = stageStatus;
      camera.setStatus(stageStatus);
      if (escalated) camera.pulseCritical();
    }

    const stage = stageFor(state);
    if (stage === lastStage) return;
    lastStage = stage;

    if (stage === 'idle') {
      setResponseState('idle', []);
      for (const r of RESPONDERS) setResponderState(r.id, 'idle');
      return;
    }
    if (stage === 'resolved') {
      setResponseState('resolved', ['Incident archived — no further action required']);
      for (const r of RESPONDERS) setResponderState(r.id, 'resolved');
      return;
    }

    const lead = state.incidents.find((i) => i.status !== 'resolved');
    const where = lead
      ? [lead.location, lead.cameraId].filter(Boolean).join(', ')
      : 'incident camera';
    const list = stage === 'notified' ? RECOMMENDATIONS.critical : RECOMMENDATIONS.elevated;
    setResponseState(stage, list.map((line) => line.replace('{location}', where)));
    const engaged = new Set(DISPATCH[stage] || []);
    for (const r of RESPONDERS) {
      setResponderState(r.id, engaged.has(r.id) ? stage : 'idle');
    }
  }

  /** Re-evaluate whenever severity, incidents or the data source change. */
  subscribe((state, changed) => {
    if (!touched(changed, 'guardianScore', 'incidents', 'dataSource')) return;
    apply(state);
  });

  /** Clear the director's memory (e.g. when returning to Demo Mode). */
  function reset() {
    lastStage = null;
    lastStageStatus = null;
  }

  return { reset };
}
