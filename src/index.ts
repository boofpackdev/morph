/**
 * morph — Agent Orchestration Layer for pi
 *
 * 5-stage pipeline: spark → plan → work → review → ship
 *
 * TUI display shows live phase dashboard, task tracker,
 * agent activity, and token costs during execution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Blackboard, getMorphDir } from "./core/blackboard.js";
import { formatDAG, formatProgress, waveGroups, estimatePhaseTokens } from "./core/engine.js";
import { formatTokens } from "./core/tokenizer.js";
import { executeSparkFlow } from "./flows/spark.js";
import { executePlanFlow } from "./flows/plan.js";
import { executeWorkFlow } from "./flows/work.js";
import { executeReviewFlow } from "./flows/review.js";
import { executeShipFlow } from "./flows/ship.js";
import {
  SPARK_AGENTS, PLAN_AGENTS, WORK_AGENTS, REVIEW_AGENTS, SHIP_AGENTS,
} from "./core/agent-runner.js";
import {
  type PipelineDisplay,
  type TaskDisplay,
  type AgentActivity,
  buildPipelineProgressWidget,
  buildTaskTracker,
  buildStatusBar,
} from "./tui/display.js";
import { startMorphServer, serverEvents } from "./server/server.js";
import type { Server } from "node:http";
import type { PlanOutput } from "./schemas/contracts.js";

async function waitConfirm(ctx: any, title: string, desc: string, phase: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;

    // Web UI approval listener
    const onApprove = (p: string) => {
      if (p === phase && !resolved) {
        resolved = true;
        serverEvents.removeListener("approve", onApprove);
        ctx.ui.notify(`✅ Approved via Web UI`, "success" as any);
        resolve(true);
      }
    };
    serverEvents.on("approve", onApprove);

    // Terminal confirmation
    ctx.ui.confirm(title, desc).then((proceed: boolean) => {
      if (!resolved) {
        resolved = true;
        serverEvents.removeListener("approve", onApprove);
        resolve(proceed);
      }
    });
  });
}


function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildWorkSpecMarkdown(plan: PlanOutput): string {
  const waves = waveGroups(plan.tasks);
  const lines: string[] = ["# morph Pre-Work Specification Review", "", "Review this specification before WORK starts. Edit anything that needs clarification, scope adjustment, or constraints.", "The final text saved from this editor is passed to implementation and review agents as human-approved guidance.", "", "## Architecture", plan.architectureDiagram, "", "## Data Models", ...(plan.dataModels.length ? plan.dataModels.map((m) => `- ${m}`) : ["- None specified"]), "", "## Components", ...(plan.componentTree.length ? plan.componentTree.map((c) => `- ${c.name}: ${c.responsibility}${c.dependsOn.length ? ` (depends on: ${c.dependsOn.join(", ")})` : ""}`) : ["- None specified"]), "", "## Execution Waves"];
  for (let i = 0; i < waves.length; i++) {
    lines.push("", `### Wave ${i + 1}`);
    for (const task of waves[i]) lines.push(`- [${task.id}] ${task.description}`, `  - Category: ${task.category}`, `  - Complexity: ${task.estimatedComplexity}`, `  - Depends on: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}`, `  - Acceptance: ${task.acceptanceCriteria}`);
  }
  lines.push("", "## QA Strategy", plan.qaStrategy, "", "## Risk Mitigations", ...(plan.riskMitigations.length ? plan.riskMitigations.map((r) => `- ${r}`) : ["- None specified"]), "", "## Human Adjustments / Approval Notes", plan.humanReviewNotes || "Approved as written.");
  return lines.join("\n");
}

function buildWorkSpecHtml(plan: PlanOutput, markdown: string): string {
  const taskRows = plan.tasks.map((task) => `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${escapeHtml(task.description)}</td><td>${escapeHtml(task.category)}</td><td>${escapeHtml(task.estimatedComplexity)}</td><td>${escapeHtml(task.dependsOn.join(", ") || "none")}</td><td>${escapeHtml(task.acceptanceCriteria)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>morph Work Specification Review</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:1180px;margin:40px auto;color:#1f2937;line-height:1.55;padding:0 24px}h1{border-bottom:4px solid #6366f1;padding-bottom:12px}h2{margin-top:32px;border-left:6px solid #6366f1;padding-left:12px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #e5e7eb;padding:8px 10px;vertical-align:top}th{background:#f9fafb}pre{background:#f3f4f6;padding:16px;border-radius:8px;overflow-x:auto}code{background:#eef2ff;padding:2px 5px;border-radius:5px}.notice{border-left:6px solid #f59e0b;background:#fffbeb;padding:14px 16px;border-radius:8px}.metric{display:inline-block;padding:4px 10px;margin-right:8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-weight:700}</style></head><body><h1>morph Work Specification Review</h1><div class="notice"><strong>Final gate before WORK:</strong> review this document, then use the pi editor popup to approve or edit the implementation spec. Edits are passed to the Engineer and Peer Reviewer agents.</div><p><span class="metric">${plan.tasks.length} tasks</span><span class="metric">${waveGroups(plan.tasks).length} waves</span><span class="metric">${escapeHtml(plan.estimatedEffort)}</span></p><h2>Architecture</h2><pre>${escapeHtml(plan.architectureDiagram)}</pre><h2>Task DAG</h2><table><thead><tr><th>ID</th><th>Description</th><th>Category</th><th>Complexity</th><th>Dependencies</th><th>Acceptance</th></tr></thead><tbody>${taskRows}</tbody></table><h2>QA Strategy</h2><pre>${escapeHtml(plan.qaStrategy)}</pre><h2>Editable Specification Snapshot</h2><pre>${escapeHtml(markdown)}</pre></body></html>`;
}

function openFileInBrowser(filePath: string): void {
  const absolute = path.resolve(filePath);
  if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "", absolute], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [absolute], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [absolute], { detached: true, stdio: "ignore" }).unref();
}

export default function (pi: ExtensionAPI) {
  // ── Shared state ──
  let blackboard: Blackboard | null = null;
  let currentAbortController: AbortController | null = null;
  let currentTick = 0;
  let animationInterval: NodeJS.Timeout | null = null;
  let webServer: Server | null = null;

  function getBB(): Blackboard {
    if (!blackboard) blackboard = new Blackboard(process.cwd());
    return blackboard;
  }

  function resetBB(): void {
    blackboard = null;
    currentAbortController?.abort();
    currentAbortController = null;
  }

  function deletePipelineState(cwd: string): void {
    currentAbortController?.abort();
    currentAbortController = null;
    blackboard = null;
    fs.rmSync(getMorphDir(cwd), { recursive: true, force: true });
  }

  function ensureDefaultModelConfig(ctx: any): void {
    const bb = getBB();
    const state = bb.getState();
    if (state.config?.provider || state.config?.model) return;

    const model = ctx.model;
    if (model?.provider || model?.id) {
      bb.setConfig({
        provider: model.provider ? String(model.provider) : undefined,
        model: model.id ? String(model.id) : undefined,
      });
    }
  }



  async function reviewWorkSpecGate(ctx: any, planOutput: PlanOutput): Promise<boolean> {
    const bb = getBB();
    const morphDir = getMorphDir(ctx.cwd);
    fs.mkdirSync(morphDir, { recursive: true });

    const markdown = buildWorkSpecMarkdown(planOutput);
    const html = buildWorkSpecHtml(planOutput, markdown);
    const markdownPath = path.join(morphDir, "work-spec.md");
    const htmlPath = path.join(morphDir, "work-preview.html");

    fs.writeFileSync(markdownPath, markdown, "utf-8");
    fs.writeFileSync(htmlPath, html, "utf-8");
    openFileInBrowser(htmlPath);

    pi.sendMessage({ customType: "morph", content: `# 🧭 Pre-Work Specification Review

Opened \`${htmlPath}\` for a final visual review. Edit/approve the specification in the popup editor before WORK begins.`, display: true, details: { phase: "pre-work", htmlPath, markdownPath } });

    const edited = await ctx.ui.editor("Review/edit WORK specification before implementation", markdown);
    if (edited === undefined) {
      ctx.ui.notify("WORK paused. Re-run /morph:run or /morph:work when ready.", "info");
      return false;
    }

    fs.writeFileSync(markdownPath, edited, "utf-8");
    planOutput.humanReviewNotes = edited;
    bb.setPlanOutput(planOutput);
    bb.recordDecision("plan", "Human reviewed pre-work specification", `Review artifact: ${htmlPath}`);
    ctx.ui.notify("Pre-work specification approved. Starting WORK...", "success" as any);
    return true;
  }

  // ── Build display state from blackboard ──
  function buildPipelineDisplay(): PipelineDisplay {
    const bb = getBB();
    const state = bb.getState();
    const tasks: TaskDisplay[] = [];
    const agents: AgentActivity[] = [];

    // Build task list from plan + work results
    if (state.planOutput) {
      const entries = state.workResults.map((r) => [r.taskId, r] as const);
      const resultMap = new Map<string, typeof state.workResults[number]>(entries);
      for (const task of state.planOutput.tasks) {
        const result = resultMap.get(task.id);
        tasks.push({
          id: task.id,
          description: task.description,
          status: result
            ? result.status === "done"
              ? "done"
              : result.status === "blocked"
                ? "blocked"
                : "failed"
            : "pending",
        });
      }
    }

    // Build agent activity from current phase
    const phaseAgents = getPhaseAgents(state.phase);
    for (const a of phaseAgents) {
      agents.push({
        name: a.name,
        role: a.role,
        phase: state.phase,
        status: "idle",
      });
    }

    return {
      phase: state.phase,
      tasks,
      agents,
      tokenLedger: state.tokenLedger,
    };
  }

  function getPhaseAgents(phase: string) {
    switch (phase) {
      case "spark": return SPARK_AGENTS;
      case "plan": return PLAN_AGENTS;
      case "work": return WORK_AGENTS;
      case "review": return REVIEW_AGENTS;
      case "ship": return SHIP_AGENTS;
      default: return [];
    }
  }

  // ── Update the phase widget with colored pipeline progress ──
  function updateWidget(ctx: {
    ui: {
      setWidget: (id: string, lines: string[] | ((tui: any, theme: any) => { render: (w: number) => string[]; invalidate: () => void }), opts?: any) => void;
    };
  }) {
    const display = buildPipelineDisplay();
    ctx.ui.setWidget(
      "morph",
      (_tui: any, theme: any) => buildPipelineProgressWidget(display, theme),
      { placement: "aboveEditor" }
    );
  }

  // ── Session lifecycle ──
  pi.on("session_start", async (_event, ctx) => {
    const bb = getBB();
    const state = bb.getState();

    // Default to the parent session's active model if no morph config is set.
    ensureDefaultModelConfig(ctx as any);

    if (state.phase !== "idle") {
      ctx.ui.notify(
        `morph pipeline at phase: ${state.phase} — /morph:status for details, /morph:reset to restart`,
        "info"
      );
    } else {
      ctx.ui.notify("🚀 morph — Type /morph:run <idea> to start your project", "info");
    }

    // Start animation loop
    if (!animationInterval) {
      animationInterval = setInterval(() => {
        currentTick++;
        updateWidget(ctx as any);
      }, 100);
    }

    // Show persistent widget and status bar
    updateWidget(ctx as any);
    ctx.ui.setStatus("morph", "morph: READY -- Type /morph:run <idea>");
  });

  pi.on("session_shutdown", async () => {
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = null;
    currentAbortController?.abort();
    resetBB();
  });

  // ── Keyboard shortcuts ──
  pi.registerShortcut("ctrl+m s" as any, {
    description: "morph: Spark (refine idea)",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText?.() || "";
      if (text.trim()) {
        ctx.ui.setEditorText?.(`/morph:run ${text}`);
      } else {
        ctx.ui.notify("Type your idea first, then Ctrl+M S", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+m p" as any, {
    description: "morph: Plan",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:plan");
    },
  });

  pi.registerShortcut("ctrl+m w" as any, {
    description: "morph: Work",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:work");
    },
  });

  pi.registerShortcut("ctrl+m r" as any, {
    description: "morph: Review",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:review");
    },
  });

  pi.registerShortcut("ctrl+m h" as any, {
    description: "morph: Ship",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:ship");
    },
  });

  pi.registerShortcut("ctrl+m g" as any, {
    description: "morph: Guided run (full pipeline)",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText?.() || "";
      if (text.trim()) {
        ctx.ui.setEditorText?.("/morph:run " + text);
      } else {
        ctx.ui.setEditorText?.("/morph:run");
      }
    },
  });

  // ═══════════════════════════════════════════
  // PLAN
  // ═══════════════════════════════════════════
  pi.registerCommand("morph:plan", {
    description: "Plan: create architecture plan from PRD (Architect + QA + Efficiency)",
    handler: async (_args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (!state.sparkOutput) {
        ctx.ui.notify("No spark output. Run /morph:run <idea> first.", "error");
        return;
      }

      bb.transition("plan");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:plan ⏳  Architect designing...");
      ctx.ui.notify("Plan: Architect + QA + Efficiency Manager working...", "info");

      try {
        currentAbortController = new AbortController();

        // Stage 1: Architect
        ctx.ui.setStatus("morph", "morph:plan ⏳  Architect → architecture + tasks");
        updateWidget(ctx as any);

        // Stage 2: QA + Efficiency (parallel) — status updates
        ctx.ui.setStatus("morph", "morph:plan ⏳  QA + Efficiency reviewing...");

        const planOutput = await executePlanFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
        });

        // Done
        const waves = waveGroups(planOutput.tasks);
        const dagText = formatDAG(planOutput.tasks);
        const estTokens = estimatePhaseTokens(planOutput.tasks);

        ctx.ui.setStatus(
          "morph",
          `morph:work (ready) ✓  ${planOutput.tasks.length} tasks, ${waves.length} waves`
        );
        updateWidget(ctx as any);

        const summary = [
          `# 📋 Plan Complete`,
          ``,
          `**${planOutput.tasks.length} tasks** in **${waves.length} waves**  •  ~${formatTokens(estTokens)} est. tokens`,
          ``,
          `**Architecture**:`,
          `\`\`\`mermaid`,
          planOutput.architectureDiagram.slice(0, 500),
          `\`\`\``,
          ``,
          `**QA Strategy**: ${planOutput.qaStrategy.slice(0, 200)}`,
          ``,
          dagText,
          ``,
          `State → \`.morph/state.json\`  •  Next → /morph:work`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "plan" } });
          ctx.ui.notify(
            `Plan done! ${planOutput.tasks.length} tasks in ${waves.length} waves. /morph:work to implement.`,
            "success" as any
          );
      } catch (err: any) {
        ctx.ui.setStatus("morph", `morph:plan ✗  ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Plan failed: ${err.message}`, "error");
      }
    },
  });

  // ═══════════════════════════════════════════
  // WORK — with live task tracker widget
  // ═══════════════════════════════════════════
  pi.registerCommand("morph:work", {
    description: "Work: execute the task DAG (Engineer + Reviewer per task, live tracker)",
    handler: async (_args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (!state.planOutput) {
        ctx.ui.notify("No plan output. Run /morph:plan first.", "error");
        return;
      }

      const specApproved = await reviewWorkSpecGate(ctx, state.planOutput);
      if (!specApproved) return;

      bb.transition("work");
      const display = buildPipelineDisplay();
      ctx.ui.setStatus("morph", buildStatusBar(display));
      ctx.ui.setWidget(
        "morph",
        (_tui: any, theme: any) => buildPipelineProgressWidget(display, theme),
        { placement: "aboveEditor" }
      );
      ctx.ui.notify(`Work: ${state.planOutput.tasks.length} tasks, ${waveGroups(state.planOutput.tasks).length} waves...`, "info");

      try {
        currentAbortController = new AbortController();

        // Collect live task state for widget updates
        const liveTasks = new Map<string, TaskDisplay>();
        for (const t of state.planOutput.tasks) {
          liveTasks.set(t.id, {
            id: t.id,
            description: t.description,
            status: "pending",
          });
        }

        const results = await executeWorkFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          maxParallel: 3,
          signal: currentAbortController.signal,

          onWaveStart: async (wave, waveIndex) => {
            // Update widget: mark wave tasks as "running"
            for (const t of wave) liveTasks.set(t.id, { ...liveTasks.get(t.id)!, status: "running" });
            ctx.ui.setWidget(
              "morph",
              (_tui: any, theme: any) => buildPipelineProgressWidget(
                { ...buildPipelineDisplay(), tasks: [...liveTasks.values()] },
                theme
              ),
              { placement: "aboveEditor" }
            );

            const waveTasks = wave
              .map((t) => `  ○ [${t.id}] ${t.description.slice(0, 60)} (${t.estimatedComplexity})`)
              .join("\n");
            const proceed = await ctx.ui.confirm(
              `🌊 Wave ${waveIndex + 1}/${waveGroups(state.planOutput!.tasks).length}`,
              `${wave.length} task(s):\n${waveTasks}\n\nExecute this wave?`
            );
            return proceed;
          },

          onTaskComplete: (result) => {
            // Update live task status
            liveTasks.set(result.taskId, {
              ...liveTasks.get(result.taskId)!,
              status: result.status === "done" ? "done" : result.status === "blocked" ? "blocked" : "failed",
            });

            // Refresh widget
            ctx.ui.setWidget(
              "morph",
              (_tui: any, theme: any) => buildPipelineProgressWidget(
                { ...buildPipelineDisplay(), tasks: [...liveTasks.values()] },
                theme
              ),
              { placement: "aboveEditor" }
            );

            // Update status bar
            const done = [...liveTasks.values()].filter((t) => t.status === "done").length;
            const total = liveTasks.size;
            ctx.ui.setStatus("morph", `morph:work ⏳  ${done}/${total} tasks  ●●●`);

            // Per-task notification
            const icon = result.status === "done" ? "✓" : result.status === "blocked" ? "⊘" : "✗";
            ctx.ui.notify(
              `${icon} [${result.taskId}] ${result.summary.slice(0, 80)}`,
              result.status === "done" ? "info" : "warning"
            );
          },
        });

        // All done
        const done = results.filter((r) => r.status === "done").length;
        const failed = results.filter((r) => r.status === "failed").length;

        ctx.ui.setStatus("morph", `morph:review (ready) ✓  ${done}/${results.length} done`);
        ctx.ui.setWidget(
          "morph",
          (_tui: any, theme: any) => buildPipelineProgressWidget(buildPipelineDisplay(), theme),
          { placement: "aboveEditor" }
        );

        const progressText = formatProgress(results, state.planOutput!.tasks);
        const summary = [
          `# 🔨 Work Complete`,
          ``,
          `**${done} done**  •  ${failed} failed`,
          ``,
          progressText,
          ``,
          `State → \`.morph/state.json\`  •  Next → /morph:review`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "work" } });
          ctx.ui.notify(
            `Work done! ${done}/${results.length} tasks. /morph:review to audit.`,
            (done === results.length ? "success" : "warning") as any
          );
      } catch (err: any) {
        ctx.ui.setStatus("morph", `morph:work ✗  ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Work failed: ${err.message}`, "error");
      }
    },
  });

  // ═══════════════════════════════════════════
  // REVIEW
  // ═══════════════════════════════════════════
  pi.registerCommand("morph:review", {
    description: "Review: audit with 4 reviewers (Tech Lead, QA, Perf, End User)",
    handler: async (args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (!state.planOutput) {
        ctx.ui.notify("No plan output. Run /morph:run <idea> and /morph:plan first.", "error");
        return;
      }

      bb.transition("review");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:review ⏳  4 reviewers auditing...");
      ctx.ui.notify("Review: Tech Lead + QA Auditor + Performance Guru + End User...", "info");

      try {
        currentAbortController = new AbortController();

        // Stage updates as agents run
        ctx.ui.setStatus("morph", "morph:review ⏳  QA + Perf + User reviewing (parallel)...");

        const reviewOutput = await executeReviewFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
          focus: args || undefined,
        });

        ctx.ui.setStatus("morph", "morph:review ⏳  Tech Lead synthesizing verdict...");

        // Done
        const verdictIcon = reviewOutput.status === "APPROVED" ? "✅" : reviewOutput.status === "REJECTED" ? "❌" : "🔧";
        ctx.ui.setStatus(
          "morph",
          reviewOutput.status === "APPROVED"
            ? "morph:ship (ready) ✓"
            : `morph:work (fixes needed) ${verdictIcon}`
        );
        updateWidget(ctx as any);

        const summary = [
          `# ${verdictIcon} Review — ${reviewOutput.status}`,
          ``,
          `**Score**: ${reviewOutput.efficiencyScore}/10`,
          ``,
          `**Technical Audit**:`,
          reviewOutput.technicalAudit.slice(0, 400),
          ``,
          `**User Perspective**:`,
          reviewOutput.userPerspectiveFeedback.slice(0, 300),
          ``,
          reviewOutput.requiredChanges.length > 0
            ? [
                `**Changes Required** (${reviewOutput.requiredChanges.length}):`,
                ...reviewOutput.requiredChanges.map((c) => `- [${c.severity}] ${c.description}`),
              ].join("\n")
            : `**No changes required**`,
          ``,
          reviewOutput.securityIssues.length > 0
            ? `**Security**: ${reviewOutput.securityIssues.length} issues found`
            : `**Security**: No issues found`,
          ``,
          reviewOutput.status === "APPROVED"
            ? `State → \`.morph/state.json\`  •  Next → /morph:ship`
            : `State → \`.morph/state.json\`  •  Fix issues and re-run /morph:review`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "review" } });
          ctx.ui.notify(
            reviewOutput.status === "APPROVED"
              ? "Review APPROVED! /morph:ship to release."
              : `Review: ${reviewOutput.status} — ${reviewOutput.requiredChanges.length} changes needed`,
            (reviewOutput.status === "APPROVED" ? "success" : "warning") as any
          );
      } catch (err: any) {
        ctx.ui.setStatus("morph", `morph:review ✗  ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Review failed: ${err.message}`, "error");
      }
    },
  });

  // ═══════════════════════════════════════════
  // SHIP
  // ═══════════════════════════════════════════
  pi.registerCommand("morph:ship", {
    description: "Ship: release with verification + changelog (DevOps + Release Consultant)",
    handler: async (_args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (!state.reviewOutput || state.reviewOutput.status !== "APPROVED") {
        ctx.ui.notify("Review must be APPROVED before shipping. Run /morph:review.", "error");
        return;
      }

      bb.transition("ship");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:ship ⏳  DevOps verifying...");
      ctx.ui.notify("Ship: DevOps + Release Consultant preparing release...", "info");

      try {
        currentAbortController = new AbortController();

        ctx.ui.setStatus("morph", "morph:ship ⏳  DevOps + Consultant (parallel)...");

        const shipOutput = await executeShipFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
        });

        const icon = shipOutput.status === "SHIPPED" ? "🚀" : "⛔";
        ctx.ui.setStatus("morph", `morph:done ${icon}  v${shipOutput.version}`);
        ctx.ui.setWidget("morph", ["✅  morph pipeline complete!", `   Version: ${shipOutput.version}  •  Status: ${shipOutput.status}`]);

        const costBreakdown = [
          `  Spark:  ${formatTokens(state.tokenLedger?.spark || 0)}`,
          `  Plan:   ${formatTokens(state.tokenLedger?.plan || 0)}`,
          `  Work:   ${formatTokens(state.tokenLedger?.work || 0)}`,
          `  Review: ${formatTokens(state.tokenLedger?.review || 0)}`,
          `  Ship:   ${formatTokens(state.tokenLedger?.ship || 0)}`,
          `  ─────────────────`,
          `  Total:  ${formatTokens(state.tokenLedger?.total || 0)} tokens`,
        ].join("\n");

        const summary = [
          `# ${icon} Shipped — v${shipOutput.version}`,
          ``,
          `**Status**: ${shipOutput.status}`,
          ``,
          `**Changelog**:`,
          shipOutput.changelog,
          ``,
          `**Deployment Checklist**:`,
          ...shipOutput.deploymentChecklist.map((c) => `- [${c.done ? "x" : " "}] ${c.item}`),
          ``,
          shipOutput.rollbackPlan ? `**Rollback Plan**:\n${shipOutput.rollbackPlan}` : "",
          ``,
          `**Pipeline Costs**:`,
          costBreakdown,
          ``,
          `🎉 Pipeline complete!`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "ship" } });
        ctx.ui.notify(`Shipped v${shipOutput.version}! Pipeline complete.`, "success" as any);
      } catch (err: any) {
        ctx.ui.setStatus("morph", `morph:ship ✗  ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Ship failed: ${err.message}`, "error");
      }
    },
  });

  // ═══════════════════════════════════════════
  // GUIDED PIPELINE
  // ═══════════════════════════════════════════

  pi.registerCommand("morph:run", {
    description: "Run the full pipeline with review gates: spark → plan → work → review → ship",
    handler: async (args, ctx) => {
      const bb = getBB();
      let state = bb.getState();

      // ── Handle stuck/failed phases ──
      if (state.phase === "spark") {
        ctx.ui.notify("⚠️  Spark phase failed or was interrupted. Run /morph:reset to restart.", "warning");
        return;
      }

      // ── Determine starting point ──
      if (state.phase === "idle") {
        if (!args?.trim()) {
          ctx.ui.notify("Usage: /morph:run <your idea> to start a new pipeline", "error");
          return;
        }
        // Spark - run it first
        bb.transition("spark");
        updateWidget(ctx as any);
        ctx.ui.setStatus("morph", "morph:run ⏳  Spark phase...");
        ctx.ui.notify("🚀 morph pipeline started! Beginning Spark phase...", "info");

        try {
          currentAbortController = new AbortController();
          const sparkOutput = await executeSparkFlow({
            cwd: ctx.cwd,
            prompt: args,
            blackboard: bb,
            signal: currentAbortController.signal,
          });
          bb.setSparkOutput(sparkOutput);
          state = bb.getState();

          ctx.ui.setStatus("morph", "morph:run ✓  Spark complete");
          updateWidget(ctx as any);
          ctx.ui.notify("💡 Spark complete! Review summary below.", "success" as any);

          // Gate: Spark → Plan
          const sparkSummary = [
            `# ✨ Spark Complete`,
            ``,
            `**Vision**: ${sparkOutput.visionStatement.slice(0, 300)}`,
            ``,
            `**Core Features** (${sparkOutput.coreFeatures.length}):`,
            ...sparkOutput.coreFeatures.map((f) => `- ${f}`),
            ``,
            `**Target User**: ${sparkOutput.targetUserPersona.slice(0, 200)}`,
            ``,
            `**Tech Stack**: ${sparkOutput.technicalStackRecommendation}`,
            ``,
            `**Risks** (${sparkOutput.risks.length}):`,
            ...sparkOutput.risks.slice(0, 5).map((r) => `- ${r}`),
            ``,
            `**Next**: Confirm to proceed to PLAN phase.`,
          ].join("\n");

          pi.sendMessage({ customType: "morph", content: sparkSummary, display: true, details: { phase: "spark" } });

          const proceed = await waitConfirm(
            ctx,
            "💡 Proceed to Plan phase?",
            "Review the Spark output in chat. Confirm to continue.",
            "spark"
          );
          if (!proceed) {
            ctx.ui.notify("Pipeline paused after Spark. Run /morph:run to continue.", "info");
            return;
          }
        } catch (err: any) {
          ctx.ui.setStatus("morph", `morph:run ✗  Spark failed: ${err.message.slice(0, 40)}`);
          ctx.ui.notify(`Spark failed: ${err.message}`, "error");
          return;
        }
      }

      // ── Plan ──
      if (state.phase === "plan") {
          ctx.ui.setStatus("morph", "morph:run ⏳  Plan phase...");
          ctx.ui.notify("📋 Plan: Architect + QA + Efficiency working...", "info");
          updateWidget(ctx as any);

          try {
            currentAbortController = new AbortController();
            const planOutput = await executePlanFlow({
              cwd: ctx.cwd,
              blackboard: bb,
              signal: currentAbortController.signal,
            });
            bb.setPlanOutput(planOutput);
            state = bb.getState();

            const waves = waveGroups(planOutput.tasks);
            ctx.ui.setStatus("morph", `morph:run ✓  ${planOutput.tasks.length} tasks planned`);
            updateWidget(ctx as any);
            ctx.ui.notify("📋 Plan complete! Review below.", "success" as any);

            // Gate: Plan → Work
            const planSummary = [
              `# 📋 Plan Complete`,
              ``,  
              `**${planOutput.tasks.length} tasks** in **${waves.length} waves**`,
              ``,  
              `**Architecture**:`,
              `\`\`\`mermaid`,
              planOutput.architectureDiagram.slice(0, 400),
              `\`\`\``,
              ``,  
              `**QA Strategy**: ${planOutput.qaStrategy.slice(0, 200)}`,
              ``,
              `**Next**: Confirm to proceed to WORK phase (implementation).`,
            ].join("\n");

            pi.sendMessage({ customType: "morph", content: planSummary, display: true, details: { phase: "plan" } });

            const proceed = await reviewWorkSpecGate(ctx, planOutput);
            if (!proceed) {
              ctx.ui.notify("Pipeline paused before Work. Run /morph:run to continue.", "info");
              return;
            }
          } catch (err: any) {
            ctx.ui.setStatus("morph", `morph:run ✗  Plan failed: ${err.message.slice(0, 40)}`);
            ctx.ui.notify(`Plan failed: ${err.message}`, "error");
            return;
          }
      }

      // ── Work ──
      if (state.phase === "work") {
        ctx.ui.setStatus("morph", "morph:run ⏳  Work phase...");
        ctx.ui.notify("🔨 Work: executing task DAG...", "info");
        updateWidget(ctx as any);

        try {
          currentAbortController = new AbortController();

          const liveTasks = new Map<string, TaskDisplay>();
          for (const t of state.planOutput!.tasks) {
            liveTasks.set(t.id, { id: t.id, description: t.description, status: "pending" });
          }

          const results = await executeWorkFlow({
            cwd: ctx.cwd,
            blackboard: bb,
            maxParallel: 3,
            signal: currentAbortController.signal,

            onWaveStart: async (wave, waveIndex) => {
              for (const t of wave) liveTasks.set(t.id, { ...liveTasks.get(t.id)!, status: "running" });
              ctx.ui.setWidget(
                "morph",
                (_tui: any, theme: any) => buildPipelineProgressWidget(buildPipelineDisplay(), theme),
                { placement: "aboveEditor" }
              );

              // Brief wave confirmation in guided mode
              const waveTasks = wave
                .map((t) => `  ○ [${t.id}] ${t.description.slice(0, 50)} (${t.estimatedComplexity})`)
                .join("\n");
              const totalWaves = waveGroups(state.planOutput!.tasks).length;
              const proceed = await ctx.ui.confirm(
                `🌊 Wave ${waveIndex + 1}/${totalWaves}`,
                `${wave.length} task(s):\n${waveTasks}\n\nExecute this wave?`
              );
              return proceed;
            },

            onTaskComplete: (result) => {
              liveTasks.set(result.taskId, {
                ...liveTasks.get(result.taskId)!,
                status: result.status === "done" ? "done" : result.status === "blocked" ? "blocked" : "failed",
              });
              ctx.ui.setWidget(
                "morph",
                (_tui: any, theme: any) => buildPipelineProgressWidget(buildPipelineDisplay(), theme),
                { placement: "aboveEditor" }
              );
              const done = [...liveTasks.values()].filter((t) => t.status === "done").length;
              ctx.ui.setStatus("morph", `morph:run ⏳  Work: ${done}/${liveTasks.size} tasks`);

              const icon = result.status === "done" ? "✓" : result.status === "blocked" ? "⊘" : "✗";
              ctx.ui.notify(`${icon} [${result.taskId}] ${result.summary.slice(0, 80)}`, 
                result.status === "done" ? "info" : "warning");
            },
          });

          bb.finishWork();
          state = bb.getState();

          const done = results.filter((r) => r.status === "done").length;
          const failed = results.filter((r) => r.status === "failed").length;
          ctx.ui.setStatus("morph", `morph:run ✓  Work: ${done}/${results.length} done`);
          updateWidget(ctx as any);
          ctx.ui.notify(`🔨 Work complete! ${done}/${results.length} tasks done.`, "success" as any);

          const progressText = formatProgress(results, state.planOutput!.tasks);
          const workSummary = [
            `# 🔨 Work Complete`,
            ``,  
            `**${done} done**${failed > 0 ? `  •  ${failed} failed` : ""}`,
            ``,  
            progressText,
            ``,
            `**Next**: Confirm to proceed to REVIEW phase.`,
          ].join("\n");

          pi.sendMessage({ customType: "morph", content: workSummary, display: true, details: { phase: "work" } });

          const proceed = await waitConfirm(
            ctx,
            "🔍 Proceed to Review phase?",
            failed > 0
              ? `${failed} task(s) failed. Review failures in chat and confirm to proceed.`
              : `All ${done} tasks done. Confirm to start review.`,
            "work"
          );
          if (!proceed) {
            ctx.ui.notify("Pipeline paused after Work. Run /morph:run to continue.", "info");
            return;
          }
        } catch (err: any) {
          ctx.ui.setStatus("morph", `morph:run ✗  Work failed: ${err.message.slice(0, 40)}`);
          ctx.ui.notify(`Work failed: ${err.message}`, "error");
          return;
        }
      }

      // ── Review ──
      if (state.phase === "review") {
        ctx.ui.setStatus("morph", "morph:run ⏳  Review phase...");
        ctx.ui.notify("🔍 Review: Tech Lead + QA + Perf + End User auditing...", "info");
        updateWidget(ctx as any);

        try {
          currentAbortController = new AbortController();
          const reviewOutput = await executeReviewFlow({
            cwd: ctx.cwd,
            blackboard: bb,
            signal: currentAbortController.signal,
          });
          bb.setReviewOutput(reviewOutput);
          state = bb.getState();

          const verdictIcon = reviewOutput.status === "APPROVED" ? "✅" : "❌";
          ctx.ui.setStatus("morph", `morph:run ${verdictIcon}  Review: ${reviewOutput.status}`);
          updateWidget(ctx as any);
            ctx.ui.notify(
              `🔍 Review: ${reviewOutput.status}`,
              (reviewOutput.status === "APPROVED" ? "success" : "warning") as any
            );

          if (reviewOutput.status !== "APPROVED") {
            ctx.ui.notify("❌ Review rejected. Fix issues and run /morph:run again.", "warning");
            return;
          }

          // Gate: Review → Ship
          const reviewSummary = [
            `# ${verdictIcon} Review — ${reviewOutput.status}`,
            ``,  
            `**Score**: ${reviewOutput.efficiencyScore}/10`,
            ``,  
            `**Technical Audit**:`,
            reviewOutput.technicalAudit.slice(0, 400),
            ``,  
            `**Security**: ${reviewOutput.securityIssues.length > 0 ? reviewOutput.securityIssues.length + " issues" : "No issues"}`,
            ``,
            `**Next**: Confirm to proceed to SHIP phase (deployment).`,
          ].join("\n");

          pi.sendMessage({ customType: "morph", content: reviewSummary, display: true, details: { phase: "review" } });

          const proceed = await ctx.ui.confirm(
            "🚀 Proceed to Ship phase?",
            "Review approved! Review details in chat and confirm to release."
          );
          if (!proceed) {
            ctx.ui.notify("Pipeline paused after Review. Run /morph:run to continue.", "info");
            return;
          }
        } catch (err: any) {
          ctx.ui.setStatus("morph", `morph:run ✗  Review failed: ${err.message.slice(0, 40)}`);
          ctx.ui.notify(`Review failed: ${err.message}`, "error");
          return;
        }
      }

      // ── Ship ──
      if (state.phase === "ship") {
        ctx.ui.setStatus("morph", "morph:run ⏳  Ship phase...");
        ctx.ui.notify("🚀 Ship: DevOps + Release Consultant preparing release...", "info");
        updateWidget(ctx as any);

        try {
          currentAbortController = new AbortController();
          const shipOutput = await executeShipFlow({
            cwd: ctx.cwd,
            blackboard: bb,
            signal: currentAbortController.signal,
          });
          bb.setShipOutput(shipOutput);
          state = bb.getState();

          ctx.ui.setStatus("morph", `morph:run 🚀  v${shipOutput.version} shipped`);
          updateWidget(ctx as any);
          ctx.ui.notify(`🚀 Shipped v${shipOutput.version}! Pipeline complete.`, "success" as any);
        } catch (err: any) {
          ctx.ui.setStatus("morph", `morph:run ✗  Ship failed: ${err.message.slice(0, 40)}`);
          ctx.ui.notify(`Ship failed: ${err.message}`, "error");
          return;
        }
      }

      // ── Done ──
      if (state.phase === "done") {
        ctx.ui.notify("🎉 morph pipeline is already complete! /morph:status for details.", "info");
      }
    },
  });

  // ═══════════════════════════════════════════
  // UTILITY COMMANDS
  // ═══════════════════════════════════════════

  pi.registerCommand("morph:config", {
    description: "Configure the model for morph agents (e.g. /morph:config provider=anthropic model=claude-3-5-sonnet-20241022)",
    handler: async (args, ctx) => {
      const bb = getBB();
      
      if (!args.trim()) {
        const conf = bb.getState().config;
        ctx.ui.notify(`Current morph config: provider=${conf?.provider || "default"}, model=${conf?.model || "default"}`, "info");
        return;
      }

      const newConfig: any = {};
      for (const part of args.split(" ")) {
        const [k, v] = part.split("=");
        if (k && v) newConfig[k] = v;
      }

      bb.setConfig(newConfig);
      ctx.ui.notify(`Updated morph config: provider=${newConfig.provider || bb.getState().config?.provider}, model=${newConfig.model || bb.getState().config?.model}`, "success" as any);
    }
  });

  pi.registerCommand("morph:status", {
    description: "Show morph pipeline status (widget + detailed summary)",
    handler: async (_args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (state.phase === "idle") {
        ctx.ui.notify("morph: idle — /morph:run <idea> to begin", "info");
        ctx.ui.setWidget("morph", ["○  morph — Ready", "   /morph:run <idea> to begin"]);
        return;
      }

      // Update widget + status
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", buildStatusBar(buildPipelineDisplay()));

      // Send detailed summary as message
      const summary = bb.getContextualSummary(4000);
      pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "status" } });
      ctx.ui.notify(`morph: phase=${state.phase}  •  ${formatTokens(state.tokenLedger?.total || 0)} tokens`, "info");
    },
  });

  pi.registerCommand("morph:reset", {
    description: "Reset pipeline (full or to a phase: idle/plan/work/review)",
    handler: async (args, ctx) => {
      const phase = args?.trim().toLowerCase() || "full";

      if (phase === "full") {
        const ok = await ctx.ui.confirm("Reset entire morph pipeline?", "All state in .morph/ will be deleted.");
        if (!ok) return;
        deletePipelineState(ctx.cwd);
        ctx.ui.setStatus("morph", undefined);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify("Pipeline reset; .morph state deleted.", "info");
        return;
      }

      const bb = getBB();
      const valid = ["idle", "plan", "work", "review"];
      if (!valid.includes(phase)) {
        ctx.ui.notify(`Invalid phase. Use: ${valid.join(", ")} or "full"`, "error");
        return;
      }

      const ok = await ctx.ui.confirm(`Reset to "${phase}"?`, `All state from ${phase} onward will be cleared.`);
      if (!ok) return;

      if (phase === "idle") deletePipelineState(ctx.cwd);
      else bb.resetPhase(phase as any);

      ctx.ui.setStatus("morph", `morph:${bb.getState().phase}`);
      updateWidget(ctx as any);
      ctx.ui.notify(`Reset to: ${bb.getState().phase}`, "info");
    },
  });

  pi.registerCommand("morph:team", {
    description: "Show morph agent team composition",
    handler: async (_args, ctx) => {
      const lines = [
        `# morph — Agent Teams (${SPARK_AGENTS.length + PLAN_AGENTS.length + WORK_AGENTS.length + REVIEW_AGENTS.length + SHIP_AGENTS.length} agents)`,
        "",
        "## 💡 Spark (2)",
        ...SPARK_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## 📋 Plan (3)",
        ...PLAN_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## 🔨 Work (2 per task)",
        ...WORK_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## 🔍 Review (4)",
        ...REVIEW_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## 🚀 Ship (2)",
        ...SHIP_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
      ].join("\n");

      pi.sendMessage({ customType: "morph", content: lines, display: true });
    },
  });

  pi.registerCommand("morph:web", {
    description: "Start the morph Mission Control Web UI",
    handler: async (_args, ctx) => {
      if (webServer) {
        ctx.ui.notify("Mission Control is already running at http://localhost:4040", "info" as any);
        return;
      }
      try {
        const bb = getBB();
        webServer = startMorphServer(bb, 4040);
        ctx.ui.notify("🚀 Mission Control started at http://localhost:4040", "success" as any);
      } catch (err: any) {
        ctx.ui.notify(`Failed to start server: ${err.message}`, "error" as any);
      }
    },
  });

  // ── Message Renderer: morph summary messages ──
  pi.registerMessageRenderer("morph", (message, _options, theme) => {
    // Just return the raw text — pi's built-in markdown rendering handles it
    // But we could add custom headers/formatting here
    return new Text((message.content as any) || "", 0, 0);
  });
}
