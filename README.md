# morph — Agent Orchestration Layer for pi

**5-stage pipeline**: spark → plan → work → review → ship

morph streamlines your workflow by orchestrating specialized agent teams through a complete software development lifecycle — all inside pi. It combines a live mission-control TUI, browser approval gates, and **Autonomous Autorecovery**, allowing the pipeline to loop back and fix issues identified during code review without human intervention.

## Pipeline

| Phase | Command | Team | Output |
|-------|---------|------|--------|
| **Spark** | `/morph:run <idea>` (start) | Visionary + Critic (2) | Refined PRD |
| **Plan** | `/morph:plan` | Architect + QA + Efficiency (3) | Architecture + Task DAG |
| **Work** | `/morph:work` | Engineer + Peer Reviewer per task (2) | Code Artifacts |
| **Review** | `/morph:review` | Tech Lead + QA + Perf + User (4) | Approval/Reject Report |
| **Ship** | `/morph:ship` | DevOps + Release Consultant (2) | Release + Changelog |

## Key Features

### Mission-Control TUI
- Live phase dashboard with truthful progress semantics
- Phase-specific operator panels for planning, work, review, and ship
- Active-agent visibility with current tool/action context
- Contextual footer hints for approvals, gates, and next actions

### Browser Approval Gates
- Review pre-work specs in the browser before implementation
- Approve release transitions from either the browser or the pi session
- Keep the interactive terminal flow and browser flow in sync

### Autonomous Autorecovery
When a review is REJECTED, morph analyzes the findings and offers to autorecover. It will:
1. Identify affected tasks from the DAG.
2. Inject the auditor's feedback (Tech Lead, QA, Perf, User) into the next implementation attempt.
3. Loop back to the **Work** phase to autonomously apply fixes.
4. Repeat until the implementation meets all acceptance criteria.

### Blackboard Pattern
All state is centralized in `.morph/state.json`. Agents read from and write to the blackboard — no direct agent-to-agent chat, which prevents hallucination loops and context bloat.

### DAG Execution
The Plan phase outputs a Directed Acyclic Graph of tasks. The Work phase executes tasks in topological order with parallel execution of independent tasks.

### Token Efficiency
- **Internal monologue stripping**: Reasoning blocks removed before handoff.
- **Context sliding window**: Truncation on loops to prevent bloat.
- **Diff-based patching**: Agents produce targeted edits, not full file rewrites.

### Final Handoff Report
After the Ship phase, morph generates final Markdown and HTML reports with:
- project overview
- implementation summary
- quickstart guidance
- release/version details
- links back to key generated artifacts

## Installation

```bash
# Install as a pi package
pi install @boofpackdev/pi-morph

# Or from git
pi install git:github.com/boofpackdev/morph
```

State is saved to `.morph/state.json` in your working directory.

## Standalone CLI

```bash
npx morph status   # Show pipeline state
npx morph reset    # Reset pipeline
npx morph help     # Show help
```

## Commands

| Command | Description |
|---------|-------------|
| `/morph:run [idea]` | **Start/continue guided pipeline** — runs all 5 phases with review gates and autorecovery |
| `/morph:plan` | Create architecture plan from PRD |
| `/morph:work` | Execute task DAG (resumes from progress) |
| `/morph:review` | Audit implementation with 4 reviewers |
| `/morph:ship` | Release with verification and changelog |
| `/morph:status` | Show current pipeline state and costs |
| `/morph:reset [phase]` | Reset to a specific phase or full reset |
| `/morph:team` | Show agent team composition |

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+M G` | **Guided run** — full pipeline with review gates |
| `Ctrl+M S` | Start guided run (uses editor text as input) |
| `Ctrl+M P` | Plan — create architecture |
| `Ctrl+M W` | Work — execute tasks |
| `Ctrl+M R` | Review — audit implementation |
| `Ctrl+M H` | Ship — release with changelog |

## Requirements

- pi v1.0+ with a configured API key
- Node.js 18+

## License

MIT
