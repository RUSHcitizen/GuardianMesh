"""
GuardianMesh: Event Classifier
Classifies events from temporal features and outputs standardized JSON.
 
Output format:
{
  "camera_id": "cam_02",
  "event_type": "possible_fall",
  "fall_score": 0.91,
  "immobility_score": 0.86,
  "tracking_confidence": 0.94,
  "overall_confidence": 0.88,
  "timestamp": "2026-09-12T10:22:16-07:00"
}
"""
 
import numpy as np
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timezone
from enum import Enum
import json
 
try:
    from .pose_tracker import Pose, PoseTracker
    from .temporal_features import TemporalFeatures, TemporalAnalyzer, FallDetector
except ImportError:  # run as a plain script from the repo root
    from pose_tracker import Pose, PoseTracker
    from temporal_features import TemporalFeatures, TemporalAnalyzer, FallDetector
 
 
class EventType(Enum):
    """Event classification categories"""
    NORMAL = "normal"
    POSSIBLE_FALL = "possible_fall"
    CONFIRMED_FALL = "confirmed_fall"  # Fall + immobility
    IMMOBILITY = "immobility"  # Unconscious/injury without fall
    AGGRESSIVE = "aggressive"  # High motion, raised arms
    DISTRESS = "distress"  # Combination of signals
    UNKNOWN = "unknown"
 
 
@dataclass
class EventDetection:
    """Single event detection output"""
    camera_id: str
    event_type: EventType
    fall_score: float  # 0-1
    immobility_score: float  # 0-1
    tracking_confidence: float  # 0-1 (pose quality)
    overall_confidence: float  # 0-1 (event detection confidence)
    timestamp: str  # ISO 8601
    person_id: Optional[int] = None
    persistence_seconds: float = 0.0
    
    # Additional signals for debugging/tuning
    body_angle: Optional[float] = None
    motion_velocity: Optional[float] = None
    ground_contact: Optional[float] = None
    pose: Optional[Pose] = None
    features: Optional[TemporalFeatures] = None
    
    def to_dict(self) -> Dict:
        """Convert to JSON-serializable dict"""
        return {
            'camera_id': self.camera_id,
            'event_type': self.event_type.value,
            'fall_score': round(self.fall_score, 2),
            'immobility_score': round(self.immobility_score, 2),
            'tracking_confidence': round(self.tracking_confidence, 2),
            'overall_confidence': round(self.overall_confidence, 2),
            'timestamp': self.timestamp,
            'person_id': self.person_id,
            'persistence_seconds': round(self.persistence_seconds, 2),
        }
    
    def to_json(self) -> str:
        """Serialize to JSON"""
        return json.dumps(self.to_dict(), indent=2)

    def to_dashboard_dict(self, frame_shape: Tuple[int, int]) -> Dict:
        """Return the normalized contract consumed by the command center."""
        height, width = frame_shape
        pose = self.pose
        features = self.features
        if not pose or not features or width <= 0 or height <= 0:
            return self.to_dict()

        keypoints = []
        for name, keypoint in pose.keypoints.items():
            if name not in PoseTracker.KEYPOINT_NAMES[:17]:
                continue
            keypoints.append({
                "name": name,
                "x": round(float(np.clip(keypoint.x / width, 0.0, 1.0)), 4),
                "y": round(float(np.clip(keypoint.y / height, 0.0, 1.0)), 4),
                "confidence": round(float(np.clip(keypoint.confidence, 0.0, 1.0)), 3),
            })

        x_min, y_min, x_max, y_max = pose.bbox
        bounding_box = {
            "x": round(float(np.clip(x_min / width, 0.0, 1.0)), 4),
            "y": round(float(np.clip(y_min / height, 0.0, 1.0)), 4),
            "width": round(float(np.clip((x_max - x_min) / width, 0.0, 1.0)), 4),
            "height": round(float(np.clip((y_max - y_min) / height, 0.0, 1.0)), 4),
        }

        event_type, status, label = self._dashboard_event_fields()
        guardian_score = np.clip(
            self.fall_score * 7.0 + self.immobility_score * 3.0,
            0.0,
            10.0,
        )
        return {
            **self.to_dict(),
            "id": f"EVT-{self.camera_id}-{self.person_id}-{self.timestamp}",
            "trackingId": f"P-{(self.person_id or 0) + 1:02d}",
            "cameraId": self.camera_id,
            "eventType": event_type,
            "label": label,
            "status": status,
            "confidence": round(self.overall_confidence, 3),
            "guardianScore": round(float(guardian_score), 1),
            "keypoints": keypoints,
            "boundingBox": bounding_box,
            "temporalFeatures": {
                "verticalVelocity": round(-features.vertical_drop * 30.0, 4),
                "motionMagnitude": round(features.body_velocity * 30.0, 4),
                "bodyAngle": round(features.body_angle, 2),
                "groundDurationMs": int(features.static_frames / 30.0 * 1000),
                "timeSinceMovementMs": int(features.static_frames / 30.0 * 1000),
            },
        }

    def _dashboard_event_fields(self) -> Tuple[str, str, str]:
        fields = {
            EventType.NORMAL: ("normal", "normal", "Normal motion"),
            EventType.POSSIBLE_FALL: ("fall", "warning", "Concerning movement pattern"),
            EventType.CONFIRMED_FALL: ("collapsed", "critical", "Ground-level pose - attention may be needed"),
            EventType.IMMOBILITY: ("immobility", "warning", "Prolonged immobility"),
            EventType.AGGRESSIVE: ("altercation", "warning", "Erratic movement"),
            EventType.DISTRESS: ("distress", "warning", "Possible distress pattern"),
        }
        return fields.get(self.event_type, ("normal", "observing", "Observed anomaly"))
 
 
class EventClassifier:
    """
    Main event classifier combining pose tracking and feature analysis.
    
    Detection pipeline:
    1. Track poses across frames
    2. Extract temporal features
    3. Compute event scores
    4. Classify into event types
    5. Output standardized JSON
    """
    
    # Thresholds (tunable based on dataset)
    THRESHOLDS = {
        'fall_score_alert': 0.50,  # Alert user to possible fall
        'fall_score_critical': 0.75,  # Critical fall detection
        'immobility_alert': 0.60,  # Person not moving for concern time
        'immobility_critical': 0.80,  # Extended immobility (need help?)
        'aggressive_threshold': 0.65,  # High motion + arm raise
        'pose_confidence_min': 0.5,  # Min pose detection confidence
    }
    
    def __init__(
        self,
        camera_id: str = "cam_01",
        pose_model_complexity: int = 1,
        history_window: int = 18,
        enable_pose: bool = True,
    ):
        self.camera_id = camera_id
        self.history_window = history_window
        
        # Initialize components
        self.pose_tracker = None
        if enable_pose:
            self.pose_tracker = PoseTracker(
                model_complexity=pose_model_complexity,
                max_person_tracking_age=history_window * 2
            )
        self.temporal_analyzer = TemporalAnalyzer(
            velocity_window=min(10, history_window // 2),
            immobility_window=history_window
        )
        self.fall_detector = FallDetector()
        
        # Per-person event state
        self.person_event_state: Dict[int, Dict] = {}
    
    def process_frame(self, frame: np.ndarray) -> List[EventDetection]:
        """
        Main inference pipeline for a single frame.
        
        Args:
            frame: RGB frame (H, W, 3)
            
        Returns:
            List of EventDetection objects (one per person)
        """
        if self.pose_tracker is None:
            raise RuntimeError("Pose tracking is disabled for this classifier")

        h, w, _ = frame.shape
        detections = []
        
        # Step 1: Track poses
        poses = self.pose_tracker.process_frame(frame)
        
        # Step 2: Analyze each tracked person
        for pose in poses:
            if pose.person_id is None:
                continue
            
            person_id = pose.person_id
            
            # Get pose history
            pose_history = self.pose_tracker.get_pose_history(
                person_id,
                window_size=self.history_window
            )
            
            # Skip if too few frames
            if len(pose_history) < 3:
                continue
            
            # Step 3: Extract features
            features = self.temporal_analyzer.extract_features(
                pose_history,
                frame_shape=(h, w)
            )
            
            if features is None:
                continue
            
            # Step 4: Classify event
            event = self._classify_event(
                pose=pose,
                features=features,
                person_id=person_id
            )
            
            detections.append(event)
        
        return detections

    def classify_features(
        self,
        pose: Pose,
        features: TemporalFeatures,
        person_id: int,
    ) -> EventDetection:
        """Classify already-extracted features for tests and offline demos."""
        return self._classify_event(pose, features, person_id)
    
    def _classify_event(
        self,
        pose: Pose,
        features: TemporalFeatures,
        person_id: int
    ) -> EventDetection:
        """
        Classify single person into event type.
        Uses rule-based logic + learned scores.
        """
        
        # Compute fall detection scores
        fall_scores = self.fall_detector.compute_fall_score(features)
        fall_score = fall_scores['fall_score']
        immobility_score = fall_scores['immobility_score']
        confidence = fall_scores['confidence']
        
        # Determine event type via decision tree
        event_type = self._decide_event_type(
            fall_score=fall_score,
            immobility_score=immobility_score,
            features=features
        )
        
        # Combine confidences
        pose_confidence = pose.confidence
        overall_confidence = (confidence * 0.7 + pose_confidence * 0.3)
        
        event = EventDetection(
            camera_id=self.camera_id,
            event_type=event_type,
            fall_score=fall_score,
            immobility_score=immobility_score,
            tracking_confidence=pose_confidence,
            overall_confidence=overall_confidence,
            timestamp=datetime.now(timezone.utc).isoformat(),
            person_id=person_id,
            body_angle=features.body_angle,
            motion_velocity=features.body_velocity,
            ground_contact=features.ground_contact_confidence,
            pose=pose,
            features=features,
        )
        
        return event
    
    def _decide_event_type(
        self,
        fall_score: float,
        immobility_score: float,
        features: TemporalFeatures
    ) -> EventType:
        """
        Decision tree for event classification.
        
        Logic:
        - High fall_score + high immobility = confirmed fall (medical emergency)
        - High fall_score, low immobility = possible fall (active falling)
        - High immobility, low fall_score = unconsciousness/injury (check wellbeing)
        - High body velocity + raised arms = aggressive behavior (security concern)
        - Everything else = normal
        """
        
        # Aggressive detection
        high_velocity = features.body_velocity > 0.3  # Normalized
        high_arm_raise = features.arm_raise_ratio > 0.6
        if high_velocity and high_arm_raise:
            return EventType.AGGRESSIVE
        
        # Fall detection
        critical_fall = (
            fall_score > self.THRESHOLDS['fall_score_critical'] and
            immobility_score > self.THRESHOLDS['immobility_alert']
        )
        if critical_fall:
            return EventType.CONFIRMED_FALL
        
        possible_fall = fall_score > self.THRESHOLDS['fall_score_alert']
        if possible_fall:
            return EventType.POSSIBLE_FALL
        
        # Immobility (without fall detection)
        immobility_only = immobility_score > self.THRESHOLDS['immobility_critical']
        if immobility_only and fall_score < self.THRESHOLDS['fall_score_alert']:
            return EventType.IMMOBILITY
        
        # Distress (combination of concerning signals)
        concerning_signals = sum([
            features.horizontal_offset > 0.7,  # Severe lean
            features.body_angle > 60,  # Very tilted
            features.ground_contact_confidence > 0.5 and features.body_velocity < 0.05,
        ])
        if concerning_signals >= 2:
            return EventType.DISTRESS
        
        return EventType.NORMAL
 
 
class RealtimeProcessor:
    """
    Wrapper for real-time video processing.
    Handles frame buffering and event aggregation.
    """
    
    def __init__(
        self,
        camera_id: str = "cam_01",
        alert_threshold: float = 0.45,
        buffer_size: int = 3,  # frames to average scores
        frames_per_second: float = 30.0,
    ):
        self.classifier = EventClassifier(camera_id=camera_id)
        self.alert_threshold = alert_threshold
        self.buffer_size = buffer_size
        self.frames_per_second = max(float(frames_per_second), 1.0)
        
        # Smoothing buffer per person
        self.score_buffer: Dict[int, List[float]] = {}
        self.alert_frame_counts: Dict[int, int] = {}
        # Every detection from the latest frame, including ones below the alert threshold
        self.last_detections: List[EventDetection] = []
    
    def process_frame(self, frame: np.ndarray) -> List[EventDetection]:
        """
        Process frame and return events above threshold.
        """
        detections = self.classifier.process_frame(frame)
        self.last_detections = detections

        # Filter and smooth
        alerts = []
        seen_person_ids = set()
        for det in detections:
            # person 0 is a real ID; only a missing ID maps to -1
            person_id = det.person_id if det.person_id is not None else -1
            seen_person_ids.add(person_id)
            
            if person_id not in self.score_buffer:
                self.score_buffer[person_id] = []
            
            self.score_buffer[person_id].append(det.fall_score)
            if len(self.score_buffer[person_id]) > self.buffer_size:
                self.score_buffer[person_id].pop(0)
            
            # Smooth score
            smoothed_fall_score = np.mean(self.score_buffer[person_id])
            
            # Alert if above threshold
            if smoothed_fall_score > self.alert_threshold:
                self.alert_frame_counts[person_id] = self.alert_frame_counts.get(person_id, 0) + 1
                det.fall_score = smoothed_fall_score
                det.persistence_seconds = self.alert_frame_counts[person_id] / self.frames_per_second
                alerts.append(det)
            else:
                self.alert_frame_counts.pop(person_id, None)

        for person_id in set(self.alert_frame_counts) - seen_person_ids:
            self.alert_frame_counts.pop(person_id, None)

        for person_id in set(self.score_buffer) - seen_person_ids:
            self.score_buffer.pop(person_id, None)
        
        return alerts
    
    def reset(self):
        """Reset tracker and buffers"""
        if self.classifier.pose_tracker is not None:
            self.classifier.pose_tracker.reset()
        self.score_buffer.clear()
        self.alert_frame_counts.clear()
        self.last_detections = []
 
 
# Example usage
if __name__ == "__main__":
    print("GuardianMesh Event Classifier")
    print("=" * 50)
    
    # Mock features for testing
    from dataclasses import replace
    
    # Test case 1: Normal standing
    normal_features = TemporalFeatures(
        body_velocity=0.05,
        max_velocity=0.1,
        motion_variance=0.001,
        horizontal_offset=0.1,
        vertical_drop=0.0,
        body_angle=10.0,
        arm_raise_ratio=0.3,
        static_frames=0,
        immobility_score=0.0,
        ground_contact_confidence=0.0,
        hand_position='mid',
        velocity_trajectory=[0.04, 0.05, 0.06],
        acceleration=0.01
    )
    
    # Test case 2: Fall detected
    fall_features = replace(
        normal_features,
        body_velocity=0.8,
        max_velocity=1.2,
        vertical_drop=0.15,
        body_angle=75.0,
        ground_contact_confidence=0.9,
        static_frames=15,
        immobility_score=0.7
    )
    
    classifier = EventClassifier()
    
    normal_event = classifier._classify_event(
        pose=Pose(keypoints={}, confidence=0.9, bbox=(0, 0, 100, 100)),
        features=normal_features,
        person_id=1
    )
    
    fall_event = classifier._classify_event(
        pose=Pose(keypoints={}, confidence=0.85, bbox=(0, 0, 100, 100)),
        features=fall_features,
        person_id=1
    )
    
    print("\nTest Case 1: Normal Activity")
    print(normal_event.to_json())
    
    print("\nTest Case 2: Fall Detection")
    print(fall_event.to_json())
 
