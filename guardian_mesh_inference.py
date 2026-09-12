"""
GuardianMesh: End-to-End Inference Pipeline
Process video files or camera streams and emit events.
 
Usage:
    python guardian_mesh_inference.py --source video.mp4 --camera_id cam_01
    python guardian_mesh_inference.py --source 0  # Webcam
    python guardian_mesh_inference.py --source rtsp://...  # IP camera
"""
 
import cv2
import numpy as np
import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
from collections import deque
from typing import List, Optional
 
from .event_classifier import RealtimeProcessor, EventDetection
 
 
class GuardianMeshPipeline:
    """
    Complete inference pipeline with visualization and logging.
    """
    
    def __init__(
        self,
        camera_id: str = "cam_01",
        alert_threshold: float = 0.45,
        visualize: bool = True,
        output_path: Optional[str] = None,
        fps_target: int = 30,
        api_url: Optional[str] = None,
        api_token: Optional[str] = None,
        allow_recording: bool = False,
    ):
        self.camera_id = camera_id
        self.visualize = visualize
        self.output_path = output_path
        self.fps_target = fps_target
        self.api_url = api_url.rstrip("/") if api_url else None
        self.api_token = api_token
        self.allow_recording = allow_recording

        if output_path and not allow_recording:
            raise ValueError(
                "Recording is disabled by default. Pass --allow-recording "
                "explicitly to save camera frames."
            )
        
        # Initialize processor
        self.processor = RealtimeProcessor(
            camera_id=camera_id,
            alert_threshold=alert_threshold
        )
        
        # Visualization
        self.viz_enabled = visualize
        self.frame_count = 0
        self.fps = 0.0
        self.event_log = deque(maxlen=20)
        
        # Optional video writer
        self.writer = None
    
    def run(self, source: str, max_frames: Optional[int] = None):
        """
        Run pipeline on video file or camera.
        
        Args:
            source: File path, URL, or camera index (0 for webcam)
            max_frames: Max frames to process (None = all)
        """
        
        # Open video source
        if source == "0":
            source = 0  # Webcam
        
        cap = cv2.VideoCapture(source)
        
        if not cap.isOpened():
            print(f"ERROR: Could not open video source: {source}")
            sys.exit(1)
        
        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS) or self.fps_target
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        print(f"\n{'='*60}")
        print(f"GuardianMesh Event Detection Pipeline")
        print(f"{'='*60}")
        print(f"Camera ID: {self.camera_id}")
        print(f"Source: {source}")
        print(f"Resolution: {w}x{h} @ {fps:.1f} FPS")
        print(f"Total Frames: {total_frames}")
        print(f"Max Frames: {max_frames or 'All'}")
        print(f"{'='*60}\n")
        
        # Setup output video
        if self.output_path:
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            self.writer = cv2.VideoWriter(
                self.output_path,
                fourcc,
                fps,
                (w, h)
            )
        
        frame_idx = 0
        import time
        last_time = time.time()
        
        while cap.isOpened():
            ret, frame = cap.read()
            
            if not ret:
                break
            
            # OpenCV supplies BGR; MediaPipe expects RGB. The frame stays local.
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            detections = self.processor.process_frame(rgb_frame)
            
            # Visualize
            if self.viz_enabled:
                frame_viz = self._visualize_frame(
                    frame,
                    detections,
                    frame_idx
                )
            else:
                frame_viz = frame
            
            # Log events
            for det in detections:
                self.event_log.appendleft(det)
                self._log_event(det)
                self._send_event(det, frame.shape[:2])
            
            # Write output
            if self.writer:
                self.writer.write(frame_viz)
            
            # Display only when visualization is enabled. Headless mode is safe
            # for a device that should only emit metadata to the backend.
            if self.viz_enabled:
                cv2.imshow('GuardianMesh', frame_viz)
            
            # FPS counter
            frame_idx += 1
            if frame_idx % 30 == 0:
                current_time = time.time()
                self.fps = 30 / (current_time - last_time)
                last_time = current_time
            
            # Check for exit
            if self.viz_enabled and cv2.waitKey(1) & 0xFF == ord('q'):
                print("\nExit requested by user")
                break
            
            if max_frames and frame_idx >= max_frames:
                print(f"\nMax frames reached: {max_frames}")
                break
        
        # Cleanup
        cap.release()
        if self.writer:
            self.writer.release()
        if self.viz_enabled:
            cv2.destroyAllWindows()
        
        print(f"\n{'='*60}")
        print(f"Processing Complete")
        print(f"Total Frames: {frame_idx}")
        print(f"Events Detected: {len(self.event_log)}")
        print(f"{'='*60}\n")
    
    def _visualize_frame(
        self,
        frame: np.ndarray,
        detections: List[EventDetection],
        frame_idx: int
    ) -> np.ndarray:
        """
        Add visualizations to frame.
        """
        viz = frame.copy()
        h, w = viz.shape[:2]
        
        # Info box
        info_text = [
            f"Frame: {frame_idx}",
            f"FPS: {self.fps:.1f}",
            f"Events: {len(detections)}",
        ]
        
        y_offset = 30
        for line in info_text:
            cv2.putText(
                viz, line,
                (10, y_offset),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0),
                2
            )
            y_offset += 25
        
        # Event boxes
        for i, det in enumerate(detections):
            color = self._event_color(det.event_type.value)
            
            event_text = (
                f"{det.event_type.value.upper()} "
                f"[Fall: {det.fall_score:.2f}, "
                f"Immob: {det.immobility_score:.2f}]"
            )
            
            cv2.putText(
                viz, event_text,
                (10, h - 60 + i * 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                color,
                2
            )
        
        # Recent event timeline
        timeline_y = h - 15
        timeline_x = w // 2
        timeline_height = 15
        cv2.rectangle(
            viz,
            (timeline_x - 100, timeline_y - timeline_height),
            (timeline_x + 100, timeline_y),
            (50, 50, 50),
            -1
        )
        
        for i, event in enumerate(self.event_log[:10]):
            color = self._event_color(event.event_type.value)
            x = timeline_x - 100 + i * 20
            cv2.circle(viz, (x, timeline_y - 7), 3, color, -1)
        
        return viz
    
    def _event_color(self, event_type: str) -> tuple:
        """Get BGR color for event type"""
        colors = {
            'normal': (0, 255, 0),  # Green
            'possible_fall': (0, 165, 255),  # Orange
            'confirmed_fall': (0, 0, 255),  # Red
            'immobility': (0, 0, 200),  # Dark red
            'aggressive': (255, 0, 0),  # Cyan
            'distress': (0, 255, 255),  # Yellow
            'unknown': (128, 128, 128),  # Gray
        }
        return colors.get(event_type, (128, 128, 128))
    
    def _log_event(self, det: EventDetection):
        """Print event to console"""
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        
        event_symbol = {
            'normal': '✓',
            'possible_fall': '⚠',
            'confirmed_fall': '🚨',
            'immobility': '⏸',
            'aggressive': '⚡',
            'distress': '❗',
            'unknown': '?',
        }.get(det.event_type.value, '?')
        
        print(
            f"[{timestamp}] {event_symbol} "
            f"Event: {det.event_type.value:15} | "
            f"Fall: {det.fall_score:.2f} | "
            f"Immob: {det.immobility_score:.2f} | "
            f"Conf: {det.overall_confidence:.2f}"
        )

    def _send_event(self, det: EventDetection, frame_shape):
        """Send event metadata only; never send frames or pose coordinates."""
        if not self.api_url:
            return

        headers = {"Content-Type": "application/json"}
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"

        request = urllib.request.Request(
            f"{self.api_url}/api/events",
            data=json.dumps(det.to_dashboard_dict(frame_shape)).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2):
                pass
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"Warning: could not send event metadata: {error}")
 
 
def main():
    parser = argparse.ArgumentParser(
        description="GuardianMesh Real-time Event Detection"
    )
    parser.add_argument(
        "--source",
        type=str,
        default="0",
        help="Video file path, URL, or camera index (default: 0 for webcam)"
    )
    parser.add_argument(
        "--camera_id",
        type=str,
        default="cam_01",
        help="Camera identifier for logging (default: cam_01)"
    )
    parser.add_argument(
        "--alert_threshold",
        type=float,
        default=0.45,
        help="Alert threshold for fall detection (0-1, default: 0.45)"
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output video file path (optional)"
    )
    parser.add_argument(
        "--max_frames",
        type=int,
        default=None,
        help="Max frames to process (default: all)"
    )
    parser.add_argument(
        "--no_viz",
        action="store_true",
        help="Disable visualization"
    )
    parser.add_argument(
        "--api_url",
        type=str,
        default=None,
        help="Optional backend URL; sends event metadata only"
    )
    parser.add_argument(
        "--api-token",
        type=str,
        default=None,
        help="Bearer token for the backend metadata endpoint"
    )
    parser.add_argument(
        "--allow-recording",
        action="store_true",
        help="Explicitly allow saving annotated camera frames"
    )
    
    args = parser.parse_args()
    
    pipeline = GuardianMeshPipeline(
        camera_id=args.camera_id,
        alert_threshold=args.alert_threshold,
        visualize=not args.no_viz,
        output_path=args.output,
        api_url=args.api_url,
        api_token=args.api_token,
        allow_recording=args.allow_recording,
    )
    
    try:
        pipeline.run(args.source, max_frames=args.max_frames)
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(0)
 
 
if __name__ == "__main__":
    main()
 