/**
 * morph â€” Work Flow (Task DAG â†’ Code)
 *
 * Team: Primary Engineer + Peer Reviewer (2 agents per task)
 *
 * Executes tasks from the DAG in topological order.
 * Each task: Engineer implements â†’ Reviewer audits â†’ merge or retry.
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
  estimatePhaseTokens,
} from "../core/engine.js";
import { estimateTokens } from "../core/tokenizer.js";
import type {
  TaskNode,
  WorkTaskResult,
  PlanOutput,
} from "../schemas/contracts.js";
import { generateDiff } from "../utils/diff.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";

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
  /** Called while a task is running with worktree-derived file changes since task start */
  onTaskActivity?: (taskId: string, activity: WorktreeFileActivity[]) => void;
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void;
}

export interface WorktreeFileActivity {
  taskId: string;
  path: string;
  operation: "add" | "modify" | "delete";
  beforeLines?: number;
  afterLines?: number;
  delta?: number;
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
    onTaskActivity,
    onAgentEvent,
  } = options;

  const planOutput = blackboard.getState().planOutput;
  if (!planOutput) {
    throw new Error("No plan output found. Run plan flow first.");
  }

  const state = blackboard.getState();
  const engineer = WORK_AGENTS.find((a) => a.name === "engineer")!;
  const reviewer = WORK_AGENTS.find((a) => a.name === "peer-reviewer")!;

  // Sort tasks topologically
  const sorted = topologicalSort(planOutput.tasks);
  const completedIds = new Set<string>(
    state.workResults
      .filter((r) => r.status === "done")
      .map((r) => r.taskId)
  );
  const processedIds = new Set<string>(
    state.workResults.map((r) => r.taskId)
  );
  const allResults: WorkTaskResult[] = [...state.workResults];
  let waveIndex = 0;

  // Process waves
  while (processedIds.size < sorted.length) {
    const ready = sorted.filter(
      (task) =>
        !processedIds.has(task.id) &&
        task.dependsOn.every((dep) => completedIds.has(dep))
    );
    if (ready.length === 0) {
      // Stuck â€” check for circular deps or all blocked
      const remaining = sorted.filter((t) => !processedIds.has(t.id));
      const blocked = remaining.filter((t) => {
        const deps = t.dependsOn.filter((d) => !completedIds.has(d));
        return deps.length > 0;
      });
      if (blocked.length === remaining.length) {
        // Mark all blocked tasks as failed
        for (const task of blocked) {
          const result: WorkTaskResult = {
            taskId: task.id,
            status: "blocked",
            summary: `Blocked by failed dependencies: ${task.dependsOn.filter(d => !completedIds.has(d)).join(", ")}`,
            filesChanged: [],
            failureKind: "DEPENDENCY_BLOCKED",
            failureEvidence: [`Unfinished dependencies: ${task.dependsOn.filter(d => !completedIds.has(d)).join(", ")}`],
          };
          allResults.push(result);
          blackboard.addWorkResult(result);
          processedIds.add(task.id);
          onTaskComplete?.(result);
        }
        continue; // Evaluate next state, will exit if all processed
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
            onTaskComplete,
            onTaskActivity,
            onAgentEvent
          )
        )
      );

      for (const result of batchResults) {
        allResults.push(result);
        blackboard.addWorkResult(result);
        processedIds.add(result.taskId);
        if (result.status === "done") {
          completedIds.add(result.taskId);
        }
      }
    }

    waveIndex++;
  }

  // Advance only when every planned task actually completed. Failed/blocked
  // work stays in WORK so review is not run against an incomplete build.
  const finalResultMap = new Map(allResults.map((result) => [result.taskId, result]));
  const allTasksDone = sorted.every((task) => finalResultMap.get(task.id)?.status === "done");
  if (allTasksDone) {
    blackboard.finishWork();
  }

  return allResults;
}

/**
 * Auto-commit scaffold/config tasks so git checkpoint stashes don't eat them.
 */
function commitScaffoldResults(task: TaskNode, cwd: string): void {
  // Only auto-commit config and scaffold-type tasks
  const scaffoldPatterns = ["scaffold", "config", "init", "setup"];
  const isScaffold = scaffoldPatterns.some((p) =>
    task.id.toLowerCase().includes(p) || task.description.toLowerCase().includes(p)
  );
  if (!isScaffold) return;

  try {
    const repoDir = execSync("git rev-parse --show-toplevel 2>nul || echo .", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Add all new/untracked files (this is what the scaffold created)
    execSync(`git add -A`, { cwd: repoDir, timeout: 10000 });

    // Only commit if there's something staged
    const status = execSync(`git status --porcelain`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (status) {
      execSync(`git commit -m "morph: auto-commit ${task.id} â€” ${task.description.slice(0, 60)}" --no-verify`, {
        cwd: repoDir,
        timeout: 10000,
        stdio: "pipe",
      });
    }
  } catch {
    // Not a git repo or git unavailable â€” skip auto-commit silently
  }
}

function findGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function snapshotChangedFiles(repoRoot: string | null): Set<string> {
  if (!repoRoot) return new Set();
  try {
    const output = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .map((file) => file.includes(" -> ") ? file.split(" -> ").pop()!.trim() : file)
    );
  } catch {
    return new Set();
  }
}

function diffChangedFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((file) => !before.has(file)).sort();
}

interface WorktreeFileSnapshot {
  fingerprint: string;
  lineCount?: number;
}

function snapshotWorkingTree(repoRoot: string | null, fallbackRoot?: string): Map<string, WorktreeFileSnapshot> {
  if (!repoRoot) {
    return fallbackRoot ? snapshotPlainDirectory(fallbackRoot) : new Map();
  }
  try {
    const tracked = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter(Boolean);
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .filter(Boolean);
    const files = [...new Set([...tracked, ...untracked])];
    const snapshot = new Map<string, WorktreeFileSnapshot>();
    for (const file of files) {
      const absolute = path.join(repoRoot, file);
      try {
        const stat = fs.statSync(absolute);
        snapshot.set(file, {
          fingerprint: `${stat.mtimeMs}:${stat.size}`,
          lineCount: countLinesIfTextFile(absolute, stat.size),
        });
      } catch {
        snapshot.set(file, { fingerprint: "missing", lineCount: 0 });
      }
    }
    return snapshot;
  } catch {
    return new Map();
  }
}

function countLinesIfTextFile(filePath: string, size?: number): number | undefined {
  try {
    const statSize = size ?? fs.statSync(filePath).size;
    if (statSize > 1_000_000) return undefined;
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content) return 0;
    return content.split(/\r?\n/).length;
  } catch {
    return undefined;
  }
}

function snapshotPlainDirectory(root: string): Map<string, WorktreeFileSnapshot> {
  const snapshot = new Map<string, WorktreeFileSnapshot>();
  const ignoredDirs = new Set([".git", ".morph", "node_modules"]);

  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolute);
        snapshot.set(relative, {
          fingerprint: `${stat.mtimeMs}:${stat.size}`,
          lineCount: countLinesIfTextFile(absolute, stat.size),
        });
      } catch {
        snapshot.set(relative, { fingerprint: "missing", lineCount: 0 });
      }
    }
  };

  visit(root);
  return snapshot;
}

function diffWorkingTree(before: Map<string, WorktreeFileSnapshot>, after: Map<string, WorktreeFileSnapshot>): string[] {
  const changed = new Set<string>();
  for (const [file, snapshot] of after) {
    if (before.get(file)?.fingerprint !== snapshot.fingerprint) changed.add(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.add(file);
  }
  return [...changed].sort();
}

function buildWorktreeActivity(
  taskId: string,
  before: Map<string, WorktreeFileSnapshot>,
  after: Map<string, WorktreeFileSnapshot>
): WorktreeFileActivity[] {
  const changed = diffWorkingTree(before, after);
  return changed.map((file) => {
    const previous = before.get(file);
    const current = after.get(file);
    const operation: WorktreeFileActivity["operation"] =
      !previous && current
        ? "add"
        : previous && !current
          ? "delete"
          : "modify";
    const beforeLines = previous?.lineCount ?? (operation === "add" ? 0 : undefined);
    const afterLines = current?.lineCount ?? (operation === "delete" ? 0 : undefined);
    return {
      taskId,
      path: file,
      operation,
      beforeLines,
      afterLines,
      delta:
        beforeLines !== undefined && afterLines !== undefined
          ? afterLines - beforeLines
          : undefined,
    };
  });
}

function mergeChangedFiles(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

function matchesExpectedFilePattern(file: string, pattern: string): boolean {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return normalizedFile === normalizedPattern;
}

function findExpectedFileMatches(task: TaskNode, taskRoot: string, changedFiles: string[]): string[] {
  const expected = task.files || [];
  if (expected.length === 0) return [];

  const matched = new Set<string>();
  for (const pattern of expected) {
    for (const changed of changedFiles) {
      if (matchesExpectedFilePattern(changed, pattern)) matched.add(pattern);
    }

    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.endsWith("/**")) {
      const directory = path.join(taskRoot, normalized.slice(0, -3));
      if (fs.existsSync(directory)) matched.add(pattern);
      continue;
    }

    if (fs.existsSync(path.join(taskRoot, normalized))) {
      matched.add(pattern);
    }
  }

  return [...matched].sort();
}

function buildVerification(
  task: TaskNode,
  taskRoot: string,
  changedFiles: string[]
): NonNullable<WorkTaskResult["verification"]> {
  const matchedExpectedFiles = findExpectedFileMatches(task, taskRoot, changedFiles);
  const notes: string[] = [];
  const changedFilesDetected = changedFiles.length > 0;
  const expectedFilesSatisfied =
    task.files && task.files.length > 0 ? matchedExpectedFiles.length > 0 : undefined;

  if (!changedFilesDetected) notes.push("No repository file changes were detected during the task attempt.");
  if (task.files?.length && !expectedFilesSatisfied) {
    notes.push(`None of the expected file targets were found or changed: ${task.files.join(", ")}`);
  }

  return {
    changedFilesDetected,
    expectedFilesSatisfied,
    matchedExpectedFiles,
    notes,
  };
}

function classifyVerificationFailure(
  task: TaskNode,
  verification: NonNullable<WorkTaskResult["verification"]>
): { kind: NonNullable<WorkTaskResult["failureKind"]>; evidence: string[] } | null {
  if (!verification.changedFilesDetected) {
    return {
      kind: "NO_EFFECT",
      evidence: ["Task attempt completed without any detected file changes."],
    };
  }
  if (task.files?.length && verification.expectedFilesSatisfied === false) {
    return {
      kind: "VERIFICATION_FAILED",
      evidence: [`Expected file targets were not satisfied: ${task.files.join(", ")}`],
    };
  }
  return null;
}

function parseReviewerVerdict(text: string): "APPROVED" | "CHANGES_REQUESTED" | undefined {
  const match = /\b(APPROVED|CHANGES_REQUESTED)\b/i.exec(text);
  if (!match) return undefined;
  return match[1].toUpperCase() as "APPROVED" | "CHANGES_REQUESTED";
}

/**
 * Build spark context for docs/reference tasks so the agent has actual content to document.
 */
function buildDocsContextBlock(blackboard: Blackboard): string {
  const state = blackboard.getState();
  if (!state.sparkOutput) return "";

  const parts: string[] = ["\n\n## Project Context (from PRD/spark)"];
  const spark = state.sparkOutput;

  if (spark.coreFeatures?.length) {
    parts.push("\n### Core Features");
    for (const f of spark.coreFeatures) parts.push(`- ${f}`);
  }
  if (spark.constraints?.length) {
    parts.push("\n### Constraints");
    for (const c of spark.constraints) parts.push(`- ${c}`);
  }
  if (spark.risks?.length) {
    parts.push("\n### Risks");
    for (const r of spark.risks) parts.push(`- ${r}`);
  }
  if (spark.successCriteria?.length) {
    parts.push("\n### Success Criteria");
    for (const s of spark.successCriteria) parts.push(`- ${s}`);
  }
  if (spark.technicalStackRecommendation) {
    parts.push(`\n### Tech Stack\n${spark.technicalStackRecommendation}`);
  }

  return parts.join("\n");
}

async function executeSingleTask(
  task: TaskNode,
  engineer: AgentConfig,
  reviewer: AgentConfig,
  baseCwd: string,
  blackboard: Blackboard,
  maxRetries: number,
  signal?: AbortSignal,
  onTaskComplete?: (result: WorkTaskResult) => void,
  onTaskActivity?: (taskId: string, activity: WorktreeFileActivity[]) => void,
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void
): Promise<WorkTaskResult> {
  // â”€â”€ Fix 2: Resolve project-scoped cwd â”€â”€
  const cwd = task.targetDir ? path.resolve(baseCwd, task.targetDir) : baseCwd;
  const repoRoot = findGitRoot(baseCwd);

  let attempt = 0;
  let lastReviewFeedback = "";
  let lastFailureSummary = "";
  const humanReviewNotes = blackboard.getState().planOutput?.humanReviewNotes?.trim();
  const humanReviewBlock = humanReviewNotes
    ? `

## Human-Reviewed Work Spec
Before implementation, the user reviewed/edited the work specification. Treat this as authoritative guidance:
${humanReviewNotes}`
    : "";

  // â”€â”€ Fix 4: Build docs context block for documentation tasks â”€â”€
  const docsContextBlock = task.category === "docs" ? buildDocsContextBlock(blackboard) : "";

  // â”€â”€ Autorecovery: Inject global review feedback â”€â”€
  const reviewOutput = blackboard.getState().reviewOutput;
  let globalReviewBlock = "";
  if (reviewOutput && reviewOutput.status !== "APPROVED") {
    const taskChanges = reviewOutput.requiredChanges
      .filter((c) => c.taskId === task.id || !c.taskId)
      .map((c) => `- [${c.severity}] ${c.description}`)
      .join("\n");

    if (taskChanges) {
      globalReviewBlock = `\n\n## Global Review Feedback (REJECTION FIXES)
The overall project review was REJECTED. You MUST address these specific findings related to this task or the project as a whole:
${taskChanges}

### Global Technical Audit
${reviewOutput.technicalAudit}

### User Perspective
${reviewOutput.userPerspectiveFeedback}`;
    }
  }

  while (attempt < maxRetries) {
    attempt++;
    const filesBeforeAttempt = snapshotChangedFiles(repoRoot);
    const treeBeforeAttempt = snapshotWorkingTree(repoRoot, baseCwd);
    const reportTaskActivity = () => {
      onTaskActivity?.(
        task.id,
        buildWorktreeActivity(task.id, treeBeforeAttempt, snapshotWorkingTree(repoRoot, baseCwd))
      );
    };
    reportTaskActivity();
    const activityInterval = setInterval(reportTaskActivity, 750);
    if (attempt > 1) {
      blackboard.incrementRetry(task.id);
    }

    // â”€â”€ Engineer implements â”€â”€
    const feedbackBlock = lastReviewFeedback
      ? `\n\n## Local Reviewer Feedback from Previous Attempt\nThe peer reviewer requested these changes during the previous implement-review loop for this specific task:\n${lastReviewFeedback}\n\nAddress ALL of the reviewer's feedback in this attempt.`
      : "";

    const targetDirNote = task.targetDir
      ? `\n\n## Target Directory\nAll file operations should be within \`${task.targetDir}\` relative to the project root.`
      : "";

    const engSystemPrompt = `You are the **Primary Engineer** for the morph orchestration pipeline.

## Your Role
You implement a single task from the execution plan. Write clean, tested,
efficient code. Follow best practices for the tech stack in use.

## Task Context
- Task ID: ${task.id}
- Category: ${task.category}
- Description: ${task.description}
- Acceptance Criteria: ${task.acceptanceCriteria}
- Complexity: ${task.estimatedComplexity}${humanReviewBlock}${globalReviewBlock}${feedbackBlock}${targetDirNote}${docsContextBlock}

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
      blackboard,
      onEvent: (event) => onAgentEvent?.(engineer.name, engineer.role, task.id, event),
    });

    blackboard.addTokens(
      "work",
      estimateTokens(engResult.output || "")
    );

    if (engResult.exitCode !== 0 || engResult.stopReason === "error") {
      clearInterval(activityInterval);
      reportTaskActivity();
      lastFailureSummary = engResult.errorMessage || engResult.output || "Implementation failed";
      if (attempt < maxRetries) continue;
      const result: WorkTaskResult = {
        taskId: task.id,
        status: "failed",
        summary: lastFailureSummary,
        filesChanged: mergeChangedFiles(
          diffChangedFiles(filesBeforeAttempt, snapshotChangedFiles(repoRoot)),
          diffWorkingTree(treeBeforeAttempt, snapshotWorkingTree(repoRoot, baseCwd))
        ),
        attemptCount: attempt,
        failureKind: "TOOL_FAILURE",
        failureEvidence: [lastFailureSummary],
      };
      onTaskComplete?.(result);
      return result;
    }

    // â”€â”€ Peer Reviewer audits â”€â”€
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
- Acceptance Criteria: ${task.acceptanceCriteria}${humanReviewBlock}`;

    const revResult = await runAgent(reviewer, {
      cwd,
      task: `Review the implementation of task ${task.id}: ${task.description}\n\nThe engineer's summary:\n${engResult.output}\n\nCheck the actual files and verify.`,
      systemPrompt: revSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(reviewer.name, reviewer.role, task.id, event),
    });

    blackboard.addTokens(
      "work",
      estimateTokens(revResult.output || "")
    );

    let reviewOutput = revResult.output || "";
    let reviewerVerdict = parseReviewerVerdict(reviewOutput);

    // Reviewer models sometimes prepend "thinking" or omit the required
    // verdict entirely. Repair the review format once before spending another
    // engineer implementation attempt on what may only be malformed output.
    if (!reviewerVerdict) {
      const verdictRetryResult = await runAgent(reviewer, {
        cwd,
        task: `Your previous review for task ${task.id} omitted the required explicit verdict.\n\nReturn the review again, starting with exactly one of:\nAPPROVED\nCHANGES_REQUESTED\n\nThen provide the concise rationale.`,
        systemPrompt: revSystemPrompt,
        signal,
        blackboard,
        onEvent: (event) => onAgentEvent?.(reviewer.name, reviewer.role, task.id, event),
      });
      blackboard.addTokens("work", estimateTokens(verdictRetryResult.output || ""));
      if (verdictRetryResult.output?.trim()) {
        reviewOutput = verdictRetryResult.output;
        reviewerVerdict = parseReviewerVerdict(reviewOutput);
      }
    }

    const isApproved = reviewerVerdict === "APPROVED";

    if (isApproved) {
      clearInterval(activityInterval);
      reportTaskActivity();
      // â”€â”€ Fix 3: Auto-commit scaffold results so git checkpoints don't eat them â”€â”€
      commitScaffoldResults(task, baseCwd);

      const changedFiles = mergeChangedFiles(
        diffChangedFiles(filesBeforeAttempt, snapshotChangedFiles(repoRoot)),
        diffWorkingTree(treeBeforeAttempt, snapshotWorkingTree(repoRoot, baseCwd))
      );
      const verification = buildVerification(task, cwd, changedFiles);
      const verificationFailure = classifyVerificationFailure(task, verification);
      if (verificationFailure) {
        lastFailureSummary = verification.notes.join(" ") || "Task failed completion verification.";
        if (attempt < maxRetries) {
          lastReviewFeedback = [
            reviewOutput,
            "",
            "Completion verification failed:",
            ...verification.notes.map((note) => `- ${note}`),
          ].join("\n");
          continue;
        }
        const result: WorkTaskResult = {
          taskId: task.id,
          status: "failed",
          summary: lastFailureSummary,
          filesChanged: changedFiles,
          attemptCount: attempt,
          failureKind: verificationFailure.kind,
          failureEvidence: verificationFailure.evidence,
          verification,
        };
        onTaskComplete?.(result);
        return result;
      }

      const result: WorkTaskResult = {
        taskId: task.id,
        status: "done",
        summary: engResult.output || "Task completed",
        filesChanged: changedFiles,
        testsPassed: true,
        attemptCount: attempt,
        failureEvidence: [],
        verification,
      };
      onTaskComplete?.(result);
      return result;
    }

    if (!reviewerVerdict) {
      clearInterval(activityInterval);
      reportTaskActivity();
      const result: WorkTaskResult = {
        taskId: task.id,
        status: "failed",
        summary: "Peer reviewer returned no valid verdict after a formatting retry.",
        notes: reviewOutput.slice(0, 500),
        filesChanged: mergeChangedFiles(
          diffChangedFiles(filesBeforeAttempt, snapshotChangedFiles(repoRoot)),
          diffWorkingTree(treeBeforeAttempt, snapshotWorkingTree(repoRoot, baseCwd))
        ),
        attemptCount: attempt,
        failureKind: "REVIEW_FORMAT_INVALID",
        failureEvidence: ["Peer reviewer omitted a valid APPROVED or CHANGES_REQUESTED verdict twice."],
      };
      onTaskComplete?.(result);
      return result;
    }

    // Changes requested â€” feed back to engineer if retries remain
    lastFailureSummary = `Review requested changes: ${reviewOutput.slice(0, 200)}`;
    if (attempt < maxRetries) {
      clearInterval(activityInterval);
      reportTaskActivity();
      // Store reviewer feedback so the engineer sees it on the next attempt
      lastReviewFeedback = reviewOutput;
      continue;
    }

    clearInterval(activityInterval);
    reportTaskActivity();
    const result: WorkTaskResult = {
      taskId: task.id,
      status: "failed",
      summary: `Review rejected after ${maxRetries} attempts: ${reviewOutput.slice(0, 200)}`,
      filesChanged: mergeChangedFiles(
        diffChangedFiles(filesBeforeAttempt, snapshotChangedFiles(repoRoot)),
        diffWorkingTree(treeBeforeAttempt, snapshotWorkingTree(repoRoot, baseCwd))
      ),
      attemptCount: attempt,
      failureKind: "REVIEW_REJECTED",
      failureEvidence: [reviewOutput.slice(0, 500)],
    };
    onTaskComplete?.(result);
    return result;
  }

  // Exhausted retries
  const result: WorkTaskResult = {
    taskId: task.id,
    status: "failed",
    summary: lastFailureSummary || `Failed after ${maxRetries} retry attempts`,
    filesChanged: [],
    attemptCount: attempt || maxRetries,
    failureKind: "STATE_INCONSISTENT",
    failureEvidence: [lastFailureSummary || "Retry loop exhausted without producing a terminal task result."],
  };
  onTaskComplete?.(result);
  return result;
}

