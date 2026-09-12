/**
 * GuardianMesh â€” pose library.
 *
 * Canonical body poses expressed as COCO-17 keypoints in NORMALISED frame
 * coordinates (0..1, origin top-left). A track places a pose by applying an
 * anchor offset and a scale, so the same library serves any camera geometry.
 *
 * This is demo/simulation data. When the CV teammate streams real keypoints,
 * the pose engine consumes those instead and this file is only a fallback.
 */

export const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
];

/** Skeleton edges drawn by both the AR overlay and the simulated scene. */
export const SKELETON_EDGES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder']
];

/** Limb segments with thickness, used to render the simulated silhouette. */
export const LIMB_SEGMENTS = [
  ['left_shoulder', 'left_elbow', 0.020], ['left_elbow', 'left_wrist', 0.016],
  ['right_shoulder', 'right_elbow', 0.020], ['right_elbow', 'right_wrist', 0.016],
  ['left_hip', 'left_knee', 0.026], ['left_knee', 'left_ankle', 0.020],
  ['right_hip', 'right_knee', 0.026], ['right_knee', 'right_ankle', 0.020]
];

const pose = (entries) => Object.fromEntries(entries.map(([n, x, y]) => [n, { x, y }]));

export const POSES = {
  standing: pose([
    ['nose', 0.500, 0.330], ['left_eye', 0.489, 0.324], ['right_eye', 0.511, 0.324],
    ['left_ear', 0.481, 0.331], ['right_ear', 0.519, 0.331],
    ['left_shoulder', 0.470, 0.378], ['right_shoulder', 0.530, 0.378],
    ['left_elbow', 0.458, 0.452], ['right_elbow', 0.542, 0.452],
    ['left_wrist', 0.452, 0.522], ['right_wrist', 0.548, 0.522],
    ['left_hip', 0.480, 0.560], ['right_hip', 0.520, 0.560],
    ['left_knee', 0.477, 0.700], ['right_knee', 0.523, 0.700],
    ['left_ankle', 0.474, 0.842], ['right_ankle', 0.526, 0.842]
  ]),

  walk_a: pose([
    ['nose', 0.500, 0.332], ['left_eye', 0.489, 0.326], ['right_eye', 0.511, 0.326],
    ['left_ear', 0.481, 0.333], ['right_ear', 0.519, 0.333],
    ['left_shoulder', 0.470, 0.380], ['right_shoulder', 0.530, 0.380],
    ['left_elbow', 0.462, 0.452], ['right_elbow', 0.540, 0.456],
    ['left_wrist', 0.472, 0.514], ['right_wrist', 0.534, 0.530],
    ['left_hip', 0.480, 0.562], ['right_hip', 0.520, 0.562],
    ['left_knee', 0.462, 0.694], ['right_knee', 0.536, 0.704],
    ['left_ankle', 0.440, 0.836], ['right_ankle', 0.556, 0.846]
  ]),

  walk_b: pose([
    ['nose', 0.500, 0.332], ['left_eye', 0.489, 0.326], ['right_eye', 0.511, 0.326],
    ['left_ear', 0.481, 0.333], ['right_ear', 0.519, 0.333],
    ['left_shoulder', 0.470, 0.380], ['right_shoulder', 0.530, 0.380],
    ['left_elbow', 0.460, 0.456], ['right_elbow', 0.544, 0.452],
    ['left_wrist', 0.466, 0.530], ['right_wrist', 0.540, 0.514],
    ['left_hip', 0.480, 0.562], ['right_hip', 0.520, 0.562],
    ['left_knee', 0.470, 0.704], ['right_knee', 0.528, 0.694],
    ['left_ankle', 0.450, 0.846], ['right_ankle', 0.548, 0.836]
  ]),

  /** Abrupt change in movement pattern â€” torso pitches forward, knees buckle. */
  stumble: pose([
    ['nose', 0.548, 0.392], ['left_eye', 0.540, 0.386], ['right_eye', 0.558, 0.388],
    ['left_ear', 0.528, 0.393], ['right_ear', 0.564, 0.396],
    ['left_shoulder', 0.505, 0.434], ['right_shoulder', 0.556, 0.422],
    ['left_elbow', 0.470, 0.482], ['right_elbow', 0.602, 0.452],
    ['left_wrist', 0.440, 0.522], ['right_wrist', 0.648, 0.492],
    ['left_hip', 0.482, 0.600], ['right_hip', 0.516, 0.596],
    ['left_knee', 0.470, 0.722], ['right_knee', 0.520, 0.726],
    ['left_ankle', 0.462, 0.852], ['right_ankle', 0.520, 0.856]
  ]),

  /** Rapid vertical displacement â€” body mid-descent, orientation changing. */
  falling: pose([
    ['nose', 0.612, 0.560], ['left_eye', 0.606, 0.552], ['right_eye', 0.620, 0.556],
    ['left_ear', 0.596, 0.556], ['right_ear', 0.624, 0.566],
    ['left_shoulder', 0.578, 0.600], ['right_shoulder', 0.590, 0.572],
    ['left_elbow', 0.545, 0.660], ['right_elbow', 0.640, 0.620],
    ['left_wrist', 0.520, 0.716], ['right_wrist', 0.688, 0.652],
    ['left_hip', 0.500, 0.700], ['right_hip', 0.510, 0.686],
    ['left_knee', 0.452, 0.760], ['right_knee', 0.470, 0.742],
    ['left_ankle', 0.410, 0.824], ['right_ankle', 0.428, 0.812]
  ]),

  /** Ground-level pose â€” abnormal body orientation, person on the ground. */
  ground: pose([
    ['nose', 0.648, 0.786], ['left_eye', 0.641, 0.780], ['right_eye', 0.652, 0.782],
    ['left_ear', 0.630, 0.784], ['right_ear', 0.658, 0.788],
    ['left_shoulder', 0.598, 0.796], ['right_shoulder', 0.600, 0.778],
    ['left_elbow', 0.560, 0.828], ['right_elbow', 0.566, 0.762],
    ['left_wrist', 0.522, 0.846], ['right_wrist', 0.538, 0.744],
    ['left_hip', 0.500, 0.806], ['right_hip', 0.502, 0.788],
    ['left_knee', 0.436, 0.824], ['right_knee', 0.442, 0.800],
    ['left_ankle', 0.378, 0.840], ['right_ankle', 0.388, 0.812]
  ]),

  /** Movement resumed â€” propped on an elbow. */
  recovering: pose([
    ['nose', 0.640, 0.700], ['left_eye', 0.634, 0.694], ['right_eye', 0.646, 0.696],
    ['left_ear', 0.624, 0.700], ['right_ear', 0.652, 0.704],
    ['left_shoulder', 0.596, 0.734], ['right_shoulder', 0.602, 0.716],
    ['left_elbow', 0.566, 0.800], ['right_elbow', 0.580, 0.760],
    ['left_wrist', 0.548, 0.848], ['right_wrist', 0.556, 0.806],
    ['left_hip', 0.500, 0.800], ['right_hip', 0.504, 0.784],
    ['left_knee', 0.444, 0.806], ['right_knee', 0.450, 0.788],
    ['left_ankle', 0.392, 0.836], ['right_ankle', 0.400, 0.812]
  ]),

  /** Seated and stable â€” used when an event resolves. */
  seated: pose([
    ['nose', 0.562, 0.600], ['left_eye', 0.554, 0.594], ['right_eye', 0.570, 0.594],
    ['left_ear', 0.546, 0.600], ['right_ear', 0.578, 0.602],
    ['left_shoulder', 0.520, 0.646], ['right_shoulder', 0.566, 0.640],
    ['left_elbow', 0.500, 0.712], ['right_elbow', 0.588, 0.706],
    ['left_wrist', 0.496, 0.772], ['right_wrist', 0.596, 0.766],
    ['left_hip', 0.498, 0.796], ['right_hip', 0.522, 0.792],
    ['left_knee', 0.442, 0.788], ['right_knee', 0.462, 0.800],
    ['left_ankle', 0.392, 0.840], ['right_ankle', 0.410, 0.846]
  ])
};

/**
 * Body states the engine understands. `cycle` states loop through poses to
 * produce continuous motion; single-pose states hold with micro-movement.
 * `sway` is the amplitude of idle movement in normalised units.
 */
export const BODY_STATES = {
  walking:      { cycle: ['walk_a', 'standing', 'walk_b', 'standing'], periodMs: 1250, sway: 0.0016 },
  standing:     { pose: 'standing', sway: 0.0022 },
  stumble:      { pose: 'stumble', sway: 0.0040 },
  falling:      { pose: 'falling', sway: 0.0030 },
  ground:       { pose: 'ground', sway: 0.0018 },
  ground_still: { pose: 'ground', sway: 0.00035 },
  recovering:   { pose: 'recovering', sway: 0.0026 },
  seated:       { pose: 'seated', sway: 0.0020 }
};

