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
Do not infer that the product is a pi extension merely because morph itself runs inside pi.
Only classify the target product as a pi extension when the user's request explicitly requires that.

## Your Output
Produce a structured PRD with these sections (mark exactly like this):

### PRODUCT SHAPE
- Deliverable Type: [web app | CLI | library | API service | pi extension | etc.]
- Runtime / Host: [where this product runs]
- Distribution: [how the product is delivered or launched]
- Explicit User Intent: [one sentence describing only what the user actually asked to build]

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
- Product-shape drift where the PRD silently turns one kind of product into another

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

Be sharp, specific, and constructive. Every criticism must come with a suggested fix.
Specifically verify that the PRODUCT SHAPE matches the user's explicit request rather than assumptions introduced by the pipeline environment.`;

  const criticOutput = blackboard.getFlowCheckpoint("spark", "critic") || (await runAgent(critic, {
    cwd,
    task: `Original user request:\n${prompt}\n\nCritique this PRD thoroughly:\n\n${visionaryOutput}`,
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

### PRODUCT SHAPE
- Deliverable Type: [concrete product type]
- Runtime / Host: [where it runs]
- Distribution: [how it is delivered]
- Explicit User Intent: [what the user explicitly asked to build]

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
  let output = hasSubstantiveSparkContent(synthesisOutput) ? synthesisOutput : visionaryOutput;
  let sparkOutput = parseSparkOutput(output, prompt);
  let sparkIssues = assessSparkQuality(sparkOutput);

  if (sparkIssues.length > 0) {
    output =
      (
        await runAgent(visionary, {
          cwd,
          task: `The previous final PRD could not be accepted because:\n${sparkIssues
            .map((issue) => `- ${issue}`)
            .join(
              "\n"
            )}\n\nRepair the PRD. Preserve the user's actual request. Return the full final PRD again, including PRODUCT SHAPE.\n\nOriginal user request:\n${prompt}\n\nPrevious PRD:\n${output}`,
          systemPrompt: synthesisSystemPrompt,
          signal,
          blackboard,
          onEvent: (event) =>
            onAgentEvent?.(visionary.name, visionary.role, "-", event),
        })
      ).output || output;
    blackboard.addTokens("spark", estimateTokens(output));
    blackboard.setFlowCheckpoint("spark", "synthesis", output);
    sparkOutput = parseSparkOutput(output, prompt);
    sparkIssues = assessSparkQuality(sparkOutput);
  }

  if (sparkIssues.length > 0) {
    throw new Error(`Spark synthesis produced an unusable product definition: ${sparkIssues.join("; ")}`);
  }

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
      `(?:###|##|#)?\\s*(?:\\d+\\.\\s*)?${marker}(?:\\s*:)?\\s*[\\s\\S]*?(?=(?:###|##|#)\\s*(?:\\d+\\.\\s*)?|$)`,
      "i"
    );
    const match = text.match(regex);
    if (!match) return "";
    
    return match[0]
      .replace(new RegExp(`^(?:###|##|#)?\\s*(?:\\d+\\.\\s*)?${marker}(?:\\s*:)?\\s*`, "i"), "")
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
  const productShapeSection = extractSection("PRODUCT SHAPE");
  const persona = extractSection("TARGET USER PERSONA") || extractSection("USER PERSONA") || extractSection("PERSONA");
  const stack = extractSection("TECHNICAL STACK RECOMMENDATION") || extractSection("TECHNICAL STACK") || extractSection("TECH STACK") || extractSection("STACK");

  const output = {
    productShape: parseProductShape(productShapeSection, originalPrompt),
    visionStatement: vision || originalPrompt.slice(0, 500),
    coreFeatures: (extractList("CORE FEATURES").length > 0 ? extractList("CORE FEATURES") : extractList("FEATURES")).slice(0, 8),
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

function parseProductShape(section: string, originalPrompt: string): SparkOutput["productShape"] {
  const readField = (label: string): string => {
    const normalizedLines = section
      .split("\n")
      .map((line) => line.replace(/\*\*/g, "").trim());
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalizedLines
      .map((line) => line.match(new RegExp(`^[-*]?\\s*${escapedLabel}\\s*:\\s*(.+)$`, "i")))
      .find(Boolean);
    return match?.[1]?.trim() || "";
  };

  return {
    deliverableType: readField("Deliverable Type") || "unspecified product",
    runtime: readField("Runtime / Host") || "unspecified runtime",
    distribution: readField("Distribution") || "unspecified distribution",
    explicitUserIntent:
      readField("Explicit User Intent") || originalPrompt.trim().slice(0, 300),
  };
}

function assessSparkQuality(output: SparkOutput): string[] {
  const issues: string[] = [];
  const shape = output.productShape;
  if (/^unspecified product$/i.test(shape.deliverableType)) {
    issues.push("product shape is missing a concrete deliverable type");
  }
  if (/^unspecified runtime$/i.test(shape.runtime)) {
    issues.push("product shape is missing a runtime / host");
  }
  if (/^unspecified distribution$/i.test(shape.distribution)) {
    issues.push("product shape is missing a distribution path");
  }
  if (!shape.explicitUserIntent.trim()) {
    issues.push("product shape is missing explicit user intent");
  }
  return issues;
}

function hasSubstantiveSparkContent(text: string): boolean {
  const normalized = text.replace(/\[thinking\]|\[toolCall\]/gi, "").trim();
  return normalized.length > 120;
}
