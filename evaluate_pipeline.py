"""
GuardianMesh: Pipeline Evaluation & Benchmarking
Evaluate performance on labeled test dataset.
 
Dataset format:
{
  "video_file": "fall_01.mp4",
  "annotations": [
    {
      "frame": 0,
      "event_type": "normal",
      "fall_score_gt": 0.0,
      "immobility_score_gt": 0.0
    },
    ...
  ]
}
 
Usage:
    python evaluate_pipeline.py --dataset_dir labeled_videos/ --output results.json
"""
 
import json
import cv2
import numpy as np
import argparse
from pathlib import Path
from collections import defaultdict
from sklearn.metrics import (
    confusion_matrix, classification_report, roc_auc_score, roc_curve,
    precision_recall_curve, f1_score, accuracy_score
)
import matplotlib.pyplot as plt
 
try:
    from .event_classifier import RealtimeProcessor, EventType
except ImportError:  # run as a plain script from the repo root
    from event_classifier import RealtimeProcessor, EventType
 
 
class PipelineEvaluator:
    """
    Evaluate pipeline on labeled dataset.
    """
    
    def __init__(self, processor: RealtimeProcessor):
        self.processor = processor
        self.results = defaultdict(list)
    
    def evaluate_video(
        self,
        video_path: str,
        annotations: list,
        verbose: bool = True
    ) -> dict:
        """
        Evaluate on single video.
        
        Args:
            video_path: Path to video file
            annotations: List of per-frame ground truth labels
            verbose: Print progress
            
        Returns:
            Metrics dict for this video
        """
        
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"ERROR: Could not open {video_path}")
            return {}
        
        frame_idx = 0
        predictions = []
        ground_truth = []
        
        # Create lookup for annotations
        anno_by_frame = {a['frame']: a for a in annotations}
        
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            # OpenCV decodes BGR; the pose model expects RGB (same as live inference)
            detections = self.processor.process_frame(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            
            # Get ground truth for this frame
            if frame_idx in anno_by_frame:
                gt = anno_by_frame[frame_idx]
                
                # Take first detection (assumes single person)
                if detections:
                    pred = detections[0]
                    predictions.append({
                        'frame': frame_idx,
                        'event_type': pred.event_type.value,
                        'fall_score': pred.fall_score,
                        'immobility_score': pred.immobility_score,
                        'confidence': pred.overall_confidence,
                    })
                else:
                    predictions.append({
                        'frame': frame_idx,
                        'event_type': 'normal',
                        'fall_score': 0.0,
                        'immobility_score': 0.0,
                        'confidence': 0.9,
                    })
                
                ground_truth.append(gt)
            
            frame_idx += 1
        
        cap.release()
        
        if verbose:
            print(f"Video: {Path(video_path).name}")
            print(f"  Frames: {frame_idx}")
            print(f"  Annotated frames: {len(ground_truth)}")
        
        # Compute metrics
        metrics = self._compute_metrics(predictions, ground_truth)
        
        return {
            'video': Path(video_path).name,
            'frames': frame_idx,
            'annotations': len(ground_truth),
            'predictions': predictions,
            'ground_truth': ground_truth,
            'metrics': metrics
        }
    
    def _compute_metrics(self, predictions: list, ground_truth: list) -> dict:
        """
        Compute evaluation metrics.
        """
        if not predictions or not ground_truth:
            return {}
        
        # Extract scores
        pred_fall_scores = np.array([p['fall_score'] for p in predictions])
        pred_immobility_scores = np.array([p['immobility_score'] for p in predictions])
        pred_events = np.array([p['event_type'] for p in predictions])
        
        gt_fall_scores = np.array([g.get('fall_score_gt', 0.0) for g in ground_truth])
        gt_immobility_scores = np.array([g.get('immobility_score_gt', 0.0) for g in ground_truth])
        gt_events = np.array([g['event_type'] for g in ground_truth])
        
        # Classification metrics
        event_types = sorted(set(gt_events))
        
        # Map to binary (event vs normal)
        gt_binary = np.array([1 if e != 'normal' else 0 for e in gt_events])
        pred_binary = np.array([1 if e != 'normal' else 0 for e in pred_events])
        
        accuracy = accuracy_score(gt_binary, pred_binary)
        
        # Regression metrics for scores
        fall_mae = np.mean(np.abs(pred_fall_scores - gt_fall_scores))
        fall_rmse = np.sqrt(np.mean((pred_fall_scores - gt_fall_scores) ** 2))
        
        immobility_mae = np.mean(np.abs(pred_immobility_scores - gt_immobility_scores))
        immobility_rmse = np.sqrt(np.mean((pred_immobility_scores - gt_immobility_scores) ** 2))
        
        # Classification report
        try:
            f1 = f1_score(gt_binary, pred_binary, average='binary')
            precision = np.sum((pred_binary == 1) & (gt_binary == 1)) / max(np.sum(pred_binary == 1), 1)
            recall = np.sum((pred_binary == 1) & (gt_binary == 1)) / max(np.sum(gt_binary == 1), 1)
        except:
            f1 = precision = recall = 0.0
        
        # ROC-AUC for fall detection
        try:
            fall_auc = roc_auc_score(gt_binary, pred_fall_scores)
        except:
            fall_auc = 0.0
        
        return {
            'accuracy': float(accuracy),
            'fall_detection': {
                'mae': float(fall_mae),
                'rmse': float(fall_rmse),
                'auc': float(fall_auc),
            },
            'immobility_detection': {
                'mae': float(immobility_mae),
                'rmse': float(immobility_rmse),
            },
            'event_classification': {
                'f1': float(f1),
                'precision': float(precision),
                'recall': float(recall),
            }
        }
    
    def evaluate_dataset(
        self,
        dataset_dir: str,
        annotation_file: str = "annotations.json",
    ) -> dict:
        """
        Evaluate on entire dataset.
        """
        dataset_path = Path(dataset_dir)
        annotation_path = dataset_path / annotation_file
        
        if not annotation_path.exists():
            print(f"ERROR: Could not find {annotation_file}")
            return {}
        
        with open(annotation_path) as f:
            dataset_config = json.load(f)
        
        all_results = []
        aggregated_predictions = []
        aggregated_ground_truth = []
        
        for video_info in dataset_config.get('videos', []):
            video_file = dataset_path / video_info['video_file']
            
            if not video_file.exists():
                print(f"WARNING: Video not found: {video_file}")
                continue
            
            print(f"\nEvaluating: {video_file.name}")
            
            result = self.evaluate_video(
                str(video_file),
                video_info['annotations']
            )
            
            all_results.append(result)
            aggregated_predictions.extend(result.get('predictions', []))
            aggregated_ground_truth.extend(result.get('ground_truth', []))
        
        # Aggregate metrics
        aggregated_metrics = self._compute_metrics(
            aggregated_predictions,
            aggregated_ground_truth
        )
        
        return {
            'dataset': str(dataset_path),
            'num_videos': len(all_results),
            'num_frames': sum(r.get('frames', 0) for r in all_results),
            'num_annotations': sum(r.get('annotations', 0) for r in all_results),
            'videos': all_results,
            'aggregated_metrics': aggregated_metrics,
        }
 
 
def plot_roc_curves(predictions: list, ground_truth: list, output_path: str = "roc_curves.png"):
    """
    Plot ROC curves for fall detection.
    """
    pred_fall_scores = np.array([p['fall_score'] for p in predictions])
    gt_events = np.array([g['event_type'] for g in ground_truth])
    gt_binary = np.array([1 if e != 'normal' else 0 for e in gt_events])
    
    try:
        fpr, tpr, thresholds = roc_curve(gt_binary, pred_fall_scores)
        auc = roc_auc_score(gt_binary, pred_fall_scores)
        
        plt.figure(figsize=(8, 6))
        plt.plot(fpr, tpr, label=f'Fall Detection (AUC = {auc:.3f})')
        plt.plot([0, 1], [0, 1], 'k--', label='Random')
        plt.xlabel('False Positive Rate')
        plt.ylabel('True Positive Rate')
        plt.title('ROC Curve: Fall Detection')
        plt.legend()
        plt.grid(alpha=0.3)
        plt.savefig(output_path, dpi=100, bbox_inches='tight')
        print(f"✓ ROC curve saved: {output_path}")
    except Exception as e:
        print(f"Could not plot ROC curve: {e}")
 
 
def main():
    parser = argparse.ArgumentParser(description="Evaluate GuardianMesh Pipeline")
    parser.add_argument(
        "--dataset_dir",
        type=str,
        required=True,
        help="Path to dataset directory"
    )
    parser.add_argument(
        "--annotation_file",
        type=str,
        default="annotations.json",
        help="Annotation file name (default: annotations.json)"
    )
    parser.add_argument(
        "--alert_threshold",
        type=float,
        default=0.65,
        help="Alert threshold"
    )
    parser.add_argument(
        "--camera_id",
        type=str,
        default="eval_cam",
        help="Camera ID for logging"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="eval_results.json",
        help="Output results file"
    )
    parser.add_argument(
        "--plot_roc",
        action="store_true",
        help="Generate ROC curve plots"
    )
    
    args = parser.parse_args()
    
    # Initialize processor
    processor = RealtimeProcessor(
        camera_id=args.camera_id,
        alert_threshold=args.alert_threshold
    )
    
    # Run evaluation
    evaluator = PipelineEvaluator(processor)
    results = evaluator.evaluate_dataset(
        args.dataset_dir,
        args.annotation_file
    )
    if not results:
        raise SystemExit(1)
    
    # Print summary
    print(f"\n{'='*60}")
    print("EVALUATION SUMMARY")
    print(f"{'='*60}")
    print(f"Dataset: {args.dataset_dir}")
    print(f"Videos: {results['num_videos']}")
    print(f"Total Frames: {results['num_frames']}")
    print(f"Annotated Frames: {results['num_annotations']}")
    
    if results.get('aggregated_metrics'):
        metrics = results['aggregated_metrics']
        print(f"\nAccuracy: {metrics.get('accuracy', 0):.3f}")
        
        fall_metrics = metrics.get('fall_detection', {})
        print(f"\nFall Detection:")
        print(f"  MAE: {fall_metrics.get('mae', 0):.3f}")
        print(f"  RMSE: {fall_metrics.get('rmse', 0):.3f}")
        print(f"  AUC: {fall_metrics.get('auc', 0):.3f}")
        
        event_metrics = metrics.get('event_classification', {})
        print(f"\nEvent Classification:")
        print(f"  F1: {event_metrics.get('f1', 0):.3f}")
        print(f"  Precision: {event_metrics.get('precision', 0):.3f}")
        print(f"  Recall: {event_metrics.get('recall', 0):.3f}")
    
    # Save results
    with open(args.output, 'w') as f:
        # Serialize results (exclude raw frames)
        export_results = {
            **results,
            'videos': [
                {k: v for k, v in r.items() if k != 'predictions'}
                for r in results.get('videos', [])
            ]
        }
        json.dump(export_results, f, indent=2, default=str)
    
    print(f"\n✓ Results saved: {args.output}")
    
    # Plot ROC if requested
    if args.plot_roc:
        all_predictions = []
        all_gt = []
        for video_result in results.get('videos', []):
            all_predictions.extend(video_result.get('predictions', []))
            all_gt.extend(video_result.get('ground_truth', []))
        
        if all_predictions:
            plot_roc_curves(all_predictions, all_gt, "roc_curves.png")
 
 
if __name__ == "__main__":
    main()
 