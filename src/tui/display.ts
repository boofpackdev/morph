/**
 * morph — TUI Display Layer
 *
 * Renders live pipeline state in the terminal:
 *   - Phase dashboard widget (above editor)
 *   - Agent activity indicators
 *   - Task tracker with status icons + progress bar
 *   - Token cost counter in status bar
 *   - Rich message rendering
 */

import { Text, Container, Spacer } from "@earendil-works/pi-tui";
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

function formatDisplayTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}
