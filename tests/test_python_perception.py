import sys
import types
import unittest

try:
    import numpy  # noqa: F401
except ModuleNotFoundError:
    # The tested paths need only mean() and clip(). Keep this unit test runnable
    # without installing the full OpenCV/MediaPipe environment.
    numpy = types.ModuleType("numpy")
    numpy.ndarray = object
    numpy.mean = lambda values: sum(values) / len(values)
    numpy.clip = lambda value, low, high: max(low, min(high, value))
    sys.modules["numpy"] = numpy

from ai_cv.event_classifier import EventDetection, EventType, RealtimeProcessor
from ai_cv.pose_tracker import Keypoint, Pose, PoseTracker


def detection(score=0.9, person_id=0):
    return EventDetection(
        camera_id="cam_test",
        event_type=EventType.POSSIBLE_FALL,
        fall_score=score,
        immobility_score=0.75,
        tracking_confidence=0.9,
        overall_confidence=0.85,
        timestamp="2026-09-12T00:00:00+00:00",
        person_id=person_id,
    )


class FakeClassifier:
    pose_tracker = None

    def __init__(self, score=0.9):
        self.score = score

    def process_frame(self, _frame):
        return [detection(self.score)]


class PythonPerceptionTests(unittest.TestCase):
    def test_landmark_indices_match_mediapipe_pose(self):
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["left_shoulder"], 11)
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["right_shoulder"], 12)
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["left_hip"], 23)
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["right_hip"], 24)
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["left_ankle"], 27)
        self.assertEqual(PoseTracker.LANDMARK_INDEXES["right_ankle"], 28)

    def test_pose_smoothing_blends_matched_points(self):
        tracker = PoseTracker.__new__(PoseTracker)
        tracker.smoothing_alpha = 0.75
        previous = Pose({"nose": Keypoint(0, 0, 0, 0.8)}, 0.8, (0, 0, 0, 0))
        current = Pose({"nose": Keypoint(8, 4, 2, 0.9)}, 0.9, (8, 4, 8, 4))

        smoothed = tracker._smooth_pose(previous, current)

        self.assertEqual(smoothed.get_keypoint("nose").x, 6)
        self.assertEqual(smoothed.get_keypoint("nose").y, 3)
        self.assertEqual(smoothed.confidence, 0.9)

    def test_continuous_alerts_accumulate_video_time(self):
        processor = RealtimeProcessor.__new__(RealtimeProcessor)
        processor.classifier = FakeClassifier()
        processor.alert_threshold = 0.5
        processor.buffer_size = 1
        processor.frames_per_second = 2.0
        processor.score_buffer = {}
        processor.alert_frame_counts = {}
        processor.last_detections = []

        alert = None
        for _ in range(10):
            alert = processor.process_frame(None)[0]

        self.assertEqual(alert.persistence_seconds, 5.0)
        self.assertEqual(alert.to_dict()["persistence_seconds"], 5.0)

    def test_persistence_resets_below_threshold(self):
        processor = RealtimeProcessor.__new__(RealtimeProcessor)
        processor.classifier = FakeClassifier()
        processor.alert_threshold = 0.5
        processor.buffer_size = 1
        processor.frames_per_second = 10.0
        processor.score_buffer = {}
        processor.alert_frame_counts = {}
        processor.last_detections = []

        processor.process_frame(None)
        processor.classifier.score = 0.1
        self.assertEqual(processor.process_frame(None), [])
        processor.classifier.score = 0.9
        alert = processor.process_frame(None)[0]

        self.assertEqual(alert.persistence_seconds, 0.1)

    def test_missing_person_clears_smoothing_history(self):
        processor = RealtimeProcessor.__new__(RealtimeProcessor)
        processor.classifier = FakeClassifier()
        processor.alert_threshold = 0.5
        processor.buffer_size = 5
        processor.frames_per_second = 10.0
        processor.score_buffer = {}
        processor.alert_frame_counts = {}
        processor.last_detections = []

        processor.process_frame(None)
        self.assertIn(0, processor.score_buffer)

        processor.classifier.process_frame = lambda _frame: []
        processor.process_frame(None)
        self.assertNotIn(0, processor.score_buffer)


if __name__ == "__main__":
    unittest.main()
