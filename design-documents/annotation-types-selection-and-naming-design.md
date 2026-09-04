# Design: User-selectable annotation types, and Adobe-accurate naming

## Part 1 — Adobe-accurate naming for each mechanism

Verified directly against Adobe's own documentation and the PDF
specification, rather than the app's own internal, arbitrary names. One
distinction is worth being precise about before the naming itself: two of
the four mechanisms draw directly into the page's own content — the same
category as ordinary page text, permanently merged in — which the industry
term is **flattened**. The other two create real, separate, selectable
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
| Hybrid | A hybrid: a small, plain circle that is flattened page content (the same category as the burned-in copy, not a true PDF Shape annotation, even though it looks like one), plus a genuine Sticky Note beside it holding the actual text. | `annotated_mn` |
| Burned-in inline copy | Flattened page content — drawn rectangles and text merged directly into the page, indistinguishable from the page's own original content. Never appears in the Comments panel; not individually selectable. | `annotated_bi` |

Renaming these has one real, practical consequence worth naming directly:
several places in the code already recognize a file by its own current
suffix — to skip re-annotating an already-annotated copy, and to exclude a
derived copy from being treated as an original. Every one of those checks
needs to be updated to the new suffix at the same time the suffix itself
changes, not after, or a rename could silently break the very logic that
currently prevents duplicate or looping annotation.

## Part 2 — Letting the person choose which types to generate

This connects directly to an idea already discussed earlier in this
project: giving someone a choice on the "Analyze & Create Workpaper" modal
for which annotation output(s) they actually want, rather than always
generating all four automatically in the background on every single run.

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
that person's own standing preference; the next time this modal opens, it
starts pre-checked to match, rather than resetting to the same fixed
starting point every single time. This is a straightforward, direct
persistence problem — no different in shape from a preference already
handled the same way elsewhere in this same project — remembered per
person, not per workpaper or per session, so the choice follows them
regardless of which workpaper they're currently working in.

The one thing worth deciding for a person's genuine first-ever use, before
any preference exists to load: a real, initial default is still needed,
since there's nothing yet to remember at that point. A reasonable starting
point: the burned-in copy and the sticky-notes copy checked (the two most
immediately useful — one for a plain, universally-viewable copy, one for
genuine, editable review comments), with the form-field and
marks-and-notes copies available but unchecked. This initial default only
ever matters once, for a person's first real use — every use after that is
governed by whatever they actually chose last time, not this starting
point.

**What changes in the actual generation code.** Each of the four wiring
functions already runs as an independent, parallel, fire-and-forget call
after Analyze completes. The change here is small and localized: each call
becomes conditional on its own corresponding checkbox being checked, rather
than always firing unconditionally. None of the four mechanisms' own
internal logic needs to change for this — only whether each one gets
invoked at all for a given run.

**A related, worthwhile pairing.** Now that library-load failures for the
two comment-based mechanisms surface as a direct, visible alert rather than
failing silently, it's worth deciding whether an unchecked type should even
attempt to load its own library preemptively, or only load it lazily at the
moment it's actually needed — the latter avoids any startup cost for a type
nobody asked for on a given run.
