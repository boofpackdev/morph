/**
 * morph — Handoff Contracts (Zod Schemas)
 *
 * These schemas are the gatekeepers. Every flow phase must produce
 * output that conforms to its schema before the state machine advances.
 */

import { z } from "zod";

// ── Task Node (DAG-compatible) ──
export const TaskNodeSchema = z.object({
  id: z.string().describe("Unique task identifier, e.g. 'DB-01'"),
  description: z.string().describe("What this task does"),
  category: z
    .enum(["db", "api", "ui", "config", "test", "docs", "infra", "other"])
    .describe("Task category for routing to the right agent"),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe("Task IDs this task must wait for"),
  acceptanceCriteria: z
    .string()
    .describe("How to verify this task is done"),
  estimatedComplexity: z
    .enum(["low", "medium", "high"])
    .describe("Rough complexity estimate"),
  files: z
    .array(z.string())
    .optional()
    .describe("Expected files this task produces/changes"),
  targetDir: z
    .string()
    .optional()
    .describe("Subdirectory to work in (relative to project root). E.g. 'packages/client' or 'portfolio'"),
});

export type TaskNode = z.infer<typeof TaskNodeSchema>;

// ── Spark Output (Idea → Refined PRD) ──
export const SparkOutputSchema = z.object({
  visionStatement: z
    .string()
    .describe("One-paragraph vision of what we're building"),
  coreFeatures: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe("Must-have features, ordered by priority"),
  targetUserPersona: z
    .string()
    .describe("Who this is for — their goal, pain point, skill level"),
  constraints: z
    .array(z.string())
    .default([])
    .describe("Hard constraints: budget, timeline, platform, compliance"),
  technicalStackRecommendation: z
    .string()
    .describe("Recommended tech stack with brief rationale"),
  risks: z
    .array(z.string())
    .default([])
    .describe("Identified risks and unknowns"),
  successCriteria: z
    .array(z.string())
    .default([])
    .describe("How we'll know this succeeded"),
});

export type SparkOutput = z.infer<typeof SparkOutputSchema>;

// ── Plan Output (PRD → Actionable Graph) ──
export const PlanOutputSchema = z.object({
  architectureDiagram: z
    .string()
    .describe("Mermaid.js format architecture diagram"),
  dataModels: z
    .array(z.string())
    .describe("Data model descriptions (tables, collections, schemas)"),
  componentTree: z
    .array(
      z.object({
        name: z.string(),
        responsibility: z.string(),
        dependsOn: z.array(z.string()).default([]),
      })
    )
    .describe("Component breakdown with dependencies"),
  tasks: z
    .array(TaskNodeSchema)
    .min(1)
    .describe("DAG of implementation tasks"),
  qaStrategy: z.string().describe("Testing approach: unit, integration, e2e"),
  riskMitigations: z
    .array(z.string())
    .default([])
    .describe("How identified risks are mitigated"),
  estimatedEffort: z
    .enum(["hours", "days", "weeks"])
    .describe("Rough effort estimate"),
  humanReviewNotes: z
    .string()
    .optional()
    .describe("Human-approved/edited pre-work specification passed to implementation agents"),
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ── Work Task Result ──
export const WorkTaskResultSchema = z.object({
  taskId: z.string(),
  status: z.enum(["done", "blocked", "failed"]),
  filesChanged: z.array(z.string()).default([]),
  diff: z.string().optional().describe("Git patch of changes"),
  summary: z.string().describe("What was done and why"),
  testsPassed: z.boolean().optional(),
  notes: z.string().optional(),
});

export type WorkTaskResult = z.infer<typeof WorkTaskResultSchema>;

// ── Review Output (Code + Tests → Approval/Rejection) ──
export const ReviewOutputSchema = z.object({
  status: z
    .enum(["APPROVED", "REJECTED", "FIX_REQUESTED"])
    .describe("Overall review verdict"),
  technicalAudit: z
    .string()
    .describe("Architecture, patterns, security, performance assessment"),
  efficiencyScore: z
    .number()
    .min(1)
    .max(10)
    .describe("Code quality / efficiency score (1-10)"),
  userPerspectiveFeedback: z
    .string()
    .describe("Feedback from simulated end-user perspective"),
  requiredChanges: z
    .array(
      z.object({
        taskId: z.string().optional(),
        description: z.string(),
        severity: z.enum(["critical", "major", "minor", "nice-to-have"]),
      })
    )
    .default([])
    .describe("Specific changes required before ship"),
  testCoverageAssessment: z.string().optional(),
  securityIssues: z.array(z.string()).default([]),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// ── Ship Output (Approved Code → Released) ──
export const ShipOutputSchema = z.object({
  status: z.enum(["SHIPPED", "ABORTED", "ROLLED_BACK"]),
  version: z.string().describe("Release version/tag"),
  changelog: z.string().describe("Human-readable changelog"),
  deploymentChecklist: z
    .array(z.object({ item: z.string(), done: z.boolean() }))
    .describe("Pre-release checklist items"),
  postReleaseNotes: z.string().optional(),
  rollbackPlan: z.string().optional(),
});

export type ShipOutput = z.infer<typeof ShipOutputSchema>;

// ── Morph State (Blackboard) ──
export const MorphPhaseSchema = z.enum([
  "idle",
  "spark",
  "plan",
  "work",
  "review",
  "ship",
  "done",
]);

export type MorphPhase = z.infer<typeof MorphPhaseSchema>;

export const MorphStateSchema = z.object({
  phase: MorphPhaseSchema,
  config: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .default({}),
  startedAt: z.string().optional(),
  pipelinePrompt: z.string().optional(),
  sparkOutput: SparkOutputSchema.optional(),
  planOutput: PlanOutputSchema.optional(),
  workResults: z.array(WorkTaskResultSchema).default([]),
  reviewOutput: ReviewOutputSchema.optional(),
  shipOutput: ShipOutputSchema.optional(),
  tokenLedger: z
    .object({
      spark: z.number().default(0),
      plan: z.number().default(0),
      work: z.number().default(0),
      review: z.number().default(0),
      ship: z.number().default(0),
      total: z.number().default(0),
    })
    .default({}),
  activeAgents: z.array(z.string()).default([]),
  flowCheckpoints: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  retries: z.record(z.string(), z.number()).default({}),
  decisions: z
    .array(
      z.object({
        phase: z.string(),
        decision: z.string(),
        reason: z.string(),
        timestamp: z.string(),
      })
    )
    .default([]),
});

export type MorphState = z.infer<typeof MorphStateSchema>;
