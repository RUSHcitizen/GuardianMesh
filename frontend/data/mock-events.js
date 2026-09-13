/**
 * GuardianMesh — operational copy and the simulated response roster.
 *
 * No camera, person, or incident is defined here: those all come from the
 * camera by way of YOLO26. What remains is the wording the interface uses and
 * the simulated responder network. The language describes observable behaviour
 * and never asserts a medical diagnosis.
 */

/** Simulated response network. Never contacts real emergency services. */
export const RESPONDERS = [
  { id: 'RSP-SEC',  name: 'Security Desk',       role: 'Security',            state: 'idle' },
  { id: 'RSP-AID',  name: 'First Aid Team',      role: 'First Aid',           state: 'idle' },
  { id: 'RSP-FAC',  name: 'Facility Staff',      role: 'Facility',            state: 'idle' },
  { id: 'RSP-DES',  name: 'Designated Responder',role: 'On-site Designate',   state: 'idle' }
];

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
    'Continue monitoring {person}',
    'Hold responder dispatch pending further temporal evidence',
    'Corroborate with adjacent mesh nodes'
  ],
  critical: [
    'Alert designated responder',
    'Display incident location — {location}',
    'Continue monitoring {person}',
    'Open live incident view for responder review',
    'Provide on-site emergency-resource information'
  ]
};

