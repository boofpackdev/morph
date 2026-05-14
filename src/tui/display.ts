/**
 * morph — TUI Display Layer
 *
 * Renders live pipeline state in the terminal:
 *   - Phase dashboard widget (above editor)
 *   - Pipeline progress bar with color-coded phases
 *   - Agent activity indicators
 *   - Task tracker with status icons + progress bar
 *   - Token cost counter in status bar
 *   - Rich message rendering
 */

import { Text, Container, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Phase metadata ──

const PHASE_ICONS: Record<string, string> = {
  idle: "○",
  spark: "💡",
  plan: "📋",
  work: "🔨",
  review: "🔍",
  ship: "🚀",
  done: "✅",
};

const PHASE_LABELS: Record<string, string> = {
  idle: "Idle",
  spark: "Spark — Idea Refinement",
  plan: "Plan — Architecture",
  work: "Work — Implementation",
  review: "Review — Audit",
  ship: "Ship — Release",
  done: "Complete",
};

// ── Phase progression order ──

export const PHASE_ORDER = ["idle", "spark", "plan", "work", "review", "ship", "done"] as const;

export const ALL_PHASES = [
  { id: "spark", icon: "💡", label: "Spark" },
  { id: "plan", icon: "📋", label: "Plan" },
  { id: "work", icon: "🔨", label: "Work" },
  { id: "review", icon: "🔍", label: "Review" },
  { id: "ship", icon: "🚀", label: "Ship" },
];

// ── Helpers ──

function bar(progress: number, total: number, width: number = 20): string {
  const filled = Math.round((progress / Math.max(total, 1)) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

// ── Task data shape (lightweight, for display only) ──

export interface TaskDisplay {
  id: string;
  description: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  agent?: string;
}

export interface AgentActivity {
  name: string;
  role: string;
  phase: string;
  status: "idle" | "running" | "done" | "error";
}

export interface PipelineDisplay {
  phase: string;
  tasks: TaskDisplay[];
  agents: AgentActivity[];
  tokenLedger: { spark: number; plan: number; work: number; review: number; ship: number; total: number };
}

// ── Widget content builders (return string[]) ──

export function buildPhaseWidget(state: PipelineDisplay): string[] {
  const lines: string[] = [];
  const icon = PHASE_ICONS[state.phase] || "○";
  const label = PHASE_LABELS[state.phase] || state.phase;

  // Header
  if (state.phase === "idle") {
    lines.push(`${icon}  morph — Ready`);
    lines.push("   Type /morph:spark <idea> to begin");
    return lines;
  }

  if (state.phase === "done") {
    lines.push(`${icon}  morph — Pipeline Complete!`);
    const total = state.tokenLedger.total;
    if (total > 0) lines.push(`   Tokens: ${formatDisplayTokens(total)}`);
    return lines;
  }

  lines.push(`${icon}  ${label}`);

  // Task progress
  if (state.tasks.length > 0) {
    const done = state.tasks.filter((t) => t.status === "done").length;
    const running = state.tasks.filter((t) => t.status === "running").length;
    const failed = state.tasks.filter((t) => t.status === "failed").length;
    const blocked = state.tasks.filter((t) => t.status === "blocked").length;

    lines.push(`   Tasks: ${done}/${state.tasks.length} done  ${bar(done, state.tasks.length, 16)}`);
    if (running > 0 || failed > 0 || blocked > 0) {
      const parts: string[] = [];
      if (running > 0) parts.push(`${running} running`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (blocked > 0) parts.push(`${blocked} blocked`);
      lines.push(`   ${parts.join("  ")}`);
    }
  }

  // Active agents
  const activeAgents = state.agents.filter((a) => a.status === "running");
  if (activeAgents.length > 0) {
    lines.push(`   Agents: ${activeAgents.map((a) => `${a.name}(${a.role})`).join(", ")}`);
  }

  // Token cost
  if (state.tokenLedger.total > 0) {
    lines.push(`   Tokens: ${formatDisplayTokens(state.tokenLedger.total)}`);
  }

  return lines;
}

/**
 * Build a colored pipeline progress widget for the TUI.
 * Shows all 5 phases with filled/empty bars and color-coded status.
 *
 * Works as a theme-aware component for ctx.ui.setWidget's callback form.
 */
export function buildPipelineProgressWidget(
  display: PipelineDisplay,
  theme: Theme
): { render: (width: number) => string[]; invalidate: () => void } {
  const currentIdx = PHASE_ORDER.indexOf(display.phase as any);
  const barW = 16;

  function phaseBar(status: "done" | "current" | "pending" | "failed"): string {
    const filled =
      status === "done"
        ? barW
        : status === "current"
          ? Math.ceil(barW * 0.55)
          : 0;
    const empty = barW - filled;
    return "█".repeat(filled) + "░".repeat(empty);
  }

  function phaseStatus(phaseId: string): "done" | "current" | "pending" | "failed" {
    const idx = PHASE_ORDER.indexOf(phaseId as any);
    if (idx < 0 || currentIdx < 0) return "pending";
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return "current";
    return "pending";
  }

  return {
    render: (width: number) => {
      const lines: string[] = [];

      if (display.phase === "idle") {
        lines.push(theme.fg("dim", "  morph — Ready"));
        lines.push(theme.fg("dim", "   /morph:run <idea> to start"));
        return lines;
      }

      if (display.phase === "done") {
        lines.push(theme.fg("success", theme.bold("  ✅  morph — Pipeline Complete!")));
        if (display.tokenLedger.total > 0) {
          lines.push(
            `   ${theme.fg("success", "✓")}  ${theme.fg("muted", `Tokens: ${formatDisplayTokens(display.tokenLedger.total)}`)}`
          );
        }
        return lines;
      }

      // Title
      lines.push(theme.fg("accent", theme.bold("  morph — Pipeline Progress")));
      lines.push("");

      for (const phase of ALL_PHASES) {
        const status = phaseStatus(phase.id);
        const barStr = phaseBar(status);
        const sIcon =
          status === "done"
            ? theme.fg("success", "✓")
            : status === "current"
              ? theme.fg("accent", "⏳")
              : theme.fg("dim", "○");

        const coloredBar =
          status === "done"
            ? theme.fg("success", barStr)
            : status === "current"
              ? theme.fg("accent", barStr)
              : theme.fg("dim", barStr);

        // Pad the label manually avoiding ANSI width issues
        const rawLabel = `${phase.icon} ${phase.label}`;
        const padAmount = 11 - rawLabel.length;
        const paddedLabel = rawLabel + " ".repeat(Math.max(0, padAmount));

        lines.push(`  ${paddedLabel}${coloredBar}  ${sIcon}`);
      }

      lines.push("");

      // Task summary (only in work phase)
      if (display.phase === "work" && display.tasks.length > 0) {
        const done = display.tasks.filter((t) => t.status === "done").length;
        const total = display.tasks.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const color = done === total ? "success" : "accent";
        lines.push(`   ${theme.fg(color, `Tasks: ${done}/${total} (${pct}%)`)}`);
      }

      // Token cost
      if (display.tokenLedger.total > 0) {
        lines.push(`   ${theme.fg("muted", `Tokens: ${formatDisplayTokens(display.tokenLedger.total)}`)}`);
      }

      // Bottom hint
      if (display.phase !== "done") {
        lines.push(
          theme.fg("dim", "   /morph:run to continue  •  /morph:status for details")
        );
      }

      // Ensure lines don't exceed width (ANSI-safe truncation)
      return lines.map((l) => {
        if (l.length > width) return truncateToWidth(l, width);
        return l;
      });
    },
    invalidate: () => {},
  };
}

/**
 * Build a detailed task tracker (for expanded view / chat messages).
 */
export function buildTaskTracker(state: PipelineDisplay): string[] {
  const lines: string[] = [];
  const done = state.tasks.filter((t) => t.status === "done").length;
  const total = state.tasks.length;

  lines.push("");
  lines.push("┌─ morph Task Tracker ──────────────────────────────");
  lines.push(`│ ${done}/${total} done  ${bar(done, total, 30)}`);
  lines.push("├────────────────────────────────────────────────────");

  for (const task of state.tasks) {
    const icon = statusIcon(task.status);
    const desc = truncate(task.description, 40);
    const meta = task.agent ? ` [${task.agent}]` : "";
    lines.push(`│ ${icon} ${pad(`[${task.id}]`, 8)} ${pad(desc, 42)}${meta}`);
  }

  lines.push("└────────────────────────────────────────────────────");
  return lines;
}

/**
 * Build agent activity summary.
 */
export function buildAgentSummary(state: PipelineDisplay): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("┌─ morph Agents ────────────────────────────────────");

  for (const agent of state.agents) {
    const icon = statusIcon(agent.status);
    const line = `│ ${icon} ${pad(agent.role, 22)} (${agent.name}) — ${agent.phase}`;
    lines.push(line);
  }

  lines.push("└────────────────────────────────────────────────────");
  return lines;
}

/**
 * Build a compact status bar string.
 */
export function buildStatusBar(state: PipelineDisplay): string {
  if (state.phase === "idle") return "morph: idle";
  if (state.phase === "done") return `morph: done ✓  ${formatDisplayTokens(state.tokenLedger.total)} tok`;

  const done = state.tasks.filter((t) => t.status === "done").length;
  const total = state.tasks.length;
  const running = state.agents.filter((a) => a.status === "running").length;

  let text = `morph:${state.phase}`;
  if (total > 0) text += `  tasks:${done}/${total}`;
  if (running > 0) text += `  agents:${running}`;
  if (state.tokenLedger.total > 0) text += `  ${formatDisplayTokens(state.tokenLedger.total)}tok`;

  return text;
}

// ── Message renderer ──

export function renderMorphMessage(
  content: string,
  theme: Theme
): { widget: string[] } | null {
  // Parse markdown sections
  const sections = content.split(/^#+\s+/m).filter(Boolean);

  if (sections.length === 0) return null;

  return { widget: content.split("\n") };
}

// ── Utilities ──

function statusIcon(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "⏳";
    case "blocked":
      return "⊘";
    case "failed":
      return "✗";
    case "error":
      return "✗";
    case "pending":
    case "idle":
    default:
      return "○";
  }
}

export function formatDisplayTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}
