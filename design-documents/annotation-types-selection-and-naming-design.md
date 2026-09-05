# Design: User-selectable annotation types, and Adobe-accurate naming

## Part 1 — Adobe-accurate naming for each mechanism

Verified directly against Adobe's own documentation and the PDF
specification, rather than the app's own internal, arbitrary names. One
distinction is worth being precise about before the naming itself: one of
the four mechanisms draws directly into the page's own content — the same
category as ordinary page text, permanently merged in — which the industry
term is **flattened**. The other three create real, separate, selectable
objects layered on top of the page, which is what the term **annotation**
formally refers to in the PDF spec. These are genuinely different
categories of thing, not just different visual styles, and the naming
should reflect that honestly rather than call something an "annotation"
that's actually flattened content.

The table below doubles as the actual selection interface described in
Part 2 — hover the section header where these outputs are chosen to reveal
it, with a checkbox on each row for whether that specific type gets
generated on the next Analyze run.

| Annotated File Type | Acrobat Characteristics | Annotated File Suffix |
|---|---|---|
| Form-field copy | Real AcroForm fields — formally, **Widget annotations** in the PDF spec, the same underlying object type used for fillable forms. Shows up under Acrobat's "Prepare Form" tool. | `annotated_ff` |
| Sticky Note | A genuine PDF **Text annotation** — what Acrobat's own UI calls a **Sticky Note**. Appears as an icon, expands on click, shown in the Comments panel. | `annotated_sn` |
| Burned-in inline copy | Flattened page content — drawn rectangles and text merged directly into the page, indistinguishable from the page's own original content. Never appears in the Comments panel; not individually selectable. | `annotated_bi` |
| Movable stamp copy | A real PDF **Stamp annotation**, whose appearance stream is the exact same drawn mark (background, symbol, attribute number, and note) the burned-in copy draws directly onto the page — but registered as a genuine `/Annots` object instead of page content. Click-selectable and freely movable in Acrobat with the ordinary Select tool, no need to enter Edit PDF. | `annotated_bi2` |

**Superseded: the "Hybrid" type.** An earlier version of this design
included a fifth type, "Hybrid" (`annotated_mn`) — a small flattened circle
paired with a genuine Sticky Note beside it. It has been removed from the
selection UI, the hover table, and the generation code entirely, per
direct request. `annotated_bi2` above is its replacement for the
"selectable as one object" use case Hybrid was originally reaching for,
achieved more directly — one real annotation per mark, rather than pairing
a flattened shape with a separate Sticky Note.

**Renaming consequences.** Several places in the code recognize a file by
its own current suffix — to skip re-annotating an already-annotated copy,
and to exclude a derived copy from being treated as an original. Every one
of those checks needs to stay in sync with the suffix currently in use;
this was the concrete failure mode when Hybrid was removed and again when
Movable stamp copy was added, so any future rename or addition should
budget for updating this same set of checks at the same time.

## Part 2 — Letting the person choose which types to generate

This connects directly to an idea already discussed earlier in this
project: giving someone a choice on the "Analyze & Create Workpaper" modal
for which annotation output(s) they actually want, rather than always
generating all of them automatically in the background on every single run.

**Where it lives, and how it's shown.** The natural home is the same modal
already holding the data-selection checkboxes and the external-search
checkbox. Per direct request, the actual selection surface is the table
from Part 1 itself, shown as a hover revealed from that section's own
header — the person sees exactly what each type actually is in real
Acrobat terms at the same moment they're deciding whether to generate it,
rather than choosing from bare labels with no explanation behind them.

**What should be selected by default — and how that default should
actually work.** Rather than a single, fixed default that never changes,
this should remember what the same person actually chose the last time
they ran Analyze, and default to that going forward. Concretely: after
Analyze runs, whatever combination of checkboxes was checked gets saved as
that person's own standing preference (`users.annotation_type_prefs`,
persisted server-side); the next time this modal opens, it starts
pre-checked to match, rather than resetting to the same fixed starting
point every single time. This is remembered per person, not per workpaper
or per session, so the choice follows them regardless of which workpaper
they're currently working in.

The one thing worth deciding for a person's genuine first-ever use, before
any preference exists to load: a real, initial default is still needed,
since there's nothing yet to remember at that point. The current starting
point: **Burned-in inline copy** and **Sticky Note** checked (the two most
immediately useful — one for a plain, universally-viewable copy, one for
genuine, editable review comments), with **Form-field copy** and
**Movable stamp copy** available but unchecked. This initial default only
ever matters once, for a person's first real use — every use after that is
governed by whatever they actually chose last time, not this starting
point.

**What changes in the actual generation code.** Each of the four wiring
functions runs as an independent, parallel, fire-and-forget call after
Analyze completes. Each call is conditional on its own corresponding
checkbox being checked, rather than always firing unconditionally. None of
the four mechanisms' own internal logic depends on this — only whether
each one gets invoked at all for a given run.

**Library dependencies, per type.** Worth knowing when reasoning about
load cost or failure modes:
- **Burned-in inline copy** and **Movable stamp copy** — pdf-lib only, no
  external library.
- **Form-field copy** — pdf-lib only (its own native AcroForm support).
- **Sticky Note** — pdf-lib plus a second library, `pdfAnnotate`
  (loaded from CDN), needed to write genuine incremental-update `/Annots`
  entries in a form Acrobat accepts.

Each type's library only loads lazily, at the moment it's actually
invoked — an unchecked type costs nothing on a given run.

## Part 3 — The exception & result model these annotations render

Every one of the four mechanisms above draws from the same underlying
per-attribute result the model returns during Analyze. Understanding that
result shape is what "exception" actually means in this app, independent
of which annotation type is rendering it.

**The four result states.** Each attribute, for each matched sample file,
gets exactly one `result` value:

| `result` value | Meaning | Symbol drawn (bi / bi2) |
|---|---|---|
| `pass` | The attribute was tested and satisfied — no issue found. | Green check |
| `pass_exception` | The attribute was tested, and something noteworthy was found, but it does not amount to an outright failure — a qualified pass. | Red X |
| `fail` | The attribute was tested and did not hold. | Red X |
| `error` (default fallback) | No usable result was returned for this attribute/file pairing at all. | Red X |

**A real, current limitation worth flagging:** the burned-in and movable-
stamp mechanisms (`bi`/`bi2`) only distinguish `pass` from everything else
when choosing the symbol's color — `pass_exception`, `fail`, and `error`
all draw as the same red X, even though the app's own `TICK_COLS` mapping
(used elsewhere, e.g. the standalone tick-mark-only mechanism feeding the
Sticky Note pipeline) defines three visually distinct colors for
`pass_exception`, `fail`, and `error`. Someone reviewing a `bi`/`bi2` file
in isolation cannot currently tell a qualified pass-with-exception apart
from an outright failure or a genuine testing error by color alone — only
the "Exception E#: ..." detail text (present for `pass_exception`/`fail`,
absent for a bare `error`) distinguishes them, and only if that detail
text is actually visible/read.

**Exception numbering.** "Exception" specifically refers to `pass_exception`
and `fail` results — an `error` result is not counted as an exception, even
though it also renders as a red X currently. Each qualifying result
increments a single running counter (`exNum`) as the mechanism walks every
attribute, in order, for a given sample file — so a file with three
exception-worthy results gets them labeled `Exception E1`, `Exception E2`,
`Exception E3` in the order they're encountered, not in any other stable
ordering (e.g. not by attribute number or page). The detail text drawn
beneath the mark for an exception is `Exception E<n>: <note>` when a note
is present, or just `Exception E<n>` when it isn't; a `pass` or `error`
result with a note instead shows the bare note text, unlabeled.

**Where this could go next**, if worth pursuing separately: giving
`pass_exception`/`fail`/`error` visually distinct colors on `bi`/`bi2` to
match `TICK_COLS`, so someone opening only a burned-in or movable-stamp
copy — without cross-referencing the in-app results view — can tell these
three states apart without reading each note.
