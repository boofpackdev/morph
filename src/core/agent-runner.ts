/**
 * morph — Agent Runner
 *
 * Spawns pi subprocesses for each agent in the pipeline.
 * Uses JSON mode for structured output capture.
 *
 * Key features:
 *   - Spawns pi with specific model, tools, and system prompt
 *   - Captures JSON events, strips reasoning tokens
 *   - Tracks token usage and cost
 *   - Supports timeout, retry, and abort
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  stripReasoningTokens,
  stripJsonReasoning,
  estimateTokens,
  calculateCost,
} from "../core/tokenizer.js";

// ── Types ──

export interface AgentConfig {
  name: string;
  role: string;
  description: string;
  provider?: string;
  model?: string;
  tools?: string[];
  thinkingLevel?: string;
}

export interface AgentResult {
  agent: string;
  role: string;
  exitCode: number;
  output: string;             // Final assistant text output
  messages: Array<{ role: string; content: string }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
}

export interface RunAgentOptions {
  cwd: string;
  task: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  tools?: string[];
  thinkingLevel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  additionalArgs?: string[];
  prependSystemPrompt?: boolean; // true = replace system prompt, false = append
  blackboard?: any;
}

// ── Default Agent Teams ──

export const SPARK_AGENTS: AgentConfig[] = [
  {
    name: "visionary",
    role: "Visionary",
    description:
      "Creative product thinker who envisions the solution and user experience",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "high",
  },
  {
    name: "critic",
    role: "Critic",
    description:
      "Sharp skeptic who stress-tests ideas, finds edge cases, and identifies risks",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "medium",
  },
];

export const PLAN_AGENTS: AgentConfig[] = [
  {
    name: "architect",
    role: "Lead Architect",
    description:
      "Senior software architect who designs system structure, data models, and component boundaries",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "grep", "find", "bash"],
    thinkingLevel: "high",
  },
  {
    name: "qa-expert",
    role: "QA Expert",
    description:
      "Quality assurance specialist who designs test strategies and acceptance criteria",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "medium",
  },
  {
    name: "efficiency-mgr",
    role: "Efficiency Manager",
    description:
      "Optimization specialist who identifies waste, simplifies designs, and reduces token/effort costs",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "low",
  },
];

export const WORK_AGENTS: AgentConfig[] = [
  {
    name: "engineer",
    role: "Primary Engineer",
    description:
      "Senior engineer who implements features with clean, tested, efficient code",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "write", "edit", "bash", "grep", "find"],
    thinkingLevel: "medium",
  },
  {
    name: "peer-reviewer",
    role: "Peer Reviewer",
    description:
      "Second engineer who reviews code for correctness, edge cases, and style",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find", "bash"],
    thinkingLevel: "low",
  },
];

export const REVIEW_AGENTS: AgentConfig[] = [
  {
    name: "tech-lead",
    role: "Tech Lead",
    description:
      "Senior technical reviewer assessing architecture, patterns, and code quality",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "grep", "find", "bash"],
    thinkingLevel: "high",
  },
  {
    name: "qa-auditor",
    role: "QA Auditor",
    description:
      "Testing specialist reviewing test coverage, edge cases, and verification completeness",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "medium",
  },
  {
    name: "perf-guru",
    role: "Performance Guru",
    description:
      "Performance expert analyzing efficiency, bottlenecks, and optimization opportunities",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find", "bash"],
    thinkingLevel: "medium",
  },
  {
    name: "end-user",
    role: "End User / Customer",
    description:
      "Simulates the end user's perspective: usability, clarity, onboarding, and real-world usage",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "low",
  },
];

export const SHIP_AGENTS: AgentConfig[] = [
  {
    name: "devops-sre",
    role: "DevOps / SRE",
    description:
      "Infrastructure and reliability specialist handling deployment, monitoring, and rollback plans",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    tools: ["read", "bash", "grep", "find"],
    thinkingLevel: "medium",
  },
  {
    name: "release-consultant",
    role: "Release Consultant",
    description:
      "Release management specialist handling changelogs, versioning, and stakeholder communication",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tools: ["read", "grep", "find"],
    thinkingLevel: "low",
  },
];

// ── Helpers ──

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writeTempFile(
  prefix: string,
  content: string
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `morph-${prefix}-`)
  );
  const filePath = path.join(tmpDir, "prompt.md");
  await fs.promises.writeFile(filePath, content, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return { dir: tmpDir, filePath };
}

// ── Core: Run a Single Agent ──

export async function runAgent(
  config: AgentConfig,
  options: RunAgentOptions
): Promise<AgentResult> {
  const {
    cwd,
    task,
    systemPrompt,
    timeoutMs = 300000, // 5 min default
    signal,
    additionalArgs = [],
  } = options;

  const bbConfig = options.blackboard?.getState()?.config || {};
  // Prefer explicit morph/parent-session config. If unset, omit provider/model
  // flags so the spawned pi subprocess uses the user's configured default.
  const provider = bbConfig.provider || options.provider;
  const model = bbConfig.model || options.model;
  const tools = options.tools || config.tools;
  const thinkingLevel = options.thinkingLevel || config.thinkingLevel || "off";

  const result: AgentResult = {
    agent: config.name,
    role: config.role,
    exitCode: 0,
    output: "",
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      turns: 0,
    },
    model: model || config.model,
    stderr: "",
  };

  // Build pi invocation
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--thinking",
    thinkingLevel,
  ];

  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);

  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }

  // System prompt via temp file (append mode preserves default instructions)
  let tmpDir: string | null = null;
  let tmpPath: string | null = null;

  try {
    options.blackboard?.addActiveAgent(config.name);

    if (systemPrompt.trim()) {
      const tmp = await writeTempFile(config.name, systemPrompt);
      tmpDir = tmp.dir;
      tmpPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPath);
    }

    args.push(...additionalArgs);
    args.push(task);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        // Strip reasoning tokens from events
        stripJsonReasoning(event);

        // Process message_end events
        if (event.type === "message_end" && event.message) {
          const msg = event.message as any;
          result.messages.push({
            role: msg.role,
            content: msg.content
              ?.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("\n") || "",
          });

          if (msg.role === "assistant") {
            result.usage.turns++;
            if (msg.usage) {
              result.usage.inputTokens += msg.usage.input || 0;
              result.usage.outputTokens += msg.usage.output || 0;
              result.usage.cacheReadTokens += msg.usage.cacheRead || 0;
              result.usage.cacheWriteTokens += msg.usage.cacheWrite || 0;
            }
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
        }

        // Process tool_result_end events
        if (event.type === "tool_result_end" && event.message) {
          const msg = event.message as any;
          result.messages.push({
            role: msg.role,
            content: `[tool:${msg.toolName}] ${
              msg.content?.[0]?.text?.slice(0, 200) || ""
            }`,
          });
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    result.exitCode = exitCode;

    if (exitCode !== 0) {
      throw new Error(`Agent process failed (exit code ${exitCode}).\nStderr: ${result.stderr.trim() || "No error output"}`);
    }

    // Calculate cost
    result.usage.cost = calculateCost(
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cacheReadTokens,
      result.usage.cacheWriteTokens
    );

    // Extract final output
    result.output = getFinalOutput(result.messages);

    // Strip reasoning from final output
    result.output = stripReasoningTokens(result.output);

    if (wasAborted) {
      result.stopReason = "aborted";
      result.errorMessage = "Agent was aborted";
    }

    return result;
  } finally {
    options.blackboard?.removeActiveAgent(config.name);
    // Cleanup temp files
    if (tmpPath)
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    if (tmpDir)
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
  }
}

/**
 * Run multiple agents concurrently with a limit.
 */
export async function runAgentsParallel(
  configs: AgentConfig[],
  options: RunAgentOptions,
  concurrency: number = 4
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  const queue = [...configs];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const config = queue.shift()!;
      const result = await runAgent(config, options);
      results.push(result);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, configs.length) },
    () => worker()
  );
  await Promise.all(workers);

  // Sort by original order
  const orderMap = new Map(configs.map((c, i) => [c.name, i]));
  results.sort(
    (a, b) => (orderMap.get(a.agent) || 0) - (orderMap.get(b.agent) || 0)
  );

  return results;
}

/**
 * Run agents in a chain, each receiving the previous agent's output.
 */
export async function runAgentsChain(
  configs: AgentConfig[],
  baseOptions: RunAgentOptions,
  outputPlaceholder: string = "{previous}"
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  let previousOutput = "";

  for (const config of configs) {
    const task = baseOptions.task.replace(
      new RegExp(outputPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      previousOutput
    );

    const result = await runAgent(config, {
      ...baseOptions,
      task,
    });

    results.push(result);

    if (result.exitCode !== 0 || result.stopReason === "error") {
      break;
    }

    previousOutput = result.output;
  }

  return results;
}

// ── Utility ──

function getFinalOutput(
  messages: Array<{ role: string; content: string }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return messages[i].content;
    }
  }
  return "";
}

/**
 * Build a hub-and-spoke system prompt.
 * The lead agent coordinates sub-agents and synthesizes their output.
 */
export function buildHubSpokePrompt(
  leadRole: string,
  leadInstructions: string,
  spokeConfigs: AgentConfig[],
  spokeInstructions: Map<string, string>,
  context: string
): string {
  const lines: string[] = [
    `You are the ${leadRole} for the morph orchestration pipeline.`,
    "",
    "## Your Role",
    leadInstructions,
    "",
    "## Context",
    context,
    "",
    "## Your Team (Hub-and-Spoke)",
    "You coordinate the following specialists. Delegate to them by describing what you need.",
    "Synthesize their inputs into a final, cohesive output.",
    "",
  ];

  for (const spoke of spokeConfigs) {
    const instr = spokeInstructions.get(spoke.name) || spoke.description;
    lines.push(`### ${spoke.role} (${spoke.name})`);
    lines.push(`Model: ${spoke.model || "default"} | Tools: ${spoke.tools?.join(", ") || "all"}`);
    lines.push(`Instructions: ${instr}`);
    lines.push("");
  }

  lines.push("## Output Format");
  lines.push("Produce your final output as clean, structured text.");
  lines.push("Do NOT include internal monologue or thinking blocks.");

  return lines.join("\n");
}
