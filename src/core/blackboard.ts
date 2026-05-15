/**
 * morph — Blackboard Pattern
 *
 * Centralized state management. Agents never hold state in their own memory.
 * They read from and write to .morph/state.json (the "Blackboard").
 *
 * Responsibilities:
 *   - Atomic read/write of morph state
 *   - Context sliding window (truncation on loops)
 *   - Token ledger tracking
 *   - Decision history logging
 *   - Phase transition enforcement
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MorphPhase, MorphState } from "../schemas/contracts.js";
import { MorphStateSchema } from "../schemas/contracts.js";

const STATE_DIR = ".morph";
const STATE_FILE = "state.json";
const HISTORY_DIR = "history";

export function getMorphDir(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function getStatePath(cwd: string): string {
  return path.join(getMorphDir(cwd), STATE_FILE);
}

export function getHistoryDir(cwd: string): string {
  return path.join(getMorphDir(cwd), HISTORY_DIR);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createInitialState(): MorphState {
  return {
    phase: "idle",
    config: {},
    workResults: [],
    tokenLedger: { spark: 0, plan: 0, work: 0, review: 0, ship: 0, total: 0 },
    activeAgents: [],
    retries: {},
    decisions: [],
  };
}

/**
 * Central Blackboard — load, mutate, and save morph state.
 */
export class Blackboard {
  private cwd: string;
  private state: MorphState;
  private listeners: Array<() => void> = [];

  constructor(cwd: string) {
    this.cwd = cwd;
    ensureDir(getMorphDir(cwd));
    ensureDir(getHistoryDir(cwd));
    this.state = this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** Add an agent to the active list. */
  addActiveAgent(agentName: string): void {
    if (!this.state.activeAgents.includes(agentName)) {
      this.state.activeAgents.push(agentName);
      this.save();
    }
  }

  /** Remove an agent from the active list. */
  removeActiveAgent(agentName: string): void {
    this.state.activeAgents = this.state.activeAgents.filter(
      (a) => a !== agentName
    );
    this.save();
  }

  /** Clear all active agents. */
  clearActiveAgents(): void {
    this.state.activeAgents = [];
    this.save();
  }

  /** Load state from disk, or initialize fresh. */
  private load(): MorphState {
    const statePath = getStatePath(this.cwd);
    if (fs.existsSync(statePath)) {
      try {
        const raw = fs.readFileSync(statePath, "utf-8");
        const parsed = JSON.parse(raw);
        const result = MorphStateSchema.safeParse(parsed);
        if (result.success) return result.data;
        // Malformed state — archive and start fresh
        this.archiveState(parsed, "malformed");
      } catch {
        // Corrupt file — start fresh
      }
    }
    return createInitialState();
  }

  /** Persist current state to disk. */
  save(): void {
    const statePath = getStatePath(this.cwd);
    ensureDir(getMorphDir(this.cwd));

    // Atomic write
    const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this.state, null, 2) + "\n";
    fs.writeFileSync(tmpPath, payload, "utf-8");
    try {
      fs.renameSync(tmpPath, statePath);
    } catch (err: any) {
      if (err.code === "EPERM" || err.code === "EBUSY") {
        fs.writeFileSync(statePath, payload, "utf-8");
        try { fs.unlinkSync(tmpPath); } catch { /* cleanup */ }
      } else {
        throw err;
      }
    }
    this.notify();
  }

  /** Archive current state for debugging. */
  private archiveState(data: unknown, reason: string): void {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(
      getHistoryDir(this.cwd),
      `archived-${reason}-${ts}.json`
    );
    fs.writeFileSync(archivePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Get full current state (read-only snapshot). */
  getState(): Readonly<MorphState> {
    return this.state;
  }

  /** Transition to a new phase. Enforces valid flow. */
  transition(target: MorphPhase): void {
    this.state.phase = target;
    this.save();
  }

  /** Update global config overrides (e.g. from TUI). */
  setConfig(config: { provider?: string; model?: string }): void {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  /** Store spark output and move to plan phase. */
  setSparkOutput(output: MorphState["sparkOutput"]): void {
    this.state.sparkOutput = output;
    this.state.phase = "plan";
    this.save();
  }

  /** Store plan output and move to work phase. */
  setPlanOutput(output: MorphState["planOutput"]): void {
    this.state.planOutput = output;
    this.state.phase = "work";
    this.save();
  }

  /** Add a completed work task result. */
  addWorkResult(result: MorphState["workResults"][number]): void {
    this.state.workResults.push(result);
    this.save();
  }

  /** Set work phase done, move to review. */
  finishWork(): void {
    this.state.phase = "review";
    this.save();
  }

  /** Store review output. */
  setReviewOutput(output: MorphState["reviewOutput"]): void {
    this.state.reviewOutput = output;
    if (output?.status === "APPROVED") {
      this.state.phase = "ship";
    } else {
      this.state.phase = "work"; // Loop back
    }
    this.save();
  }

  /** Store ship output. */
  setShipOutput(output: MorphState["shipOutput"]): void {
    this.state.shipOutput = output;
    this.state.phase = "done";
    this.save();
  }

  /** Add tokens to the ledger for a phase. */
  addTokens(phase: keyof MorphState["tokenLedger"], amount: number): void {
    const ledger = this.state.tokenLedger;
    if (phase in ledger) {
      (ledger as Record<string, number>)[phase] += amount;
      ledger.total += amount;
    }
    this.save();
  }

  /** Record a decision for audit trail. */
  recordDecision(
    phase: string,
    decision: string,
    reason: string
  ): void {
    this.state.decisions.push({
      phase,
      decision,
      reason,
      timestamp: new Date().toISOString(),
    });
    this.save();
  }

  /** Increment retry count for a task. */
  incrementRetry(taskId: string): number {
    const count = (this.state.retries[taskId] || 0) + 1;
    this.state.retries[taskId] = count;
    this.save();
    return count;
  }

  /** Reset a phase's progress (for retries). */
  resetPhase(phase: MorphPhase): void {
    if (phase === "review") {
      this.state.reviewOutput = undefined;
      this.state.phase = "work";
    } else if (phase === "work") {
      // Keep completed tasks, just reset phase
      this.state.phase = "work";
    } else if (phase === "plan") {
      this.state.planOutput = undefined;
      this.state.workResults = [];
      this.state.phase = "spark";
    }
    this.save();
  }

  /** Get a summary of the state for agent context. */
  getContextualSummary(maxTokens: number = 2000): string {
    const s = this.state;
    const lines: string[] = [`# Morph State — Phase: ${s.phase}`];
    lines.push("");

    if (s.sparkOutput) {
      lines.push("## Spark (PRD)");
      lines.push(`Vision: ${s.sparkOutput.visionStatement.slice(0, 300)}`);
      lines.push(
        `Features: ${s.sparkOutput.coreFeatures.slice(0, 5).join(", ")}`
      );
      lines.push(`Persona: ${s.sparkOutput.targetUserPersona.slice(0, 200)}`);
      lines.push(`Stack: ${s.sparkOutput.technicalStackRecommendation}`);
      lines.push("");
    }

    if (s.planOutput) {
      lines.push("## Plan");
      lines.push(
        `Tasks: ${s.planOutput.tasks.length} (${s.planOutput.estimatedEffort})`
      );
      const done = s.workResults.filter((r) => r.status === "done").length;
      const blocked = s.workResults.filter((r) => r.status === "blocked").length;
      lines.push(`Progress: ${done} done, ${blocked} blocked`);
      lines.push(`QA: ${s.planOutput.qaStrategy.slice(0, 200)}`);
      lines.push("");
    }

    if (s.reviewOutput) {
      lines.push("## Review");
      lines.push(
        `Status: ${s.reviewOutput.status} | Score: ${s.reviewOutput.efficiencyScore}/10`
      );
      if (s.reviewOutput.requiredChanges.length > 0) {
        lines.push(`Changes needed: ${s.reviewOutput.requiredChanges.length}`);
      }
      lines.push("");
    }

    if (s.shipOutput) {
      lines.push("## Ship");
      lines.push(`Status: ${s.shipOutput.status} | Version: ${s.shipOutput.version}`);
      lines.push("");
    }

    lines.push("## Token Costs");
    const l = s.tokenLedger;
    lines.push(
      `Spark: ${l.spark} | Plan: ${l.plan} | Work: ${l.work} | Review: ${l.review} | Ship: ${l.ship} | Total: ${l.total}`
    );

    const joined = lines.join("\n");
    if (joined.length > maxTokens * 4) {
      return joined.slice(0, maxTokens * 4);
    }
    return joined;
  }

  /** Get total estimated cost based on tokens. */
  getEstimatedCost(ratePer1kTokens: number = 0.003): number {
    return this.state.tokenLedger.total * (ratePer1kTokens / 1000);
  }

  /** Format the state as a compact one-liner for status bars. */
  statusLine(): string {
    const s = this.state;
    const tasks = s.planOutput?.tasks.length ?? 0;
    const done = s.workResults.filter((r) => r.status === "done").length;
    return `morph:${s.phase} | tasks:${done}/${tasks} | tokens:${s.tokenLedger.total}`;
  }
}
