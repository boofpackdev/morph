# Changelog

## 0.7.1 — Clearer intent, leaner review

### Added
- Structured Product Shape capture in Spark: deliverable type, runtime/host, distribution path, and explicit user intent
- A prominent “what morph believes it is building” section in the browser approval report
- Spark repair/quality checks that fail early when the product identity is too vague to trust
- Structured Plan telemetry plus a live Plan Intelligence panel that shows target shape, planning signals, recovery state, and next step

### Changed
- Review now starts from deterministic implementation evidence before asking specialist agents for opinions
- QA, performance, and end-user reviewers are invoked conditionally instead of by default
- Plan receives the explicit Product Shape contract so downstream architecture stays anchored to the intended deliverable
- Plan recovery now preserves rich human-readable plans and extracts a machine-readable DAG instead of discarding useful work

### Fixed
- Negative review verdicts can no longer arrive without actionable required changes; Morph asks for a repaired review instead
- Product Shape parsing now accepts markdown-formatted labels such as `**Deliverable Type:**`
- Older persisted states are backfilled with a safe Product Shape placeholder during recovery
- Plan recovery can salvage a strong Architect draft when the final synthesis checkpoint is empty or tool-only output
- Plan parsing now accepts numbered headings such as `## 1. Architecture Diagram`

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
