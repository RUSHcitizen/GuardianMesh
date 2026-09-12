from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class ScoreRequest(BaseModel):
    camera_id: str
    fall_score: float
    immobility_score: float
    tracking_confidence: float
    persistence_seconds: float

@app.get('/health')
def health():
    return {'status': 'ok'}

@app.post('/score')
def score(req: ScoreRequest):
    confidence = round(0.45*req.fall_score + 0.35*req.immobility_score + 0.20*req.tracking_confidence, 3)
    if req.fall_score >= 0.75 and req.immobility_score >= 0.70 and req.tracking_confidence >= 0.70 and req.persistence_seconds >= 5:
        state = 'DISTRESS_EVENT'
        reason = 'High fall signal with sustained immobility'
    elif req.fall_score >= 0.75 and req.immobility_score >= 0.65:
        state = 'VERIFYING'
        reason = 'Possible fall with immobility under verification'
    elif req.fall_score >= 0.75:
        state = 'POSSIBLE_FALL'
        reason = 'Fall signal detected'
    else:
        state = 'NORMAL'
        reason = 'No significant distress pattern detected'
    return {'state': state, 'overall_confidence': confidence, 'reason': reason}
