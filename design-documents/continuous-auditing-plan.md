# Continuous Auditing / Continuous Monitoring — Design

## Context

Every workpaper in Wavefire today assumes a **point-in-time** test: a
fixed set of sample files is uploaded once, attributes are tested
against that static sample, and the result is a single Analyze run
producing one snapshot of pass/fail conclusions
(`_wpAnalysisResults[ref]`, the Testwork Grid). Continuous Auditing/
Continuous Monitoring (CA/CM) breaks that assumption in three ways at
once:

1. The "sample" isn't a fixed file the auditor uploads once — it's a
   **live or periodically-refreshed feed** from a source system the
   auditor doesn't control.
2. Analyze doesn't run once at the end of fieldwork — it runs
   **repeatedly**, on some cadence independent of when the underlying
   data actually changes.
3. The audience for a result isn't only the audit file — a CA result
   may need to reach the **control owner directly**, sometimes without
   an auditor in the loop at all.

This document proposes how Wavefire supports CA/CM as a distinct
workpaper *type* that reuses as much of the existing workpaper
architecture as legitimately applies (scope via linked risks/
entities/FS accounts, attributes, workpaper files for supporting
documentation) while replacing the two pieces that are fundamentally
different: how source data gets in, and what "Analyze" means when the
data itself is a moving target.

## Definitions

- **Continuous Auditing (CA)**: the audit function itself runs
  attribute-based tests against a data source on a recurring or
  near-real-time basis, with results still routed through the audit
  workflow (exceptions/findings/recommendations, sign-off, etc.).
- **Continuous Monitoring (CM)**: the same underlying mechanism, but
  results (or a subset of them) are routed to, or visible to, the
  **control owner directly** — sometimes with the audit function only
  reviewing a periodic roll-up rather than every individual result.
  Wavefire should treat CA and CM as **one mechanism with a routing
  choice**, not two separate features — see Result routing below.
- **Refresh** (of source data) vs. **Analyze** (execution of the test)
  are two independent events with independent cadences — this
  distinction is the crux of the whole design and is treated as its own
  section below.

## What's the same as a regular workpaper (reuse, don't rebuild)

- **Scope definition**: linked risks, Assessment Entities, and FS
  Accounts (`wpFsAccounts`/`fsAccounts`, the Assessment Entities
  section, `public/index.html:889, 979, 2428, 7025`) work exactly the
  same way for a CA workpaper as any other — the thing being tested is
  still framed the same way.
- **Attributes**: `wpTestAttributes[ref]` stays the mechanism for
  defining what's being tested, with the same Success/Failure Criteria
  and Additional Information fields (including the classification-
  steering behavior already built — see
  [pass-fail-override-and-sync-plan.md](pass-fail-override-and-sync-plan.md)).
  A CA attribute is still "a thing that's either satisfied or not," it
  just gets re-evaluated against fresh data repeatedly instead of once.
- **Workpaper Files**: unchanged — still the place for supporting
  documentation (test approach memos, source-system access
  agreements, sign-off evidence) that isn't itself the data under test.
- **Exceptions/Findings/Recommendations grid**: unchanged mechanism,
  reused as-is for CA results, with one addition — see Volume/dedup
  below, since a CA test can plausibly generate far more raw fails per
  run than a traditional sample ever would.
- **Review/sign-off**: the workpaper-level review lock design (see
  [workpaper-review-lock-plan.md](workpaper-review-lock-plan.md))
  applies the same way to a CA workpaper's own configuration (scope,
  attributes, connection setup) — but explicitly does NOT gate the
  underlying scheduled Analyze runs themselves (see Interaction with
  the review lock below); locking the workpaper is about locking its
  *design*, not pausing live monitoring.

## What's fundamentally different

### 1. The "Sample" — replaced by a Data Source configuration

A CA workpaper has no static Sample Data grid populated by hand or by
one-time upload. It has a **Data Source configuration** instead,
answering: where does the data live, how does Wavefire reach it, how
often is it refreshed, and what does one "row" of it mean for testing
purposes. See the Data access section below for the mechanisms.

### 2. The Testwork Grid — becomes a time series, not a single snapshot

A regular workpaper's Testwork Grid is one row per sample, one column
per attribute, one Analyze run. A CA workpaper's grid needs a **third
dimension: which run**. Two real design options, not mutually
exclusive:

- **Option A — one grid per run, with a run picker.** The grid looks
  exactly like today's, but a dropdown/tab strip at the top lets the
  auditor switch between "Run: Sep 8, 2026 9:00 AM," "Run: Sep 7,"
  etc. Simple to build (mostly reuses today's rendering as-is per
  selected run), but doesn't show trend at a glance.
- **Option B — a rolled-up trend view**, one row per attribute (or per
  entity/key being tracked), showing pass/fail/exception-rate over the
  last N runs as a small sparkline or a colored strip, with drill-down
  into any single run's full grid (which then looks like Option A).
  More work, much more useful for CA's actual purpose (spotting a
  trend or a spike, not re-reading yesterday's answer).

**Recommendation**: build Option A first (it's a incremental, low-risk
extension of the existing grid — store one snapshot per run instead of
overwriting `_wpAnalysisResults[ref]` in place, keyed by run id/
timestamp) and treat Option B as an explicit, separately-scoped
follow-up once real CA usage exists to design the roll-up against.
Building the trend view speculatively, before anyone has actually run
a CA workpaper for a few cycles, risks guessing wrong about what
"useful roll-up" even means for a given attribute.

### 3. The Sample Files section — becomes a Source Data Extracts section

Where a regular workpaper's "Attached Sample Files" holds the actual
evidence files, a CA workpaper's equivalent section holds each run's
**source data extract** — whatever file/export/query-result Wavefire
actually pulled or received for that run (see Data access below). This
section should:
- Group by run, most recent first, same visual pattern as the Sample
  Files section today, but each group labeled with the refresh
  timestamp and the ingestion method (upload/fileshare/SFTP/SMTP/direct
  query — see below).
- Keep every run's raw extract retained (not overwritten), for the same
  reason annotated files are never overwritten in place — an auditor
  or an admin may need to go back and see exactly what data a given
  run's conclusion was based on, including after the source system's
  own data has since changed or aged out.
- Flag data-quality anomalies at ingestion time (row count wildly
  different from the prior run, a column missing, a parse failure) —
  see Variability below — as their own visible marker on that run's
  entry, since a CA workpaper accepting silently-malformed source data
  is a much bigger risk than a traditional workpaper doing so (nobody's
  eyeballing the file before it's tested).

## Data access — how source data actually gets into Wavefire

This is "the biggest obstacle" per the prompt, so it's treated as its
own first-class configuration on the CA workpaper, not an
afterthought. Every mechanism below produces the same thing on the
Wavefire side — a file or row-set landing in the Source Data Extracts
section for a given run — so the rest of the pipeline (testwork,
Analyze, results) doesn't need to know or care which one was used.
Ordered roughly by how likely each is to be the real-world answer for
a given customer, per the prompt's own framing:

### A. Manual upload (baseline, always available)

The auditor (or a designated user at the customer, e.g. the control
owner) manually uploads a file into Wavefire each cycle — mechanically
identical to today's file upload, just repeated on a cadence and
landing in the Source Data Extracts section instead of Sample Files.
**No new infrastructure required** — this should be the default,
always-available fallback regardless of what else is built, since it
requires zero trust/network changes on the customer's side. Its
obvious limitation is that it's manual, so it inherits whatever cadence
a human remembers to run it on — fine for weekly/monthly CM, not
credible for anything approaching real-time.

### B. Customer-side fileshare — pull vs. push

The prompt specifically calls out the case where a report or query is
already routinely exported to a fileshare. Two sub-approaches:

- **B1. Wavefire pulls from the fileshare.** Requires Wavefire (a
  cloud SaaS product per the existing architecture — Railway-hosted
  per this repo's deployment) to reach a network location that is, by
  definition, inside the customer's own network/VPN, not
  internet-routable in the general case. This is the "last mile"
  problem named in the prompt. Realistic options:
  - A customer-side **agent** (see Agent section below) that watches
    the fileshare and pushes new/changed files to Wavefire over an
    outbound connection it initiates — this sidesteps the
    inbound-firewall-hole problem entirely, since the customer never
    needs to open anything inbound.
  - A **cloud-fileshare exception**: if the "fileshare" is actually
    already cloud-hosted (SharePoint/OneDrive, a cloud storage bucket,
    a cloud-hosted SFTP), Wavefire can potentially poll or subscribe to
    it directly via that platform's own API, with no customer-side
    agent needed. Worth supporting as its own first-class connector
    type, since it's genuinely simpler when it applies, but not a
    substitute for the on-prem-fileshare case, which is likely still
    the more common one.
  - A **direct VPN/private-link connection** — technically possible
    (Railway/most cloud hosts support this), but **explicitly
    out of scope** for this design: a dedicated network configuration,
    a standing security review, and an ongoing liability per customer
    is a different order of commitment than every other option here,
    and nothing in this design depends on it existing. Listed for
    completeness only, so it isn't silently forgotten as an option a
    future, larger customer might eventually require — not something
    to plan or build toward now.

#### Tracking what's already been ingested (B1 pull only)

When Wavefire is the one polling a fileshare (rather than a file being
pushed to it), it needs its own record of what it has already pulled,
so a poll doesn't either re-ingest the same file over and over or miss
a genuinely updated one. This is a real, dedicated mechanism, not an
incidental detail:

- Keep a **per-Data-Source ingestion log** — one row per file
  Wavefire has pulled from that fileshare location, recording at
  minimum: the file's name (as it appears on the fileshare), its
  source-side last-modified date/timestamp (not Wavefire's own pull
  time), its size, and a content fingerprint (reuse the existing
  `_daSha256Hex` hashing utility already used elsewhere in the app for
  exactly this kind of dedup) — the fingerprint matters because a
  same-named file can be silently replaced with different content
  without its timestamp reliably changing on every fileshare/export
  tool, and relying on the name+timestamp pair alone would miss that.
- **On each poll**: list the fileshare's current contents, compare
  against the ingestion log, and only pull a file that is either (a)
  not in the log at all, or (b) in the log but with a different
  timestamp AND/OR a different content fingerprint than what's
  recorded — i.e. the same filename reappearing with a newer
  timestamp or changed content is treated as a genuinely new extract
  to ingest, not a duplicate to skip.
- **Bound the poll to a rolling recency window** (e.g. only consider
  files dated within the last 60 days, configurable per Data Source)
  so a poll against a fileshare that accumulates years of historical
  exports doesn't re-scan or re-consider everything on every cycle —
  this is a practical scaling/performance bound on the *scan*, not a
  retention limit on what Wavefire keeps once ingested (Wavefire's own
  copy of an already-ingested extract is retained per the existing
  Source Data Extracts retention behavior described elsewhere in this
  document, independent of how old the source file was when pulled).
- **On ingestion, append the ingestion date/time to the stored
  filename** (e.g. `AP_Transactions.csv` pulled on Sep 8, 2026 at
  9:00 AM is stored/displayed as `AP_Transactions_20260908_0900.csv`)
  — this mirrors the existing app-wide convention of timestamp-suffixed
  filenames already used elsewhere (e.g. the xlsx export filenames
  referenced in the review-notes/testwork designs) and guarantees two
  ingested copies of a same-named source file never collide in
  Wavefire's own storage, while the ingestion log above still tracks
  the *original* source filename separately so "was this file already
  pulled" comparisons aren't confused by Wavefire's own renaming.
- This same ingestion-log mechanism is the natural place to record the
  Variability validation outcome (below) for each pulled file, since
  it's already the per-file record of what came in and when.

- **B2. Customer pushes to Wavefire.** The customer's own
  export/report job (or a scheduled task/script someone already
  controls) is pointed at Wavefire instead of (or in addition to) the
  fileshare — via SFTP or SMTP, per the prompt's own suggestion:
  - **SFTP inbound**: Wavefire (or a managed SFTP-to-storage gateway in
    front of it) exposes a per-tenant, per-workpaper (or per-data-
    source) SFTP drop folder with its own credentials. The customer's
    existing "export to fileshare" job is retargeted (or duplicated)
    to also drop a copy there. This is the closest match to "a query
    output to a fileshare" the prompt describes, and requires the
    least new tooling on the customer's side — most schedulers/ETL
    tools can write to an SFTP target as easily as a local path.
  - **SMTP inbound (email)**: Wavefire owns a receiving mailbox/address
    (per-tenant, or per-workpaper via a `+tag`-style alias) and treats
    an arriving attachment as a new extract. Lower setup friction than
    SFTP for a customer whose export mechanism already emails a report
    (common for canned ERP reports), but weaker on security/size/
    reliability guarantees (email is not designed as a data pipe) — use
    for smaller, less sensitive extracts, and flag this limitation to
    the customer explicitly rather than silently accepting arbitrary
    volume over it.
  - Both need the same landing pipeline once the file arrives: virus/
    malformed-file scanning, a size cap, a mapping from
    "which mailbox/SFTP folder did this land in" to "which CA
    workpaper's Data Source this belongs to," and the same data-quality
    checks as any other ingestion path (see Variability below).

### C. Direct database connection

The prompt correctly flags this as "less common," and per explicit
direction this is **not** a live connection Wavefire itself holds open
to a production database at all — it is a **customer-local query that
outputs to a file** in the customer's own environment, which then
travels to Wavefire via one of the file-based mechanisms already
described above (B1's fileshare-pull-with-ingestion-tracking, or B2's
SFTP/SMTP push). In other words, "direct database connection" is really
a description of how the *extract file itself gets produced*
(a scheduled query run locally against the source system) rather than a
fourth, separate transport mechanism — it converges into the exact
same landing pipeline as every other extract once the file exists.
- **The query itself is explicitly the customer's own responsibility
  to build and maintain** — Wavefire does not write, host, execute, or
  hold credentials for any query against the customer's production
  database. The customer's own DBA/IT function owns the query's
  correctness, its performance impact on the source system, its own
  change control when the source schema changes, and its own scheduling
  (e.g. a local scheduled task or job that runs the query and writes
  its output to the agreed fileshare/SFTP/SMTP destination on the
  agreed cadence). Wavefire's side of this arrangement is documentation
  only: the CA workpaper's Data Source configuration should record
  *that* this source is fed by a customer-maintained query (for audit-
  trail/documentation purposes — e.g. "how does data get here" being
  answerable from the workpaper itself) without Wavefire ever storing
  or being able to run the query.
- Where a customer-side **agent** (below) is already in place for other
  reasons, it MAY be handed a pre-approved, customer-reviewed query to
  run on the agent's own schedule instead of relying on a customer-
  managed cron/scheduled task — but this is still the customer's own
  query, reviewed and owned by them; the agent is only a scheduler/
  executor for something the customer already built and approved, not
  a query-authoring tool. A raw query string should never be something
  the auditor can freely edit and have silently re-run against a live
  production system without the customer's own review — this needs its
  own approval/change-control step, out of scope to design in full here
  but flagged as a hard requirement, not an implementation detail to
  skip.

### The customer-side agent — when it's actually needed

A lightweight agent (a small installed service/container in the
customer's environment) is the common thread underneath B1 and C
above. Its job is narrow and should stay narrow: **watch a
location or run an approved query, and push the result to Wavefire
over an outbound HTTPS connection it initiates.** It should NOT be a
general remote-execution or remote-access tool — scoping it tightly
(one job: move approved data from point A to Wavefire) is both a much
easier security conversation with the customer and a much smaller
thing for Wavefire to build and support. Recommended shape:
- Configuration is pull-based from Wavefire's side in one sense (the
  agent, on its own schedule, calls home to ask "what am I supposed to
  fetch/push right now"), but the actual data transfer is always
  agent-initiated/outbound, never Wavefire reaching in.
- Per-tenant, per-workpaper (or per-data-source) credentials/token,
  revocable from the Wavefire admin side at any time — this is a
  standing piece of customer-environment access and needs the same
  "who can revoke it, how do we know it's been compromised" story as
  any other credential the app manages.
- **Not needed at all for**: manual upload (A), SFTP/SMTP push where
  the customer's own existing scheduler already does the pushing (B2),
  or a genuinely cloud-hosted fileshare with its own API (B1's cloud
  exception). The agent is specifically the answer for "the data lives
  somewhere Wavefire's cloud can't reach and nothing there already
  pushes outbound on its own" — build/recommend it only when the other,
  simpler options are confirmed not to fit a given customer, not as a
  default first offering.

## Volume and variability

- **Volume**: a CA data source can plausibly be orders of magnitude
  larger than a traditional sample (a full day's transaction log vs. a
  hand-picked sample of 25-60). This affects several already-built
  mechanisms that assumed sample-grid scale:
  - The Testwork Grid's per-sample-row rendering does not scale
    directly to thousands/millions of rows — a CA run's grid needs
    pagination/virtualized rendering, or (more realistically) the grid
    shows only exceptions/failures plus a small sampled/representative
    set of passes, with an aggregate pass/fail count for the rest,
    rather than literally rendering one row per source record.
  - Annotation/burn (PDF marking) makes no sense at CA volume/format —
    CA source data is far more likely to be structured (CSV/DB rows)
    than a document to annotate; the whole annotation subsystem should
    be explicitly out of scope for a CA workpaper's own results (it
    still applies normally to anything in Workpaper Files).
  - Exceptions/Findings/Recommendations dedup (already built for the
    regular flow) becomes load-bearing rather than a nice-to-have — a
    CA run that finds the same underlying issue recurring every day
    must not create a new Exception row per day; the existing dedup-
    by-name-and-linked-files logic needs a CA-aware key (e.g. dedup by
    attribute + the natural business key of the failing record, so a
    persistent issue accumulates occurrences under one Exception rather
    than spawning duplicates) — this is real, CA-specific extension
    work, not just reuse.
- **Variability**: unlike a human-curated sample, a live/periodic feed
  will occasionally arrive malformed, late, partial, or structurally
  changed (a column renamed/added/removed upstream). The ingestion
  pipeline (regardless of which Data access mechanism produced the
  file) needs an explicit validation step before an extract is
  considered "ready to test": expected-schema check, a sanity check on
  row count vs. recent history, and a clear, visible "this run's data
  looked off — reviewed before testing?" state rather than silently
  either failing the whole run or silently testing bad data as if
  nothing were wrong. This should log as its own event (see Logging
  below) and should be surfaced to the auditor prominently, not buried.

## The Analyze cadence — separate from the Refresh cadence

This is explicitly the crux the prompt calls out, so it's designed as
two independent triggers, not one combined "run everything now" button:

### Refresh (source data arrives/is pulled)

- **On demand**: the auditor (or the agent, or an inbound SFTP/SMTP
  drop) triggers ingestion of whatever's currently available.
- **Scheduled**: a cron-like cadence (hourly/daily/weekly/monthly) —
  matches how often the source system itself actually produces new
  data; no value refreshing more often than the source changes.
- **Event-driven** (for a push mechanism — SFTP/SMTP/agent): a refresh
  is simply "a new extract arrived," with no separate schedule to
  configure at all — the source system's own export cadence *is* the
  refresh cadence.

### Analyze (the test actually runs)

Independent of the above, with its own trigger options:
- **On demand**: auditor presses Analyze against the latest available
  extract (or a specific past one, for investigation) — identical in
  spirit to today's button, just pointed at a CA data source's latest
  run instead of the static Sample Data grid.
- **Scheduled**: Analyze runs automatically on its own cadence
  (e.g. nightly) against whatever the latest refreshed extract is at
  that time — this decouples "how often does new data show up" from
  "how often do we bother re-checking it," which matters when data
  refreshes far more often than anyone needs re-testing (e.g. hourly
  transaction exports, but a daily control test is sufficient).
- **Criteria-driven** (the prompt's "based on certain criteria" case):
  realistic triggers to support, roughly in order of build complexity:
  - **On every new refresh** — the simplest criteria-driven mode:
    Analyze automatically fires whenever a new extract lands, i.e.
    Refresh and Analyze cadences are the same, configured as one
    setting rather than two independent schedules. This should be the
    easiest configuration to select, since it's likely the common case
    for anyone wanting genuinely continuous (not just periodic)
    monitoring.
  - **Volume/threshold-based** — e.g. "only re-run once at least N new
    records have accumulated since the last run," useful when a source
    trickles in small updates and re-testing on every tiny delta would
    be wasteful.
  - **A specific business-calendar event** — e.g. "run after month-end
    close," "run after the nightly batch job's own completion flag/
    file appears" — this last one is really a variant of event-driven
    Refresh (a specific file's arrival IS the trigger) rather than a
    new mechanism, so it should reuse the same "fires on a named
    event" plumbing as the simple on-every-refresh case above, just
    scoped to a specific file/flag rather than any new extract.
  - Explicitly deferred as a follow-up, not core scope here: statistical/
    anomaly-triggered Analyze (e.g. "re-run early if this cycle's data
    looks unusual") — genuinely useful eventually, but depends on
    Variability detection (above) maturing first, and is speculative
    without real CA usage data to validate against.

### Interaction with the workpaper review lock

Per the existing review-lock design, signing off a CA workpaper locks
its **configuration** (scope, attributes, Data Source setup, schedule
settings) exactly like any other workpaper — but a scheduled Refresh/
Analyze that was already configured before lock should **keep running**
unless explicitly paused; a lock is about "don't let someone quietly
change what's being tested out from under a signed-off review," not
"stop monitoring the control." This needs one small explicit setting on
top of the existing lock semantics: a CA workpaper's scheduled
Refresh/Analyze jobs are unaffected by the workpaper being
locked/unlocked, and a **separate** pause/resume control (independent
of the review lock) governs whether the schedule itself is active.
Conflating these two would mean every re-review cycle interrupts live
monitoring, which defeats the point of "continuous."

## Result routing (CA vs. CM)

Both flow through the same Exceptions/Findings/Recommendations
mechanism and the same Testwork Grid — the only difference is who else,
besides the audit file, sees a result and how quickly:
- **Audit-only (classic CA)**: results land in the workpaper exactly
  like today; the control owner sees them only if/when the auditor
  shares the workpaper or a report from it, on the audit team's own
  timeline.
- **Control-owner-visible (CM)**: the workpaper additionally names a
  control-owner recipient (reuse the same user-picker pattern already
  used for Preparer/Reviewer dropdowns) and a routing rule — e.g. "every
  new Exception," "a daily/weekly digest," or "only Exceptions above a
  configured severity" — triggering a notification (email, in-app, or
  both) to that person. This should be an explicit, workpaper-level
  configuration choice, not an implicit side effect of the workpaper
  merely existing, since routing a result outside the audit function
  changes who has access to potentially sensitive findings and needs to
  be a deliberate decision each time it's turned on.
- Regardless of routing, **the audit function's own copy of the record
  is authoritative** — a control owner being notified directly doesn't
  remove the item from the audit workpaper's own Exceptions grid or
  change the workpaper's own review workflow.

## Logging

Per explicit requirement, both Refresh and Analyze are independent,
first-class loggable events — extending the existing `wpChangeLog`/
`logEvent` mechanism already used for every other tracked action in the
app, not a new parallel logging system:
- **Refresh event**: source, method (upload/SFTP/SMTP/agent-query/
  direct-cloud-API), timestamp, row/record count, and the outcome of
  the Variability validation step (clean / flagged / rejected) —
  logged whether the refresh was on-demand, scheduled, or event-driven.
- **Analyze event**: which extract/run it was executed against
  (linking back to the specific Refresh event, not just "the latest
  data," since a later Refresh may have already superseded it by the
  time someone reviews the log), trigger type (on-demand/scheduled/
  criteria-driven and which criterion), duration, and a summary count
  of results (pass/fail/exception counts) — mirroring the level of
  detail already logged for a regular workpaper's Analyze run.
- **Result-communication event**: whenever a result is routed to a
  control owner (CM routing above), log that separately from the
  Analyze event itself — recipient, what was sent (a single Exception?
  a digest?), and via what channel — since "the test ran" and "someone
  outside the audit function was told about it" are two different
  facts worth two different audit-trail entries.

## Data model sketch (high level — not a full schema)

Not attempting a full DB migration here — this is enough to reason
about scope, left for detailed design once this direction is confirmed:
- `workpapers.type` (or a new dedicated flag) distinguishing a CA
  workpaper from a standard one, gating which sections render (Data
  Source config instead of Sample Data grid, etc.) — mirrors how
  `workpaper_types` already exists as an administrative categorization
  today, though this is a functional distinction, not merely a label,
  so it likely needs its own flag rather than overloading that table.
- A new `ca_data_sources` concept: one row per configured source per
  CA workpaper — access method, connection details (redacted/
  encrypted credentials where applicable), refresh cadence
  configuration.
- A new `ca_runs` concept: one row per Refresh event (extract landed,
  metadata, validation outcome) and a related one per Analyze event
  (which run it tested, trigger type, result summary) — this is the
  backing store for the "one grid per run" / trend-view designs above,
  and for the Logging section's own audit trail.
- Agent credentials/tokens: a new, narrowly-scoped credential table,
  revocable independently per data source — explicitly NOT reusing
  general user auth, since an agent is a machine identity with a much
  narrower job than a logged-in user.

## Known open questions (flagging honestly, not deciding here)

- Exactly how a raw, potentially-sensitive production data extract
  (possibly containing PII/financial detail well beyond what a curated
  audit sample would ever include) is stored/retained/purged in
  Wavefire needs its own data-retention and access-control design —
  CA plausibly imports much more raw source data than the audit
  function has ever had to hold before. This is a real, separate
  design question, not a footnote to be waved past.
- Multi-tenant isolation for agent credentials and inbound SFTP/SMTP
  endpoints needs its own security review before build — this document
  assumes per-tenant isolation is achievable within the existing
  tenant model but does not design the mechanism.
- Pricing/metering implications (CA plausibly drives many more Analyze/
  AI-unit-consuming runs than a traditional workpaper) are out of scope
  here but should be flagged to whoever owns AI-unit billing before
  this ships broadly.

## Recommended build order

1. Manual upload into a CA-flagged workpaper, on-demand Analyze only,
   one-run-at-a-time grid (Option A, no trend view yet) — proves the
   workpaper-type/Data-Source/Testwork-Grid-versioning mechanics with
   the lowest-risk ingestion method.
2. Scheduled Refresh + scheduled/event-driven Analyze, still via
   manual/SFTP/SMTP ingestion (no agent yet) — proves the two-cadence
   scheduling model and the Logging mechanism.
3. Volume handling (grid summarization, CA-aware Exception dedup) —
   needed as soon as any real customer data source is larger than a
   traditional sample, likely immediately.
4. CM result routing to a control owner.
5. The customer-side agent, for the specific cases (running a customer-
   owned local query on schedule, an unreachable on-prem fileshare)
   that genuinely require it — built
   last and only once a real customer need for it is confirmed, since
   it's the most expensive piece to build, secure, and support.
