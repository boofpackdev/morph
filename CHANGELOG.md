# Changelog

## 0.7.4 - Fewer collisions, less exhaust

### Added
- Plan-time concrete file-target overlap detection with high/medium severity based on execution wave
- File-overlap warnings in Plan Intelligence and the browser approval report
- Live Work-board collision warnings when concurrent tasks touch the same real source file

### Changed
- Worktree activity ignores generated/cache noise such as `.pytest_cache`, `__pycache__`, and Python bytecode artifacts

### Fixed
- Runtime cache churn no longer crowds meaningful source changes out of the Work board
- Parallel tasks that converge on the same source file are now visible before and during implementation

## 0.7.3 - Better doctrine, better instruments

### Added
- Phase-scoped skill profiles for Spark, Plan, and retry/recovery behavior
- Recovery reports now include Morph's debugging doctrine so operators can see how a retry is being reasoned about
- Live lane freshness hints in the Work board (`active now`, `quiet 37s`, `quiet 5m`)

### Changed
- Spark and Plan now record which skill profiles shaped their output for easier auditability
- Token totals keep one decimal place above 1k so live growth is visible instead of rounding itself into invisibility

### Fixed
- Work progress no longer shows contradictory task counts between the left rail and the Work Control panel
- Live Work rendering now uses one task truth source while tasks are in flight

## 0.7.2 — Harder to derail

### Added
- Deterministic Plan fallbacks for markdown task tables and component tables
- DAG repair flow for duplicate IDs, dangling dependencies, and cyclic task graphs

### Changed
- Plan recovery now accepts bare JSON arrays, malformed JSON task blocks, and rich alternate artifacts as salvage sources
- Spark and Review parsing now tolerate numbered headings as well as the canonical section format

### Fixed
- Plan can recover from rich plans whose JSON DAG contains malformed string escaping
- Plan preserves stronger earlier artifacts when a later synthesis is weak or tool-only
- Spark falls back to the stronger draft when final synthesis is non-substantive
- Review no longer accepts `APPROVED` verdicts that still carry major or critical required changes

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
