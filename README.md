# morph — Agent Orchestration Layer for pi

**5-stage pipeline**: spark → plan → work → review → ship

morph streamlines your workflow by orchestrating specialized agent teams through a complete software development lifecycle — all inside pi.

## Pipeline

| Phase | Command | Team | Output |
|-------|---------|------|--------|
| **Spark** | `/morph:spark <idea>` | Visionary + Critic (2) | Refined PRD |
| **Plan** | `/morph:plan` | Architect + QA + Efficiency (3) | Architecture + Task DAG |
| **Work** | `/morph:work` | Engineer + Reviewer per task (2) | Code Artifacts |
| **Review** | `/morph:review` | Tech Lead + QA + Perf + User (4) | Approval/Reject Report |
| **Ship** | `/morph:ship` | DevOps + Release Consultant (2) | Release + Changelog |

## Agent Teams

### Spark (2 agents)
- **Visionary** — Creative product thinker, envisions solutions
- **Critic** — Sharp skeptic, stress-tests ideas

### Plan (3 agents)
- **Lead Architect** — Designs architecture, components, task DAG
- **QA Expert** — Test strategy and acceptance criteria
- **Efficiency Manager** — Optimization and cost reduction

### Work (2 agents per task)
- **Primary Engineer** — Implements with clean, tested code
- **Peer Reviewer** — Audits for correctness and edge cases

### Review (4 agents)
- **Tech Lead** — Final verdict on architecture and quality
- **QA Auditor** — Test coverage and edge case analysis
- **Performance Guru** — Bottlenecks and optimization
- **End User / Customer** — Real user perspective simulation

### Ship (2 agents)
- **DevOps / SRE** — Pre-release verification, deployment, rollback
- **Release Consultant** — Changelog, versioning, stakeholder communication

## Commands

| Command | Description |
|---------|-------------|
| `/morph:spark <idea>` | Start a new pipeline — refine idea into PRD |
| `/morph:plan` | Create architecture plan from PRD |
| `/morph:work` | Execute task DAG (pauses per wave for approval) |
| `/morph:review` | Audit implementation with 4 reviewers |
| `/morph:ship` | Release with verification and changelog |
| `/morph:status` | Show current pipeline state |
| `/morph:reset [phase]` | Reset to a specific phase or full reset |
| `/morph:team` | Show agent team composition |

## Architecture

### Blackboard Pattern
All state is centralized in `.morph/state.json`. Agents read from and write to the blackboard — no direct agent-to-agent chat, which prevents hallucination loops and context bloat.

### DAG Execution
The Plan phase outputs a Directed Acyclic Graph of tasks. The Work phase executes tasks in topological order with parallel execution of independent tasks.

### Token Efficiency
- **Internal monologue stripping**: `<think>` and reasoning blocks removed before handoff
- **Context sliding window**: Only last 3 turns kept for loop debugging
- **Diff-based patching**: Agents produce diffs, not full file rewrites
- **Targeted model routing**: Heavy models for planning, fast models for review

### Human-in-the-Loop
- **Post-Spark**: PRD shown for approval before Plan
- **Per-Wave**: Each work wave requires confirmation
- **Ctrl+C**: Graceful abort with state preservation

## Installation

```bash
# Install as a pi package
pi install git:github.com/who/morph

# Or from local path
pi install /path/to/morph
```

State is saved to `.morph/state.json` in your working directory.

## Prompt Templates

morph includes prompt templates for quick access:

- `/pipeline <idea>` — Full pipeline walkthrough
- `/spark <idea>` — Spark phase only
- `/plan` — Plan phase
- `/work` — Work phase
- `/review` — Review phase
- `/ship` — Ship phase

## Standalone CLI

```bash
npx morph status   # Show pipeline state
npx morph reset    # Reset pipeline
npx morph help     # Show help
```

## Requirements

- pi v1.0+ with a configured API key (Anthropic recommended)
- Node.js 18+ or Bun

## License

MIT
