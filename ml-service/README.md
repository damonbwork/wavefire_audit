WaveFire Anomaly Detection ML Service
A standalone Python/FastAPI service providing scikit-learn implementations of
the Multivariate/ML Detection methods and supervised binary classification
for the WaveFire audit platform. This is the "Option B" engine — the Node
app's JS-only implementations remain as an offline/no-dependency fallback.
Why this is a separate service
The main app (`server.js`) runs on Node, and real Isolation Forest / robust
Mahalanobis / cross-validated Random Forest are meaningfully better as
scikit-learn calls than as hand-rolled JavaScript. Rather than rewrite the
whole backend in Python, this ships as a second Railway service that the
Node app calls over HTTP.
What's better here than the JS engine
Mahalanobis distance uses `MinCovDet` (a robust covariance estimator),
which avoids the "masking effect" — where a single extreme outlier
inflates the very covariance matrix used to score it, suppressing its own
distance. Verified in testing: the same fixture that produces a muted
3.0-vs-2.4 separation in the JS engine produces a clean 172-vs-4 separation
here.
Isolation Forest and LOF use scikit-learn's optimized, well-tested
implementations rather than a from-scratch port, and aren't subject to the
JS engine's 3,000-row LOF cap (O(n²) pairwise distances in the browser).
Supervised training adds Random Forest and Gradient Boosting with real
cross-validated precision/recall/F1, proper `class_weight='balanced'`
handling for imbalanced labels, and feature importance — none of which the
JS engine attempts.
API
All endpoints require a shared-secret `token` field matching the
`ML_SERVICE_TOKEN` environment variable. There is no per-user auth — this
service trusts the Node backend as its only caller.
`POST /api/ml/unsupervised`
```json
{
  "token": "...",
  "method": "isolation_forest | mahalanobis | lof",
  "features": [[1.2, 3.4], [2.1, 3.9], ...],
  "row_ids": [0, 1, 2, ...],
  "params": { "contamination": 0.05 }
}
```
Returns raw scores, a 0–1 percentile rank per row (for consistent slider
behavior regardless of which engine ran), and the row IDs the model itself
would flag at its default threshold.
`POST /api/ml/train`
```json
{
  "token": "...",
  "features": [[...], ...],
  "row_ids": [0, 1, 2, ...],
  "labels": { "14": "anomaly", "22": "normal", ... },
  "model_hint": null
}
```
Trains a binary classifier (auto-selected based on label count and class
balance unless `model_hint` is given), returns held-out precision/recall/F1
where possible, feature importance, and P(anomaly) for every row in
`features` — labeled and unlabeled alike.
`GET /health`
Liveness check. Also reports whether `ML_SERVICE_TOKEN` is configured.
Deploying to Railway
Create a new Railway service from this directory (`ml-service/`) as the
root — Railway will detect the `Dockerfile` automatically.
Set environment variables on the service:
`ML_SERVICE_TOKEN` — a random 32+ character secret. Required — the
service refuses all requests with a 503 if this is unset, rather than
silently running open.
`ALLOWED_ORIGINS` — comma-separated list. Since the Node app calls this
service server-to-server (not from the browser), this can usually be
left unset; CORS only matters if you ever call this API directly from
client-side code.
Once deployed, copy the service's public URL.
In the main Node app's Railway environment, set:
`ML_SERVICE_URL` — the URL from step 3
`ML_SERVICE_TOKEN` — the same secret from step 2
Redeploy the Node app. It will detect `ML_SERVICE_URL` is set and prefer
this service over the JS fallback for Isolation Forest, Mahalanobis, and
LOF, and will unlock Random Forest / Gradient Boosting as supervised
options.
Local development
```bash
cd ml-service
pip install -r requirements.txt
export ML_SERVICE_TOKEN=dev-local-secret
uvicorn app.main:app --reload --port 8000
```
Then point the Node app's `.env` at `ML_SERVICE_URL=http://localhost:8000`
and the same `ML_SERVICE_TOKEN`.
What is NOT stored here
This service is stateless — every request is a fresh model fit. No datasets,
labels, or trained models are persisted here. Postgres (via the Node app)
remains the system of record. This means every unsupervised call and every
training call re-fits from scratch, which is the correct tradeoff for audit
population sizes (hundreds to low tens-of-thousands of rows) — training
Random Forest on 500 labeled rows takes well under a second.
