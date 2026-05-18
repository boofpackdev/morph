# Changelog

## 0.7.11 - Keep humans for judgment, not cleanup

### Added
- Shared browser-gate design system for Spark, pre-work, review, and exception decisions
- A distinct release-exception gate when Morph cannot clear the ship-readiness floor or repair the issue automatically
- Review telemetry that explains specialist routing, synthesis, and next steps in the TUI and browser gates
- Dark mode, markdown-lite rendering, accessible status icons, and dynamic mobile spacing for browser gate pages

### Changed
- Ordinary Review → Ship approval now appears only for real ship candidates under a pragmatic quality floor
- Below-floor reviews with precise task IDs return to targeted repair instead of broad rework
- Below-floor reviews without safe automatic repair now pause for explicit human exception handling

### Fixed
- Automatic review no longer runs when WORK is incomplete after recovery
- Vague negative reviews no longer clear completed work results wholesale
- Stale review output and telemetry are cleared before a fresh review pass

## 0.7.10 - Say what is true now

### Fixed
- Startup no longer posts an “unfinished flow detected” warning when the user immediately resumes that flow into active execution
- Recovery notices are now shown only when a flow is actually paused and waiting for an operator action
- Resume messaging now distinguishes an active recovered run from an idle recoverable snapshot

## 0.7.9 - Create the room before entering it

### Fixed
- Work tasks whose `targetDir` does not exist yet now launch from the project root instead of failing before they can create the directory
- Repo-relative task file verification now stays anchored at the project root even when agents work inside nested target directories
- Target-directory guidance now tells agents when the directory may need to be created as part of the task

## 0.7.8 - Manual recovery means retry

### Fixed
- Explicit `/morph:recover` now clears the selected failed work branch even when the failure is intentionally not auto-safe
- Startup “Resume now” prepares work recovery before rerunning the phase instead of immediately re-halting on persisted failed results
- Manual recovery and startup resume now share the same failed-branch reset behavior

### Changed
- Automatic recovery remains conservative, while operator-chosen recovery now behaves like an actual retry command

## 0.7.7 - Stop spinning on ghosts

### Added
- `CLI_LAUNCH_FAILURE` classification for missing runtime / process-launch failures
- Richer child-process diagnostics with spawn errors, structured agent errors, last assistant output, and recent non-JSON stdout

### Fixed
- Stale blocked tasks are cleared once their dependencies have recovered, so resumed branches become runnable again
- Recovery no longer fixates on a blocked leaf whose dependencies are already complete
- Dead current-runtime paths are no longer selected for pi relaunches
- Auto-recovery now consumes durable retry budget when it clears failed work, preventing infinite first-attempt loops

### Packaging
- Follow-up npm release so installed pi packages can receive the 0.7.x recovery fixes instead of remaining on older published builds

## 0.7.6 - Recover the real branch

### Added
- Automatic serialization for same-wave tasks that target the same concrete file
- Explicit `AUTH_OR_QUOTA_FAILURE` classification for provider-credit and API-key failures
- Agent-launch diagnostics that identify whether Morph used the current pi CLI, a known install, or PATH fallback

### Changed
- Live file activity is now scoped to each task's declared file targets when available
- Resumed work reports the original DAG wave number instead of restarting labels at wave 1
- Worktree collision displays mark unexpected task/file combinations more clearly

### Fixed
- Recovery now follows dependency-blocked children back to the real failed ancestor
- Auto-recovery clears stale blocked descendants when retrying a failed root task
- Busy WORK no longer presents itself as idle just because no agent event is visible for a moment
- Quota/auth failures no longer burn through routine auto-retry loops as if they were transient tool glitches
- Work task results are persisted exactly once, avoiding duplicate bookkeeping during execution
- Git helper paths no longer emit noisy “not a git repository” failures when the target folder has no repo
- Work failure cleanup now clears stale live-agent/file activity instead of leaving the board dirty

## 0.7.5 - Exorcise `nul`

### Changed
- Scaffold commit setup now uses native git-root detection instead of shell redirection tricks

### Fixed
- Windows reserved device names such as `nul`, `con`, and `prn` are ignored by live file-activity tracking
- False-positive live file collisions against pseudo-paths like `nul` no longer appear

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
