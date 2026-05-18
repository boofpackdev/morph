/**
 * morph — Recovery & Regression Logic
 *
 * Extracted from index.ts. Functions for diagnosing failures, determining
 * auto-recovery safety, clearing stale task result branches, and detecting
 * state regression from archived snapshots.
 */

import type { Blackboard, ArchivedMorphState } from "./blackboard.js";
import { renderSkillProfiles } from "./skill-profiles.js";

// ── Recovery state types ──

export interface RecoveryDiagnosis {
  taskId?: string;
  failureKind?: string;
  evidence: string[];
  recommendation: string;
  autoSafe: boolean;
}

// ── Helpers ──

function doneTaskIds(state: ReturnType<Blackboard["getState"]>): Set<string> {
  return new Set(
    state.workResults
      .filter((result) => result.status === "done")
      .map((result) => result.taskId)
  );
}

function samePlanShape(
  left: ReturnType<Blackboard["getState"]>,
  right: ReturnType<Blackboard["getState"]>
): boolean {
  const leftTaskIds = left.planOutput?.tasks.map((task) => task.id).join("|");
  const rightTaskIds = right.planOutput?.tasks.map((task) => task.id).join("|");
  return Boolean(leftTaskIds) && leftTaskIds === rightTaskIds;
}

// ── Public API ──

export function summarizeRecoveryState(state: ReturnType<Blackboard["getState"]>): {
  unfinished: boolean;
  kind: "none" | "recoverable" | "restartable" | "stale";
  checkpointCount: number;
  doneTasks: number;
  totalTasks: number;
  failedTasks: number;
  blockedTasks: number;
  message: string;
} {
  const checkpointCount = Object.keys(state.flowCheckpoints[state.phase] || {}).length;
  const doneTasks = state.workResults.filter((result) => result.status === "done").length;
  const failedTasks = state.workResults.filter((result) => result.status === "failed").length;
  const blockedTasks = state.workResults.filter((result) => result.status === "blocked").length;
  const totalTasks = state.planOutput?.tasks.length ?? 0;
  const unfinished = state.phase !== "idle" && state.phase !== "done";
  const hasPhaseCheckpoints = checkpointCount > 0;
  const hasRestartContext =
    state.phase === "spark"
      ? Boolean(state.pipelinePrompt?.trim())
      : state.phase === "plan"
        ? Boolean(state.sparkOutput)
        : state.phase === "work"
          ? Boolean(state.planOutput)
          : state.phase === "review"
            ? Boolean(state.planOutput && state.workResults.length > 0)
            : state.phase === "ship"
              ? Boolean(state.reviewOutput)
              : false;
  const hasMaterialProgress =
    Boolean(state.sparkOutput) ||
    Boolean(state.planOutput) ||
    state.workResults.length > 0 ||
    Boolean(state.reviewOutput) ||
    Boolean(state.shipOutput) ||
    state.tokenLedger.total > 0 ||
    state.decisions.length > 0;
  const kind: "none" | "recoverable" | "restartable" | "stale" =
    !unfinished
      ? "none"
      : !hasRestartContext
        ? "stale"
        : hasPhaseCheckpoints || hasMaterialProgress
        ? "recoverable"
        : "restartable";

  if (!unfinished) {
    return { unfinished, kind, checkpointCount, doneTasks, totalTasks, failedTasks, blockedTasks, message: "" };
  }

  const progress =
    totalTasks > 0
      ? `tasks ${doneTasks}/${totalTasks}${failedTasks > 0 ? `, ${failedTasks} failed` : ""}${blockedTasks > 0 ? `, ${blockedTasks} blocked` : ""}`
      : "no task DAG yet";
  const checkpoints =
    checkpointCount > 0
      ? `${checkpointCount} checkpoint${checkpointCount === 1 ? "" : "s"} available`
      : "no checkpoints saved";

  return {
    unfinished,
    kind,
    checkpointCount,
    doneTasks,
    totalTasks,
    failedTasks,
    blockedTasks,
    message:
      kind === "restartable"
        ? `unfinished morph setup found in this folder: ${state.phase} · ${progress} · ${checkpoints}`
        : `unfinished morph flow detected in this folder: ${state.phase} · ${progress} · ${checkpoints}`,
  };
}

export function findLatestRecoverableFailure(
  state: ReturnType<Blackboard["getState"]>,
  latestFailed: ReturnType<Blackboard["getState"]>["workResults"][number] | undefined
): ReturnType<Blackboard["getState"]>["workResults"][number] | undefined {
  if (!latestFailed || latestFailed.failureKind !== "DEPENDENCY_BLOCKED") {
    return latestFailed;
  }

  const tasksById = new Map(state.planOutput?.tasks.map((task) => [task.id, task]) ?? []);
  const resultsById = new Map(state.workResults.map((result) => [result.taskId, result]));
  const visited = new Set<string>();
  const rootFailures: ReturnType<Blackboard["getState"]>["workResults"] = [];

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    const result = resultsById.get(taskId);
    if (result && result.status === "failed") {
      rootFailures.push(result);
      return;
    }

    const task = tasksById.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      visit(dependencyId);
    }
  };

  visit(latestFailed.taskId);

  if (rootFailures.length === 0) {
    const completedIds = new Set(
      state.workResults
        .filter((result) => result.status === "done")
        .map((result) => result.taskId)
    );
    const latestBlockedTask = tasksById.get(latestFailed.taskId);
    const dependenciesRecovered =
      latestBlockedTask?.dependsOn.every((dependencyId) => completedIds.has(dependencyId)) ?? false;
    if (dependenciesRecovered) {
      return [...state.workResults]
        .reverse()
        .find((result) => result.status === "failed");
    }
    return latestFailed;
  }

  const resultOrder = new Map(state.workResults.map((result, index) => [result.taskId, index]));
  return rootFailures.sort(
    (a, b) => (resultOrder.get(b.taskId) ?? -1) - (resultOrder.get(a.taskId) ?? -1)
  )[0];
}

export function diagnoseRecoveryState(state: ReturnType<Blackboard["getState"]>): RecoveryDiagnosis {
  const latestFailed = [...state.workResults]
    .reverse()
    .find((result) => result.status === "failed" || result.status === "blocked");
  const latestRecoverableFailure = findLatestRecoverableFailure(state, latestFailed);
  const impossibleSuccess = [...state.workResults]
    .reverse()
    .find((result) => result.status === "done" && result.filesChanged.length === 0);

  if (impossibleSuccess) {
    return {
      taskId: impossibleSuccess.taskId,
      failureKind: "STATE_INCONSISTENT",
      evidence: [
        "Task is marked done but has no recorded file changes.",
        "Persisted success no longer passes the stricter completion standard.",
      ],
      recommendation: "Clear the untrusted task result and rerun it from Work.",
      autoSafe: true,
    };
  }

  if (!latestRecoverableFailure) {
    return {
      evidence: ["No failed or blocked task result is currently recorded."],
      recommendation: "Resume the current phase from its saved state.",
      autoSafe: true,
    };
  }

  const kind = latestRecoverableFailure.failureKind;
  switch (kind) {
    case "NO_EFFECT":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Rerun the task with explicit completion evidence and expected file targets.",
        autoSafe: true,
      };
    case "TOOL_FAILURE":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Retry the task; the last failure came from the execution layer rather than the task itself.",
        autoSafe: true,
      };
    case "CLI_LAUNCH_FAILURE":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Repair the pi/Node launch path before retrying; the agent process could not be started.",
        autoSafe: false,
      };
    case "AUTH_OR_QUOTA_FAILURE":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Fix provider access or credits, or switch provider/model config, before retrying this task.",
        autoSafe: false,
      };
    case "REVIEW_REJECTED":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Rerun the task with reviewer feedback injected into the next attempt.",
        autoSafe: true,
      };
    case "REVIEW_FORMAT_INVALID":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Retry the review path; implementation may be fine, but the reviewer response was malformed.",
        autoSafe: true,
      };
    case "VERIFICATION_FAILED":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Rerun the task against the missing expected artifacts before trusting another approval.",
        autoSafe: true,
      };
    case "DEPENDENCY_BLOCKED":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Recover the failed dependency first; blocked children should not be retried in isolation.",
        autoSafe: false,
      };
    case "TASK_UNDERSPECIFIED":
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Replan the task before spending more implementation attempts on fog.",
        autoSafe: false,
      };
    default:
      return {
        taskId: latestRecoverableFailure.taskId,
        failureKind: kind,
        evidence: latestRecoverableFailure.failureEvidence,
        recommendation: "Resume cautiously from the current phase and inspect the task if it fails again.",
        autoSafe: true,
      };
  }
}

export function findTrustedRegressionSnapshot(
  state: ReturnType<Blackboard["getState"]>,
  archives: ArchivedMorphState[]
): { archive: ArchivedMorphState; missingDoneTaskIds: string[] } | undefined {
  if (state.phase !== "work" || !state.reviewOutput || !state.planOutput) return undefined;

  const currentDone = doneTaskIds(state);
  const reviewActionableIds = new Set(
    state.reviewOutput.requiredChanges
      .map((change) => change.taskId)
      .filter((taskId): taskId is string => Boolean(taskId))
  );

  const candidates = archives
    .filter((archive) => samePlanShape(state, archive.state))
    .map((archive) => {
      const archivedDone = doneTaskIds(archive.state);
      const missingDoneTaskIds = [...archivedDone].filter((taskId) => !currentDone.has(taskId));
      return { archive, missingDoneTaskIds };
    })
    .filter(({ missingDoneTaskIds }) => missingDoneTaskIds.length > 0)
    .filter(({ missingDoneTaskIds }) =>
      missingDoneTaskIds.some((taskId) => !reviewActionableIds.has(taskId))
    )
    .sort((a, b) => {
      const doneDelta = b.missingDoneTaskIds.length - a.missingDoneTaskIds.length;
      return doneDelta !== 0
        ? doneDelta
        : b.archive.modifiedAt.getTime() - a.archive.modifiedAt.getTime();
    });

  return candidates[0];
}

export function restoreTrustedRegressionSnapshot(
  bb: Blackboard,
  state: ReturnType<Blackboard["getState"]>
): { state: ReturnType<Blackboard["getState"]>; restored: boolean; restoredTaskCount: number } {
  const candidate = findTrustedRegressionSnapshot(state, bb.getRecoverableArchives());
  if (!candidate) {
    return { state, restored: false, restoredTaskCount: 0 };
  }

  bb.archiveCurrentState("detected-ledger-regression");
  bb.restoreArchivedState(candidate.archive);
  return {
    state: bb.getState(),
    restored: true,
    restoredTaskCount: candidate.missingDoneTaskIds.length,
  };
}

export function buildRecoveryReport(
  state: ReturnType<Blackboard["getState"]>,
  diagnosis: RecoveryDiagnosis
): string {
  const task = diagnosis.taskId
    ? state.planOutput?.tasks.find((candidate) => candidate.id === diagnosis.taskId)
    : undefined;
  const result = diagnosis.taskId
    ? [...state.workResults].reverse().find((candidate) => candidate.taskId === diagnosis.taskId)
    : undefined;
  const changedFiles = result?.filesChanged ?? [];
  const verification = result?.verification;
  const lines = [
    `# Recovery Report${diagnosis.taskId ? ` — ${diagnosis.taskId}` : ""}`,
    "",
    `- **Generated**: ${new Date().toISOString()}`,
    `- **Phase**: ${state.phase}`,
    `- **Failure kind**: ${diagnosis.failureKind || "RESUME"}`,
    `- **Auto-safe**: ${diagnosis.autoSafe ? "yes" : "no"}`,
    "",
    "## Diagnosis",
    diagnosis.evidence.length > 0
      ? diagnosis.evidence.map((item) => `- ${item}`).join("\n")
      : "- No specific failure evidence recorded.",
    "",
    "## Recommended Next Move",
    diagnosis.recommendation,
    "",
  ];

  if (task) {
    lines.push(
      "## Task Context",
      `- **Description**: ${task.description}`,
      `- **Category**: ${task.category}`,
      `- **Acceptance criteria**: ${task.acceptanceCriteria}`,
      `- **Expected files**: ${task.files?.length ? task.files.join(", ") : "none declared"}`,
      ""
    );
  }

  if (result) {
    lines.push(
      "## Latest Task Result",
      `- **Status**: ${result.status}`,
      `- **Attempts**: ${result.attemptCount ?? "unknown"}`,
      `- **Summary**: ${result.summary}`,
      `- **Changed files**: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`,
      ""
    );
  }

  if (verification) {
    lines.push(
      "## Verification",
      `- **Changed files detected**: ${verification.changedFilesDetected ? "yes" : "no"}`,
      `- **Expected files satisfied**: ${
        verification.expectedFilesSatisfied === undefined
          ? "not applicable"
          : verification.expectedFilesSatisfied
            ? "yes"
            : "no"
      }`,
      `- **Matched expected files**: ${
        verification.matchedExpectedFiles.length > 0
          ? verification.matchedExpectedFiles.join(", ")
          : "none"
      }`,
      ...(verification.notes.length > 0 ? ["", ...verification.notes.map((note) => `- ${note}`)] : []),
      ""
    );
  }

  lines.push(
    "## Operator Notes",
    diagnosis.autoSafe
      ? "- Morph can safely attempt the recommended recovery automatically."
      : "- Morph should not pretend this is routine. Human judgment or upstream repair is recommended before continuing.",
    "",
    renderSkillProfiles(["debugging-and-error-recovery"]),
    ""
  );

  return lines.join("\n");
}

export function persistRecoveryReport(
  bb: Blackboard,
  state: ReturnType<Blackboard["getState"]>,
  diagnosis: RecoveryDiagnosis
): string | undefined {
  if (!diagnosis.taskId) return undefined;
  return bb.writeRecoveryReport(diagnosis.taskId, buildRecoveryReport(state, diagnosis));
}

export function shouldAutoRecoverWithinWork(
  state: ReturnType<Blackboard["getState"]>,
  diagnosis: RecoveryDiagnosis
): boolean {
  const historicalRetries = diagnosis.taskId ? state.retries[diagnosis.taskId] || 0 : 0;
  return (
    state.phase === "work" &&
    Boolean(diagnosis.taskId) &&
    diagnosis.autoSafe &&
    historicalRetries < 6 &&
    ["NO_EFFECT", "TOOL_FAILURE", "REVIEW_REJECTED", "REVIEW_FORMAT_INVALID", "VERIFICATION_FAILED", "STATE_INCONSISTENT"]
      .includes(diagnosis.failureKind || "")
  );
}

export function clearAutoRecoverableTaskResult(
  bb: Blackboard,
  diagnosis: RecoveryDiagnosis
): void {
  if (!diagnosis.taskId) return;
  bb.incrementRetry(diagnosis.taskId);
  clearWorkResultBranch(bb, diagnosis.taskId);
}

export function clearWorkResultBranch(
  bb: Blackboard,
  taskId: string
): void {
  const state = bb.getState();
  const taskIdsToClear = new Set<string>([taskId]);
  const tasks = state.planOutput?.tasks ?? [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (taskIdsToClear.has(task.id)) continue;
      const result = state.workResults.find((candidate) => candidate.taskId === task.id);
      const dependsOnClearedTask = task.dependsOn.some((dependencyId) => taskIdsToClear.has(dependencyId));
      if (dependsOnClearedTask && result?.status === "blocked") {
        taskIdsToClear.add(task.id);
        changed = true;
      }
    }
  }

  bb.clearWorkResults([...taskIdsToClear]);
}

export function prepareExplicitWorkRecovery(
  bb: Blackboard,
  state: ReturnType<Blackboard["getState"]>,
  diagnosis: RecoveryDiagnosis
): ReturnType<Blackboard["getState"]> {
  if (
    state.phase === "work" &&
    (diagnosis.failureKind === "AUTH_OR_QUOTA_FAILURE" || diagnosis.failureKind === "CLI_LAUNCH_FAILURE")
  ) {
    const systemicTaskIds = state.workResults
      .filter(
        (result) =>
          result.status !== "done" &&
          result.failureKind === diagnosis.failureKind
      )
      .map((result) => result.taskId);
    if (systemicTaskIds.length > 0) {
      for (const taskId of systemicTaskIds) {
        clearWorkResultBranch(bb, taskId);
      }
      return bb.getState();
    }
  }
  return state;
}
