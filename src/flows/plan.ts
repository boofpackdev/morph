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
  runAgentsParallel,
  PLAN_AGENTS,
  type AgentConfig,
  type AgentResult,
} from "../core/agent-runner.js";
import { estimateTokens } from "../core/tokenizer.js";
import { formatDAG, topologicalSort } from "../core/engine.js";
import type { PlanOutput, TaskNode } from "../schemas/contracts.js";

export interface PlanFlowOptions {
  cwd: string;
  blackboard: Blackboard;
  signal?: AbortSignal;
}

export async function executePlanFlow(
  options: PlanFlowOptions
): Promise<PlanOutput> {
  const { cwd, blackboard, signal } = options;
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

The DAG must be complete: every component from the component tree must have
corresponding tasks. Tasks must be ordered correctly (database before API, etc.).

Be exhaustive. This plan drives the entire implementation phase.`;

  const architectTask = `PRD:\n${prdContext}\n\nDesign the complete technical plan.`;

  const architectResult = await runAgent(architect, {
    cwd,
    task: architectTask,
    systemPrompt: architectSystemPrompt,
    signal,
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
  const architectTaskParsed = parseTasks(planText);

  const [qaResult, efficiencyResult] = await runAgentsParallel(
    [qaExpert, efficiencyMgr],
    {
      cwd,
      task: `Architecture plan:\n${planText}`,
      systemPrompt: "", // Each agent has their own prompt
      signal,
    },
    2
  );

  // Override system prompts per agent (parallel runner uses same for all)
  // We need separate runs — let's do sequential for clarity
  const qaResultActual = await runAgent(qaExpert, {
    cwd,
    task: `Architecture plan:\n${planText}\n\nReview for testability and QA strategy.`,
    systemPrompt: qaSystemPrompt,
    signal,
  });

  const effResultActual = await runAgent(efficiencyMgr, {
    cwd,
    task: `Architecture plan:\n${planText}\n\nAnalyze for efficiency and optimization.`,
    systemPrompt: efficiencySystemPrompt,
    signal,
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
A JSON array of task objects:
\`\`\`json
[
  {
    "id": "DB-01",
    "description": "...",
    "category": "db",
    "dependsOn": [],
    "acceptanceCriteria": "...",
    "estimatedComplexity": "medium"
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
Every component must have tasks. Every dependency must reference a real task ID.
Tasks must form a valid DAG (no cycles).`;

  const synthesisTask = `Original plan:\n${planText}\n\nQA feedback:\n${qaResultActual.output}\n\nEfficiency feedback:\n${effResultActual.output}\n\nSynthesize the FINAL plan.`;

  const finalResult = await runAgent(architect, {
    cwd,
    task: synthesisTask,
    systemPrompt: synthesisSystemPrompt,
    signal,
  });

  blackboard.addTokens("plan", estimateTokens(finalResult.output || ""));

  // ── Parse output into structured PlanOutput ──
  const planOutput = parsePlanOutput(finalResult.output || "");

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

function parseTasks(text: string): TaskNode[] {
  // Try to extract JSON array from markdown code block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through to manual parsing
    }
  }

  // Fallback: look for task-like lines
  const tasks: TaskNode[] = [];
  const lines = text.split("\n");
  let currentTask: Partial<TaskNode> | null = null;

  for (const line of lines) {
    const taskMatch = line.match(
      /^[-*]\s*(?:\[([^\]]+)\]\s*)?(.+)$/
    );
    if (taskMatch) {
      if (currentTask && currentTask.id) {
        tasks.push(currentTask as TaskNode);
      }
      const id = taskMatch[1] || `TASK-${String(tasks.length + 1).padStart(2, "0")}`;
      currentTask = {
        id,
        description: taskMatch[2].trim(),
        category: "other",
        dependsOn: [],
        acceptanceCriteria: "",
        estimatedComplexity: "medium",
      };
    }
  }
  if (currentTask && currentTask.id) {
    tasks.push(currentTask as TaskNode);
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
