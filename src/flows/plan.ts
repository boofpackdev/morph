/**
 * morph — Plan Flow (PRD → Actionable DAG)
 *
 * Team: Lead Architect + QA Expert + Efficiency Manager (3 agents)
 *
 * Hub-and-spoke model: Architect coordinates QA and Efficiency,
 * synthesizing their inputs into a final execution plan with DAG tasks.
 *
 * Output: PlanOutput (architecture diagram, data models, component tree, tasks, QA strategy)
 */

import { Blackboard } from "../core/blackboard.js";
import {
  runAgent,
  PLAN_AGENTS,
} from "../core/agent-runner.js";
import { estimateTokens } from "../core/tokenizer.js";
import { formatDAG, topologicalSort } from "../core/engine.js";
import type { PlanOutput, TaskNode } from "../schemas/contracts.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PlanFlowOptions {
  cwd: string;
  blackboard: Blackboard;
  signal?: AbortSignal;
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void;
}

export async function executePlanFlow(
  options: PlanFlowOptions
): Promise<PlanOutput> {
  const { cwd, blackboard, signal, onAgentEvent } = options;
  const sparkOutput = blackboard.getState().sparkOutput;
  if (!sparkOutput) {
    throw new Error("No spark output found. Run spark flow first.");
  }

  const architect = PLAN_AGENTS.find((a) => a.name === "architect")!;
  const qaExpert = PLAN_AGENTS.find((a) => a.name === "qa-expert")!;
  const efficiencyMgr = PLAN_AGENTS.find((a) => a.name === "efficiency-mgr")!;

  // ── Build the PRD context ──
  const prdContext = buildPrdContext(sparkOutput);

  // ── Step 1: Architect generates initial architecture ──
  const architectSystemPrompt = `You are the **Lead Architect** for the morph orchestration pipeline.

## Your Role
You transform a PRD into a comprehensive, implementable technical plan.
You design the architecture, component tree, data models, and task breakdown.

## Instructions
Given the PRD below, produce:

### ARCHITECTURE DIAGRAM
A Mermaid.js diagram showing system components and their relationships.
Use flowchart TB (top-to-bottom) format.

### DATA MODELS
For each data entity, describe:
- Name and purpose
- Key fields/types
- Relationships

### COMPONENT TREE
List each component with:
- Name and responsibility
- Dependencies (what it depends on)

### TASK BREAKDOWN
Create a DAG (Directed Acyclic Graph) of implementation tasks.
Each task must have:
- id: unique identifier like "DB-01", "API-02"
- description: what to implement
- category: db | api | ui | config | test | docs | infra | other
- dependsOn: array of task IDs this depends on (empty if none)
- acceptanceCriteria: how to verify completion
- estimatedComplexity: low | medium | high
- files: expected files or glob-like paths this task will create/change
- targetDir: the project subdirectory this task belongs to, relative to repo root. Use "." for repo root.

The DAG must be complete: every component from the component tree must have
corresponding tasks. Tasks must be ordered correctly (database before API, etc.).

Be exhaustive. This plan drives the entire implementation phase.`;

  const architectTask = `PRD:\n${prdContext}\n\nDesign the complete technical plan.`;

  const architectResult = await runAgent(architect, {
    cwd,
    task: architectTask,
    systemPrompt: architectSystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(architect.name, architect.role, "-", event),
  });

  blackboard.addTokens("plan", estimateTokens(architectResult.output || ""));

  // ── Step 2: QA Expert and Efficiency Manager run in parallel ──

  const qaSystemPrompt = `You are the **QA Expert** for the morph orchestration pipeline.

## Your Role
You design the testing strategy and review tasks for testability.
For each task in the plan, you ensure:
- Acceptance criteria are testable and specific
- Edge cases are covered
- Appropriate test types are identified (unit, integration, e2e)

## Output
Produce:

### QA STRATEGY
[Overall testing approach: frameworks, coverage targets, test types]

### TASK TESTABILITY REVIEW
For each task, provide:
- Is the acceptance criteria testable?
- Suggested test approach
- Missing edge cases

### ADDITIONAL TEST TASKS
Any tasks that should be added to the DAG for testing infrastructure.`;

  const efficiencySystemPrompt = `You are the **Efficiency Manager** for the morph orchestration pipeline.

## Your Role
You optimize the plan for efficiency:
- Identify redundant or over-engineered tasks
- Suggest simplifications that reduce scope without sacrificing quality
- Find opportunities for parallel execution
- Estimate token/compute costs
- Flag tasks that are too complex and should be split

## Output
Produce:

### EFFICIENCY ANALYSIS
[Overall assessment of plan efficiency]

### REDUNDANT / OVER-ENGINEERED
[Tasks that can be simplified or removed, with justification]

### PARALLELIZATION OPPORTUNITIES
[Tasks that can run concurrently — adjust dependencies if needed]

### COMPLEXITY FLAGS
[Tasks that should be split into smaller units]

### COST ESTIMATE
[Rough estimate of implementation effort and compute cost]`;

  const planText = architectResult.output || "";

  const qaResultActual = await runAgent(qaExpert, {
    cwd,
    task: `Architecture plan:\n${planText}\n\nReview for testability and QA strategy.`,
    systemPrompt: qaSystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(qaExpert.name, qaExpert.role, "-", event),
  });

  const effResultActual = await runAgent(efficiencyMgr, {
    cwd,
    task: `Architecture plan:\n${planText}\n\nAnalyze for efficiency and optimization.`,
    systemPrompt: efficiencySystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(efficiencyMgr.name, efficiencyMgr.role, "-", event),
  });

  blackboard.addTokens("plan", estimateTokens(qaResultActual.output || ""));
  blackboard.addTokens(
    "plan",
    estimateTokens(effResultActual.output || "")
  );

  // ── Step 3: Architect synthesizes final plan ──
  const synthesisSystemPrompt = `You are the **Lead Architect** for the morph orchestration pipeline.

## Your Role
You've received QA and efficiency feedback on your architecture plan.
Synthesize a FINAL, comprehensive plan.

## Instructions
Produce the final plan with these exact sections:

### ARCHITECTURE DIAGRAM
[Mermaid.js flowchart TB]

### DATA MODELS
[Data model descriptions]

### COMPONENT TREE
[Name, responsibility, dependencies for each component]

### TASKS (DAG)
A JSON array of task objects. Each task must be a concrete, implementable unit of work.
CRITICAL: Do NOT include markdown headings, design notes, explanatory text, or metadata as tasks.
Only create tasks that produce actual code, tests, configuration, or documentation changes.

\`\`\`json
[
  {
    "id": "DB-01",
    "description": "Create the users table schema with email, name, and timestamps",
    "category": "db",
    "dependsOn": [],
    "acceptanceCriteria": "Migration runs cleanly; schema has all required columns with correct types",
    "estimatedComplexity": "low",
    "files": ["src/db/schema.ts"],
    "targetDir": "."
  },
  {
    "id": "API-01",
    "description": "Implement POST /api/users endpoint with input validation",
    "category": "api",
    "dependsOn": ["DB-01"],
    "acceptanceCriteria": "Can create a user via POST; returns 201 with user object; returns 400 on invalid input",
    "estimatedComplexity": "medium",
    "files": ["src/routes/users.ts", "tests/users.test.ts"],
    "targetDir": "."
  }
]
\`\`\`

### QA STRATEGY
[Testing approach]

### RISK MITIGATIONS
- [Risk → Mitigation]

### ESTIMATED EFFORT
One of: hours | days | weeks

Make sure the task DAG is complete and all dependencies are correct.
Every component must have corresponding tasks. Every dependency must reference a real task ID.
Tasks must form a valid DAG (no cycles).
Use the SAME targetDir for related work on the same deliverable. If the requested feature/site/app is meant to live in a subdirectory, place every related task in that subdirectory consistently rather than mixing root and nested paths.`;

  const synthesisTask = `Original plan:\n${planText}\n\nQA feedback:\n${qaResultActual.output}\n\nEfficiency feedback:\n${effResultActual.output}\n\nSynthesize the FINAL plan.`;

  const finalResult = await runAgent(architect, {
    cwd,
    task: synthesisTask,
    systemPrompt: synthesisSystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(architect.name, architect.role, "-", event),
  });

  blackboard.addTokens("plan", estimateTokens(finalResult.output || ""));

  // ── Parse output into structured PlanOutput ──
  const planOutput = normalizePlanOutput(parsePlanOutput(finalResult.output || ""), cwd, sparkOutput);

  // Validate DAG
  try {
    const sorted = topologicalSort(planOutput.tasks);
    blackboard.recordDecision(
      "plan",
      `DAG valid: ${sorted.length} tasks in topological order`,
      "Verified no cycles"
    );
  } catch (err: any) {
    blackboard.recordDecision(
      "plan",
      `DAG validation failed: ${err.message}`,
      "Will retry with fix"
    );
    throw err;
  }

  blackboard.recordDecision(
    "plan",
    `Estimated effort: ${planOutput.estimatedEffort}`,
    "Based on task complexity analysis"
  );

  blackboard.setPlanOutput(planOutput);

  return planOutput;
}

// ── Parsing ──

function buildPrdContext(spark: NonNullable<ReturnType<Blackboard["getState"]>["sparkOutput"]>): string {
  return [
    `# Product Requirements Document`,
    ``,
    `## Vision`,
    spark.visionStatement,
    ``,
    `## Core Features`,
    ...spark.coreFeatures.map((f) => `- ${f}`),
    ``,
    `## Target User`,
    spark.targetUserPersona,
    ``,
    `## Constraints`,
    ...spark.constraints.map((c) => `- ${c}`),
    ``,
    `## Tech Stack (Recommended)`,
    spark.technicalStackRecommendation,
    ``,
    `## Risks`,
    ...spark.risks.map((r) => `- ${r}`),
    ``,
    `## Success Criteria`,
    ...spark.successCriteria.map((s) => `- ${s}`),
  ].join("\n");
}

/**
 * Attempt to extract and parse a JSON array of tasks from the AI output.
 * Tries multiple patterns and cleans common formatting issues.
 */
function tryExtractJsonTasks(text: string): TaskNode[] | null {
  // Pattern 1: Standard ```json ... ``` code block, also ```...``` unlabeled
  const patterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    let jsonStr = match[1] || match[0];

    // Clean the JSON string
    // 1. Remove leading/trailing non-JSON content
    jsonStr = jsonStr.trim();
    // Find the first [ and last ]
    const firstBracket = jsonStr.indexOf("[");
    const lastBracket = jsonStr.lastIndexOf("]");
    if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) continue;
    jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);

    // 2. Remove trailing commas before ] or }
    jsonStr = jsonStr.replace(/,([\s\r\n]*[}\]])/g, "$1");

    // 3. Fix unquoted keys (common AI mistake)
    jsonStr = jsonStr.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as TaskNode[];
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Patterns that indicate a line is NOT a real task (markdown fluff, metadata, etc.)
 */
const NON_TASK_PATTERNS = [
  /^--+$/,                    // Just dashes
  /^\*[^*:]+:\*\*?/,        // Design notes like "*Key design decisions:**"
  /^\*\*[A-Z][a-z]+:\*\*/, // "**Complexity:**", "**Dependencies:**"
  /^~[^~]+~$/,                // Tilde-wrapped notes "~50 tasks...~"
  /^\(Updated\)/i,          // "(Updated)"
  /^Savings from original/i,  // Efficiency savings notes
  /^\d+-\d+ tasks?/,        // "47 tasks..." summary lines
  /^~\d+/,                    // Lines starting with "~" and a number (effort estimates)
];

/**
 * Check if a description looks like a real, implementable task.
 * Real tasks describe concrete changes (code, tests, config, docs, infra).
 */
function isRealTask(description: string): boolean {
  const trimmed = description.trim();

  // Reject empty/trivial
  if (!trimmed || trimmed === "--" || trimmed.length < 3) return false;

  // Reject markdown metadata patterns
  for (const pat of NON_TASK_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }

  // Accept if it looks like a concrete action
  const actionPatterns = [
    /^(Create|Implement|Add|Build|Set up|Configure|Write|Refactor|Move|Inline|Extract|Remove|Delete|Replace|Migrate|Update|Fix)/i,
    /^(Render|Fetch|Handle|Validate|Transform|Export|Import|Deploy|Test|Document)/i,
    /`[^`]+`\s*→/,           // "`File.svelte` → inline in..."
    /`[^`]+`\s+(component|file|module|class|function)/i,
  ];

  for (const pat of actionPatterns) {
    if (pat.test(trimmed)) return true;
  }

  // If it has backtick references to files or implementations, likely real
  if (trimmed.includes("`") && trimmed.length > 10) return true;

  return false;
}

function parseTasks(text: string): TaskNode[] {
  // PRIORITY 1: Try to extract proper JSON array of tasks
  const jsonTasks = tryExtractJsonTasks(text);
  if (jsonTasks) return jsonTasks;

  // PRIORITY 2: Fallback — look for task-like lines, filtering out non-tasks
  const tasks: TaskNode[] = [];
  const lines = text.split("\n");
  let currentTask: Partial<TaskNode> | null = null;
  let insideTaskSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect the TASKS section
    if (/^###\s*TASKS/i.test(trimmed)) {
      insideTaskSection = true;
      continue;
    }
    // End of TASKS section when we hit another heading
    if (insideTaskSection && /^###\s/.test(trimmed)) {
      insideTaskSection = false;
    }

    // Only parse bullet points
    const taskMatch = trimmed.match(/^[-*]\s*(?:\[([^\]]+)\]\s*)?(.+)$/);
    if (!taskMatch) continue;

    const description = taskMatch[2].trim();

    // Skip non-task lines
    if (!isRealTask(description) && !insideTaskSection) continue;
    if (!isRealTask(description) && insideTaskSection) {
      // Inside TASKS section, still filter out obvious garbage patterns
      if (description === "--" || description.length < 3) continue;
      let isGarbage = false;
      for (const pat of NON_TASK_PATTERNS) {
        if (pat.test(description)) { isGarbage = true; break; }
      }
      if (isGarbage) continue;
    }

    // Push previous task if we have one
    if (currentTask && currentTask.id && currentTask.description) {
      tasks.push(currentTask as TaskNode);
    }

    const id = taskMatch[1] || `TASK-${String(tasks.length + 1).padStart(2, "0")}`;
    currentTask = {
      id,
      description,
      category: "other",
      dependsOn: [],
      acceptanceCriteria: "",
      estimatedComplexity: "medium",
    };
  }

  // Push the last task
  if (currentTask && currentTask.id && currentTask.description) {
    tasks.push(currentTask as TaskNode);
  }

  // If we got no tasks at all, create a sensible default
  if (tasks.length === 0) {
    tasks.push(createDefaultTask());
  }

  return tasks;
}

function parsePlanOutput(text: string): PlanOutput {
  const extractSection = (marker: string): string => {
    const regex = new RegExp(
      `###\\s*${marker}[\\s\\S]*?(?=###\\s|$)`,
      "i"
    );
    const match = text.match(regex);
    return match ? match[0].replace(/^###\s*${marker}\s*/i, "").trim() : "";
  };

  const extractList = (marker: string): string[] => {
    const section = extractSection(marker);
    return section
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 0);
  };

  const tasks = parseTasks(text);

  const effortText = extractSection("ESTIMATED EFFORT").toLowerCase();
  const estimatedEffort: "hours" | "days" | "weeks" = effortText.includes("week")
    ? "weeks"
    : effortText.includes("day")
      ? "days"
      : "hours";

  return {
    architectureDiagram:
      extractSection("ARCHITECTURE DIAGRAM") ||
      "graph TB\n  A[System] --> B[Components]",
    dataModels: extractList("DATA MODELS"),
    componentTree: parseComponents(extractSection("COMPONENT TREE")),
    tasks: tasks.length > 0 ? tasks : [createDefaultTask()],
    qaStrategy:
      extractSection("QA STRATEGY") || "Standard unit + integration + e2e testing",
    riskMitigations: extractList("RISK MITIGATIONS"),
    estimatedEffort,
  };
}

function normalizePlanOutput(
  plan: PlanOutput,
  cwd: string,
  spark: NonNullable<ReturnType<Blackboard["getState"]>["sparkOutput"]>
): PlanOutput {
  const inferredDefaultTarget = inferDefaultTargetDir(cwd, spark);
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      files: task.files?.length ? task.files : inferFilesForTask(task),
      targetDir: normalizeTargetDir(task.targetDir, inferredDefaultTarget),
    })),
  };
}

function inferDefaultTargetDir(
  cwd: string,
  spark: NonNullable<ReturnType<Blackboard["getState"]>["sparkOutput"]>
): string {
  const rootHasProjectMarker = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"]
    .some((file) => fs.existsSync(path.join(cwd, file)));

  const nestedProjectDirs = fs.readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((dir) => ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "index.html"]
      .some((file) => fs.existsSync(path.join(cwd, dir, file))));

  const text = [
    spark.visionStatement,
    ...spark.coreFeatures,
    spark.technicalStackRecommendation,
  ].join(" ").toLowerCase();

  const matchingNestedDir = nestedProjectDirs.find((dir) => text.includes(dir.toLowerCase()));
  if (matchingNestedDir) return matchingNestedDir;
  if (!rootHasProjectMarker && nestedProjectDirs.length === 1) return nestedProjectDirs[0];
  return ".";
}

function normalizeTargetDir(targetDir: string | undefined, fallback: string): string {
  const normalized = targetDir?.trim();
  if (!normalized || normalized === "/") return fallback;
  if (normalized === ".") return ".";
  return normalized.replace(/^[.][/\\]/, "").replace(/\\/g, "/");
}

function inferFilesForTask(task: TaskNode): string[] {
  switch (task.category) {
    case "test":
      return ["tests/**"];
    case "docs":
      return ["README.md"];
    case "config":
      return ["package.json"];
    case "ui":
      return ["src/**"];
    case "api":
      return ["src/**", "tests/**"];
    case "db":
      return ["src/**"];
    case "infra":
      return ["infra/**"];
    default:
      return [];
  }
}

function parseComponents(
  text: string
): Array<{ name: string; responsibility: string; dependsOn: string[] }> {
  const components: Array<{
    name: string;
    responsibility: string;
    dependsOn: string[];
  }> = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^[-*]\s*\*?\*?([^*]+?)\*?\*?\s*[-:]\s*(.+)$/);
    if (match) {
      components.push({
        name: match[1].trim(),
        responsibility: match[2].trim(),
        dependsOn: [],
      });
    }
  }

  return components;
}

function createDefaultTask(): TaskNode {
  return {
    id: "IMPL-01",
    description: "Implement the core feature",
    category: "other",
    dependsOn: [],
    acceptanceCriteria: "Feature works as specified",
    estimatedComplexity: "medium",
  };
}
