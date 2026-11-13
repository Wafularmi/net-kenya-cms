# TODO — Transcript Generator "raws are not defined" Error

## Status: FIXED (2026-11-13)

## Root cause
`buildProfessionalTranscript()` referenced `displayRows` (never defined) when computing "Total Courses" in the Academic Summary block. JavaScript threw `ReferenceError: displayRows is not defined`, which aborted transcript generation and surfaced as an error toast.

## Fix
Changed `${displayRows.length}` to `${resultRows.length}` (the variable that actually holds the resolved course rows). Committed as 75432e4, pushed, and deployed.

## Verification
- Hard refresh (`Ctrl+F5`) to load `bundle.min.js?v=519`.
- Generate a transcript for a student with grades — it should now render without error.

