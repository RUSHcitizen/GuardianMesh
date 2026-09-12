"""
GuardianMesh: Pose Tracking Module
Handles pose estimation, multi-person tracking, and keypoint smoothing
"""
 
import numpy as np
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional
import logging

try:
    import mediapipe as mp
except ImportError:
    mp = None
 
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
 
@dataclass
class Keypoint:
    """Single pose keypoint"""
    x: float
    y: float
    z: float  # depth from MediaPipe
    confidence: float
    
    def to_numpy(self) -> np.ndarray:
        return np.array([self.x, self.y, self.z])
 
@dataclass
class Pose:
    """Full body pose with keypoints"""
    keypoints: Dict[str, Keypoint]  # name -> Keypoint
    confidence: float  # overall pose detection confidence
    bbox: Tuple[float, float, float, float]  # x_min, y_min, x_max, y_max
    person_id: Optional[int] = None
    
    def get_keypoint(self, name: str) -> Optional[Keypoint]:
        return self.keypoints.get(name)
    
    def get_keypoint_xy(self, name: str) -> Optional[Tuple[float, float]]:
        kp = self.keypoints.get(name)
        return (kp.x, kp.y) if kp else None
 
class PoseTracker:
    """
    MediaPipe-based pose tracker with:
    - Multi-person detection
    - Per-person tracking (ID assignment)
    - Keypoint smoothing (Kalman filtering)
    - Confidence filtering
    """
    
    # MediaPipe keypoint names (COCO-33 format)
    KEYPOINT_NAMES = [
        'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
        'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
        'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
        'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
        # Additional 16 keypoints in COCO-33
        'neck', 'head', 'left_hip_alt', 'right_hip_alt',
        'left_knee_alt', 'right_knee_alt', 'left_ankle_alt', 'right_ankle_alt',
        'left_eye_inner', 'left_eye_outer', 'right_eye_inner', 'right_eye_outer',
        'left_ear_inner', 'right_ear_inner', 'mouth_left', 'mouth_right'
    ]
    
    def __init__(
        self,
        model_complexity: int = 1,  # 0=lite, 1=full
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        max_person_tracking_age: int = 30,  # frames
        smoothing_alpha: float = 0.7  # Exponential smoothing
    ):
        if mp is None:
            raise RuntimeError(
                "MediaPipe is required for camera inference. "
                "Install dependencies with: pip install -r requirements/requirements.txt"
            )

        self.min_detection_confidence = min_detection_confidence
        self.min_tracking_confidence = min_tracking_confidence
        self.max_person_tracking_age = max_person_tracking_age
        self.smoothing_alpha = smoothing_alpha
        
        # Initialize MediaPipe Pose
        self.mp_pose = mp.solutions.pose
        self.pose = self.mp_pose.Pose(
            static_image_mode=False,
            model_complexity=model_complexity,
            smooth_landmarks=True,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence
        )
        
        # Tracking state
        self.next_person_id = 0
        self.tracked_poses: Dict[int, Pose] = {}  # person_id -> Pose
        self.pose_history: Dict[int, deque] = defaultdict(
            lambda: deque(maxlen=30)  # Keep last 30 frames per person
        )
        self.person_age: Dict[int, int] = defaultdict(int)  # Frames each person has been matched
        # Frames since each person was last matched; stale tracks are dropped on this,
        # not on age, so a continuously visible person keeps their ID and history.
        self.frames_since_seen: Dict[int, int] = {}
        
    def process_frame(self, frame: np.ndarray) -> List[Pose]:
        """
        Process a single frame and return tracked poses.
        
        Args:
            frame: RGB frame (height, width, 3)
            
        Returns:
            List of Pose objects with tracking IDs
        """
        h, w, _ = frame.shape
        
        # Run MediaPipe inference
        results = self.pose.process(frame)
        
        # Parse detections
        current_detections = []
        if results.pose_landmarks:
            # Multiple people might be detected; MediaPipe returns per-person landmarks
            landmarks = results.pose_landmarks
            
            # Convert to Keypoint objects
            keypoints = {}
            bbox_coords = []
            min_confidence = 1.0
            
            for i, lm in enumerate(landmarks.landmark):
                if i < len(self.KEYPOINT_NAMES):
                    keypoint = Keypoint(
                        x=lm.x * w,
                        y=lm.y * h,
                        z=lm.z,
                        confidence=lm.visibility
                    )
                    keypoints[self.KEYPOINT_NAMES[i]] = keypoint
                    bbox_coords.append([lm.x * w, lm.y * h])
                    min_confidence = min(min_confidence, lm.visibility)
            
            if bbox_coords:
                bbox_coords = np.array(bbox_coords)
                bbox = (
                    bbox_coords[:, 0].min(),
                    bbox_coords[:, 1].min(),
                    bbox_coords[:, 0].max(),
                    bbox_coords[:, 1].max()
                )
                
                pose = Pose(
                    keypoints=keypoints,
                    confidence=min_confidence,
                    bbox=bbox
                )
                current_detections.append(pose)
        
        # Associate detections to tracked persons (Hungarian-like matching)
        seen_ids = self._associate_and_update_tracks(current_detections, frame.shape[:2])

        # Remove stale tracks
        self._cleanup_old_tracks()

        # Only poses observed in THIS frame. Re-appending a remembered pose for a
        # person who wasn't detected would fake a motionless history (false immobility).
        result_poses = [self.tracked_poses[pid] for pid in seen_ids if pid in self.tracked_poses]

        # Store history for temporal features
        for pose in result_poses:
            self.pose_history[pose.person_id].append(pose)

        return result_poses
    
    def _associate_and_update_tracks(self, detections: List[Pose], frame_shape: Tuple[int, int]) -> List[int]:
        """
        Simple centroid-based tracking.
        For more robust tracking, use DeepSORT or Hungarian algorithm.

        Returns the person IDs matched or created in this frame.
        """
        h, w = frame_shape

        for pid in self.frames_since_seen:
            self.frames_since_seen[pid] += 1

        if not detections:
            return []
        
        # Compute centroids
        detection_centroids = [
            ((d.bbox[0] + d.bbox[2]) / 2, (d.bbox[1] + d.bbox[3]) / 2)
            for d in detections
        ]
        
        tracked_centroids = {
            pid: ((p.bbox[0] + p.bbox[2]) / 2, (p.bbox[1] + p.bbox[3]) / 2)
            for pid, p in self.tracked_poses.items()
        }
        seen_ids: List[int] = []
        
        # Simple IoU-based matching
        used_detections = set()
        for person_id, pose in list(self.tracked_poses.items()):
            best_match_idx = -1
            best_distance = float('inf')
            
            for i, detection in enumerate(detections):
                if i in used_detections:
                    continue
                
                # Distance between centroids
                dist = np.linalg.norm(
                    np.array(detection_centroids[i]) - np.array(tracked_centroids[person_id])
                )
                
                # Also check IoU
                iou = self._bbox_iou(pose.bbox, detection.bbox)
                
                # Weighted distance: prefer spatial proximity
                score = dist * 0.6 + (1 - iou) * 0.4
                
                if score < best_distance and score < 50:  # Threshold
                    best_distance = score
                    best_match_idx = i
            
            if best_match_idx >= 0:
                # Update existing track
                self.tracked_poses[person_id] = detections[best_match_idx]
                self.tracked_poses[person_id].person_id = person_id
                self.person_age[person_id] += 1
                self.frames_since_seen[person_id] = 0
                used_detections.add(best_match_idx)
                seen_ids.append(person_id)

        # New detections become new tracks
        for i, detection in enumerate(detections):
            if i not in used_detections:
                detection.person_id = self.next_person_id
                self.tracked_poses[self.next_person_id] = detection
                self.person_age[self.next_person_id] = 1
                self.frames_since_seen[self.next_person_id] = 0
                seen_ids.append(self.next_person_id)
                self.next_person_id += 1

        return seen_ids
    
    def _bbox_iou(self, bbox1: Tuple, bbox2: Tuple) -> float:
        """Compute Intersection over Union of two bboxes"""
        x1_min, y1_min, x1_max, y1_max = bbox1
        x2_min, y2_min, x2_max, y2_max = bbox2
        
        inter_x_min = max(x1_min, x2_min)
        inter_y_min = max(y1_min, y2_min)
        inter_x_max = min(x1_max, x2_max)
        inter_y_max = min(y1_max, y2_max)
        
        if inter_x_max < inter_x_min or inter_y_max < inter_y_min:
            return 0.0
        
        inter_area = (inter_x_max - inter_x_min) * (inter_y_max - inter_y_min)
        
        bbox1_area = (x1_max - x1_min) * (y1_max - y1_min)
        bbox2_area = (x2_max - x2_min) * (y2_max - y2_min)
        
        union_area = bbox1_area + bbox2_area - inter_area
        
        return inter_area / union_area if union_area > 0 else 0.0
    
    def _cleanup_old_tracks(self):
        """Remove tracks that haven't been seen in a while"""
        to_remove = [
            pid for pid, missed in self.frames_since_seen.items()
            if missed > self.max_person_tracking_age
        ]
        for pid in to_remove:
            self.tracked_poses.pop(pid, None)
            self.person_age.pop(pid, None)
            self.frames_since_seen.pop(pid, None)
            self.pose_history.pop(pid, None)
    
    def get_pose_history(self, person_id: int, window_size: Optional[int] = None) -> deque:
        """Get pose history for a person for temporal feature extraction"""
        history = self.pose_history.get(person_id, deque())
        if window_size:
            return deque(list(history)[-window_size:])
        return history
    
    def reset(self):
        """Reset tracker state"""
        self.tracked_poses.clear()
        self.pose_history.clear()
        self.person_age.clear()
        self.frames_since_seen.clear()
        self.next_person_id = 0
 