/**
 * morph — Execution Engine & DAG Router
 *
 * The brain of the orchestrator. Controls phase transitions,
 * DAG-based task execution ordering, retry logic, and HITL checkpoints.
 *
 * Architecture:
 *   - Topological sort of task DAG
 *   - Parallel execution of independent tasks
 *   - Retry loop (max 3 per task)
 *   - Phase state machine enforcement
 */

import type { MorphPhase, TaskNode, WorkTaskResult } from "../schemas/contracts.js";
import { Blackboard } from "./blackboard.js";
import { estimateTokens } from "./tokenizer.js";

export interface EngineConfig {
  maxRetriesPerTask: number;
  maxParallelTasks: number;
  hitlCheckpoints: boolean; // Human-in-the-loop pause points
}

const DEFAULT_CONFIG: EngineConfig = {
  maxRetriesPerTask: 3,
  maxParallelTasks: 4,
  hitlCheckpoints: true,
};

/**
 * Topological sort of tasks based on dependsOn.
 * Returns tasks in execution order. Throws on cycles.
 */
export function topologicalSort(tasks: TaskNode[]): TaskNode[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }

  // Build graph
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!taskMap.has(depId)) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${depId}"`
        );
      }
      adjacency.get(depId)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: TaskNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(taskMap.get(id)!);
    for (const neighbor of adjacency.get(id) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== tasks.length) {
    throw new Error("Cycle detected in task dependencies");
  }

  return sorted;
}

/**
 * Group tasks by execution wave (tasks in same wave have no dependencies on each other).
 */
export function waveGroups(tasks: TaskNode[]): TaskNode[][] {
  const sorted = topologicalSort(tasks);
  const waves: TaskNode[][] = [];
  const completed = new Set<string>();

  while (completed.size < sorted.length) {
    const wave: TaskNode[] = [];
    for (const task of sorted) {
      if (completed.has(task.id)) continue;
      const depsDone = task.dependsOn.every((d) => completed.has(d));
      if (depsDone) {
        wave.push(task);
      }
    }
    for (const task of wave) {
      completed.add(task.id);
    }
    waves.push(wave);
  }

  return waves;
}

export interface FileTargetOverlap {
  file: string;
  taskIds: string[];
  waveNumbers: number[];
  severity: "high" | "medium";
  suggestion: string;
}

export function detectFileTargetOverlaps(tasks: TaskNode[]): FileTargetOverlap[] {
  const waves = waveGroups(tasks);
  const waveByTaskId = new Map<string, number>();
  waves.forEach((wave, index) => wave.forEach((task) => waveByTaskId.set(task.id, index + 1)));

  const taskIdsByFile = new Map<string, Set<string>>();
  for (const task of tasks) {
    for (const file of task.files ?? []) {
      const normalized = normalizeExpectedFileTarget(task.targetDir, file);
      if (!normalized || normalized.includes("*")) continue;
      const taskIds = taskIdsByFile.get(normalized) ?? new Set<string>();
      taskIds.add(task.id);
      taskIdsByFile.set(normalized, taskIds);
    }
  }

  return [...taskIdsByFile.entries()]
    .filter(([, taskIds]) => taskIds.size > 1)
    .map(([file, taskIds]) => {
      const ids = [...taskIds].sort();
      const waveNumbers = [...new Set(ids.map((id) => waveByTaskId.get(id)).filter((wave): wave is number => wave !== undefined))].sort((a, b) => a - b);
      const sameWave = waveNumbers.length < ids.length;
      const severity: FileTargetOverlap["severity"] = sameWave ? "high" : "medium";
      return {
        file,
        taskIds: ids,
        waveNumbers,
        severity,
        suggestion: sameWave
          ? "Merge duplicate work or add dependencies so these tasks do not edit the file concurrently."
          : "Confirm each task owns a distinct edit to this shared artifact.",
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function normalizeExpectedFileTarget(targetDir: string | undefined, file: string): string {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedDir = targetDir?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalizedDir || normalizedDir === ".") return normalizedFile;
  return `${normalizedDir}/${normalizedFile}`;
}

/**
 * Select tasks ready to execute (all dependencies done and not yet completed).
 */
export function getReadyTasks(
  tasks: TaskNode[],
  completedIds: Set<string>
): TaskNode[] {
  return tasks.filter(
    (task) =>
      !completedIds.has(task.id) &&
      task.dependsOn.every((dep) => completedIds.has(dep))
  );
}

/**
 * Check if a retry is allowed for a task.
 */
export function canRetry(
  taskId: string,
  blackboard: Blackboard,
  maxRetries: number
): boolean {
  const retries = blackboard.getState().retries[taskId] || 0;
  return retries < maxRetries;
}

/**
 * Determine which phase comes next in the pipeline.
 */
export function nextPhase(current: MorphPhase): MorphPhase {
  const order: MorphPhase[] = [
    "idle",
    "spark",
    "plan",
    "work",
    "review",
    "ship",
    "done",
  ];
  const idx = order.indexOf(current);
  if (idx < 0 || idx >= order.length - 1) return "done";
  return order[idx + 1];
}

/**
 * Determine if a phase can progress forward.
 * Review → Work is a valid backward transition (fix loop).
 */
export function canTransitionTo(
  from: MorphPhase,
  to: MorphPhase
): boolean {
  const validTransitions: Record<MorphPhase, MorphPhase[]> = {
    idle: ["spark"],
    spark: ["plan"],
    plan: ["work"],
    work: ["review"],
    review: ["ship", "work"], // APPROVED → ship, else → work
    ship: ["done"],
    done: [],
  };
  return (validTransitions[from] || []).includes(to);
}

/**
 * Format a task DAG as a text summary for agent context.
 */
export function formatDAG(tasks: TaskNode[]): string {
  const waves = waveGroups(tasks);
  const lines: string[] = ["# Execution Plan (DAG)", ""];

  for (let i = 0; i < waves.length; i++) {
    lines.push(`## Wave ${i + 1} (${waves[i].length} tasks)`);
    for (const task of waves[i]) {
      const deps = task.dependsOn.length > 0
        ? ` [depends: ${task.dependsOn.join(", ")}]`
        : "";
      lines.push(
        `- [${task.id}] ${task.category} | ${task.description}${deps}`
      );
    }
    lines.push("");
  }

  lines.push(`Total: ${tasks.length} tasks in ${waves.length} waves`);
  return lines.join("\n");
}

/**
 * Format task results as a progress summary.
 */
export function formatProgress(
  results: WorkTaskResult[],
  tasks: TaskNode[]
): string {
  const lines: string[] = ["# Work Progress", ""];
  const resultMap = new Map(results.map((r) => [r.taskId, r]));
  const done = results.filter((r) => r.status === "done").length;
  const blocked = results.filter((r) => r.status === "blocked").length;
  const failed = results.filter((r) => r.status === "failed").length;

  lines.push(`Progress: ${done}/${tasks.length} done`);
  if (blocked > 0) lines.push(`Blocked: ${blocked}`);
  if (failed > 0) lines.push(`Failed: ${failed}`);
  lines.push("");

  for (const task of tasks) {
    const result = resultMap.get(task.id);
    const icon = result
      ? result.status === "done"
        ? "✓"
        : result.status === "blocked"
          ? "⊘"
          : "✗"
      : "○";
    const summary = result ? ` — ${result.summary.slice(0, 100)}` : "";
    lines.push(`  ${icon} [${task.id}] ${task.description}${summary}`);
  }

  return lines.join("\n");
}

/**
 * Estimate total tokens for a phase based on task descriptions.
 */
export function estimatePhaseTokens(tasks: TaskNode[]): number {
  let total = 0;
  for (const task of tasks) {
    total += estimateTokens(task.description);
    total += estimateTokens(task.acceptanceCriteria);
  }
  return total;
}
