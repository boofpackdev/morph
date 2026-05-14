/**
 * morph — Spark Flow (Idea → Refined PRD)
 *
 * Team: Visionary + Critic (2 agents)
 *
 * The Visionary generates the PRD. The Critic stress-tests it.
 * The Lead (Visionary) synthesizes feedback into final output.
 *
 * Output: SparkOutput (vision, features, persona, constraints, stack, risks, success criteria)
 */

import { Blackboard } from "../core/blackboard.js";
import {
  runAgent,
  runAgentsChain,
  SPARK_AGENTS,
  type AgentConfig,
} from "../core/agent-runner.js";
import { estimateTokens } from "../core/tokenizer.js";
import type { SparkOutput } from "../schemas/contracts.js";

export interface SparkFlowOptions {
  cwd: string;
  prompt: string;
  blackboard: Blackboard;
  signal?: AbortSignal;
}

export async function executeSparkFlow(
  options: SparkFlowOptions
): Promise<SparkOutput> {
  const { cwd, prompt, blackboard, signal } = options;

  const visionary = SPARK_AGENTS.find((a) => a.name === "visionary")!;
  const critic = SPARK_AGENTS.find((a) => a.name === "critic")!;

  // ── Step 1: Visionary generates initial PRD ──
  const visionarySystemPrompt = `You are the **Visionary** for the morph orchestration pipeline.

## Your Role
You take a raw idea and produce a structured, actionable Product Requirements Document (PRD).
Be creative but grounded. Think about the user, the market, the technical feasibility.

## Your Output
Produce a structured PRD with these sections (mark exactly like this):

### VISION STATEMENT
[One paragraph describing what we're building and why]

### CORE FEATURES
- [Feature 1 — highest priority]
- [Feature 2] 
- ...

### TARGET USER PERSONA
[Who this is for — their goal, pain point, skill level]

### CONSTRAINTS
- [Constraint 1]
- ...

### TECHNICAL STACK RECOMMENDATION
[Recommended tech stack with brief rationale]

### RISKS
- [Risk 1]
- ...

### SUCCESS CRITERIA
- [Criterion 1]
- ...

Be exhaustive. Think through edge cases. This PRD will be stress-tested by a Critic, so make it robust.`;

  const visionaryResult = await runAgent(visionary, {
    cwd,
    task: `Refine this idea into a comprehensive PRD:\n\n${prompt}`,
    systemPrompt: visionarySystemPrompt,
    signal,
  });

  blackboard.addTokens(
    "spark",
    estimateTokens(visionaryResult.output || "")
  );

  // ── Step 2: Critic stress-tests the PRD ──
  const criticSystemPrompt = `You are the **Critic** for the morph orchestration pipeline.

## Your Role
You stress-test ideas and PRDs. You find:
- Logical flaws and contradictions
- Missing edge cases
- Over-engineered or under-engineered aspects
- Risks that were overlooked
- Unrealistic assumptions
- Ambiguous language that could confuse implementers

## Instructions
Review the PRD below. Produce a structured critique with:

### STRENGTHS
[What's solid and should be kept]

### WEAKNESSES / GAPS
[Specific problems with suggested fixes]

### MISSING EDGE CASES
[Scenarios not covered]

### RISK REASSESSMENT
[Risks the Visionary missed]

### REFINEMENT SUGGESTIONS
[Concrete improvements to the PRD]

Be sharp, specific, and constructive. Every criticism must come with a suggested fix.`;

  const criticResult = await runAgent(critic, {
    cwd,
    task: `Critique this PRD thoroughly:\n\n${visionaryResult.output}`,
    systemPrompt: criticSystemPrompt,
    signal,
  });

  blackboard.addTokens("spark", estimateTokens(criticResult.output || ""));

  // ── Step 3: Visionary synthesizes final PRD ──
  const synthesisSystemPrompt = `You are the **Visionary** (Lead) for the morph orchestration pipeline.

## Your Role
You've seen the Critic's feedback on your PRD. Now synthesize a FINAL, refined PRD that incorporates the valid criticisms.

## Instructions
Produce the final PRD in this exact format (parseable):

### VISION STATEMENT
[One paragraph]

### CORE FEATURES
- [Feature 1]
- [Feature 2]
...

### TARGET USER PERSONA
[Description]

### CONSTRAINTS
- [Constraint 1]
...

### TECHNICAL STACK RECOMMENDATION
[Stack + rationale]

### RISKS
- [Risk 1 with mitigation]
...

### SUCCESS CRITERIA
- [Criterion 1]
...

Be concise. This output flows directly to the Plan phase.`;

  const synthesisResult = await runAgent(visionary, {
    cwd,
    task: `My original PRD:\n${visionaryResult.output}\n\nCritic's feedback:\n${criticResult.output}\n\nSynthesize a FINAL, refined PRD.`,
    systemPrompt: synthesisSystemPrompt,
    signal,
  });

  blackboard.addTokens("spark", estimateTokens(synthesisResult.output || ""));

  // ── Parse output into structured SparkOutput ──
  const output = synthesisResult.output || "";
  const sparkOutput = parseSparkOutput(output, prompt);

  // Record decisions
  blackboard.recordDecision(
    "spark",
    `Selected tech stack: ${sparkOutput.technicalStackRecommendation}`,
    "Based on Visionary + Critic synthesis"
  );
  blackboard.recordDecision(
    "spark",
    `Identified ${sparkOutput.risks.length} risks and ${sparkOutput.coreFeatures.length} core features`,
    "Critic validation complete"
  );

  blackboard.setSparkOutput(sparkOutput);

  return sparkOutput;
}

// ── Parsing ──

function parseSparkOutput(text: string, originalPrompt: string): SparkOutput {
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

  return {
    visionStatement: extractSection("VISION STATEMENT") || "Vision not extracted",
    coreFeatures: extractList("CORE FEATURES"),
    targetUserPersona: extractSection("TARGET USER PERSONA") || "Persona not extracted",
    constraints: extractList("CONSTRAINTS"),
    technicalStackRecommendation:
      extractSection("TECHNICAL STACK RECOMMENDATION") ||
      extractSection("TECHNICAL STACK") ||
      "Stack not specified",
    risks: extractList("RISKS"),
    successCriteria: extractList("SUCCESS CRITERIA"),
  };
}
