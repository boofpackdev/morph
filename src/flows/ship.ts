/**
 * morph — Ship Flow (Approved Code → Released)
 *
 * Team: DevOps/SRE + Release Consultant (2 agents)
 *
 * Handles pre-release verification, deployment checklist,
 * changelog generation, versioning, and rollback planning.
 *
 * Output: ShipOutput (status, version, changelog, checklist, rollback plan)
 */

import { Blackboard } from "../core/blackboard.js";
import {
  runAgent,
  runAgentsParallel,
  SHIP_AGENTS,
  type AgentConfig,
} from "../core/agent-runner.js";
import { estimateTokens } from "../core/tokenizer.js";
import type { ShipOutput } from "../schemas/contracts.js";

export interface ShipFlowOptions {
  cwd: string;
  blackboard: Blackboard;
  signal?: AbortSignal;
  /** Version to release (auto-detected if not provided) */
  version?: string;
  /** Deployment target (production, staging, etc.) */
  target?: string;
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void;
}

export async function executeShipFlow(
  options: ShipFlowOptions
): Promise<ShipOutput> {
  const { cwd, blackboard, signal, version, target = "production", onAgentEvent } = options;

  const state = blackboard.getState();
  const sparkOutput = state.sparkOutput;
  const planOutput = state.planOutput;
  const reviewOutput = state.reviewOutput;

  if (!reviewOutput || reviewOutput.status !== "APPROVED") {
    throw new Error(
      "Cannot ship: review not approved. Run review flow until APPROVED."
    );
  }

  const devops = SHIP_AGENTS.find((a) => a.name === "devops-sre")!;
  const releaseConsultant = SHIP_AGENTS.find(
    (a) => a.name === "release-consultant"
  )!;

  // ── Build ship context ──
  const shipContext = buildShipContext(state);

  // ── DevOps/SRE: pre-release verification + deployment plan ──
  const devopsSystemPrompt = `You are the **DevOps / SRE** for the morph orchestration pipeline.

## Your Role
You handle the release process:
- Verify the codebase is ready for release
- Check for build issues, test failures, linting errors
- Create a deployment checklist
- Design a rollback plan
- Identify infrastructure requirements

## Output
### PRE-RELEASE VERIFICATION
[What you checked and results]

### DEPLOYMENT CHECKLIST
- [ ] Item 1
- [ ] Item 2
...

### ROLLBACK PLAN
[Step-by-step rollback procedure]

### INFRASTRUCTURE NOTES
[Dependencies, environment variables, services needed]

### GO / NO-GO
**GO** or **NO-GO** with reasoning

Be thorough. A bad deploy costs more than a delayed one.`;

  // ── Release Consultant: changelog + versioning + communication ──
  const consultantSystemPrompt = `You are the **Release Consultant** for the morph orchestration pipeline.

## Your Role
You handle release communication:
- Generate a clear, user-facing changelog
- Determine appropriate version (semver)
- Write release notes for stakeholders
- Suggest post-release monitoring focus

## Output
### CHANGELOG
[Human-readable changelog organized by: Features, Fixes, Improvements, Breaking Changes]

### VERSION
[Suggested version following semver: MAJOR.MINOR.PATCH]

### RELEASE NOTES
[2-3 paragraphs for stakeholders / team]

### POST-RELEASE MONITORING
[What to watch after release]

Keep the changelog clear and user-focused. No internal jargon.`;

  const [devopsOutput, consultantOutput] = await Promise.all([
    blackboard.getFlowCheckpoint("ship", "devops") ? Promise.resolve(blackboard.getFlowCheckpoint("ship", "devops")!) : runAgent(devops, {
      cwd,
      task: `Prepare for release to ${target}:\n\n${shipContext}`,
      systemPrompt: devopsSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(devops.name, devops.role, "-", event),
    }).then((result) => result.output || ""),
    blackboard.getFlowCheckpoint("ship", "consultant") ? Promise.resolve(blackboard.getFlowCheckpoint("ship", "consultant")!) : runAgent(releaseConsultant, {
      cwd,
      task: `Generate release artifacts:\n\n${shipContext}`,
      systemPrompt: consultantSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(releaseConsultant.name, releaseConsultant.role, "-", event),
    }).then((result) => result.output || ""),
  ]);

  if (!blackboard.getFlowCheckpoint("ship", "devops")) {
    blackboard.addTokens("ship", estimateTokens(devopsOutput));
    blackboard.setFlowCheckpoint("ship", "devops", devopsOutput);
  }
  if (!blackboard.getFlowCheckpoint("ship", "consultant")) {
    blackboard.addTokens("ship", estimateTokens(consultantOutput));
    blackboard.setFlowCheckpoint("ship", "consultant", consultantOutput);
  }

  // ── Parse outputs ──
  const shipOutput = parseShipOutput(
    devopsOutput,
    consultantOutput,
    version
  );

  blackboard.recordDecision(
    "ship",
    `Release ${shipOutput.version} to ${target}: ${shipOutput.status}`,
    "DevOps and Release Consultant verified"
  );

  blackboard.setShipOutput(shipOutput);

  return shipOutput;
}

// ── Helpers ──

function buildShipContext(
  state: ReturnType<Blackboard["getState"]>
): string {
  const lines: string[] = ["# Ship Context", ""];

  if (state.sparkOutput) {
    lines.push("## Product");
    lines.push(state.sparkOutput.visionStatement.slice(0, 300));
    lines.push(
      `Features: ${state.sparkOutput.coreFeatures.join(", ")}`
    );
    lines.push("");
  }

  if (state.planOutput) {
    lines.push("## Implementation");
    lines.push(`Tasks: ${state.planOutput.tasks.length}`);
    const done = state.workResults.filter((r) => r.status === "done").length;
    lines.push(`Completed: ${done}`);
    lines.push("");
  }

  if (state.reviewOutput) {
    lines.push("## Review Summary");
    lines.push(`Verdict: ${state.reviewOutput.status}`);
    lines.push(`Score: ${state.reviewOutput.efficiencyScore}/10`);
    lines.push(
      `User feedback: ${state.reviewOutput.userPerspectiveFeedback.slice(
        0,
        200
      )}`
    );
    if (state.reviewOutput.securityIssues.length > 0) {
      lines.push(
        `Security issues resolved: ${state.reviewOutput.securityIssues.length}`
      );
    }
    lines.push("");
  }

  lines.push("## Token Costs");
  const l = state.tokenLedger;
  lines.push(
    `Total: ${l.total} (Spark: ${l.spark}, Plan: ${l.plan}, Work: ${l.work}, Review: ${l.review})`
  );

  return lines.join("\n");
}

function parseShipOutput(
  devopsText: string,
  consultantText: string,
  fallbackVersion?: string
): ShipOutput {
  const extractSection = (marker: string, source: string): string => {
    const regex = new RegExp(
      `###\\s*${marker}[\\s\\S]*?(?=###\\s|$)`,
      "i"
    );
    const match = source.match(regex);
    return match ? match[0].replace(/^###\s*${marker}\s*/i, "").trim() : "";
  };

  // Determine status
  const goNoGo = extractSection("GO / NO-GO", devopsText).toUpperCase();
  let status: ShipOutput["status"] = "ABORTED";
  if (goNoGo.includes("GO") && !goNoGo.includes("NO-GO")) {
    status = "SHIPPED";
  }

  // Extract version
  let extractedVersion =
    fallbackVersion ||
    extractSection("VERSION", consultantText);
  if (!extractedVersion || extractedVersion.length > 20) {
    extractedVersion = "0.1.0";
  }

  // Parse deployment checklist
  const checklistText = extractSection("DEPLOYMENT CHECKLIST", devopsText);
  const checklist = checklistText
    .split("\n")
    .filter((l) => l.match(/^[-*]\s*\[[\sx]\]/))
    .map((l) => ({
      item: l.replace(/^[-*]\s*\[[\sx]\]\s*/, "").trim(),
      done: l.includes("[x]") || l.includes("[X]"),
    }));

  return {
    status,
    version: extractedVersion.replace(/[^\d.]/g, "").slice(0, 15) || "0.1.0",
    changelog:
      extractSection("CHANGELOG", consultantText) ||
      "Changelog not generated",
    deploymentChecklist:
      checklist.length > 0
        ? checklist
        : [
            { item: "Verify all tests pass", done: false },
            { item: "Review deployment plan", done: false },
            { item: "Confirm rollback strategy", done: false },
          ],
    postReleaseNotes:
      extractSection("POST-RELEASE MONITORING", consultantText) || undefined,
    rollbackPlan:
      extractSection("ROLLBACK PLAN", devopsText) || undefined,
  };
}
