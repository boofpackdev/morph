# Changelog

## 0.7.0 — Reliable recovery, fewer needless approvals

### Added
- Human-readable recovery reports under `.morph/recovery/`
- Structured Work failure metadata, including failure kind, evidence, attempts, and verification details
- Completion verification gates so tasks cannot be marked done without repo evidence
- Plan-quality checks that reject placeholder or underspecified implementation plans before Work begins
- Archived-state recovery support for damaged or stale blackboard snapshots

### Changed
- Work now follows a balanced flow: the browser-approved work spec remains the human gate, while approved waves execute automatically
- Safe in-scope failures auto-recover inside Work instead of requiring repeated `/morph:recover` confirmations
- Review rejections automatically loop back into Work when fixes remain inside the approved scope
- Provider/model changes clear stale tool-failure results so the next run actually retries with the new config
- Work progress and recovery messaging now distinguish failed, blocked, and completed tasks more truthfully

### Fixed
- Prevented zero-change tasks from being accepted as successful work
- Prevented Review from running against incomplete Work unless explicitly requested
- Clamped malformed Spark feature lists back to the supported contract size when recovering older persisted state
