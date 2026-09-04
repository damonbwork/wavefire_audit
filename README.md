# WaveFire Handoff Package — How to Use With Claude Code

This package hands off an in-progress session on the WaveFire Audit SaaS
app to Claude Code, so a new session there has full context without you
needing to re-explain anything.

## What's in this zip

```
wavefire-handoff/
├── README.md                          ← this file
├── CHRONOLOGICAL_LOG.md                ← full session history, in order
├── REQUIREMENTS_SUMMARY.md             ← distilled current state — read this first
├── design-documents/
│   ├── pass-fail-override-and-sync-plan.md
│   ├── annotation-types-selection-and-naming-design.md
│   └── admin-file-inventory-design.md
└── source-code/
    ├── auditflow_artifact.html         ← current frontend
    └── server.js                       ← current backend
```

## How to install this for Claude Code

1. **Unzip this file** somewhere convenient (your Desktop, Downloads, or
   wherever you keep temporary files) — you don't need to unzip it
   directly inside your project folder.

2. **Copy the two source files into your actual WaveFire project folder**,
   overwriting the versions already there:
   - `source-code/auditflow_artifact.html` → your project's frontend file
     (wherever your actual, deployed HTML file lives — likely named
     `auditflow_artifact.html` or similar in your repo)
   - `source-code/server.js` → your project's backend file

   **Important:** these are the current, latest versions from this
   session — including two fixes that have NOT yet been confirmed
   working (see the "start here" note below). Confirm you actually want
   to overwrite before doing so, especially if you've made any local
   changes since the last file you received from this conversation.

3. **Copy the three remaining items into your project folder too** (in
   any subfolder you like — a `docs/` or `handoff/` folder works well, or
   directly in the project root):
   - `CHRONOLOGICAL_LOG.md`
   - `REQUIREMENTS_SUMMARY.md`
   - the entire `design-documents/` folder

   These aren't application code — Claude Code doesn't need them to run
   the app, but having them in the project folder means Claude Code can
   read them directly if you point it at them, without you needing to
   paste anything.

4. **Start a new Claude Code session in that project folder**, and as
   your first message, say something like:

   > Read REQUIREMENTS_SUMMARY.md first, then CHRONOLOGICAL_LOG.md if you
   > need more detail on anything specific. There's an unresolved bug
   > described at the end of the summary and the end of the log — that's
   > where we left off.

## Where things actually stand (read this before anything else)

The single most important unresolved item: **the "hybrid" (mn) PDF
annotation type produces a file that Adobe Acrobat reports as damaged.**
A temporary diagnostic is already built into `auditflow_artifact.html` to
help figure out exactly why — search the file for the text `TEMPORARY
DIAGNOSTIC` to find it. The next concrete step is running Analyze with
that annotation type checked, downloading the diagnostic file it produces,
and checking whether *that* file opens correctly in Acrobat. Full detail
on why this matters and what each possible outcome means is in the
"STATUS AT END OF LOG" section at the very bottom of
`CHRONOLOGICAL_LOG.md`, and in section 4 of `REQUIREMENTS_SUMMARY.md`.

There's also a second, related fix (`No /DA entry found`, on a different
annotation type) that was made but never confirmed working — it's
possible the version you were testing against didn't actually include the
fix yet. Section 4 of `REQUIREMENTS_SUMMARY.md` explains this too.

## A note on verifying deployments

Several times this session, a reported bug turned out to be caused by a
stale, not-yet-deployed version of the code rather than a real problem
with the fix itself. The reliable way to check: open the live, deployed
page, view its page source (Ctrl+U on Windows/Linux, Cmd+Option+U on Mac),
and search for a specific string that only exists in the latest version of
whatever was just changed. If it's there, the deploy worked. If it's not,
redeploy before assuming a fix didn't work. This is mentioned because it's
a real, recurring source of confusion in this project specifically — the
deployment pipeline appears to lag behind the actual source files at
times.

## If you're not sure where to start

Read `REQUIREMENTS_SUMMARY.md` top to bottom first — it's organized by
topic, not chronologically, and tells you plainly what's fixed and
confirmed, what's fixed but unconfirmed, what's fully built, and what's
still just a design document with no code behind it yet. Only go to
`CHRONOLOGICAL_LOG.md` when you need the specific reasoning or sequence of
events behind something the summary mentions.
