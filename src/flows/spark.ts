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
  onAgentEvent?: (agentName: string, role: string, taskId: string, event: any) => void;
}

export async function executeSparkFlow(
  options: SparkFlowOptions
): Promise<SparkOutput> {
  const { cwd, prompt, blackboard, signal, onAgentEvent } = options;

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

  const visionaryOutput = blackboard.getFlowCheckpoint("spark", "visionary") || (await runAgent(visionary, {
    cwd,
    task: `Refine this idea into a comprehensive PRD:\n\n${prompt}`,
    systemPrompt: visionarySystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(visionary.name, visionary.role, "-", event),
  })).output || "";
  if (!blackboard.getFlowCheckpoint("spark", "visionary")) {
    blackboard.addTokens("spark", estimateTokens(visionaryOutput));
    blackboard.setFlowCheckpoint("spark", "visionary", visionaryOutput);
  }

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

  const criticOutput = blackboard.getFlowCheckpoint("spark", "critic") || (await runAgent(critic, {
    cwd,
    task: `Critique this PRD thoroughly:\n\n${visionaryOutput}`,
    systemPrompt: criticSystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(critic.name, critic.role, "-", event),
  })).output || "";
  if (!blackboard.getFlowCheckpoint("spark", "critic")) {
    blackboard.addTokens("spark", estimateTokens(criticOutput));
    blackboard.setFlowCheckpoint("spark", "critic", criticOutput);
  }

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

  const synthesisOutput = blackboard.getFlowCheckpoint("spark", "synthesis") || (await runAgent(visionary, {
    cwd,
    task: `My original PRD:\n${visionaryOutput}\n\nCritic's feedback:\n${criticOutput}\n\nSynthesize a FINAL, refined PRD.`,
    systemPrompt: synthesisSystemPrompt,
    signal,
    blackboard,
    onEvent: (event) => onAgentEvent?.(visionary.name, visionary.role, "-", event),
  })).output || "";
  if (!blackboard.getFlowCheckpoint("spark", "synthesis")) {
    blackboard.addTokens("spark", estimateTokens(synthesisOutput));
    blackboard.setFlowCheckpoint("spark", "synthesis", synthesisOutput);
  }

  // ── Parse output into structured SparkOutput ──
  const output = synthesisOutput;
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
    // Match ### SECTION or ## SECTION or SECTION: 
    const regex = new RegExp(
      `(?:###|##|#)?\\s*${marker}(?:\\s*:)?\\s*[\\s\\S]*?(?=(?:###|##|#)\\s|$)`,
      "i"
    );
    const match = text.match(regex);
    if (!match) return "";
    
    return match[0]
      .replace(new RegExp(`^(?:###|##|#)?\\s*${marker}(?:\\s*:)?\\s*`, "i"), "")
      .trim();
  };

  const extractList = (marker: string): string[] => {
    const section = extractSection(marker);
    return section
      .split("\n")
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter((l) => l.length > 0 && !l.toLowerCase().includes(marker.toLowerCase()));
  };

  const vision = extractSection("VISION STATEMENT") || extractSection("VISION");
  const persona = extractSection("TARGET USER PERSONA") || extractSection("USER PERSONA") || extractSection("PERSONA");
  const stack = extractSection("TECHNICAL STACK RECOMMENDATION") || extractSection("TECHNICAL STACK") || extractSection("TECH STACK") || extractSection("STACK");

  const output = {
    visionStatement: vision || originalPrompt.slice(0, 500),
    coreFeatures: extractList("CORE FEATURES").length > 0 ? extractList("CORE FEATURES") : extractList("FEATURES"),
    targetUserPersona: persona || "General User",
    constraints: extractList("CONSTRAINTS"),
    technicalStackRecommendation: stack || "Stack not specified",
    risks: extractList("RISKS"),
    successCriteria: extractList("SUCCESS CRITERIA"),
  };
  
  if (output.visionStatement === "Vision not extracted" && text.length < 50) {
    throw new Error(`Spark failed to generate a valid PRD. Agent output was too short: "${text}"`);
  }
  
  return output;
}
