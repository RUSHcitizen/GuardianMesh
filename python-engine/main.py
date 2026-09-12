from fastapi import FastAPI
from typing import Optional

from pydantic import BaseModel

app = FastAPI()

class ScoreRequest(BaseModel):
    # Same request shape as backend_server.py's /api/score
    camera_id: Optional[str] = None
    fall_score: float
    immobility_score: float
    tracking_confidence: float
    persistence_seconds: float = 0.0

@app.get('/health')
def health():
    return {'status': 'ok'}

@app.post('/score')
def score(req: ScoreRequest):
    confidence = round(0.45*req.fall_score + 0.35*req.immobility_score + 0.20*req.tracking_confidence, 3)
    if req.fall_score >= 0.75 and req.immobility_score >= 0.70 and req.tracking_confidence >= 0.70 and req.persistence_seconds >= 5:
        state = 'DISTRESS_EVENT'
        reason = 'Sustained stillness after unusual motion — camera focused on subject for review'
    elif req.fall_score >= 0.75 and req.immobility_score >= 0.65:
        state = 'VERIFYING'
        reason = 'Unusual motion detected — verifying with continued monitoring'
    elif req.fall_score >= 0.75:
        state = 'POSSIBLE_FALL'
        reason = 'Unusual motion detected — monitoring closely'
    else:
        state = 'NORMAL'
        reason = 'No unusual activity detected'
    return {'state': state, 'overall_confidence': confidence, 'reason': reason}
