"""
GuardianMesh: Temporal Feature Extraction
Extracts motion, velocity, posture features from pose sequences
"""
 
import numpy as np
from collections import deque
from dataclasses import dataclass
from typing import Dict, Optional, List, Tuple
try:
    from .pose_tracker import Pose, Keypoint
except ImportError:  # run as a plain script from the repo root
    from pose_tracker import Pose, Keypoint
 
@dataclass
class TemporalFeatures:
    """Computed features from pose sequence"""
    # Motion metrics
    body_velocity: float  # avg movement speed
    max_velocity: float  # peak movement
    motion_variance: float  # consistency of movement
    
    # Posture metrics
    horizontal_offset: float  # lean left/right
    vertical_drop: float  # head drop (fall indicator)
    body_angle: float  # torso orientation
    arm_raise_ratio: float  # hands above shoulders
    
    # Immobility
    static_frames: int  # consecutive low-motion frames
    immobility_score: float  # 0-1, high = more immobile
    
    # Contact
    ground_contact_confidence: float  # likelihood person is on ground
    hand_position: str  # 'up', 'mid', 'down', 'touching_ground'
    
    # Velocity profile
    velocity_trajectory: List[float]  # recent velocity history
    acceleration: float  # rate of change in velocity
 
class TemporalAnalyzer:
    """
    Extracts temporal features from pose sequences.
    Designed for fall detection, immobility, and distress signals.
    """
    
    CRITICAL_KEYPOINTS = {
        'head': ['nose', 'left_ear', 'right_ear'],
        'torso': ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
        'limbs': ['left_wrist', 'right_wrist', 'left_ankle', 'right_ankle'],
        'left_arm': ['left_shoulder', 'left_elbow', 'left_wrist'],
        'right_arm': ['right_shoulder', 'right_elbow', 'right_wrist'],
        'left_leg': ['left_hip', 'left_knee', 'left_ankle'],
        'right_leg': ['right_hip', 'right_knee', 'right_ankle'],
    }
    
    def __init__(
        self,
        velocity_window: int = 10,  # frames to compute velocity
        immobility_threshold: float = 0.05,  # pixels/frame
        immobility_window: int = 30,  # frames to detect immobility
    ):
        self.velocity_window = velocity_window
        self.immobility_threshold = immobility_threshold
        self.immobility_window = immobility_window
    
    def extract_features(
        self,
        pose_history: deque,
        frame_shape: Tuple[int, int]
    ) -> Optional[TemporalFeatures]:
        """
        Extract temporal features from pose sequence.
        
        Args:
            pose_history: deque of Pose objects
            frame_shape: (height, width) for normalization
            
        Returns:
            TemporalFeatures or None if sequence too short
        """
        if len(pose_history) < 3:
            return None
        
        poses = list(pose_history)
        h, w = frame_shape
        
        # Compute velocities
        velocities = self._compute_velocities(poses, h, w)
        body_velocity = np.mean(velocities) if velocities else 0.0
        max_velocity = np.max(velocities) if velocities else 0.0
        motion_variance = np.var(velocities) if len(velocities) > 1 else 0.0
        acceleration = self._compute_acceleration(velocities)
        
        # Posture features
        latest_pose = poses[-1]
        horizontal_offset = self._compute_horizontal_offset(latest_pose, h, w)
        vertical_drop = self._compute_vertical_drop(poses, h, w)
        body_angle = self._compute_body_angle(latest_pose)
        arm_raise_ratio = self._compute_arm_raise_ratio(latest_pose)
        
        # Immobility detection
        static_frames = self._count_static_frames(
            poses,
            threshold=self.immobility_threshold,
            frame_height=h
        )
        immobility_score = min(1.0, static_frames / self.immobility_window)
        
        # Ground contact (key fall indicator)
        ground_contact_conf, hand_pos = self._detect_ground_contact(latest_pose, h)
        
        # Velocity trajectory for trend analysis
        velocity_trajectory = velocities[-10:]
        
        return TemporalFeatures(
            body_velocity=body_velocity,
            max_velocity=max_velocity,
            motion_variance=motion_variance,
            horizontal_offset=horizontal_offset,
            vertical_drop=vertical_drop,
            body_angle=body_angle,
            arm_raise_ratio=arm_raise_ratio,
            static_frames=static_frames,
            immobility_score=immobility_score,
            ground_contact_confidence=ground_contact_conf,
            hand_position=hand_pos,
            velocity_trajectory=velocity_trajectory,
            acceleration=acceleration
        )
    
    def _compute_velocities(
        self,
        poses: List[Pose],
        h: int,
        w: int
    ) -> List[float]:
        """Compute per-frame velocity of center of mass"""
        if len(poses) < 2:
            return []
        
        velocities = []
        for i in range(1, len(poses)):
            prev_com = self._compute_center_of_mass(poses[i-1])
            curr_com = self._compute_center_of_mass(poses[i])
            
            if prev_com is not None and curr_com is not None:
                velocity = np.linalg.norm(curr_com - prev_com)
                # Normalize by frame height
                velocity_normalized = velocity / h
                velocities.append(velocity_normalized)
        
        return velocities
    
    def _compute_center_of_mass(self, pose: Pose) -> Optional[np.ndarray]:
        """Compute center of mass from visible keypoints"""
        positions = []
        confidences = []
        
        for keypoint in pose.keypoints.values():
            if keypoint.confidence > 0.3:  # Only use visible keypoints
                positions.append([keypoint.x, keypoint.y])
                confidences.append(keypoint.confidence)
        
        if not positions:
            return None
        
        positions = np.array(positions)
        confidences = np.array(confidences)
        
        # Weighted center of mass
        com = np.average(positions, axis=0, weights=confidences)
        return com
    
    def _compute_acceleration(self, velocities: List[float]) -> float:
        """Compute acceleration (change in velocity)"""
        if len(velocities) < 2:
            return 0.0
        
        diffs = np.diff(velocities)
        return np.mean(np.abs(diffs)) if len(diffs) > 0 else 0.0
    
    def _compute_horizontal_offset(self, pose: Pose, h: int, w: int) -> float:
        """
        Measure lean/offset.
        Positive = lean right, Negative = lean left
        Range: -1 to 1
        """
        left_shoulder = pose.get_keypoint('left_shoulder')
        right_shoulder = pose.get_keypoint('right_shoulder')
        
        if not (left_shoulder and right_shoulder):
            return 0.0
        
        shoulder_center = (left_shoulder.x + right_shoulder.x) / 2
        frame_center = w / 2
        
        offset = (shoulder_center - frame_center) / (w / 2)
        return np.clip(offset, -1.0, 1.0)
    
    def _compute_vertical_drop(self, poses: List[Pose], h: int, w: int) -> float:
        """
        Measure head drop over time.
        Negative value = head moving downward (fall indicator)
        """
        if len(poses) < 2:
            return 0.0
        
        head_positions = []
        for pose in poses:
            nose = pose.get_keypoint('nose')
            if nose and nose.confidence > 0.3:
                head_positions.append(nose.y)
        
        if len(head_positions) < 2:
            return 0.0
        
        # Compute trend
        y_trend = np.polyfit(range(len(head_positions)), head_positions, 1)[0]
        # Normalize: positive trend = head going down (bad)
        return y_trend / h
    
    def _compute_body_angle(self, pose: Pose) -> float:
        """
        Compute torso angle.
        0 = vertical, 90 = horizontal (lying down)
        """
        left_shoulder = pose.get_keypoint('left_shoulder')
        right_shoulder = pose.get_keypoint('right_shoulder')
        left_hip = pose.get_keypoint('left_hip')
        right_hip = pose.get_keypoint('right_hip')
        
        if not all([left_shoulder, right_shoulder, left_hip, right_hip]):
            return 0.0
        
        # Shoulder midpoint
        shoulder_mid = np.array([
            (left_shoulder.x + right_shoulder.x) / 2,
            (left_shoulder.y + right_shoulder.y) / 2
        ])
        
        # Hip midpoint
        hip_mid = np.array([
            (left_hip.x + right_hip.x) / 2,
            (left_hip.y + right_hip.y) / 2
        ])
        
        # Vector from hip to shoulder
        torso_vec = shoulder_mid - hip_mid
        
        # Angle from vertical
        angle_rad = np.arctan2(torso_vec[0], -torso_vec[1])
        angle_deg = np.degrees(angle_rad)
        
        # Map to 0-90 (0=upright, 90=horizontal)
        return abs(angle_deg)
    
    def _compute_arm_raise_ratio(self, pose: Pose) -> float:
        """
        Measure how high hands are relative to shoulders.
        Returns: 0 (hands down) to 1 (hands high)
        """
        left_shoulder = pose.get_keypoint('left_shoulder')
        right_shoulder = pose.get_keypoint('right_shoulder')
        left_wrist = pose.get_keypoint('left_wrist')
        right_wrist = pose.get_keypoint('right_wrist')
        
        if not all([left_shoulder, right_shoulder, left_wrist, right_wrist]):
            return 0.0
        
        shoulder_y = (left_shoulder.y + right_shoulder.y) / 2
        wrist_y = (left_wrist.y + right_wrist.y) / 2
        
        if shoulder_y <= 0:
            return 0.0

        # Negative = hands above shoulders
        raise_ratio = max(0.0, 1.0 - (wrist_y / shoulder_y))
        return np.clip(raise_ratio, 0.0, 1.0)
    
    def _count_static_frames(
        self,
        poses: List[Pose],
        threshold: float,
        frame_height: int
    ) -> int:
        """Count consecutive frames with low motion"""
        if len(poses) < 2:
            return 0
        
        velocities = self._compute_velocities(
            poses,
            h=frame_height,
            w=1000
        )
        
        if not velocities:
            return 0
        
        # Count from end backwards
        static_count = 0
        for v in reversed(velocities):
            if v < threshold:
                static_count += 1
            else:
                break
        
        return static_count
    
    def _detect_ground_contact(self, pose: Pose, h: int) -> Tuple[float, str]:
        """
        Detect if person is in contact with ground.
        Checks ankle/hand proximity to bottom of frame.
        
        Returns:
            (confidence, hand_position_str)
        """
        ground_threshold = 0.15 * h  # Bottom 15% of frame
        
        ankles = [pose.get_keypoint('left_ankle'), pose.get_keypoint('right_ankle')]
        wrists = [pose.get_keypoint('left_wrist'), pose.get_keypoint('right_wrist')]
        
        # Check if hands/feet are near ground
        near_ground = 0
        total_limbs = 0
        
        for limb in ankles + wrists:
            if limb and limb.confidence > 0.3:
                total_limbs += 1
                if limb.y > (h - ground_threshold):
                    near_ground += 1
        
        confidence = near_ground / total_limbs if total_limbs > 0 else 0.0
        
        # Hand position categorization
        hand_y_positions = []
        for wrist in wrists:
            if wrist and wrist.confidence > 0.3:
                hand_y_positions.append(wrist.y)
        
        if not hand_y_positions:
            hand_pos = 'unknown'
        else:
            avg_hand_y = np.mean(hand_y_positions)
            shoulder_y = 0.4 * h  # Rough shoulder height
            
            if avg_hand_y > h - ground_threshold:
                hand_pos = 'touching_ground'
            elif avg_hand_y > 0.6 * h:
                hand_pos = 'down'
            elif avg_hand_y > shoulder_y:
                hand_pos = 'mid'
            else:
                hand_pos = 'up'
        
        return confidence, hand_pos
 
 
class FallDetector:
    """
    Multi-signal fall detection combining temporal features.
    Outputs scores for:
    - possible_fall
    - confirmed_fall (with immobility)
    """
    
    def __init__(self):
        self.temporal_analyzer = TemporalAnalyzer()
    
    def compute_fall_score(
        self,
        features: TemporalFeatures,
        recent_trajectory_length: int = 20
    ) -> Dict[str, float]:
        """
        Compute fall likelihood from multiple signals.
        
        Returns dict with keys:
            - 'fall_score': 0-1, likelihood of active fall
            - 'immobility_score': 0-1, likelihood of unconsciousness/injury
            - 'confidence': overall model confidence
        """
        
        signals = {}
        
        # Signal 1: Rapid body angle change (standing -> lying)
        # High body angle + rapid change = likely falling
        signals['body_angle'] = min(1.0, features.body_angle / 75.0)
        
        # Signal 2: Fast downward motion + immobility
        signals['vertical_drop'] = max(0.0, features.vertical_drop * 2.0)  # Clip at 1.0
        signals['vertical_drop'] = min(1.0, signals['vertical_drop'])
        
        # Signal 3: High velocity + immediate immobility = impact
        high_recent_velocity = max(features.velocity_trajectory) if features.velocity_trajectory else 0.0
        signals['impact_pattern'] = high_recent_velocity * (1.0 - features.body_velocity / max(features.max_velocity, 0.01))
        signals['impact_pattern'] = np.clip(signals['impact_pattern'], 0.0, 1.0)
        
        # Signal 4: Ground contact confidence
        signals['ground_contact'] = features.ground_contact_confidence
        
        # Signal 5: Immobility (frozen state)
        signals['immobility'] = features.immobility_score
        
        # Combine signals for fall detection
        # Weight: high body angle + ground contact + downward motion = high fall risk
        fall_score = (
            signals['body_angle'] * 0.25 +
            signals['ground_contact'] * 0.30 +
            signals['vertical_drop'] * 0.20 +
            signals['impact_pattern'] * 0.15 +
            signals['immobility'] * 0.10
        )
        
        # Immobility score: high immobility + low body_velocity + on ground
        immobility_final = (
            features.immobility_score * 0.50 +
            (1.0 - min(1.0, features.body_velocity * 10.0)) * 0.30 +
            features.ground_contact_confidence * 0.20
        )
        
        # Overall confidence from detection signals
        signal_variance = np.var(list(signals.values()))
        confidence = 1.0 - (signal_variance / 0.25)  # Normalized
        confidence = np.clip(confidence, 0.3, 1.0)
        
        return {
            'fall_score': float(np.clip(fall_score, 0.0, 1.0)),
            'immobility_score': float(np.clip(immobility_final, 0.0, 1.0)),
            'confidence': float(confidence),
            'signals': signals
        }
 