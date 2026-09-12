# Workpaper Chat Assistant — Design

## Purpose

A conversational panel on the workpaper detail page letting a user ask
questions about that workpaper's own Analyze results, get plain-language
explanations of why a given (attribute, sample) reached the conclusion
it did, and get coached toward the actual, existing levers that change
future conclusions — without needing to already know those levers exist.

This is explicitly **not** a general-purpose chatbot bolted onto the
app. It's a front-end onto data and mechanisms that already exist:
per-attribute reasoning (the "G" guidance data), Success/Failure
Criteria, the Additional Info classification-steering field, and the
override mechanism on each tick. The chat doesn't invent new
capability — it makes existing capability discoverable and usable in
plain language.

## Scope decision

Workpaper-scoped only, for this first version — one chat panel per
open workpaper, context assembled from that workpaper's own state. An
app-wide "how do I use Wavefire" assistant (navigation, feature
discovery) is a distinct, smaller need with a different context shape
(the existing `HELP_TOPICS` registry would cover most of it) — worth
building later, separately, not folded into this one.

## Core interaction loop

1. **Explain** — "Why did sample 3 fail attribute B?" → pulls that
   exact `(attributeIndex, sampleRowIndex)`'s `reasoning`/`note` from
   `_wpAnalysisResults[ref]` (or, once persisted per the recent fix,
   reconstructed from `attribute_sample_results`), states it in plain
   language, and can cross-reference that attribute's own Success/
   Failure Criteria so the user sees which criterion actually drove it.
2. **Pattern-spot across samples** — "Why does attribute B keep
   failing?" → the assistant can look across every sample's reasoning
   for that one attribute (exactly what the "G" icon already surfaces
   per-attribute) and summarize a common thread, not just answer about
   one cell.
3. **Coach toward the real lever** — "How do I get a different
   conclusion here going forward?" → explains that an attribute's own
   Additional Information field can carry a binding, attribute-specific
   rule (already built — see
   [pass-fail-override-and-sync-plan.md](pass-fail-override-and-sync-plan.md)
   Part 7), weighed *ahead of* the general rule on every future Analyze
   run. Reusing the exact pattern `_offerClassificationGuidanceAppend`
   already established: the assistant can **draft the actual sentence**
   to add, show it to the user, and offer to save it — never silently
   writing it. The user reviews, edits, or declines exactly as they
   already do today for a reclassification's guidance suggestion.
4. **Draw the override/wording line precisely** — per the recent,
   explicit correction that reclassifying/deleting never flips pass/
   fail as a side effect, the assistant must be equally precise: if a
   user's real ask is "just make this one pass," that's an **override**
   (a separate, deliberate action on the tick, with its own
   confirmation and file-resync), not a wording change to Additional
   Information. The assistant should say so plainly and point at the
   correct control, rather than blurring a distinction the app just
   went to deliberate effort to enforce in code.

## Helping the USER frame good questions (per explicit follow-up)

A blank chat box is a bad first experience for a tool most auditors
have never used conversationally before — most people won't know what's
even askable. Two complementary mechanisms, not either/or:

### 1. Context-aware suggested-question chips

Rather than one static set of examples, generate 3-4 chips from the
workpaper's own CURRENT state each time the panel opens or the
workpaper's results change — the same "look at what's actually true
right now" approach `_analysisOptionDataAvailability` already uses for
the Analyze-options auto-detection feature:

- **If there are failing attributes**: "Why did [most-recently-failed
  attribute] fail on [its most recent failing sample]?"
- **If one attribute fails disproportionately often**: "Why does
  [attribute] keep failing across samples?"
- **If there are unresolved Exceptions**: "Summarize the open
  Exceptions on this workpaper."
- **If Analyze hasn't run yet, or the grid is empty**: different,
  onboarding-flavored chips instead — "What does this workpaper still
  need before I can run Analyze?", "What's Analyze going to test?"
- **Always available, regardless of state**: "What would make
  [attribute] harder to fail incorrectly?" / "How do I stop this
  attribute from flagging [specific recurring pattern]?"

Clicking a chip sends it as a real message (not just filling the
textbox) — lowest-friction path to a first real answer, so a new user's
very first interaction is already a good one, not a blank box they have
to guess into.

### 2. A short, static "what you can ask" primer

Below the chip row (or in a collapsed "Examples" affordance, matching
the click-to-open help-icon pattern already used elsewhere), a few
fixed example phrasings covering the three interaction modes above, so
the user has a mental model of the shape of a good question even after
the contextual chips stop being novel:

> - "Why did [attribute] fail on [sample]?"
> - "Why does [attribute] keep failing across my samples?"
> - "How do I stop this from being flagged as an Exception when
>   [specific condition]?"
> - "Summarize what's outstanding on this workpaper."

This should be genuinely short — three or four lines, not a manual.
The chips do the real teaching, by example, in context; this is just a
fallback for when nothing chip-worthy currently applies.

### 3. The assistant's own replies should model good follow-ups

When the assistant answers, ending with one natural next-step suggestion
("Want me to draft a note for this attribute's Additional Information
so this doesn't happen again?") continues the coaching function turn by
turn, rather than front-loading everything into onboarding. This mirrors
the existing classification-guidance-append flow's own "offer, don't
assume" shape.

## What's needed to build this (high level — detailed later once this direction is confirmed)

- A chat panel UI (reuse the floating, draggable/resizable window
  pattern already used for Review Notes and the attribute Guidance
  modal — non-blocking, doesn't cover the workpaper underneath it).
- A context-assembly function per message: workpaper metadata,
  attribute definitions + criteria, relevant slice of
  `_wpAnalysisResults`/`attribute_sample_results` (not the whole
  workpaper on every message — targeted to what the question is about,
  or a compact summary when the question is broad), open Exceptions/
  Findings/Recommendations.
- A chat-turn endpoint (new `/api/assistant-chat` or reusing `/api/claude`
  directly) with a system prompt describing Wavefire's own model:
  attribute/sample/result/reasoning/Exception-Finding-Recommendation
  vocabulary, and the override-vs-wording distinction above stated
  explicitly so the assistant never blurs it.
- The suggested-chip generator described above, reusing the same
  "inspect current state, don't ask the user to know it" philosophy as
  `_analysisOptionDataAvailability`.
- A decision on chat history persistence (session-only vs. saved per
  workpaper) — flagged as an open question, not resolved here.
- AI-unit metering: decide whether chat messages count against the
  same usage tracking the rest of the app already has
  (`_loadMyAiUsage`) — flagged, not resolved here.

## Explicitly out of scope for this first version

- App-wide navigation/help chat (separate, smaller feature — see Scope
  decision above).
- The assistant executing an override or a reclassification directly on
  the user's behalf — it drafts and explains; the user always takes the
  actual action through the existing, real UI controls, consistent with
  the "never silent" pattern every other AI-assisted write in this app
  already follows.

## Implemented and verified (first version, 2026-09-11)

Built substantially as designed above:
- "Ask Wavefire" button in the workpaper header opens a floating,
  draggable/resizable chat window (same `.notes-window` pattern as
  Review Notes and the attribute Guidance window) — non-blocking, the
  rest of the page stays usable underneath it.
- Routes through the existing generic `/api/claude` proxy — no new
  server endpoint, and AI-unit usage logging already happens there for
  every call, closing that open question from the design.
- `_buildWpChatContext(ref)` assembles a compact, capped (12,000 char)
  summary: workpaper metadata, every attribute's title/description/
  criteria/Additional Information, every sample's result per attribute
  (AI result, with an active override layered on top exactly as the
  grid itself displays it — via the same `_findOverrideFor` the grid
  uses), and open Exceptions/Findings/Recommendations. Chose "compact
  summary of everything" over per-question targeted retrieval for this
  first version — simpler to build and verify, adequate for a typical
  workpaper's size; targeted retrieval for an unusually large grid is a
  reasonable later refinement, not required to ship a working v1.
- The system prompt states the Exception/Finding/Recommendation
  vocabulary and, explicitly, the override-vs-wording distinction from
  the recent correction — the assistant is told point-blank it cannot
  change a result itself, reclassifying/editing never changes a result
  either, and it may only draft an Additional Information suggestion,
  never apply it.
- `_buildWpChatSuggestions(ref)` generates up to 4 context-aware chips
  (pre-Analyze onboarding chips vs. failure-pattern-aware chips vs.
  Exception-summary chips), shown only until the first real message —
  after that, the assistant's own replies carry the "what to ask next"
  job instead, per the design's own stated intent.
- Session-only chat history, one window shared across whichever
  workpaper is currently open (`_wpChatHistory[ref]`, `_wpChatOpenRef`)
  — matches this app's existing convention for most other transient,
  per-workpaper UI state; persisting history across reloads is left as
  a follow-up, not resolved here.

Verified against the dev server with a mocked `/api/claude` response:
opening the window shows correctly state-aware chips (a genuinely
repeated failure pattern produces the "keep failing across samples"
chip, not the single-failure phrasing); the assembled context string
correctly reflects the workpaper's real attributes/results/exceptions;
sending a message posts that context plus the override/wording
distinction in the system prompt; the reply renders; and the chips are
correctly cleared once a real conversation has started.

**Deliberately not yet built** (explicitly out of scope for this first
version, per the design above): the app-wide navigation/help chat, and
any action where the assistant would apply a change itself rather than
drafting it for the user to apply through the real, existing controls.

## Locate, surface, and output data beyond one workpaper (2026-09-11)

Per explicit follow-up: the assistant can now reach beyond the single
open workpaper's pre-assembled context, and produce a real downloadable
file — via Claude's native tool-use (function calling), not by
expanding the context bundle to include the whole tenant on every
message.

**Three tools**, each a thin client-side function over data already
loaded for the current tenant — no new server endpoint, and no new
tenant-isolation surface, since `WORKPAPERS`/`wpExceptions` were only
ever populated with this tenant's own rows in the first place (by
`_loadWorkpapersFromDB` at bootstrap):
- `search_exceptions({type?, auditName?, keyword?})` — searches
  Exceptions/Findings/Recommendations across every workpaper the tenant
  has, not just the open one.
- `list_workpapers({auditName?, status?})` — lists workpapers by audit/
  status across the tenant.
- `export_to_csv({filename, columns, rows})` — the assistant hands back
  a table of data it has gathered (from either tool above, or the
  already-given workpaper context), and this generates and triggers a
  real download using the same Blob+anchor pattern every other export
  in this app already uses.

**The loop**: `/api/claude` already passes through Anthropic's raw
Messages API, which natively supports `tools` — no server change
needed. `_sendWpChatMessage` now runs a small agentic loop (capped at 4
rounds, to guard against a runaway tool-call cycle): send the message
with `tools` attached; if the response's `stop_reason` is `tool_use`,
execute each requested tool against local client state, append the
tool's own `tool_use`/`tool_result` blocks to the in-flight message
list, and send again; once the model returns plain text instead, that's
the final reply appended to the visible chat history. The tool-call
round-trip itself is NOT shown as chat bubbles — only the user's
question and the model's final answer are, keeping `_wpChatHistory[ref]`
a simple display log rather than needing to replay prior tool plumbing
on every future turn (each turn rebuilds its own working message list
fresh, with the current context already re-attached via the system
prompt).

The system prompt was extended to tell the assistant plainly that it
has these tools and when to use each one — including using
`export_to_csv` instead of pasting a large table into the chat whenever
the user asks to export/download/get a report.

**Verified** against the dev server: `search_exceptions` correctly
filters by audit/type/keyword across multiple workpapers (confirmed
against synthetic cross-workpaper Exception/Finding data);
`list_workpapers` correctly filters by audit; `export_to_csv` produces
a real Blob-backed CSV download with a sanitized filename; a full,
mocked two-round tool-use exchange (tool call → tool result → final
text) renders the correct final answer in the chat; and a simulated
runaway tool-call loop is correctly stopped by the round cap with a
graceful fallback message rather than hanging.

**Deliberately narrow for this version** — only these three read-only/
export tools exist; no tool can modify any data (create/edit/delete an
Exception, change an override, etc.). Per the design's own standing
principle, the assistant surfaces and drafts; it never acts on the
user's behalf through a tool either.
