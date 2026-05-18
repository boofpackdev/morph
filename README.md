# MORPH

<p align="center">
<pre style="color: #00ff00; background: #000; padding: 20px; border: 2px solid #00ff00; border-radius: 4px; display: inline-block; font-family: monospace; font-weight: bold;">
    __  ___                 __  
   /  |/  /___  _________  / /_ 
  / /|_/ / __ \/ ___/ __ \/ __ \
 / /  / / /_/ / /  / /_/ / / / /
/_/  /_/\____/_/  / .___/_/ /_/ 
                 /_/            
</pre>
</p>

**AGENT ORCHESTRATION PIPELINE FOR PI**

[![VERSION](https://img.shields.io/badge/VERSION-0.7.9-00ff00?style=for-the-badge&labelColor=000000)](https://npmjs.org/package/@boofpackdev/pi-morph)
[![LICENSE](https://img.shields.io/badge/LICENSE-MIT-ff9900?style=for-the-badge&labelColor=000000)](https://opensource.org/licenses/MIT)
[![STATUS](https://img.shields.io/badge/STATUS-ACTIVE-00ccff?style=for-the-badge&labelColor=000000)](#)

---

## <span style="color: #ff9900;">SYNOPSIS</span>

`morph` is a strict, 5-stage deterministic state machine designed to transform high-level intent into verified software artifacts. It orchestrates specialized agent teams within `pi`, enforcing strict data handoffs through a centralized **Blackboard** and a Directed Acyclic Graph (DAG) execution engine.

It utilizes a Hub-and-Spoke consensus model, deterministic git-diff validation, and an exhaustive 10-state Autorecovery Taxonomy to prevent hallucination loops and ensure architectural integrity without operator babysitting.

## <span style="color: #ff9900;">1. STATE MACHINE & DATA CONTRACTS</span>

The pipeline evolves a "Product Shape" through five strictly enforced Zod schemas. Progression is impossible without a validated state extraction.

| PHASE | AGENTS | OUTPUT SCHEMA | DESCRIPTION |
| :--- | :--- | :--- | :--- |
| **SPARK** | Visionary, Critic | `SparkOutputSchema` | Extracts core features, risk parameters, and the exact Deliverable Type. |
| **PLAN** | Architect, QA, Efficiency | `PlanOutputSchema` | Synthesizes Mermaid architecture, Data Models, and the JSON Task DAG. |
| **WORK** | Engineer, Peer Reviewer | `WorkTaskResultSchema` | Executes DAG tasks. Requires strict git-diff validation to pass. |
| **REVIEW** | Tech Lead, QA, Perf, User | `ReviewOutputSchema` | Generates a 1-10 Efficiency Score and a definitive GO / NO-GO verdict. |
| **SHIP** | DevOps, Release Consultant | `ShipOutputSchema` | Computes SEMVER, changelog, and a step-by-step rollback procedure. |

## <span style="color: #ff9900;">2. DAG EXECUTION ENGINE</span>

The `Work` phase execution is strictly controlled by a DAG Router (`src/core/engine.ts`).

- **Topological Sorting:** Tasks are resolved via Kahn's algorithm based on `dependsOn` arrays. Cycles will throw exceptions and trigger Plan-phase auto-repair.
- **Wave Parallelization:** Tasks with resolved dependencies are grouped into execution waves and processed in parallel batches (default `maxParallel: 3`).
- **File Target Overlap Detection:** Analyzes target files across waves. If concurrent edits to the same file are detected (`severity: "high"`), the engine applies `serializeHighSeverityFileOverlaps` to rewrite the DAG, forcing sequential execution to prevent git-patch collisions.
- **Truthful Completion Verification:** A task is never marked `done` based on LLM output alone. Morph compares a pre-task and post-task git worktree snapshot. If no file delta is detected, the task fails verification.

## <span style="color: #ff9900;">3. AUTONOMOUS AUTORECOVERY TAXONOMY</span>

When an execution failure occurs, Morph diagnoses the state and categorizes it into one of 10 taxonomical states (`diagnoseRecoveryState`). Safe failures are retried automatically; critical failures halt execution and generate markdown incident reports.

- <span style="color: #ff3333;">`NO_EFFECT`</span>: The agent claimed success, but no git-diff was produced. *Auto-safe retry.*
- <span style="color: #ff3333;">`TOOL_FAILURE`</span>: Internal system exception or subprocess crash. *Auto-safe retry.*
- <span style="color: #ff3333;">`CLI_LAUNCH_FAILURE`</span>: Node/pi process spawn failure. *Halts pipeline.*
- <span style="color: #ff3333;">`AUTH_OR_QUOTA_FAILURE`</span>: API limits reached or 401 Unauthorized. *Halts pipeline.*
- <span style="color: #ff3333;">`REVIEW_REJECTED`</span>: The Peer Reviewer agent rejected the implementation. Feedback is automatically injected into the next Engineer retry attempt. *Auto-safe retry.*
- <span style="color: #ff3333;">`REVIEW_FORMAT_INVALID`</span>: Reviewer failed to provide a valid APPROVED/REJECTED verdict. *Auto-safe retry.*
- <span style="color: #ff3333;">`VERIFICATION_FAILED`</span>: File changes were detected, but they did not match the expected targets declared in the Task Node. *Auto-safe retry.*
- <span style="color: #ff3333;">`DEPENDENCY_BLOCKED`</span>: A parent task failed, recursively blocking all children. The engine will not retry blocked children until the parent is repaired. *Halts pipeline.*
- <span style="color: #ff3333;">`TASK_UNDERSPECIFIED`</span>: The LLM rejected the task due to fog-of-war. Requires replanning. *Halts pipeline.*
- <span style="color: #ff3333;">`STATE_INCONSISTENT`</span>: The Blackboard and repository state diverge impossibly (e.g., marked done but zero worktree changes). *Auto-safe retry (wipes stale state).*

## <span style="color: #ff9900;">4. HUB-AND-SPOKE CONSENSUS PROTOCOL</span>

To prevent context bloat and hallucination loops, agents do not chat freely. They use a strict hub-and-spoke synthesis model.

- **Plan Synthesis:** The Lead Architect drafts a DAG. The QA Expert analyzes it for edge cases, and the Efficiency Manager checks for redundant loops. The Architect is then re-invoked to synthesize the feedback into a final JSON array.
- **Review Routing:** The `determineReviewRouting` system uses regex heuristics against the codebase diff to determine if the QA Auditor, Performance Guru, or End User agents need to be invoked. The Tech Lead then synthesizes their parallel reports into a final verdict.

## <span style="color: #ff9900;">5. CENTRALIZED BLACKBOARD & CONSERVATION</span>

- **Atomic File Swaps:** All context is read/written atomically to `.morph/state.json` via `.tmp` file renaming to prevent corruption.
- **Fallback JSON Repair:** `repairPersistedState` dynamically fixes malformed states (e.g., truncating bloated array limits from older parsers) instead of destroying the Blackboard.
- **Internal Monologue Stripping:** `<thinking>` tokens and chain-of-thought blocks are purged via `stripReasoningTokens` before state handoffs.
- **Context Sliding Window:** Deep retry loops aggressively truncate historical context to prevent the window from collapsing during extended debugging sessions.
- **Differential Patching:** `diff.ts` invokes `git diff --no-index` for clean, unified patch blocks. If git fails, it falls back to an internal Longest Common Subsequence (LCS) matrix diff.

## <span style="color: #ff9900;">6. MISSION CONTROL TUI & BROWSER GATES</span>

- **Live TUI Display:** Displays pipeline telemetry (`PipelineDisplay`), execution waves, real-time file-modification activity (`FileActivity`), and live token ledger costs via `@earendil-works/pi-tui`.
- **Pre-Work Approval Gate:** Before implementation begins, Morph generates `work-spec.md` and `work-approval.html`, launching a local REST/WebSocket server (`localhost:4040/api/approve`). The DAG must be explicitly approved via browser or terminal.
- **Final Handoff Artifacts:** Produces a comprehensive `final-report.md` / `final-report.html` detailing the quickstart guide, inferred project root, delivered architecture, and rollback instructions.
- **Auto-Scaffolding Protection:** Configuration tasks automatically execute `git commit -m "morph: auto-commit"` so Morph's internal `git stash push` checkpoints do not accidentally wipe untracked scaffolding logic.

## <span style="color: #ff9900;">INSTALLATION</span>

```bash
pi install @boofpackdev/pi-morph
```

## <span style="color: #ff9900;">CLI CONTROL</span>

### <span style="color: #00ccff;">SHORTCUTS</span>
<pre style="background: #111; color: #00ff00; padding: 10px; border-left: 4px solid #ff9900; font-family: monospace;">
CTRL+M G : Full Guided Pipeline
CTRL+M S : Spark (Idea Refinement)
CTRL+M P : Plan (Architecture)
CTRL+M W : Work (Implementation)
CTRL+M R : Review (Audit)
CTRL+M H : Ship (Release)
</pre>

### <span style="color: #00ccff;">DAEMON COMMANDS</span>
```text
/morph:run <idea>  Start a new project
/morph:recover     Diagnose and resume from an Autorecovery failure state
/morph:status      Poll Blackboard for phase/token telemetry
/morph:reset       Purge local .morph/ context and kill active agents
```

---
<div align="center" style="color: #444; font-size: 0.8em; letter-spacing: 0.2em;">MORPH OPERATIONAL DATA · EOF</div>
