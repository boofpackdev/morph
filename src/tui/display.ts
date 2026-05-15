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

import { Text, Container, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const isWin32 = process.platform === "win32";

const SPINNERS = isWin32 ? {
  braille: ["|", "/", "-", "\\"],
  pulse: ["-", "\\", "|", "/"],
  scan: ["-", "\\", "|", "/"],
  helix: ["|", "/", "-", "\\"],
} : {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  pulse: ["⢾", "⣉", "⡷"],
  scan: ["⠁", "⠂", "⠄", "⠂"],
  helix: ["⢉", "⢊", "⢔", "⢖", "⢙", "⢚", "⢠", "⢢"],
};

// ── Phase metadata ──

const PHASE_ORDER = ["idle", "spark", "plan", "work", "review", "ship", "done"] as const;

export const ALL_PHASES = [
  { id: "spark", icon: ">", label: "SPARK" },
  { id: "plan", icon: ">", label: "PLAN" },
  { id: "work", icon: ">", label: "WORK" },
  { id: "review", icon: ">", label: "REVIEW" },
  { id: "ship", icon: ">", label: "SHIP" },
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

export interface SubagentActivity {
  name: string;
  role: string;
  taskId: string;
  status: "running" | "idle" | "done" | "error";
  currentTool: string;
  lastAction: string;
  turns: number;
  toolDetail: string;
}

export interface PhaseContext {
  title: string;
  lines: string[];
}

export interface AgentActivity {
  name: string;
  role: string;
  phase: string;
  status: "idle" | "running" | "done" | "error";
  currentTool?: string;
  lastAction?: string;
  toolDetail?: string;
}

export interface PipelineDisplay {
  phase: string;
  tasks: TaskDisplay[];
  agents: AgentActivity[];
  tokenLedger: { spark: number; plan: number; work: number; review: number; ship: number; total: number };
  tick: number;
  subagentActivities?: SubagentActivity[];
  phaseContext?: PhaseContext;
}

/**
 * Build a colored pipeline progress widget for the TUI.
 */
export function buildPipelineProgressWidget(
  getDisplay: () => PipelineDisplay,
  theme: Theme
): { render: (width: number) => string[]; invalidate: () => void } {
  const barW = 16;

  function phaseBar(status: "done" | "current" | "pending" | "failed"): string {
    const filled =
      status === "done"
        ? barW
        : status === "current"
          ? Math.ceil(barW * 0.55)
          : 0;
    const empty = barW - filled;
    if (filled === 0) return "░".repeat(barW);
    return "█".repeat(filled) + "░".repeat(empty);
  }

  function phaseStatus(displayPhase: string, phaseId: string): "done" | "current" | "pending" | "failed" {
    const currentIdx = PHASE_ORDER.indexOf(displayPhase as any);
    const idx = PHASE_ORDER.indexOf(phaseId as any);
    if (idx < 0 || currentIdx < 0) return "pending";
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return "current";
    return "pending";
  }

  return {
    render: (width: number) => {
      const display = getDisplay();
      const lines: string[] = [];
      const tick = display.tick ?? 0;

      if (display.phase === "idle") {
        lines.push(theme.fg("dim", "  morph — READY"));
        lines.push(theme.fg("dim", "   /morph:run <idea> to start"));
        return lines;
      }

      if (display.phase === "done") {
        lines.push(theme.fg("success", theme.bold("  ✓ morph — PIPELINE COMPLETE")));
        if (display.tokenLedger.total > 0) {
          lines.push(
            `   ${theme.fg("success", "[DONE]")}  ${theme.fg("muted", `Tokens: ${formatDisplayTokens(display.tokenLedger.total)}`)}`
          );
        }
        return lines;
      }

      // Title
      lines.push(theme.fg("accent", theme.bold("  morph — PIPELINE PROGRESS")));
      lines.push("");

      for (const phase of ALL_PHASES) {
        const status = phaseStatus(display.phase, phase.id);
        const barStr = phaseBar(status);
        
        let sIcon = theme.fg("dim", "(o)");
        let coloredBar = theme.fg("dim", barStr);
        let labelColor: any = "dim";

        if (status === "done") {
          sIcon = theme.fg("success", "✓");
          coloredBar = theme.fg("success", barStr);
          labelColor = "success";
        } else if (status === "current") {
          const spin = SPINNERS.pulse[tick % SPINNERS.pulse.length];
          sIcon = theme.fg("accent", spin);
          coloredBar = theme.fg("accent", barStr);
          labelColor = "accent";
        }

        // Pad the label manually avoiding ANSI width issues
        const rawLabel = `${phase.icon} ${phase.label}`;
        const padAmount = 11 - rawLabel.length;
        const paddedLabel = theme.fg(labelColor, rawLabel + " ".repeat(Math.max(0, padAmount)));

        lines.push(`  ${paddedLabel}${coloredBar}  ${sIcon}`);
      }

      const subs = display.subagentActivities?.filter((s) => s.status === "running") || [];
      if (subs.length > 0) {
        lines.push("");
        for (const sub of subs) {
          const spin = SPINNERS.helix[tick % SPINNERS.helix.length];
          const toolInfo = sub.currentTool
            ? theme.fg("accent", sub.currentTool) + (sub.toolDetail ? theme.fg("dim", ` ${sub.toolDetail}`) : "")
            : theme.fg("dim", "thinking...");
          const taskTag = theme.fg("dim", sub.taskId && sub.taskId !== "-" ? `[${sub.taskId}]` : "");
          lines.push(`  ${theme.fg("accent", spin)}  ${theme.fg("muted", sub.role)} ${taskTag} ${toolInfo}`);
          if (sub.lastAction) {
            const snippet = sub.lastAction.length > 55 ? sub.lastAction.slice(0, 53) + "…" : sub.lastAction;
            lines.push(`     ${theme.fg("dim", snippet)}`);
          }
        }
      }

      lines.push("");

      // Task summary (only in work phase)
      if (display.phase === "work" && display.tasks.length > 0) {
        const done = display.tasks.filter((t) => t.status === "done").length;
        const failed = display.tasks.filter((t) => t.status === "failed" || t.status === "blocked").length;
        const total = display.tasks.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const color = done === total ? "success" : "accent";
        lines.push(`   ${theme.fg(color, `TASKS: ${done}/${total} (${pct}%)`)}` + (failed > 0 ? theme.fg("error", `  ${failed} failed`) : ""));
      }

      // Token cost
      if (display.tokenLedger.total > 0) {
        lines.push(`   ${theme.fg("muted", `TOKENS: ${formatDisplayTokens(display.tokenLedger.total)}`)}`);     
      }

      // Bottom hint
      if (display.phase !== "done") {
        lines.push(
          theme.fg("dim", "   /morph:run to continue | /morph:status for details")
        );
      }

      const leftColumnWidth = 35;
      const columnGap = 3;
      const contextLines = buildPhaseContextPanel(
        display,
        theme,
        Math.max(34, width - leftColumnWidth - columnGap)
      );
      const composedLines =
        width >= 84 && contextLines.length > 0
          ? combineColumns(lines, contextLines, leftColumnWidth, columnGap)
          : contextLines.length > 0
            ? [...lines, "", ...contextLines]
            : lines;

      return composedLines.map((l) => {
        if (visibleWidth(l) > width) return truncateToWidth(l, width);
        return l;
      });
    },
    invalidate: () => {},
  };
}

function combineColumns(left: string[], right: string[], leftWidth: number, gap: number): string[] {
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const rawLeft = left[i] ?? "";
    const r = right[i] ?? "";
    if (!r) {
      lines.push(rawLeft);
      continue;
    }
    const l = truncateToWidth(rawLeft, leftWidth);
    const padWidth = Math.max(0, leftWidth - visibleWidth(l));
    lines.push(`${l}${" ".repeat(padWidth + gap)}${r}`);
  }
  return lines;
}

function buildPhaseContextPanel(display: PipelineDisplay, theme: Theme, width: number): string[] {
  if (!display.phaseContext) return [];
  const innerWidth = Math.max(20, width - 4);
  const border = "─".repeat(innerWidth + 2);
  const lines = [
    theme.fg("dim", `╭${border}╮`),
    theme.fg("accent", `│ ${pad(display.phaseContext.title, innerWidth)} │`),
    theme.fg("dim", `├${border}┤`),
  ];
  for (const line of display.phaseContext.lines.slice(0, 6)) {
    const color = line.includes("!") ? "error" : line.includes("●") ? "accent" : line.includes("✓") ? "success" : "muted";
    lines.push(theme.fg(color, `│ ${pad(truncateToWidth(line, innerWidth), innerWidth)} │`));
  }
  lines.push(theme.fg("dim", `╰${border}╯`));
  return lines;
}

/**
 * Build a detailed task tracker (for expanded view / chat messages).
 */
export function buildTaskTracker(state: PipelineDisplay, theme: Theme): string[] {
  const lines: string[] = [];
  const done = state.tasks.filter((t) => t.status === "done").length;
  const total = state.tasks.length;

  lines.push("");
  lines.push(theme.fg("accent", "+-- morph TASK TRACKER -----------------------------------+"));
  lines.push(`| ${theme.fg("success", String(done))}/${total} done  ${theme.fg("accent", bar(done, total, 30))}`);
  lines.push(theme.fg("accent", "+---------------------------------------------------------+"));

  for (const task of state.tasks) {
    const icon = statusIcon(task.status, theme);
    const desc = truncate(task.description, 40);
    const meta = task.agent ? ` [${task.agent}]` : "";
    lines.push(`| ${icon} ${theme.fg("dim", pad(`[${task.id}]`, 8))} ${pad(desc, 42)}${meta}`);
  }

  lines.push(theme.fg("accent", "+---------------------------------------------------------+"));
  return lines;
}

/**
 * Build a compact status bar string.
 */
export function buildStatusBar(state: PipelineDisplay): string {
  if (state.phase === "idle") return "morph: idle";
  if (state.phase === "done") return `morph: DONE ✓ ${formatDisplayTokens(state.tokenLedger.total)} tok`;    

  const done = state.tasks.filter((t) => t.status === "done").length;
  const total = state.tasks.length;
  const running = state.agents.filter((a) => a.status === "running").length;
  const subRunning = state.subagentActivities?.filter((s) => s.status === "running").length || 0;

  let text = `morph:${state.phase.toUpperCase()}`;
  if (total > 0) text += ` tasks:${done}/${total}`;
  if (subRunning > 0) text += ` agents:${subRunning}`;
  else if (running > 0) text += ` agents:${running}`;
  if (state.tokenLedger.total > 0) text += ` ${formatDisplayTokens(state.tokenLedger.total)}tok`;

  return text;
}

// ── Message renderer ──

export function renderMorphMessage(
  content: string,
  theme: Theme
): { widget: string[] } | null {
  const sections = content.split(/^#+\s+/m).filter(Boolean);
  if (sections.length === 0) return null;
  return { widget: content.split("\n") };
}

// ── Utilities ──

function statusIcon(status: string, theme: Theme): string {
  switch (status) {
    case "done":
      return theme.fg("success", "✓");
    case "running":
      return theme.fg("accent", "◉");
    case "blocked":
      return theme.fg("error", "⊘");
    case "failed":
      return theme.fg("error", "✗");
    case "error":
      return theme.fg("error", "✗");
    case "pending":
    case "idle":
    default:
      return theme.fg("dim", "○");
  }
}

export function formatDisplayTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}
