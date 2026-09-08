# Design: In-context help icons on section headers

## The request, precisely

Add a small icon to section headers throughout the app (Testwork Grid,
Test Attributes, Attached Sample Files, and others) that, on
interaction, explains how that feature works. Per direct follow-up:

- **No consolidated "download the whole guide" option** — a separate
  solution for that is being built elsewhere; this doc's scope is the
  in-context help itself, not a document-generation feature.
- **Must work identically on mobile, with no device detection** — one
  mechanism, not a desktop path and a separate mobile path.
- **The Testwork Grid's own help content is specified explicitly**: it
  must cover the Exception/Finding/Recommendation definitions, how the
  AI determines pass/fail, how to change a pass/fail decision, and what
  that change does to already-annotated files.

## What already exists (precedent, and why it's not quite reusable as-is)

Three different hand-built patterns already do a version of this, none
shared:
- The "Sample File Annotation Type(s)" header (~line 5839,
  `.wf-ann-type-hover-wrap` / `.wf-ann-type-popup`) — a real `ti-info-
  circle` icon with a popup table, shown via pure CSS `:hover`.
- The Test Attributes grid's Success/Failure Criteria column headers
  (~line 3401) — `onmouseenter`/`onmouseleave` JS toggling one shared
  singleton `#criteria-tooltip` div's visibility and content.
- A handful of plain `ti-info-circle` icons elsewhere (Audit
  information, Control information headers) that are just static
  labels, not interactive at all.

Two real problems with extending either interactive pattern as-is:
1. **Both rely on hover**, which doesn't exist as a concept on a
   touchscreen — a tablet user can't hover a static icon, so neither
   pattern works on mobile without a second, different interaction
   path. The request specifically asks to avoid a device-detected fork.
2. **Neither is a shared component** — each is its own hand-rolled
   markup and toggle logic. Extending this to several more headers by
   copy-pasting either pattern several more times means several more
   places that can drift out of sync in look or behavior.

## Design: one interaction mechanism everywhere — tap/click to open, not hover

**Click/tap to open, click anywhere outside (or an explicit close) to
dismiss.** This is the one mechanism that needs no device detection at
all: a `click` event fires identically whether it came from a mouse or
a touchscreen tap, so the exact same code path handles both — there is
no "mobile version" to build or maintain, which directly satisfies
"prefer not" to fork behavior by device. Hover is deliberately **not**
used for opening (a desktop user hovering past an icon on their way
somewhere else would otherwise trigger popups they didn't ask for
anyway) — every existing and new help icon becomes click-to-open,
including the two precedent patterns above, for the same reason and for
one consistent feel across the whole app.

**One shared component, not one bespoke build per header.** A single
render helper and a single positioning/toggle function, used by every
header that wants one:

```js
// Renders the icon itself. `topicKey` looks up content in the registry
// below; nothing about the icon's markup needs to change per header.
function helpIcon(topicKey) {
  return `<i class="ti ti-help-circle wf-help-icon" data-help-topic="${escAttr(topicKey)}"
    onclick="event.stopPropagation();_toggleHelpPopup(this)"
    title="Click to explain this section"></i>`;
}
```

`_toggleHelpPopup(iconEl)` (one shared function, not one per header):
looks up `iconEl.dataset.helpTopic` in the content registry, builds (or
reuses) one popup element anchored near the icon, and toggles it open/
closed. A single `document`-level click listener closes any open popup
when a click lands outside it — the same dismiss behavior everywhere,
written once.

**Deliberately a distinct icon from the existing `ti-info-circle`.**
The app already uses a plain "i" info-circle for short, static,
non-interactive context (e.g., the Audit/Control information headers,
which aren't asking to be clicked). Per the request's own wording — "a
question mark inside an icon" — this new, always-clickable, always-
substantial explainer uses `ti-help-circle` (a "?" in a circle)
specifically so it reads as a different, clickable affordance rather
than blending into the existing static icons that happen to sit in
similar positions.

**Content lives in one registry, not scattered per header.** A single
object, one entry per topic:

```js
const HELP_TOPICS = {
  testworkGrid: {
    title: 'Testwork Grid',
    html: `...` // see content outline below
  },
  testAttributes: { title: 'Test Attributes', html: `...` },
  sampleFiles:    { title: 'Attached Sample Files', html: `...` },
  // one entry per header that gets an icon
};
```
This is what actually matters for the "keep as reference" half of the
original request even without a download button: the content is
addressable, one topic at a time, in one place — not copy-pasted markup
sitting inline at each header, which would make it harder to review or
update consistently later. It also means adding a new header's help
text is "add one registry entry," not "invent another popup from
scratch."

**Per-topic download stays, a whole-guide download does not.** Per the
explicit correction, no consolidated "download everything" button —
that's being solved elsewhere. What the original request was actually
after — "a way to keep the explanation as reference, spend more time
with it" — is still worth a small, low-cost affordance: a "Download this
explanation" link inside each individual popup, exporting just that one
topic's own text (plain `.txt`, same lightweight Blob-download pattern
already used throughout this app, e.g. `downloadTestGuidance`). This is
deliberately scoped to one topic at a time, matching what's actually
being asked for here (a reference copy of what you're looking at right
now), not a substitute for whatever the separate, dedicated guide
solution ends up being.

## Mobile behavior, specifically

Click-to-open already means a tap opens it — nothing further is needed
for the open action. Two things worth being deliberate about so it also
reads well on a small screen, still with no device branching in the
*logic*, only in the *CSS* sizing that already responds to viewport
width the normal way:
- The popup's width should be `min(<desktop width>, 92vw)` (the existing
  annotation-type popup already does exactly this), so it never
  overflows a narrow viewport — a CSS max-width rule, not a JS device
  check.
- Position the popup to stay on-screen: anchor below the icon by
  default, flipping above if there isn't room below (the same
  edge-aware positioning already used for `positionTooltip`/
  `positionAuditTooltip` elsewhere in this file) — again logic that
  reacts to the icon's real on-screen position, not to what kind of
  device it's running on.

## Content outline for the Testwork Grid's own help topic

Per explicit specification, this one topic needs to be substantial
enough to actually explain the feature, not a one-line tooltip. Content
sourced from, and kept consistent with, the existing design docs
(`pass-fail-override-and-sync-plan.md`) rather than re-derived —
whenever those docs change this section's own real behavior, this
content should be revisited at the same time:

1. **What the grid shows** — one tick per (sample, attribute), pulled
   live from the most recent Analyze run plus any override; a `[Ref]`
   tag identifies the Exception tied to a fail tick; an `OVR` tag marks
   an attribute a person has since overridden.
2. **Definitions** — the three real classifications, reusing the exact
   language from `pass-fail-override-and-sync-plan.md`'s Part 7:
   - **Exception**: a confirmed, sample-specific failure of the
     attribute's own stated pass criteria (or a stated failure
     criterion being met); drives that sample's attribute to Fail;
     requires disposition.
   - **Finding**: a sample-specific deviation that does *not* fail the
     attribute's own criteria — the sample can still Pass — but is
     worth recording.
   - **Recommendation**: a suggestion about the control/process itself,
     not tied to any one sample's result.
3. **How the AI reaches a pass/fail result** — the attribute's title,
   description, additional information, and pass/failure criteria are
   weighed together, never any one alone; a genuine control failure (or
   a genuine inconsistency between the sample data given and what the
   source documents show) is a fail, and always comes with real
   exception text explaining why; sample data that can't be located
   anywhere in the source documents is also a fail (untestable is not
   the same as passing); an attribute's own "Additional Information"
   can carry a binding, attribute-specific rule for when something
   should be a Finding instead of an Exception, or a Recommendation
   instead of either — overriding the general rule for that one
   attribute specifically.
4. **How to change a decision** — click any tick to open the results
   modal; overriding a result there is independent of whether an
   Exception record exists or gets resolved, and the Type dropdown in
   the Exceptions/Findings/Recommendations grid lets a person
   reclassify an item between the three types directly.
5. **What happens to already-annotated files when a decision changes**
   — every annotated file is always fully rebuilt from the pristine
   original on every write, never patched in place; changing an
   override or reclassifying an item that already has annotated copies
   shows a confirmation listing exactly which files would be updated
   (each one a clickable link to open and check first) before anything
   is touched; declining leaves every existing file exactly as it was.

## Prioritized rollout (content-writing is the real cost, not the UI)

Given the shared component makes adding a new icon cheap, the limiting
factor is writing genuinely accurate, useful explanations — worth
sequencing by where confusion is most likely, not adding everywhere at
once:
1. **Testwork Grid** — content specified above; build first.
2. **Test Attributes** (the grid overall, plus the existing Success/
   Failure Criteria tooltips migrated into this same shared mechanism
   rather than left as their own separate, hover-only implementation).
3. **Exceptions, Findings and Recommendations grid** — the Type column,
   Ref numbering scheme, and what deleting/reclassifying an item does.
4. **Attached Sample Files** — original vs. annotated copies, the
   `_annotatedFrom` relationship, what "Stored on server" / "Not yet
   saved" / "Original" tags mean (the existing static legend at the
   bottom of that section is a natural candidate to fold into this
   same mechanism too).
5. **Sample File Annotation Type(s)** — migrate the existing hover-only
   popup onto the new shared click-to-open mechanism, so it works on
   mobile too instead of remaining the one exception.
Every later addition is the same shape: one registry entry, one
`helpIcon('key')` call in that header's markup.

## Files touched (when built)

All in `public/index.html`:
- New shared `helpIcon()`, `_toggleHelpPopup()`, one popup-close
  document listener, and the `HELP_TOPICS` registry.
- Each targeted section header gains one `helpIcon('...')` call.
- The two existing hand-built patterns (annotation-type popup, criteria
  tooltips) migrated onto the shared mechanism rather than left as
  their own separate implementations, per the rollout above.
- No server-side change — this is static, authored content, not
  workpaper data.

## Verification (when this is built)

1. Click a help icon; confirm the popup opens with the right topic's
   content, positioned so it stays on-screen near the icon.
2. Click elsewhere on the page; confirm the popup closes.
3. Open one popup, then click a different header's help icon; confirm
   the first popup closes and the second one opens (never two open at
   once).
4. Resize to a narrow/mobile viewport; confirm the popup never overflows
   the screen and opens correctly on a simulated tap (no separate code
   path exercised — the same click handler).
5. Use the "Download this explanation" link inside one popup; confirm
   it downloads only that topic's own text, not every topic combined.
6. Confirm the Testwork Grid's popup includes all four required
   elements: the three definitions, the pass/fail determination
   explanation, how to change a decision, and the annotated-file
   implications of changing one.

**Implemented and verified** (2026-09-07) for the Testwork Grid, the
first of the prioritized rollout list — the shared `helpIcon()`/
`_toggleHelpPopup()`/`_closeHelpPopup()`/`HELP_TOPICS`/
`_downloadHelpTopic()` mechanism, plus the `ti-help-circle` icon wired
into the Testwork Grid's own header, with its content covering all four
required elements. Verified against the dev server (auth-gated
workpaper pages aren't reachable in this harness, so tested by injecting
an equivalent icon into a reachable page and exercising the exact same
shared functions): click opens the popup positioned near the icon;
click-away closes it; clicking the same icon again toggles it closed;
the popup contains the three definitions and the annotated-file-
implications section; "Download this explanation" produces clean,
readable plain text (block-level segments joined by blank lines, no
template-literal indentation artifacts, using a control character no
real content will ever contain as the internal split marker rather than
a plain space or newline that real text could collide with).

**Implemented and verified** (2026-09-07) for Test Attributes, the
second rollout item — a `testAttributes` topic on the section header
covering the grid's purpose and each column, plus two further, more
targeted topics: `additionalInfo` (its dual role — general context and
a binding, attribute-specific classification rule, cross-referencing
the Testwork Grid's own help) and `successCriteria`/`failureCriteria`.
The existing hover-only `#criteria-tooltip` (shared between both
criteria columns, shown via `onmouseenter`/`onmouseleave`) was removed
entirely and replaced by dedicated help icons on each column header
using the same shared mechanism — no hover-only implementation remains
on this grid. Verified against the dev server: all four topics open
with correct titles and content; the `additionalInfo` topic's content
was spot-checked for the classification-rule example text.

**Implemented and verified** (2026-09-07) for the Exceptions, Findings
and Recommendations grid, the third rollout item — an `exceptionsGrid`
topic on the section header covering the Ref numbering scheme (the
shared `#` sequence vs. each type's own letter-prefixed sequence),
reclassifying an item via the Type dropdown (including which direction
needs the pass/fail confirmation and which doesn't), and the three-way
delete confirmation, cross-referencing the Testwork Grid's own help for
the type definitions themselves rather than repeating them. Verified
against the dev server: popup opens with correct content, confirmed via
`innerText` (not `innerHTML`, since tag boundaries split literal
substring matches) that the Ref numbering examples, the reclassify
explanation, and the three-way delete choices are all present and
accurate.

**Implemented and verified** (2026-09-07) for Attached Sample Files, the
fourth rollout item — a `sampleFiles` topic on the section header
covering the original-vs-annotated-copy relationship (never modified in
place; every annotated copy always fully rebuilt from pristine bytes;
deleting an original doesn't delete anything that names it, just flags
it as no longer attached) and what the storage-status dot and Original
badge mean. The existing static Legend at the bottom of the section
(the dot/badge explanations) was left in place rather than removed — it
was already always-visible and self-explanatory, not a hover-only
pattern needing migration — with the new help topic providing the
fuller explanation and restating what the Legend's own indicators mean,
so a person can read everything in one place if they open the popup.
Verified against the dev server: popup opens with correct content,
covering the original-vs-annotated relationship, the storage
indicators, and the Original badge.

Migrating the remaining hover-only annotation-type popup remains per
the rollout list above.
