/**
 * morph — Review Flow (Code → Approval/Rejection)
 *
 * Team: Tech Lead + QA Auditor + Performance Guru + End User (4 agents)
 *
 * Hub-and-spoke: Tech Lead coordinates QA, Performance, and End User agents,
 * synthesizing a comprehensive review with approval/rejection verdict.
 *
 * Output: ReviewOutput (status, technical audit, efficiency score,
 *          user perspective, required changes, security issues)
 */

import { Blackboard } from "../core/blackboard.js";
import {
  runAgent,
  runAgentsParallel,
  REVIEW_AGENTS,
  type AgentConfig,
} from "../core/agent-runner.js";
import { estimateTokens } from "../core/tokenizer.js";
import { formatProgress } from "../core/engine.js";
import type { ReviewOutput } from "../schemas/contracts.js";

export interface ReviewFlowOptions {
  cwd: string;
  blackboard: Blackboard;
  signal?: AbortSignal;
  /** Custom instructions for the review focus */
  focus?: string;
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void;
}

export async function executeReviewFlow(
  options: ReviewFlowOptions
): Promise<ReviewOutput> {
  const { cwd, blackboard, signal, focus, onAgentEvent } = options;

  const state = blackboard.getState();
  const planOutput = state.planOutput;
  const workResults = state.workResults;
  const sparkOutput = state.sparkOutput;

  if (!planOutput || !sparkOutput) {
    throw new Error("Missing plan or spark output. Run earlier phases first.");
  }

  const techLead = REVIEW_AGENTS.find((a) => a.name === "tech-lead")!;
  const qaAuditor = REVIEW_AGENTS.find((a) => a.name === "qa-auditor")!;
  const perfGuru = REVIEW_AGENTS.find((a) => a.name === "perf-guru")!;
  const endUser = REVIEW_AGENTS.find((a) => a.name === "end-user")!;

  // ── Build review context ──
  const reviewContext = buildReviewContext(
    sparkOutput,
    planOutput,
    workResults
  );
  const focusInstruction = focus ? `\n\n## Review Focus\n${focus}` : "";

  // ── Run three review agents in parallel ──

  const qaSystemPrompt = `You are the **QA Auditor** for the morph orchestration pipeline.

## Your Role
You audit the implementation for quality:
- Verify acceptance criteria are met for each task
- Check test coverage and quality
- Identify missing tests or untestable code
- Find edge cases in the implementation

## Output
### QA AUDIT
[Overall QA assessment]

### TASK VERIFICATION
For each task, state PASS/FAIL and reasoning

### TEST GAPS
[Missing tests or weak test coverage]

### EDGE CASES MISSED
[Specific scenarios not covered]`;

  const perfSystemPrompt = `You are the **Performance Guru** for the morph orchestration pipeline.

## Your Role
You analyze the implementation for performance:
- Identify bottlenecks and inefficiencies
- Assess algorithmic complexity
- Check for N+1 queries, memory leaks, excessive allocations
- Evaluate caching strategy
- Suggest optimization opportunities

## Output
### PERFORMANCE ASSESSMENT
[Overall performance evaluation]

### BOTTLENECKS
[Specific performance issues with severity]

### OPTIMIZATION SUGGESTIONS
[Actionable improvements with expected impact]`;

  const endUserSystemPrompt = `You are the **End User / Customer** for the morph orchestration pipeline.

## Your Role
You simulate a real end user. You don't care about code quality or architecture.
You care about:
- Does this solve my actual problem?
- Is it intuitive and easy to use?
- Would I be confused or frustrated?
- Is anything missing from a user's perspective?
- Does the output/behavior make sense?

## Output
### USER PERSPECTIVE
[How you would feel as a real user]

### USABILITY ISSUES
[Things that would confuse or frustrate you]

### MISSING FROM USER'S VIEW
[Features or polish you'd expect]

### VERDICT
Happy / Neutral / Frustrated — and why

Be brutally honest. You're the customer, not a developer.`;

  const [qaOutput, perfOutput, userOutput] = await Promise.all([
    blackboard.getFlowCheckpoint("review", "qa") ? Promise.resolve(blackboard.getFlowCheckpoint("review", "qa")!) : runAgent(qaAuditor, {
      cwd,
      task: `Review the implementation:\n\n${reviewContext}${focusInstruction}`,
      systemPrompt: qaSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(qaAuditor.name, qaAuditor.role, "-", event),
    }).then((result) => result.output || ""),
    blackboard.getFlowCheckpoint("review", "perf") ? Promise.resolve(blackboard.getFlowCheckpoint("review", "perf")!) : runAgent(perfGuru, {
      cwd,
      task: `Analyze performance:\n\n${reviewContext}${focusInstruction}`,
      systemPrompt: perfSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(perfGuru.name, perfGuru.role, "-", event),
    }).then((result) => result.output || ""),
    blackboard.getFlowCheckpoint("review", "user") ? Promise.resolve(blackboard.getFlowCheckpoint("review", "user")!) : runAgent(endUser, {
      cwd,
      task: `Evaluate as an end user:\n\nPRD Vision: ${sparkOutput.visionStatement}\n\nFeatures: ${sparkOutput.coreFeatures.join(", ")}\n\nTarget User: ${sparkOutput.targetUserPersona}${focusInstruction}`,
      systemPrompt: endUserSystemPrompt,
      signal,
      blackboard,
      onEvent: (event) => onAgentEvent?.(endUser.name, endUser.role, "-", event),
    }).then((result) => result.output || ""),
  ]);

  if (!blackboard.getFlowCheckpoint("review", "qa")) {
    blackboard.addTokens("review", estimateTokens(qaOutput));
    blackboard.setFlowCheckpoint("review", "qa", qaOutput);
  }
  if (!blackboard.getFlowCheckpoint("review", "perf")) {
    blackboard.addTokens("review", estimateTokens(perfOutput));
    blackboard.setFlowCheckpoint("review", "perf", perfOutput);
  }
  if (!blackboard.getFlowCheckpoint("review", "user")) {
    blackboard.addTokens("review", estimateTokens(userOutput));
    blackboard.setFlowCheckpoint("review", "user", userOutput);
  }

  // ── Tech Lead synthesizes final review ──
  const techLeadSystemPrompt = `You are the **Tech Lead** for the morph orchestration pipeline.

## Your Role
You synthesize inputs from QA, Performance, and End User reviews into a
comprehensive final review with a clear verdict.

## Instructions
Given the implementation context and review inputs below, produce:

### VERDICT
One of: APPROVED | REJECTED | FIX_REQUESTED

### TECHNICAL AUDIT
[Architecture, patterns, security, code quality assessment — 2-3 paragraphs]

### EFFICIENCY SCORE
A number from 1-10

### USER PERSPECTIVE FEEDBACK
[Synthesized user-facing feedback]

### REQUIRED CHANGES
For each change needed, specify:
- Task ID (if applicable)
- Description
- Severity: critical | major | minor | nice-to-have

### SECURITY ISSUES
[Any security concerns found]

### TEST COVERAGE ASSESSMENT
[Brief assessment of test quality]

## Rules
- If there are critical issues → REJECTED
- If there are major issues → FIX_REQUESTED
- If only minor/nice-to-have issues → APPROVED
- Be specific and actionable
- Every issue must have a suggestion for fixing it`;

  const techLeadTask = `Implementation context:\n${reviewContext}\n\nQA Audit:\n${qaOutput}\n\nPerformance Assessment:\n${perfOutput}\n\nEnd User Perspective:\n${userOutput}\n\nSynthesize the final review with verdict.`;
const techLeadOutput = blackboard.getFlowCheckpoint("review", "techLead") || (await runAgent(techLead, {
  cwd,
  task: techLeadTask,
  systemPrompt: techLeadSystemPrompt,
  signal,
  blackboard,
  onEvent: (event) => onAgentEvent?.(techLead.name, techLead.role, "-", event),
})).output || "";

  if (!blackboard.getFlowCheckpoint("review", "techLead")) {
    blackboard.addTokens("review", estimateTokens(techLeadOutput));
    blackboard.setFlowCheckpoint("review", "techLead", techLeadOutput);
  }

  // ── Parse output ──
  const reviewOutput = parseReviewOutput(
    techLeadOutput,
    qaOutput,
    perfOutput,
    userOutput
  );

  // Record decisions
  blackboard.recordDecision(
    "review",
    `Verdict: ${reviewOutput.status} | Score: ${reviewOutput.efficiencyScore}/10`,
    `Tech Lead synthesis with QA + Perf + User input`
  );

  blackboard.setReviewOutput(reviewOutput);

  return reviewOutput;
}

// ── Helpers ──

function buildReviewContext(
  spark: NonNullable<ReturnType<Blackboard["getState"]>["sparkOutput"]>,
  plan: NonNullable<ReturnType<Blackboard["getState"]>["planOutput"]>,
  results: ReturnType<Blackboard["getState"]>["workResults"]
): string {
  const lines: string[] = [];

  lines.push("# Review Context");
  lines.push("");
  lines.push("## Product Vision");
  lines.push(spark.visionStatement);
  lines.push("");

  lines.push("## Architecture");
  lines.push(plan.architectureDiagram);
  lines.push("");

  lines.push("## QA Strategy");
  lines.push(plan.qaStrategy);
  lines.push("");

  lines.push("## Implementation Progress");
  lines.push(formatProgress(results, plan.tasks));
  lines.push("");

  lines.push("## Task Details");
  for (const task of plan.tasks) {
    const result = results.find((r) => r.taskId === task.id);
    const status = result?.status || "pending";
    lines.push(`- [${task.id}] ${status}: ${task.description}`);
    if (result?.summary) {
      lines.push(`  Summary: ${result.summary.slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}

function parseReviewOutput(
  techLeadText: string,
  qaText: string,
  perfText: string,
  userText: string
): ReviewOutput {
  const extractSection = (marker: string, source: string = techLeadText): string => {
    const regex = new RegExp(
      `###\\s*${marker}[\\s\\S]*?(?=###\\s|$)`,
      "i"
    );
    const match = source.match(regex);
    return match ? match[0].replace(/^###\s*${marker}\s*/i, "").trim() : "";
  };

  const verdictText = extractSection("VERDICT").toUpperCase();
  let status: ReviewOutput["status"] = "FIX_REQUESTED";
  if (verdictText.includes("APPROVED")) status = "APPROVED";
  else if (verdictText.includes("REJECTED")) status = "REJECTED";

  // Parse efficiency score
  const scoreMatch = extractSection("EFFICIENCY SCORE").match(/(\d+)/);
  const efficiencyScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 7;

  // Parse required changes
  const requiredChanges: ReviewOutput["requiredChanges"] = [];
  const changesText = extractSection("REQUIRED CHANGES");
  const changeLines = changesText.split("\n");
  let currentChange: Partial<ReviewOutput["requiredChanges"][number]> = {};

  for (const line of changeLines) {
    const severityMatch = line.match(
      /severity:\s*(critical|major|minor|nice-to-have)/i
    );
    if (severityMatch) {
      currentChange.severity = severityMatch[1].toLowerCase() as any;
    }

    const taskMatch = line.match(/task(?:\s*id)?:\s*([A-Z]+-\d+)/i);
    if (taskMatch) {
      currentChange.taskId = taskMatch[1];
    }

    if (line.startsWith("-") || line.startsWith("*")) {
      if (currentChange.description) {
        requiredChanges.push({
          description: currentChange.description,
          severity: currentChange.severity || "minor",
          taskId: currentChange.taskId,
        });
      }
      currentChange = {
        description: line.replace(/^[-*]\s*/, "").trim(),
        severity: "minor",
      };
    } else if (currentChange.description && line.trim()) {
      currentChange.description += " " + line.trim();
    }
  }
  if (currentChange.description) {
    requiredChanges.push({
      description: currentChange.description,
      severity: currentChange.severity || "minor",
      taskId: currentChange.taskId,
    });
  }

  // Parse security issues
  const securityText = extractSection("SECURITY ISSUES");
  const securityIssues = securityText
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);

  return {
    status,
    technicalAudit:
      extractSection("TECHNICAL AUDIT") ||
      techLeadText.slice(0, 500),
    efficiencyScore: Math.min(10, Math.max(1, efficiencyScore)),
    userPerspectiveFeedback:
      extractSection("USER PERSPECTIVE FEEDBACK") ||
      extractSection("USER PERSPECTIVE", userText) ||
      "No user feedback provided",
    requiredChanges,
    testCoverageAssessment:
      extractSection("TEST COVERAGE ASSESSMENT") || undefined,
    securityIssues,
  };
}
