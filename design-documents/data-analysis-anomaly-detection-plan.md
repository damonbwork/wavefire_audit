# Data Analysis Module — Anomaly Detection (continued design)

## Purpose of this document

A memory-reconstructed design doc (`~/Downloads/data-analysis-anomaly-
detection-design.md`) was produced from stored project facts plus an
unrelated prior conversation about Isolation Forest, because no design
doc for this module existed in this repo yet. That reconstruction
**significantly undersold how much of this module is already built** —
it described the Python/scikit-learn architecture as future work and
found "nothing" on UI/UX or a Fraud Indicator folder. Reading the actual
code in `public/index.html` and `server.js` shows a materially more
complete picture. This document **corrects the record** against the
real code, then continues the design into the genuine gaps that remain.

## Objectives (per explicit direction)

These are the stated goals for the module, distinct from — and in one
case, going beyond — what's built today:

1. **Analyze any two-dimensional dataset for potential outliers.** The
   input is generically tabular (rows × columns), not assumed to be any
   specific transaction type ahead of time — matches how the module is
   already built (any uploaded file, any columns the user picks), so
   this objective is already satisfied structurally; it's stated here
   to anchor the objectives that follow against it.
2. **Wavefire selects the model(s), not the user.** Today's UI requires
   the auditor to manually check which of the nine methods to run and
   hand-pick feature columns/parameters for each. This objective is a
   **real, new capability**, not something the current build does:
   Wavefire itself should determine which method(s) best fit a given
   dataset and objective. This is addressed as **Gap 5** below, since
   it's a distinct, previously-unidentified gap from the four already
   documented.
3. **Model selection depends on whether the user provides training
   signal.** Concretely: if the user has (or will) label some rows as
   confirmed outliers, that changes which approach is appropriate —
   a **supervised or semi-supervised** posture (learn from labeled
   examples, per Gap 2's labeling system) becomes viable, versus a
   purely **unsupervised** posture (Isolation Forest/Mahalanobis/LOF as
   built today, with no ground truth) when no labels exist yet. This
   directly connects Gap 5 (model selection) to Gap 2 (the supervised
   training loop) — they are not independent problems; Gap 5's decision
   logic needs Gap 2 to actually exist as an option it can choose.
4. **Distinguish valid vs. invalid outliers, not just "outlier or
   not."** A row can be numerically anomalous yet perfectly legitimate
   (a real, large, one-off transaction), or anomalous *and* actually
   wrong. The existing binary `anomaly`/`normal` label (Gap 2) captures
   only "is this worth a human's attention," not this finer distinction
   — see Gap 6 below for why this needs its own, separate label
   dimension rather than overloading the existing one.
5. **The end goal is actionable findings, not scores.** A flagged
   transaction should ultimately be describable by *characteristics*
   that explain why it needs correction or management attention (a
   miscoded PO, a potential fraudulent transaction) — a raw anomaly
   score or percentile is not, by itself, an audit finding. This is the
   natural convergence point with **Gap 1** (pushing results into a
   workpaper's Exceptions/Findings grid): the "reason" text an Exception
   needs is exactly the human-readable characteristic description this
   objective calls for, not just "flagged by Isolation Forest, score
   -0.17."

## What actually exists today (confirmed by reading the code)

The Data Analysis module is a standalone tab (`activateDataAnalysis()`,
`public/index.html:13774`) — a user uploads a data file, checks one or
more detection methods across three folders, and runs them. All nine
methods described below are fully built, configurable, and wired to a
shared results renderer (`_daResults`), not placeholders:

### Folder 1 — Statistical Outlier Detection
- **Statistical Outliers** — Z-score or IQR on one numeric column,
  configurable threshold.
- **Duplicate Detection** — exact/near-duplicate rows across one or
  more selected key columns.
- **Date Anomalies** — weekend transactions, future dates, and
  statistical date outliers on a selected date column.

### Folder 2 — Multivariate / ML Detection
- **Isolation Forest**, **Mahalanobis Distance**, **Local Outlier
  Factor (LOF)** — each with its own feature-column picker and
  method-specific parameters (contamination/trees, percentile
  threshold, k-neighbors/threshold respectively).
- **The Python migration is already architected, not just planned.**
  Each of the three ML methods first calls `_daCallMLService()`
  (`public/index.html:14958`), which POSTs to `/api/ml/unsupervised`.
  That Node route (`server.js:8059`) proxies to an external
  `ML_SERVICE_URL` (a Python/scikit-learn microservice), injecting a
  server-side-only `ML_SERVICE_TOKEN` so the shared secret never
  reaches the browser. **When `ML_SERVICE_URL`/`ML_SERVICE_TOKEN` are
  unset, every ML method silently falls back to an in-browser
  JavaScript re-implementation** of the same algorithm (`_daIF_*`,
  the Mahalanobis JS block, the LOF JS block) — the UI even shows a
  live "JS engine" vs. Python-service badge
  (`da-ml-engine-badge`, driven by `/api/ml/status`,
  `server.js:8055`). **The originally-assumed "JS now, Python later"
  framing is wrong** — it's "Python when configured, JS as a graceful
  fallback," and the fallback already exists in production-quality
  form (row-count caps included — see `DA_LOF_MAX_ROWS`).
- A `/api/ml/train` proxy route also already exists (`server.js:8077`),
  same token-injection pattern — this is the wiring for **supervised**
  training, addressed under Gaps below.

### Folder 3 — Fraud Indicator Tests
- **Benford's Law** — leading-digit distribution test on a numeric
  column, configurable significance level.
- **Round Number Test** — flags values divisible by a configurable
  threshold ($1/$10/$100/$1,000/$5,000).
- **Sequence Gap Analysis** — missing values in a sequential column
  (invoice/check/PO numbers).

So: the original doc's "nothing found addresses the Fraud Indicator
folder" was simply an artifact of that content living only in code that
memory search doesn't reach — it is fully designed and built, and its
three methods (Benford's, rounding, gaps) are a coherent, standard
forensic-accounting toolkit, not an empty folder.

### A labeling/training-data system already exists, feeding a not-yet-
### built supervised loop
- Every uploaded dataset is registered server-side
  (`_daRegisterDataset`, `public/index.html:14518`) by content hash,
  so re-uploading the same file restores prior work rather than
  starting over.
- A per-row **anomaly / normal** label can be set and is persisted
  server-side (`_daPersistLabel`, `public/index.html:15709`,
  `_daLabels`), restored automatically on re-upload
  (`_daRestoreLabelsFromServer`).
- Labels are explicitly scoped to the three ML methods
  (`ML_LABELING_METHODS = ['Isolation Forest', 'Mahalanobis Distance',
  'Local Outlier Factor']`, `public/index.html:15280`) — Benford's/
  gap-analysis results don't have a "the single row" concept to label
  against, which the code itself notes.
- **What's missing**: no UI trigger was found that actually calls
  `/api/ml/train` with the accumulated labels — the proxy route exists
  server-side, and the labels are being collected and persisted, but
  nothing in the client currently closes the loop by requesting a
  trained model or applying one. This is a real, identifiable gap, not
  a matter of searching harder — see Gap 2 below.

### Output today: export only, not integrated with a workpaper
- Results can be exported as CSV or XLSX (`daExportCSV`/`daExportXLSX`,
  `public/index.html:15853, 15867`) — that's the only output path.
- **The Data Analysis tab is not connected to any workpaper, audit,
  Exception, or Attribute in this app.** It's a general-purpose
  standalone analysis tool a user runs against any file they upload,
  with no `ref`/workpaper context and no path from a flagged row into
  the Exceptions/Findings/Recommendations grid used everywhere else in
  the app. This is the single biggest structural gap relative to how
  the rest of Wavefire works, and is the main thing worth deciding next
  — see Gap 1.

## What the June 13 prior conversation actually contributes

Re-reading it against the above: its technical content (Isolation
Forest via scikit-learn, feature engineering like day-of-week to catch
context-relative anomalies, z-score vs. Isolation Forest trade-offs) is
a reasonable **validation** that the already-built Isolation Forest
method's design direction is sound, but it describes a **generic,
unrelated MCP-tool exercise** (a standalone Claude Code tool for ad hoc
PO-data analysis), not Wavefire's own architecture — Wavefire's actual
implementation is a full in-app UI with nine methods across three
folders, a Python-proxy-with-JS-fallback architecture, and a labeling/
training pipeline, all considerably more developed than that
conversation's scope. Its one genuinely transferable idea, already
implicitly honored by the existing UI (which lets a user pick *any*
feature columns per method) is: **flag a value as anomalous relative to
its own category/time-period/preparer, not just the raw global
distribution** — worth keeping in mind as a design principle for
Gap 3 (feature engineering) below, but not a missing piece of
architecture.

## Real, confirmed gaps — this is where "continuing the design" matters

### Gap 1 — No connection to a workpaper (the biggest one)

Every other analytical capability in Wavefire (Analyze, overrides,
Exceptions) is workpaper-centric; Data Analysis today is an island. Two
real directions, not mutually exclusive:

- **1a. Feed Data Analysis output INTO a workpaper.** A flagged row (or
  a whole method's flag set) becomes a candidate Exception/Finding on a
  workpaper the user picks — reusing the exact same "type-choice + push
  into `wpExceptions[ref]`" mechanism already built for the Exceptions
  grid (`addGridItem`, per the classification-steering design), with
  `linkedFiles` pointing at the uploaded dataset and the flagged row's
  own key fields recorded in the Exception's description. This turns
  Data Analysis from a side tool into a genuine sourcing mechanism for
  audit findings.
- **1b. A Data-Analysis-flavored attribute/test**, where an attribute's
  "test" IS one of these nine methods run against the workpaper's own
  Sample Data or (per the separately-designed Continuous Auditing plan,
  see [continuous-auditing-plan.md](continuous-auditing-plan.md)) a CA
  Data Source — closing the loop the CA design already gestures at
  ("engineering context-aware features... directly transferable to
  auditing use cases") but never concretely specified. This is a
  bigger lift (it means the Testwork Grid needs to know how to render
  "Isolation Forest flagged this row" as a pass/fail-shaped result) but
  is the more architecturally coherent long-term answer, since it makes
  anomaly detection just another attribute-testing method rather than
  a separate, disconnected tool.
- **Recommendation**: build 1a first — it's a much smaller, additive
  change (one new "Send flagged rows to a workpaper" action on the
  existing results screen) that delivers real value immediately without
  touching the Testwork Grid/attribute model at all. Treat 1b as a
  larger, separately-scoped follow-up once there's real usage data on
  which of the nine methods auditors actually reach for on real
  workpapers.

### Gap 2 — The supervised training loop is half-built

The labeling UI, dataset registration, and `/api/ml/train` proxy all
exist; nothing calls the third piece. Concretely missing:
- A **"Train model"** action, gated on having enough labels (e.g. a
  minimum count of both `anomaly` and `normal` labels — the code
  already tracks `reviewedInQueue`/label counts for its own queue UI,
  `public/index.html:15669`, so the data needed to gate this already
  exists) that calls `/api/ml/train` with the accumulated labeled rows.
- A decision on **where a trained model lives and how it's later
  applied**: per-dataset (unlikely to generalize — a trained model on
  one file's specific columns/scale isn't obviously reusable against a
  different file), per-tenant (more plausible — "this tenant's AP data
  tends to look like X"), or not persisted at all, with training only
  ever informing threshold/contamination tuning for that same session's
  run rather than producing a reusable artifact. **This is a genuine
  open design question**, not something the code answers implicitly —
  worth a direct decision before building the "Train model" button,
  since it changes what the button actually does.
- If a trained model IS meant to be reusable, a versioning/staleness
  story is needed (does a new label invalidate the last trained model?
  is there a "last trained: <date>, on N labels" indicator?) — mirrors
  the same "don't silently go stale" principle already applied
  elsewhere in this app (e.g. the override-sync design's insistence on
  never silently reverting to an AI's original answer).

### Gap 3 — Feature engineering is entirely manual today

Every ML method requires the user to hand-pick feature columns; there's
no assistance suggesting *which* columns or *derived* features (e.g.
day-of-week, amount-as-%-of-category-median, time-since-last-
transaction-by-same-preparer) might make a given dataset's anomalies
more detectable — exactly the pattern the June 13 conversation's
worked example demonstrated manually. Two options, not mutually
exclusive:
- **Manual-only, permanently** — keep it exactly as-is; auditors doing
  real forensic work often want full control over exactly what's being
  compared, and an opaque "we picked features for you" step could
  reduce trust in results used as audit evidence. This is a legitimate,
  defensible choice, not just "not built yet."
  - **Assisted suggestions** — a lightweight helper (could reuse the
  app's existing AI/Claude integration) that, given the uploaded
  dataset's column names/types, suggests likely-useful derived features
  or flags "these two columns are highly correlated, consider
  Mahalanobis over raw Isolation Forest on both" — genuinely useful,
  but explicitly an assistive suggestion the auditor accepts or
  rejects, never an automatic, invisible transformation applied to
  results presented as findings.
- **Recommendation**: no urgency here — flag as a real, legitimate
  future enhancement once Gap 1 (workpaper integration) proves out real
  usage, rather than investing in this before anyone's actually running
  these methods against real audit data through a connected workflow.

### Gap 4 — Python service operational story is undesigned

`ML_SERVICE_CONFIGURED` being false is treated gracefully client-side
(automatic JS fallback, visible engine badge) — that part is solid.
What's not designed: how/where the actual Python FastAPI/scikit-learn
service is deployed, scaled, and secured in production (a second
Railway service? a separate container? who owns its uptime?), and
what "training" means operationally if Gap 2 is built (does the Python
service persist trained models across requests, and if so, where —
its own disk, which Railway may not durably persist across
redeploys, or a shared store Wavefire's own Postgres could hold
instead). This is infrastructure/ops design, out of scope for this
document to resolve, but flagged explicitly since Gap 2 can't be fully
specified without it.

### Gap 5 — Automatic model selection (new, per explicit objective)

Today the auditor manually checks methods and picks columns/parameters
per method — there is no logic anywhere that inspects a dataset and
recommends or auto-runs an appropriate method. Per the stated
objective, Wavefire itself should decide. A concrete, buildable
decision procedure, staged by what's actually knowable about the
dataset and the user's intent:

1. **Has the user provided (or started providing) outlier labels for
   this dataset?** (Gap 2's `_daLabels`, already tracked per dataset.)
   - **No labels yet** → **unsupervised** posture: run the existing
     Multivariate/ML methods (Isolation Forest as the default
     general-purpose choice, per both this module's own existing UI
     ordering and the June 13 conversation's own recommendation),
     alongside the Statistical and Fraud Indicator methods that apply
     to whichever columns are present (e.g. only offer Benford's/
     rounding on true numeric amount columns, gap analysis only on a
     column that looks sequential/ID-like). This requires a **column-
     type/shape classifier** as a real, new small piece of logic: given
     the uploaded dataset's columns, infer which are amount-like,
     date-like, sequence-like, or categorical, and use that to decide
     which methods are even applicable — not asking the user to
     manually determine "is this column suitable for Benford's" as
     today's UI implicitly requires them to.
   - **Some labels exist, but too few for reliable supervised
     learning** (a minimum-count threshold, consistent with Gap 2's own
     gating idea) → stay unsupervised for now, but use the available
     labels to auto-tune the unsupervised methods' own parameters
     (e.g. calibrate Isolation Forest's `contamination` to roughly
     match the observed labeled-anomaly rate, rather than leaving it at
     a generic default) — a real, useful middle ground between "no
     signal used at all" and "full supervised model."
   - **Enough labels exist** → **supervised/semi-supervised** posture
     becomes viable: train a classifier (this is what Gap 2's
     `/api/ml/train` is for) using the labeled rows as ground truth,
     and prefer its output over the purely unsupervised methods for
     future runs against similar data. This is where Gap 2 and Gap 5
     converge into one mechanism rather than two.
2. **Multiple applicable methods can, and often should, run together**
   rather than the system picking exactly one — e.g. Isolation Forest
   AND Benford's AND rounding can all legitimately apply to the same
   AP dataset simultaneously, flagging different things for different
   reasons. "Wavefire selects the model(s)" should be read as
   **recommending/pre-selecting a sensible default set** (with the
   auditor still able to see what was chosen and adjust, not a fully
   opaque black box), not as replacing the multi-method UI with a
   single forced choice — a single auto-picked method would actually
   be a regression from what's already built, since today's UI already
   lets an auditor combine methods deliberately.
3. **Recommendation**: build the column-type classifier and the
   "recommend a default method+column selection, pre-checked but fully
   editable" behavior first (a much smaller, purely-heuristic addition
   with no dependency on Gap 2/4's harder training/deployment
   questions), and treat the labeled-data-driven parameter tuning and
   full supervised-model paths as the natural follow-on once Gap 2's
   own open questions (model scope/persistence) are settled.

### Gap 6 — "Valid" vs. "invalid" outlier is a second label dimension,
### not the same as anomaly/normal

Per the stated objective, the real question an auditor cares about
isn't only "is this row statistically unusual" (today's `anomaly`/
`normal` label) but "is this unusual row actually WRONG" — a
legitimately large, real transaction is a valid outlier (correctly
flagged as unusual, but not an error); a miscoded PO or a fabricated
entry is an invalid outlier (unusual AND wrong). Collapsing these into
one label would lose exactly the distinction the objective asks for.
Concrete design:
- Extend labeling to a **second, independent dimension**, applied only
  to rows already labeled `anomaly` (a row that isn't even flagged as
  unusual has nothing to validate): `valid` (a real but legitimate
  outlier — no action needed beyond having noticed it) or `invalid`
  (a genuine error/fraud indicator warranting the correction/management-
  attention path described in the objective) — stored as a second field
  alongside the existing label, not overloading the existing
  `anomaly`/`normal` value.
- This is also the natural bridge to **Gap 1**: only `invalid`-labeled
  rows are realistic candidates for automatically becoming an Exception/
  Finding when pushed to a workpaper; `valid` outliers are audit-trail-
  worthy context (worth keeping visible, per the labeling system's own
  existing persistence) but shouldn't silently spawn a formal Exception
  just for being numerically unusual.
- A trained model (Gap 2/5) should ultimately be trained toward
  predicting `invalid` specifically, not merely `anomaly` — training
  only on the coarser anomaly/normal split would produce a model that
  finds "unusual" rows well but can't distinguish a valid business
  outlier from a genuine problem, which is the actual objective stated
  here. This has to be a deliberate decision in `/api/ml/train`'s own
  design, not an afterthought bolted on once that endpoint's contract
  is already fixed.

## Open questions worth a direct decision (not answered by any source found)

- Should Gap 1a's "send to workpaper" require the dataset to already be
  associated with a specific audit/workpaper before running Data
  Analysis at all, or should it stay upload-anything-anytime with the
  workpaper choice deferred to the point of pushing a result? The
  latter preserves today's flexible standalone-tool feel; the former
  makes the eventual Exception's provenance (which workpaper's scope
  did this belong to) unambiguous from the start. Recommend the latter
  (defer workpaper choice to push-time) to avoid forcing every casual
  exploratory analysis into a workpaper it may never need one.
- For Gap 2, is a trained model meant to detect the SAME kind of
  anomaly across different datasets of the same type (e.g. "AP invoice
  data" in general), or is training scoped narrowly to "help me tune
  today's specific file's contamination/threshold better"? This
  materially changes the data model (Gap 2's per-tenant-vs-ephemeral
  question) and should be settled before `/api/ml/train`'s actual
  payload/response contract is finalized.
- Should Fraud Indicator results (Benford's, rounding, gaps) ever
  become labelable/trainable the same way ML results are, or do they
  stay purely rule-based/deterministic forever (as forensic tests
  conventionally are)? The existing code's own `ML_LABELING_METHODS`
  scoping suggests "no" was already an implicit design choice — worth
  confirming that's intentional rather than an oversight.

## Recommended next step

Given the above, the highest-leverage next build (not yet started) is
**Gap 1a**: a "Send flagged rows to a workpaper" action on the Data
Analysis results screen, reusing the existing Exception-creation
mechanism. It's additive, doesn't touch the Testwork Grid/attribute
model, and is the one gap that actually changes whether this module's
real output reaches an audit file today — which mirrors this session's
running theme (page-header separator through workpaper review lock) of
building small, additive, well-verified increments onto an existing
mechanism rather than large speculative new subsystems.

Immediately behind it, in order, given the newly-stated objectives:
Gap 6's `valid`/`invalid` second label dimension (small, additive,
and a prerequisite for Gap 1a's own "only push genuine problems"
judgment call to be meaningful rather than pushing every numerically
unusual row), then Gap 5's column-type classifier and default-method
recommendation (bigger, but still independent of Gap 2/4's harder
open questions), with full supervised training (Gap 2 proper) last,
since it depends on both Gap 5's and Gap 4's open questions being
settled first.
