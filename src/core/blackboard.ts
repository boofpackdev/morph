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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MorphPhase, MorphState } from "../schemas/contracts.js";
import { MorphStateSchema } from "../schemas/contracts.js";

const STATE_DIR = ".morph";
const STATE_FILE = "state.json";
const HISTORY_DIR = "history";
const RECOVERY_DIR = "recovery";

export function getMorphDir(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function getStatePath(cwd: string): string {
  return path.join(getMorphDir(cwd), STATE_FILE);
}

export function getHistoryDir(cwd: string): string {
  return path.join(getMorphDir(cwd), HISTORY_DIR);
}

export function getRecoveryDir(cwd: string): string {
  return path.join(getMorphDir(cwd), RECOVERY_DIR);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createInitialState(): MorphState {
  return {
    phase: "idle",
    config: { source: "inherited" },
    workResults: [],
    tokenLedger: { spark: 0, plan: 0, work: 0, review: 0, ship: 0, total: 0 },
    activeAgents: [],
    flowCheckpoints: {},
    retries: {},
    decisions: [],
  };
}

export interface ArchivedMorphState {
  path: string;
  modifiedAt: Date;
  state: MorphState;
}

/**
 * Central Blackboard -" load, mutate, and save morph state.
 */
export class Blackboard {
  private cwd: string;
  private state: MorphState;
  private listeners: Array<() => void> = [];
  private dirty = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    ensureDir(getMorphDir(cwd));
    ensureDir(getHistoryDir(cwd));
    ensureDir(getRecoveryDir(cwd));
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
        if (result.success) {
          // Backfill startedAt for legacy state files
          if (!result.data.startedAt && result.data.phase !== "idle") {
            result.data.startedAt = new Date().toISOString();
          }
          return result.data;
        }
        const repaired = repairPersistedState(parsed);
        const repairedResult = MorphStateSchema.safeParse(repaired);
        if (repairedResult.success) {
          this.archiveState(parsed, "repaired");
          fs.writeFileSync(statePath, JSON.stringify(repairedResult.data, null, 2) + "\n", "utf-8");
          if (!repairedResult.data.startedAt && repairedResult.data.phase !== "idle") {
            repairedResult.data.startedAt = new Date().toISOString();
          }
          return repairedResult.data;
        }
        // Malformed state - archive and start fresh
        this.archiveState(parsed, "malformed");
      } catch {
        // Corrupt file - start fresh
      }
    }
    const initial = createInitialState();
    // Backfill startedAt for legacy state files
    if (!initial.startedAt && initial.phase !== "idle") {
      initial.startedAt = new Date().toISOString();
    }
    return initial;
  }

  /** Schedule a deferred save. Multiple calls within the same tick only flush once. */
  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimeout) {
      this.saveTimeout = setTimeout(() => this.flush(), 0);
    }
  }

  /** Flush all pending mutations to disk immediately. Called at phase boundaries. */
  flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (!this.dirty) return;
    this.dirty = false;

    const statePath = getStatePath(this.cwd);
    ensureDir(getMorphDir(this.cwd));

    // Atomic write with random temp filename
    const tmpPath = `${statePath}.${crypto.randomUUID()}.tmp`;
    const payload = JSON.stringify(this.state, null, 2) + "\n";
    fs.writeFileSync(tmpPath, payload, "utf-8");
    try {
      fs.renameSync(tmpPath, statePath);
    } catch (err: any) {
      if (err.code === "EPERM" || err.code === "EBUSY") {
        // Retry rename with backoff before falling back to direct write
        let renamed = false;
        for (let retry = 0; retry < 3; retry++) {
          try { fs.renameSync(tmpPath, statePath); renamed = true; break; } catch { /* retry */ }
          const start = Date.now();
          while (Date.now() - start < 50) { /* 50ms backoff */ }
        }
        if (!renamed) {
          console.warn(`morph: atomic rename failed after retries, falling back to direct write for ${statePath}`);
          fs.writeFileSync(statePath, payload, "utf-8");
        }
        try { fs.unlinkSync(tmpPath); } catch { /* cleanup */ }
      } else {
        throw err;
      }
    }
    this.notify();
  }

  /** Persist current state to disk (delegates to batched scheduleSave). */
  private save(): void {
    this.scheduleSave();
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

  /** Persist a recoverable snapshot of the current state before risky mutations. */
  archiveCurrentState(reason: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(
      getHistoryDir(this.cwd),
      `snapshot-${reason}-${ts}.json`
    );
    fs.writeFileSync(archivePath, JSON.stringify(this.state, null, 2), "utf-8");
    return archivePath;
  }

  /** Get full current state (read-only snapshot). */
  getState(): Readonly<MorphState> {
    return this.state;
  }

  /** Persist a human-readable recovery report for inspection outside state.json. */
  writeRecoveryReport(taskId: string, markdown: string): string {
    const recoveryDir = getRecoveryDir(this.cwd);
    ensureDir(recoveryDir);
    const safeTaskId = taskId.replace(/[^a-z0-9._-]+/gi, "-");
    const reportPath = path.join(recoveryDir, `${safeTaskId}-latest.md`);
    fs.writeFileSync(reportPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf-8");
    return reportPath;
  }

  /** Return recoverable archived snapshots, newest first. */
  getRecoverableArchives(): ArchivedMorphState[] {
    const historyDir = getHistoryDir(this.cwd);
    if (!fs.existsSync(historyDir)) return [];

    return fs.readdirSync(historyDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(historyDir, name))
      .map((archivePath) => {
        try {
          const raw = fs.readFileSync(archivePath, "utf-8");
          const parsed = JSON.parse(raw);
          const repaired = repairPersistedState(parsed);
          const result = MorphStateSchema.safeParse(repaired);
          if (!result.success || !isMeaningfulState(result.data)) return null;
          return {
            path: archivePath,
            modifiedAt: fs.statSync(archivePath).mtime,
            state: result.data,
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ArchivedMorphState => Boolean(entry))
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  /** Restore a previously archived snapshot into active state. */
  restoreArchivedState(archive: ArchivedMorphState): void {
    this.state = archive.state;
    this.dirty = true;
    this.flush();
  }

  /** Transition to a new phase. Enforces valid flow. */
  transition(target: MorphPhase): void {
    if (!this.state.startedAt && target !== "idle") {
      this.state.startedAt = new Date().toISOString();
    }
    this.state.phase = target;
    this.dirty = true;
    this.flush();
  }

  /** Update global config overrides (e.g. from TUI). */
  setConfig(config: { provider?: string; model?: string; source?: "inherited" | "manual" }): void {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  setPipelinePrompt(prompt: string): void {
    this.state.pipelinePrompt = prompt;
    this.save();
  }

  getFlowCheckpoint(phase: string, key: string): string | undefined {
    return this.state.flowCheckpoints[phase]?.[key];
  }

  setFlowCheckpoint(phase: string, key: string, value: string): void {
    this.state.flowCheckpoints[phase] = {
      ...(this.state.flowCheckpoints[phase] || {}),
      [key]: value,
    };
    this.save();
  }

  clearFlowCheckpoints(phase?: string): void {
    if (phase) delete this.state.flowCheckpoints[phase];
    else this.state.flowCheckpoints = {};
    this.save();
  }

  /** Store spark output and move to plan phase. */
  setSparkOutput(output: MorphState["sparkOutput"]): void {
    this.state.sparkOutput = output;
    delete this.state.planTelemetry;
    delete this.state.flowCheckpoints.spark;
    this.state.phase = "plan";
    this.dirty = true;
    this.flush();
  }

  /** Store plan output and move to work phase. */
  setPlanOutput(output: MorphState["planOutput"]): void {
    this.state.planOutput = output;
    delete this.state.flowCheckpoints.plan;
    this.state.phase = "work";
    this.dirty = true;
    this.flush();
  }

  setPlanTelemetry(output: MorphState["planTelemetry"]): void {
    this.state.planTelemetry = output;
    this.save();
  }

  /** Add or update a work task result. */
  addWorkResult(result: MorphState["workResults"][number]): void {
    const existingIdx = this.state.workResults.findIndex(
      (r) => r.taskId === result.taskId
    );
    if (existingIdx >= 0) {
      this.state.workResults[existingIdx] = result;
    } else {
      this.state.workResults.push(result);
    }
    this.save();
  }

  /** Clear work results for specific tasks (to trigger re-work). */
  clearWorkResults(taskIds?: string[]): void {
    const idsToRemove = taskIds ? new Set(taskIds) : null;
    const removesCompletedWork = this.state.workResults.some(
      (result) =>
        result.status === "done" &&
        (!idsToRemove || idsToRemove.has(result.taskId))
    );

    if (removesCompletedWork) {
      this.archiveCurrentState("before-work-result-clear");
    }

    if (!taskIds) {
      this.state.workResults = [];
    } else {
      this.state.workResults = this.state.workResults.filter(
        (r) => !idsToRemove!.has(r.taskId)
      );
    }
    this.save();
  }

  /** Set work phase done, move to review. */
  finishWork(): void {
    // A new review pass should not inherit the previous verdict after fixes
    // return from WORK.
    this.state.reviewOutput = undefined;
    this.state.reviewTelemetry = undefined;
    delete this.state.flowCheckpoints.review;
    this.state.phase = "review";
    this.dirty = true;
    this.flush();
  }

  /** Store review output. */
  setReviewOutput(output: MorphState["reviewOutput"]): void {
    this.state.reviewOutput = output;
    delete this.state.flowCheckpoints.review;
    if (output?.status === "APPROVED") {
      this.state.phase = "ship";
    } else {
      this.state.phase = "work"; // Loop back
    }
    this.dirty = true;
    this.flush();
  }

  setReviewTelemetry(output: MorphState["reviewTelemetry"]): void {
    this.state.reviewTelemetry = output;
    this.save();
  }

  /** Store ship output. */
  setShipOutput(output: MorphState["shipOutput"]): void {
    this.state.shipOutput = output;
    delete this.state.flowCheckpoints.ship;
    this.state.phase = "done";
    this.dirty = true;
    this.flush();
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
      this.state.reviewTelemetry = undefined;
      delete this.state.flowCheckpoints.review;
      this.state.phase = "work";
    } else if (phase === "work") {
      // Keep completed tasks, just reset phase
      this.state.phase = "work";
    } else if (phase === "plan") {
      if (this.state.workResults.some((result) => result.status === "done")) {
        this.archiveCurrentState("before-plan-reset");
      }
      this.state.planOutput = undefined;
      this.state.workResults = [];
      delete this.state.flowCheckpoints.plan;
      this.state.phase = "spark";
    }
    this.dirty = true;
    this.flush();
  }

  /** Get a summary of the state for agent context. */
  getContextualSummary(maxTokens: number = 2000): string {
    const s = this.state;
    const lines: string[] = [`# Morph State -" Phase: ${s.phase}`];
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
      const failed = s.workResults.filter((r) => r.status === "failed").length;
      lines.push(`Progress: ${done} done, ${failed} failed, ${blocked} blocked`);
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

    const checkpointEntries = Object.entries(s.flowCheckpoints);
    if (checkpointEntries.length > 0) {
      lines.push("## Recovery Checkpoints");
      for (const [phase, checkpoints] of checkpointEntries) {
        const keys = Object.keys(checkpoints);
        if (keys.length > 0) {
          lines.push(`- ${phase}: ${keys.join(", ")}`);
        }
      }
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

function repairPersistedState(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const repaired = structuredClone(data as Record<string, unknown>) as Record<string, any>;

  // Older parser versions could accidentally persist many more than the
  // contract's 8 core features by swallowing nested bullets/code blocks.
  // Preserve the flow and clamp it back to the current contract instead of
  // discarding the whole blackboard.
  if (Array.isArray(repaired.sparkOutput?.coreFeatures) && repaired.sparkOutput.coreFeatures.length > 8) {
    repaired.sparkOutput.coreFeatures = repaired.sparkOutput.coreFeatures
      .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 8);
  }

  if (repaired.sparkOutput && !repaired.sparkOutput.productShape) {
    repaired.sparkOutput.productShape = {
      deliverableType: "unspecified product",
      runtime: "unspecified runtime",
      distribution: "unspecified distribution",
      explicitUserIntent:
        typeof repaired.pipelinePrompt === "string" && repaired.pipelinePrompt.trim()
          ? repaired.pipelinePrompt.trim().slice(0, 300)
          : "Intent not captured in older state",
    };
  }

  return repaired;
}

function isMeaningfulState(state: MorphState): boolean {
  return (
    state.phase !== "idle" &&
    state.phase !== "done" &&
    (
      Boolean(state.pipelinePrompt?.trim()) ||
      Boolean(state.sparkOutput) ||
      Boolean(state.planOutput) ||
      state.workResults.length > 0 ||
      Boolean(state.reviewOutput) ||
      Boolean(state.shipOutput) ||
      state.tokenLedger.total > 0 ||
      state.decisions.length > 0 ||
      Object.values(state.flowCheckpoints).some((phase) => Object.keys(phase).length > 0)
    )
  );
}
