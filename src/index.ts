/**
 * morph — Agent Orchestration Layer for pi
 *
 * 5-stage pipeline: spark → plan → work → review → ship
 *
 * TUI display shows live phase dashboard, task tracker,
 * agent activity, and token costs during execution.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Blackboard } from "./core/blackboard.js";
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

export default function (pi: ExtensionAPI) {
  // ── Shared state ──
  let blackboard: Blackboard | null = null;
  let currentAbortController: AbortController | null = null;

  function getBB(): Blackboard {
    if (!blackboard) blackboard = new Blackboard(process.cwd());
    return blackboard;
  }

  function resetBB(): void {
    blackboard = null;
    currentAbortController?.abort();
    currentAbortController = null;
  }

  // ── Build display state from blackboard ──
  function buildPipelineDisplay(): PipelineDisplay {
    const bb = getBB();
    const state = bb.getState();
    const tasks: TaskDisplay[] = [];
    const agents: AgentActivity[] = [];

    // Build task list from plan + work results
    if (state.planOutput) {
      const resultMap = new Map(
        state.workResults.map((r) => ({ key: r.taskId, value: r }))
      );
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

    if (state.phase !== "idle") {
      ctx.ui.notify(
        `morph pipeline at phase: ${state.phase} — /morph:status for details, /morph:reset to restart`,
        "info"
      );
    }

    // Show persistent widget and status bar
    updateWidget(ctx);
    ctx.ui.setStatus("morph", buildStatusBar(buildPipelineDisplay()));
  });

  pi.on("session_shutdown", async () => {
    currentAbortController?.abort();
    resetBB();
  });

  // ── Keyboard shortcuts ──
  pi.registerShortcut("ctrl+m s", {
    description: "morph: Spark (refine idea)",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText?.() || "";
      if (text.trim()) {
        ctx.ui.setEditorText?.(`/morph:spark ${text}`);
      } else {
        ctx.ui.notify("Type your idea first, then Ctrl+M S", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+m p", {
    description: "morph: Plan",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:plan");
    },
  });

  pi.registerShortcut("ctrl+m w", {
    description: "morph: Work",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:work");
    },
  });

  pi.registerShortcut("ctrl+m r", {
    description: "morph: Review",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:review");
    },
  });

  pi.registerShortcut("ctrl+m h", {
    description: "morph: Ship",
    handler: async (ctx) => {
      ctx.ui.setEditorText?.("/morph:ship");
    },
  });

  pi.registerShortcut("ctrl+m g", {
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
  // SPARK
  // ═══════════════════════════════════════════
  pi.registerCommand("morph:spark", {
    description: "Spark: refine an idea into a PRD (Visionary + Critic)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /morph:spark <your idea>", "error");
        return;
      }

      const bb = getBB();
      if (bb.getState().phase !== "idle" && bb.getState().phase !== "spark") {
        const ok = await ctx.ui.confirm(
          "Pipeline in progress",
          `Current phase: ${bb.getState().phase}. Reset and start fresh?`
        );
        if (!ok) return;
        resetBB();
      }

      // Start: show widget + status
      bb.transition("spark");
      updateWidget(ctx);
      ctx.ui.setStatus("morph", "morph:spark ⏳  Visionary + Critic");
      ctx.ui.notify("Spark: Visionary drafting PRD...", "info");

      try {
        currentAbortController = new AbortController();

        // ── Stage 1: Visionary ──
        ctx.ui.setStatus("morph", "morph:spark ⏳  Visionary drafting...");
        updateWidget(ctx);

        const sparkOutput = await executeSparkFlow({
          cwd: ctx.cwd,
          prompt: args,
          blackboard: bb,
          signal: currentAbortController.signal,
        });

        // ── Done ──
        ctx.ui.setStatus("morph", "morph:plan (ready) ✓");
        updateWidget(ctx);

        const summary = [
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
          `State → \`.morph/state.json\`  •  Next → /morph:plan`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "spark" } });
        ctx.ui.notify("Spark complete! /morph:plan to continue.", "success");
      } catch (err: any) {
        ctx.ui.setStatus("morph", `morph:spark ✗  ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Spark failed: ${err.message}`, "error");
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
        ctx.ui.notify("No spark output. Run /morph:spark <idea> first.", "error");
        return;
      }

      bb.transition("plan");
      updateWidget(ctx);
      ctx.ui.setStatus("morph", "morph:plan ⏳  Architect designing...");
      ctx.ui.notify("Plan: Architect + QA + Efficiency Manager working...", "info");

      try {
        currentAbortController = new AbortController();

        // Stage 1: Architect
        ctx.ui.setStatus("morph", "morph:plan ⏳  Architect → architecture + tasks");
        updateWidget(ctx);

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
        updateWidget(ctx);

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
          "success"
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
          done === results.length ? "success" : "warning"
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
        ctx.ui.notify("No plan output. Run /morph:spark and /morph:plan first.", "error");
        return;
      }

      bb.transition("review");
      updateWidget(ctx);
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
        updateWidget(ctx);

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
          reviewOutput.status === "APPROVED" ? "success" : "warning"
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
      updateWidget(ctx);
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
        ctx.ui.notify(`Shipped v${shipOutput.version}! Pipeline complete.`, "success");
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
        updateWidget(ctx);
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
          updateWidget(ctx);
          ctx.ui.notify("💡 Spark complete! Review summary below.", "success");

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
          ].join("\n");

          const proceed = await ctx.ui.confirm(
            "💡 Proceed to Plan phase?",
            "Review the Spark output above. Edit specs in the editor / .morph/ files, then confirm to continue."
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
          updateWidget(ctx);

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
            updateWidget(ctx);
            ctx.ui.notify("📋 Plan complete! Review below.", "success");

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
            ].join("\n");

            const proceed = await ctx.ui.confirm(
              "🔨 Proceed to Work phase?",
              `${planOutput.tasks.length} tasks in ${waves.length} waves. Edit the plan in .morph/ then confirm.`
            );
            if (!proceed) {
              ctx.ui.notify("Pipeline paused after Plan. Run /morph:run to continue.", "info");
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
        updateWidget(ctx);

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
          updateWidget(ctx);
          ctx.ui.notify(`🔨 Work complete! ${done}/${results.length} tasks done.`, "success");

          // Gate: Work → Review
          const workSummary = [
            `# 🔨 Work Complete`,
            ``,  
            `**${done} done**${failed > 0 ? `  •  ${failed} failed` : ""}`,
            ``,  
            ...results.map((r) => `- ${r.status === "done" ? "✓" : "✗"} [${r.taskId}] ${r.summary.slice(0, 80)}`),
          ].join("\n");

          const proceed = await ctx.ui.confirm(
            "🔍 Proceed to Review phase?",
            failed > 0
              ? `${failed} task(s) failed. Fix issues first, then confirm to proceed.`
              : `All ${done} tasks done. Confirm to start review.`
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
        updateWidget(ctx);

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
          updateWidget(ctx);
          ctx.ui.notify(`🔍 Review: ${reviewOutput.status}`, 
            reviewOutput.status === "APPROVED" ? "success" : "warning");

          if (reviewOutput.status !== "APPROVED") {
            ctx.ui.notify("❌ Review rejected. Fix issues and run /morph:run again.", "warning");
            return;
          }

          // Gate: Review → Ship
          const reviewSummary = [
            `# ✅ Review — APPROVED`,
            ``,  
            `**Score**: ${reviewOutput.efficiencyScore}/10`,
            ``,  
            `**Technical Audit**:`,
            reviewOutput.technicalAudit.slice(0, 300),
            ``,  
            `**Security**: ${reviewOutput.securityIssues.length > 0 ? reviewOutput.securityIssues.length + " issues" : "No issues"}`,
          ].join("\n");

          const proceed = await ctx.ui.confirm(
            "🚀 Proceed to Ship phase?",
            "Review approved! Confirm to release."
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
        updateWidget(ctx);

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
          updateWidget(ctx);
          ctx.ui.notify(`🚀 Shipped v${shipOutput.version}! Pipeline complete.`, "success");
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

  pi.registerCommand("morph:status", {
    description: "Show morph pipeline status (widget + detailed summary)",
    handler: async (_args, ctx) => {
      const bb = getBB();
      const state = bb.getState();

      if (state.phase === "idle") {
        ctx.ui.notify("morph: idle — /morph:spark <idea> to begin", "info");
        ctx.ui.setWidget("morph", ["○  morph — Ready", "   /morph:spark <idea> to begin"]);
        return;
      }

      // Update widget + status
      updateWidget(ctx);
      ctx.ui.setStatus("morph", buildStatusBar(buildPipelineDisplay()));

      // Send detailed summary as message
      const summary = bb.getContextualSummary(4000);
      pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "status" } });
      ctx.ui.notify(`morph: phase=${state.phase}  •  ${formatTokens(state.tokenLedger?.total || 0)} tokens`, "info");
    },
  });

  pi.registerCommand("morph:reset", {
    description: "Reset pipeline (full or to a phase: idle/spark/plan/work/review)",
    handler: async (args, ctx) => {
      const phase = args?.trim().toLowerCase() || "full";

      if (phase === "full") {
        const ok = await ctx.ui.confirm("Reset entire morph pipeline?", "All state in .morph/ will be cleared.");
        if (!ok) return;
        resetBB();
        ctx.ui.setStatus("morph", undefined);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify("Pipeline reset.", "info");
        return;
      }

      const bb = getBB();
      const valid = ["idle", "spark", "plan", "work", "review"];
      if (!valid.includes(phase)) {
        ctx.ui.notify(`Invalid phase. Use: ${valid.join(", ")} or "full"`, "error");
        return;
      }

      const ok = await ctx.ui.confirm(`Reset to "${phase}"?`, `All state from ${phase} onward will be cleared.`);
      if (!ok) return;

      if (phase === "idle") resetBB();
      else bb.resetPhase(phase as any);

      ctx.ui.setStatus("morph", `morph:${bb.getState().phase}`);
      updateWidget(ctx);
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

  // ── Message Renderer: morph summary messages ──
  pi.registerMessageRenderer("morph", (message, _options, theme) => {
    // Just return the raw text — pi's built-in markdown rendering handles it
    // But we could add custom headers/formatting here
    return new Text(message.content || "", 0, 0);
  });
}
