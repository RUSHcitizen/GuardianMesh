/**
 * GuardianMesh â€” single source of truth for demo/mock data.
 *
 * Nothing outside this file should hard-code camera names, responder labels,
 * event copy, or incident values. Swap this file for backend data and the UI
 * is unchanged.
 */

/** Mesh nodes: cameras. */
export const CAMERAS = [
  { id: 'CAM-01', label: 'CAM 01', location: 'Main Hall',     status: 'normal', people: 0, score: 0.4, online: true },
  { id: 'CAM-02', label: 'CAM 02', location: 'Main Corridor', status: 'normal', people: 1, score: 0.6, online: true, primary: true },
  { id: 'CAM-03', label: 'CAM 03', location: 'School Gym',    status: 'normal', people: 0, score: 0.3, online: true },
  { id: 'CAM-04', label: 'CAM 04', location: 'North Entrance',status: 'normal', people: 0, score: 0.2, online: true }
];

/** Mesh nodes: non-camera sensors that can corroborate an event. */
export const SENSORS = [
  { id: 'SEN-01', label: 'SENSOR 01', location: 'Corridor Motion', kind: 'motion',  status: 'normal', online: true },
  { id: 'SEN-02', label: 'SENSOR 02', location: 'Gym Acoustic',    kind: 'acoustic', status: 'normal', online: true }
];

/** Simulated response network. Never contacts real emergency services. */
export const RESPONDERS = [
  { id: 'RSP-SEC',  name: 'Security Desk',       role: 'Security',            state: 'idle' },
  { id: 'RSP-AID',  name: 'First Aid Team',      role: 'First Aid',           state: 'idle' },
  { id: 'RSP-FAC',  name: 'Facility Staff',      role: 'Facility',            state: 'idle' },
  { id: 'RSP-DES',  name: 'Designated Responder',role: 'On-site Designate',   state: 'idle' }
];

/** People the mesh is tracking anonymously at rest. */
export const BASELINE_PEOPLE = [];

/** The subject of the scripted incident. */
export const SUBJECT = {
  trackingId: 'P-02', cameraId: 'CAM-02', bodyState: 'walking',
  anchor: { x: 0.02, y: 0.02 }, scale: 1.0, drift: { x: 0.004, y: 0 },
  state: 'tracking', label: 'Normal motion'
};

/** Guardian Score band copy. Keys match CONFIG.SCORE_BANDS. */
export const BAND_CAPTIONS = {
  normal:   'No concerning pattern observed.',
  elevated: 'Movement anomaly under observation. Continuing to gather temporal evidence.',
  high:     'Sustained concerning pattern. Responder review suggested.',
  critical: 'High-confidence distress pattern. Responder dispatch recommended.'
};

/** Human-readable labels for event types. Deliberately non-medical language. */
export const EVENT_LABELS = {
  normal: 'Normal motion',
  pose_anomaly: 'Pose anomaly',
  rapid_displacement: 'Rapid vertical displacement',
  fall: 'Movement anomaly',
  collapsed: 'Ground-level pose',
  immobility: 'Prolonged immobility',
  distress: 'Possible distress pattern',
  running: 'Unusual movement',
  altercation: 'Erratic movement',
  crowd_anomaly: 'Crowd anomaly'
};

/** Recommended actions surfaced when concern is elevated or higher. */
export const RECOMMENDATIONS = {
  elevated: [
    'Continue monitoring person P-02',
    'Hold responder dispatch pending further temporal evidence',
    'Corroborate with adjacent mesh nodes'
  ],
  critical: [
    'Alert designated responder',
    'Display incident location â€” School Gym, Camera 03 sightline',
    'Continue monitoring person P-02',
    'Open live incident view for responder review',
    'Provide on-site emergency-resource information'
  ]
};

/** Cross-sensor corroboration evidence used by the scripted incident. */
export const CORROBORATION = {
  entries: [
    { source: 'CAM-02', observation: 'Rapid downward movement', confidence: 0.63 },
    { source: 'CAM-03', observation: 'Ground-level pose',       confidence: 0.76 },
    { source: 'SEN-01', observation: 'Minimal movement',        confidence: 0.71 }
  ],
  result: {
    label: 'Possible distress pattern',
    confidence: 0.94,
    guardianScore: 8.9,
    status: 'critical'
  }
};

/** Anonymous cross-camera handoff demonstration (no identity data involved). */
export const HANDOFF = {
  trackingId: 'P-04',
  from: 'CAM-01',
  to: 'CAM-02',
  note: 'Trajectory continued'
};

/** Incident template for the scripted event. */
export const INCIDENT_TEMPLATE = {
  id: 'INC-001',
  trackingId: 'P-02',
  eventType: 'pose_anomaly',
  label: 'Movement anomaly under observation',
  cameraId: 'CAM-02',
  location: 'Main Corridor',
  confidence: 0.61,
  guardianScore: 4.6,
  status: 'observing',
  durationSeconds: 0,
  immobilitySeconds: 0,
  responseState: 'Monitoring',
  timestamp: null
};






