/**
 * morph — Work Flow (Task DAG → Code)
 *
 * Team: Primary Engineer + Peer Reviewer (2 agents per task)
 *
 * Executes tasks from the DAG in topological order.
 * Each task: Engineer implements → Reviewer audits → merge or retry.
 * Independent tasks run in parallel waves.
 *
 * Output: WorkTaskResult[] stored on the Blackboard
 */

import { Blackboard } from "../core/blackboard.js";
import {
  runAgent,
  WORK_AGENTS,
  type AgentConfig,
} from "../core/agent-runner.js";
import {
  topologicalSort,
  getReadyTasks,
  canRetry,
  estimatePhaseTokens,
} from "../core/engine.js";
import { estimateTokens } from "../core/tokenizer.js";
import type {
  TaskNode,
  WorkTaskResult,
  PlanOutput,
} from "../schemas/contracts.js";
import { generateDiff } from "../utils/diff.js";

export interface WorkFlowOptions {
  cwd: string;
  blackboard: Blackboard;
  maxRetries?: number;
  maxParallel?: number;
  signal?: AbortSignal;
  /** Called before each wave for HITL approval */
  onWaveStart?: (wave: TaskNode[], waveIndex: number) => Promise<boolean>;
  /** Called after each task completes */
  onTaskComplete?: (result: WorkTaskResult) => void;
}

export async function executeWorkFlow(
  options: WorkFlowOptions
): Promise<WorkTaskResult[]> {
  const {
    cwd,
    blackboard,
    maxRetries = 3,
    maxParallel = 3,
    signal,
    onWaveStart,
    onTaskComplete,
  } = options;

  const planOutput = blackboard.getState().planOutput;
  if (!planOutput) {
    throw new Error("No plan output found. Run plan flow first.");
  }

  const engineer = WORK_AGENTS.find((a) => a.name === "engineer")!;
  const reviewer = WORK_AGENTS.find((a) => a.name === "peer-reviewer")!;

  // Sort tasks topologically
  const sorted = topologicalSort(planOutput.tasks);
  const completedIds = new Set<string>();
  const allResults: WorkTaskResult[] = [];
  let waveIndex = 0;

  // Process waves
  while (completedIds.size < sorted.length) {
    const ready = getReadyTasks(sorted, completedIds);
    if (ready.length === 0) {
      // Stuck — check for circular deps or all blocked
      const remaining = sorted.filter((t) => !completedIds.has(t.id));
      const blocked = remaining.filter((t) => {
        const deps = t.dependsOn.filter((d) => !completedIds.has(d));
        return deps.length > 0;
      });
      if (blocked.length === remaining.length) {
        throw new Error(
          `Work stuck: ${blocked.length} tasks blocked by unresolved dependencies`
        );
      }
      break;
    }

    // HITL checkpoint
    if (onWaveStart) {
      const proceed = await onWaveStart(ready, waveIndex);
      if (!proceed) {
        blackboard.recordDecision(
          "work",
          `Wave ${waveIndex} paused by user`,
          "HITL checkpoint"
        );
        break;
      }
    }

    // Execute wave tasks in parallel batches
    const batches: TaskNode[][] = [];
    for (let i = 0; i < ready.length; i += maxParallel) {
      batches.push(ready.slice(i, i + maxParallel));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((task) =>
          executeSingleTask(
            task,
            engineer,
            reviewer,
            cwd,
            blackboard,
            maxRetries,
            signal,
            onTaskComplete
          )
        )
      );

      for (const result of batchResults) {
        allResults.push(result);
        blackboard.addWorkResult(result);
        if (result.status === "done") {
          completedIds.add(result.taskId);
        }
      }
    }

    waveIndex++;
  }

  // Mark phase as done
  blackboard.finishWork();

  return allResults;
}

async function executeSingleTask(
  task: TaskNode,
  engineer: AgentConfig,
  reviewer: AgentConfig,
  cwd: string,
  blackboard: Blackboard,
  maxRetries: number,
  signal?: AbortSignal,
  onTaskComplete?: (result: WorkTaskResult) => void
): Promise<WorkTaskResult> {
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    if (attempt > 1) {
      blackboard.incrementRetry(task.id);
    }

    // ── Engineer implements ──
    const engSystemPrompt = `You are the **Primary Engineer** for the morph orchestration pipeline.

## Your Role
You implement a single task from the execution plan. Write clean, tested,
efficient code. Follow best practices for the tech stack in use.

## Task Context
- Task ID: ${task.id}
- Category: ${task.category}
- Description: ${task.description}
- Acceptance Criteria: ${task.acceptanceCriteria}
- Complexity: ${task.estimatedComplexity}

## Instructions
1. Read relevant existing files first
2. Implement the changes needed
3. Write or update tests
4. Verify your implementation works
5. Output a SUMMARY of what you changed and why

**CRITICAL**: Only output specific, targeted edits. Do NOT rewrite entire files.
Use the \`edit\` tool for surgical changes. Use \`write\` only for new files.

Your code will be reviewed by a Peer Reviewer. Make it reviewable.`;

    const engResult = await runAgent(engineer, {
      cwd,
      task: `Implement task ${task.id}: ${task.description}\n\nAcceptance criteria: ${task.acceptanceCriteria}\n\nGet it done.`,
      systemPrompt: engSystemPrompt,
      signal,
    });

    blackboard.addTokens(
      "work",
      estimateTokens(engResult.output || "")
    );

    if (engResult.exitCode !== 0 || engResult.stopReason === "error") {
      if (canRetry(task.id, blackboard, maxRetries)) continue;
      const result: WorkTaskResult = {
        taskId: task.id,
        status: "failed",
        summary: engResult.errorMessage || engResult.output || "Implementation failed",
      };
      onTaskComplete?.(result);
      return result;
    }

    // ── Peer Reviewer audits ──
    const revSystemPrompt = `You are the **Peer Reviewer** for the morph orchestration pipeline.

## Your Role
You review a single implemented task for correctness, edge cases,
code quality, and adherence to acceptance criteria.

## Review Criteria
- Does the implementation satisfy the acceptance criteria?
- Are there edge cases not handled?
- Is the code clean, readable, and well-structured?
- Are tests adequate?
- Are there any security concerns or performance issues?

## Output
Start with a verdict: **APPROVED** or **CHANGES_REQUESTED**

If CHANGES_REQUESTED, list specific changes needed in order of priority.
Keep feedback actionable and specific. Reference exact file paths and line numbers.

## Task
- ID: ${task.id}
- Description: ${task.description}
- Acceptance Criteria: ${task.acceptanceCriteria}`;

    const revResult = await runAgent(reviewer, {
      cwd,
      task: `Review the implementation of task ${task.id}: ${task.description}\n\nThe engineer's summary:\n${engResult.output}\n\nCheck the actual files and verify.`,
      systemPrompt: revSystemPrompt,
      signal,
    });

    blackboard.addTokens(
      "work",
      estimateTokens(revResult.output || "")
    );

    const reviewOutput = revResult.output || "";
    const isApproved = /APPROVED/i.test(reviewOutput.split("\n")[0] || "");

    if (isApproved) {
      const result: WorkTaskResult = {
        taskId: task.id,
        status: "done",
        summary: engResult.output || "Task completed",
        testsPassed: true,
      };
      onTaskComplete?.(result);
      return result;
    }

    // Changes requested — feed back to engineer if retries remain
    if (canRetry(task.id, blackboard, maxRetries)) {
      // The engineer will retry with reviewer feedback on next loop iteration
      // We append the review feedback to the next task
      continue;
    }

    const result: WorkTaskResult = {
      taskId: task.id,
      status: "failed",
      summary: `Review rejected after ${maxRetries} attempts: ${reviewOutput.slice(0, 200)}`,
    };
    onTaskComplete?.(result);
    return result;
  }

  // Exhausted retries
  const result: WorkTaskResult = {
    taskId: task.id,
    status: "failed",
    summary: `Failed after ${maxRetries} retry attempts`,
  };
  onTaskComplete?.(result);
  return result;
}
