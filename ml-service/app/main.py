"""
WaveFire Audit — Anomaly Detection ML Service
===============================================
A standalone FastAPI service exposing scikit-learn implementations of the
multivariate/ML anomaly detection methods (Isolation Forest, Mahalanobis
distance via EllipticEnvelope, Local Outlier Factor) plus supervised binary
classification once an auditor has labeled rows.

This is the "Option B" engine referenced in the main app: the JS-only
implementations in auditflow_artifact.html are the fallback/offline engine;
when ML_SERVICE_URL is configured, the client calls here instead for
production-grade results (real Random Forest / Gradient Boosting, proper
cross-validation, no browser dataset-size ceiling).

Deploy as a second Railway service. Set ML_SERVICE_URL in the Node app's
environment to this service's public URL once deployed.

No data is persisted here — every request is stateless. The Node/Postgres
app remains the system of record for datasets, labels, and column metadata.
"""

import os
import logging
from typing import Literal, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from sklearn.ensemble import (
    IsolationForest,
    RandomForestClassifier,
    GradientBoostingClassifier,
)
from sklearn.covariance import EllipticEnvelope, MinCovDet
from sklearn.neighbors import LocalOutlierFactor
from sklearn.linear_model import LogisticRegression
from sklearn.svm import OneClassSVM
from sklearn.model_selection import train_test_split
from sklearn.metrics import precision_score, recall_score, f1_score, roc_auc_score
from sklearn.preprocessing import StandardScaler

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("wavefire-ml")

app = FastAPI(title="WaveFire Anomaly Detection ML Service", version="1.0.0")

# CORS: restrict to the Node app's origin(s). Comma-separated in the env var.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],  # permissive default for local dev only
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
    allow_credentials=False,
)

# Simple shared-secret auth: the Node backend is the only caller. Without this,
# anyone who discovers the service URL could run arbitrary training jobs.
ML_SERVICE_TOKEN = os.environ.get("ML_SERVICE_TOKEN", "")


def _check_auth(token: Optional[str]):
    if not ML_SERVICE_TOKEN:
        # Fail closed: refuse to run unauthenticated in any environment where
        # the operator forgot to set a token, rather than silently allowing
        # open access.
        raise HTTPException(status_code=503, detail="ML_SERVICE_TOKEN not configured on server")
    if token != ML_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing service token")


# ── Request/response models ────────────────────────────────────────────────────

class UnsupervisedRequest(BaseModel):
    token: str
    method: Literal["isolation_forest", "mahalanobis", "lof"]
    features: list[list[float]] = Field(..., description="n_rows x n_features numeric matrix, already numeric-encoded")
    row_ids: list[int] = Field(..., description="original dataset row indices, parallel to `features`")
    params: dict = Field(default_factory=dict)

    @field_validator("features")
    @classmethod
    def _non_empty(cls, v):
        if not v or len(v) < 10:
            raise ValueError("At least 10 rows are required")
        width = len(v[0])
        if width < 2:
            raise ValueError("At least 2 features are required")
        if any(len(row) != width for row in v):
            raise ValueError("All feature rows must have the same length")
        return v


class UnsupervisedResponse(BaseModel):
    method: str
    scores: list[float]          # raw model score, higher = more anomalous (normalized per-method below)
    percentile_rank: list[float] # 0-1 rank within this result set, for consistent UI slider behavior
    row_ids: list[int]
    flagged_row_ids: list[int]
    params_used: dict
    engine: str = "python-sklearn"


class TrainRequest(BaseModel):
    token: str
    features: list[list[float]]
    row_ids: list[int]
    labels: dict[int, Literal["anomaly", "normal"]] = Field(
        ..., description="row_id -> label, for the labeled subset only"
    )
    model_hint: Optional[Literal["logistic", "random_forest", "gradient_boosting", "one_class_svm"]] = None

    @field_validator("labels")
    @classmethod
    def _both_classes(cls, v):
        if len(v) < 10:
            raise ValueError("At least 10 labels are required to train")
        classes = set(v.values())
        if "anomaly" not in classes and len(v) >= 10:
            # one-class SVM path is allowed with zero confirmed-normal labels,
            # but at minimum we need some anomaly examples to be useful
            pass
        return v


class TrainResponse(BaseModel):
    model_type: str
    reasoning: str
    n_labels: int
    n_anomaly: int
    n_normal: int
    class_imbalance_ratio: Optional[float]
    held_out_metrics: Optional[dict]
    feature_importance: Optional[list[float]]
    model_id: str  # opaque token the client stores; identical params + labels reproduce results
    scores_all: list[float]         # P(anomaly) for every row in `features`
    percentile_rank_all: list[float]
    row_ids: list[int]


# ── Unsupervised endpoint ───────────────────────────────────────────────────────

def _percentile_ranks(scores: np.ndarray) -> np.ndarray:
    """Convert raw scores to 0-1 percentile rank, for a UI slider that behaves
    consistently regardless of a method's native score scale."""
    order = np.argsort(scores)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(len(scores)) / max(len(scores) - 1, 1)
    return ranks


@app.post("/api/ml/unsupervised", response_model=UnsupervisedResponse)
def run_unsupervised(req: UnsupervisedRequest):
    _check_auth(req.token)
    X = np.array(req.features, dtype=float)
    n, d = X.shape

    # Standardize features — consistent with the JS engine's z-score normalization,
    # so results are comparable regardless of which engine ran.
    X = StandardScaler().fit_transform(X)

    try:
        if req.method == "isolation_forest":
            contamination = float(req.params.get("contamination", 0.05))
            n_estimators = int(req.params.get("n_estimators", 100))
            contamination = min(max(contamination, 0.001), 0.5)
            model = IsolationForest(
                n_estimators=n_estimators,
                contamination=contamination,
                random_state=42,
            )
            model.fit(X)
            # decision_function: higher = more normal. Flip sign so higher = more anomalous,
            # matching the JS engine's convention.
            raw_scores = -model.decision_function(X)
            flagged_mask = model.predict(X) == -1
            params_used = {"contamination": contamination, "n_estimators": n_estimators}

        elif req.method == "mahalanobis":
            pct = float(req.params.get("percentile", 0.975))
            # MinCovDet gives a robust covariance estimate, which avoids the
            # "masking effect" the JS engine's classical estimator is subject to
            # (an extreme outlier inflating the very covariance used to score it).
            try:
                mcd = MinCovDet(random_state=42).fit(X)
                raw_scores = np.sqrt(mcd.mahalanobis(X))
            except Exception as e:
                log.warning(f"MinCovDet failed ({e}), falling back to EllipticEnvelope")
                ee = EllipticEnvelope(contamination=min(1 - pct, 0.5), random_state=42).fit(X)
                raw_scores = np.sqrt(ee.mahalanobis(X))
            cutoff = np.quantile(raw_scores, pct)
            flagged_mask = raw_scores > cutoff
            params_used = {"percentile": pct}

        elif req.method == "lof":
            k = int(req.params.get("n_neighbors", 20))
            k = min(max(k, 2), n - 1)
            lof = LocalOutlierFactor(n_neighbors=k, novelty=False)
            labels = lof.fit_predict(X)  # -1 = outlier
            raw_scores = -lof.negative_outlier_factor_  # higher = more anomalous
            flagged_mask = labels == -1
            params_used = {"n_neighbors": k}

        else:
            raise HTTPException(status_code=400, detail=f"Unknown method: {req.method}")

    except HTTPException:
        raise
    except Exception as e:
        log.exception("Unsupervised scoring failed")
        raise HTTPException(status_code=500, detail="Model failed to fit — check feature matrix for degenerate columns (zero variance, all-identical values)")

    pct_rank = _percentile_ranks(raw_scores)
    flagged_ids = [rid for rid, flag in zip(req.row_ids, flagged_mask) if flag]

    return UnsupervisedResponse(
        method=req.method,
        scores=raw_scores.tolist(),
        percentile_rank=pct_rank.tolist(),
        row_ids=req.row_ids,
        flagged_row_ids=flagged_ids,
        params_used=params_used,
    )


# ── Supervised training endpoint ────────────────────────────────────────────────

def _suggest_model(n_labels: int, n_anomaly: int, model_hint: Optional[str]) -> tuple[str, str]:
    if model_hint:
        return model_hint, "Model explicitly requested by client."
    if n_anomaly < 5:
        return "one_class_svm", (
            f"Only {n_anomaly} confirmed anomaly label(s) — too few to train a reliable "
            "two-class model. Training on normal examples only instead."
        )
    if n_labels < 30:
        return "logistic", (
            f"{n_labels} total labels is a small sample. Logistic regression is interpretable "
            "and reasonably stable at this scale."
        )
    if n_labels < 100:
        return "random_forest", (
            f"{n_labels} labels is enough for Random Forest, which handles nonlinear feature "
            "relationships and provides feature importance."
        )
    return "gradient_boosting", (
        f"{n_labels} labels supports Gradient Boosting, typically the best-performing option "
        "at this scale."
    )


@app.post("/api/ml/train", response_model=TrainResponse)
def train_supervised(req: TrainRequest):
    _check_auth(req.token)
    X_all = np.array(req.features, dtype=float)
    row_id_to_idx = {rid: i for i, rid in enumerate(req.row_ids)}

    labeled_idx, y = [], []
    for rid, label in req.labels.items():
        if rid not in row_id_to_idx:
            continue  # label refers to a row not in this feature matrix — skip rather than fail the whole request
        labeled_idx.append(row_id_to_idx[rid])
        y.append(1 if label == "anomaly" else 0)

    if len(labeled_idx) < 10:
        raise HTTPException(status_code=400, detail="At least 10 valid labels (matching provided row_ids) are required")

    y = np.array(y)
    n_anomaly = int(y.sum())
    n_normal = int(len(y) - n_anomaly)
    imbalance_ratio = (max(n_anomaly, n_normal) / max(min(n_anomaly, n_normal), 1)) if min(n_anomaly, n_normal) > 0 else None

    scaler = StandardScaler().fit(X_all)
    X_all_scaled = scaler.transform(X_all)
    X_labeled = X_all_scaled[labeled_idx]

    model_type, reasoning = _suggest_model(len(y), n_anomaly, req.model_hint)

    held_out_metrics = None
    feature_importance = None

    try:
        if model_type == "one_class_svm":
            # Train on normal-labeled rows only; score everything.
            normal_rows = X_labeled[y == 0]
            if len(normal_rows) < 5:
                raise HTTPException(status_code=400, detail="One-Class SVM requires at least 5 confirmed-normal labels")
            model = OneClassSVM(nu=0.1, kernel="rbf", gamma="scale").fit(normal_rows)
            raw_scores_all = -model.decision_function(X_all_scaled)  # higher = more anomalous
            probs_all = 1 / (1 + np.exp(-raw_scores_all))  # logistic squashing for a pseudo-probability, NOT calibrated

        else:
            # Stratify only if both classes present and each has 2+ examples
            can_stratify = n_anomaly >= 2 and n_normal >= 2
            X_train, X_test, y_train, y_test = train_test_split(
                X_labeled, y, test_size=0.25, random_state=42,
                stratify=y if can_stratify else None,
            )
            class_weight = "balanced"

            if model_type == "logistic":
                model = LogisticRegression(class_weight=class_weight, max_iter=1000, random_state=42)
            elif model_type == "random_forest":
                model = RandomForestClassifier(
                    n_estimators=200, class_weight=class_weight, random_state=42, max_depth=8
                )
            else:  # gradient_boosting
                # GradientBoostingClassifier has no class_weight param — use sample_weight instead
                sw = np.where(y_train == 1, n_normal / max(n_anomaly, 1), 1.0)
                model = GradientBoostingClassifier(n_estimators=150, random_state=42)

            if model_type == "gradient_boosting":
                model.fit(X_train, y_train, sample_weight=sw)
            else:
                model.fit(X_train, y_train)

            if len(np.unique(y_test)) > 1:
                y_pred = model.predict(X_test)
                y_proba = model.predict_proba(X_test)[:, 1]
                held_out_metrics = {
                    "precision": float(precision_score(y_test, y_pred, zero_division=0)),
                    "recall": float(recall_score(y_test, y_pred, zero_division=0)),
                    "f1": float(f1_score(y_test, y_pred, zero_division=0)),
                    "roc_auc": float(roc_auc_score(y_test, y_proba)) if len(np.unique(y_test)) > 1 else None,
                    "n_test": int(len(y_test)),
                    "note": "Computed on a 25% held-out split of labeled rows only. With small label counts these estimates are noisy — treat as directional.",
                }

            if hasattr(model, "feature_importances_"):
                feature_importance = model.feature_importances_.tolist()
            elif hasattr(model, "coef_"):
                feature_importance = np.abs(model.coef_[0]).tolist()

            probs_all = model.predict_proba(X_all_scaled)[:, 1] if hasattr(model, "predict_proba") else model.decision_function(X_all_scaled)

    except HTTPException:
        raise
    except Exception as e:
        log.exception("Training failed")
        raise HTTPException(status_code=500, detail=f"Training failed: {e}")

    pct_rank = _percentile_ranks(probs_all)
    model_id = f"{model_type}-{len(y)}labels-{abs(hash(tuple(sorted(req.labels.items())))) % 100000}"

    return TrainResponse(
        model_type=model_type,
        reasoning=reasoning,
        n_labels=len(y),
        n_anomaly=n_anomaly,
        n_normal=n_normal,
        class_imbalance_ratio=imbalance_ratio,
        held_out_metrics=held_out_metrics,
        feature_importance=feature_importance,
        model_id=model_id,
        scores_all=probs_all.tolist(),
        percentile_rank_all=pct_rank.tolist(),
        row_ids=req.row_ids,
    )


@app.get("/health")
def health():
    return {"status": "ok", "auth_configured": bool(ML_SERVICE_TOKEN)}

