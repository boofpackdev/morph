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

const ACTIVE_PHASE_FRAMES = ["◆", "◇"];

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
  lastEventAt?: number;
}

export interface FileActivity {
  taskId: string;
  path: string;
  operation: "add" | "modify" | "delete";
  beforeLines?: number;
  afterLines?: number;
  delta?: number;
  status: "active" | "done";
}

export interface FileCollision {
  path: string;
  taskIds: string[];
  unexpectedTaskIds?: string[];
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
  status: "ready" | "busy" | "waiting";
  tasks: TaskDisplay[];
  agents: AgentActivity[];
  tokenLedger: { spark: number; plan: number; work: number; review: number; ship: number; total: number };
  tick: number;
  startedAt?: string;
  versionLabel?: string;
  runtimeLabel?: string;
  profileLabel?: string;
  subagentActivities?: SubagentActivity[];
  fileActivities?: FileActivity[];
  fileCollisions?: FileCollision[];
  phaseContext?: PhaseContext;
  footerHint?: string;
  restoredCheckpointCount?: number;
}

/**
 * Get the animated status indicator.
 */
function getIndicator(status: PipelineDisplay["status"], tick: number, theme: Theme): string {
  if (status === "waiting") {
    // Red pulsing: ● / ○
    const char = tick % 2 === 0 ? "●" : "○";
    return theme.fg("error", char);
  }
  if (status === "busy") {
    // Yellow spinner
    const spin = SPINNERS.braille[tick % SPINNERS.braille.length];
    return theme.fg("accent", spin);
  }
  // Green ready: ●
  return theme.fg("success", "●");
}

/**
 * Build a colored pipeline progress widget for the TUI.
 */
export function buildPipelineProgressWidget(
  getDisplay: () => PipelineDisplay,
  theme: Theme
): { render: (width: number) => string[]; invalidate: () => void } {
  return {
    render: (width: number) => {
      const display = getDisplay();
      const lines: string[] = [];
      const tick = display.tick ?? 0;
      const indicator = getIndicator(display.status, tick, theme);

      if (display.phase === "idle") {
        lines.push(`  ${indicator} ${theme.fg("dim", "morph — READY")}`);
        lines.push(theme.fg("dim", "    /morph:run <idea> to start"));
        return lines;
      }

      if (display.phase === "done") {
        lines.push(`  ${indicator} ${theme.fg("success", theme.bold("morph — PIPELINE COMPLETE"))}`);
        if (display.tokenLedger.total > 0) {
          lines.push(
            `    ${theme.fg("success", "[DONE]")}  ${theme.fg("muted", `Tokens: ${formatDisplayTokens(display.tokenLedger.total)}`)}`
          );
        }
        return lines;
      }

      lines.push(...buildPipelineCockpit(display, theme, tick));

      const leftColumnWidth = 44;
      const columnGap = 3;
      const contextLines = buildOperatorPanel(
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

function buildPipelineCockpit(
  display: PipelineDisplay,
  theme: Theme,
  tick: number
): string[] {
  const innerWidth = 40;
  const border = "─".repeat(innerWidth);
  const version = display.versionLabel ? ` v${display.versionLabel}` : "";
  const title = `⬡ morph${version}`;
  const titleFill = "─".repeat(Math.max(1, innerWidth - visibleWidth(title) - 1));
  const labels = ALL_PHASES.map((phase) => phase.label.toLowerCase());
  const widths = labels.map((label) => Math.max(label.length, 4));
  const phaseLabelLine = labels
    .map((label, index) => centerText(label, widths[index]))
    .join(" » ");
  const phaseStatusLine = ALL_PHASES
    .map((phase, index) => centerText(renderPhaseGlyph(display, phase.id, tick, theme), widths[index]))
    .join("   ");
  const { done, blocked, failed, total } = summarizeTasks(display.tasks);
  const uptime = formatUptime(display.startedAt);
  const eta = formatEta(display);
  const footer = buildFooterHint(display);
  const taskSummary = total > 0
    ? buildWorkSummary(done, total, blocked, failed)
    : "work —";
  const tokenRows = buildTokenRows(display);
  const runLabel = display.profileLabel ? `${display.profileLabel} run` : "pipeline run";

  return [
    theme.fg("dim", `╭─ ${title} ${titleFill}╮`),
    cockpitLine(
      `${renderCockpitStatusGlyph(display, tick, theme)} ${buildCockpitStateLabel(display)} · ${runLabel} · ${display.runtimeLabel ?? "node"}`,
      innerWidth,
      theme,
      "dim"
    ),
    cockpitLine("", innerWidth, theme),
    cockpitLine(phaseLabelLine, innerWidth, theme, "muted"),
    cockpitLine(phaseStatusLine, innerWidth, theme),
    cockpitLine("", innerWidth, theme),
    cockpitLine(`uptime ${uptime} · eta ${eta}`, innerWidth, theme, "dim"),
    cockpitLine("", innerWidth, theme),
    cockpitLine("TOKENS BY PHASE", innerWidth, theme, "accent"),
    ...tokenRows.map((row) => cockpitLine(row, innerWidth, theme)),
    cockpitLine("", innerWidth, theme),
    cockpitLine(
      taskSummary,
      innerWidth,
      theme,
      taskSummary.includes("failed") || taskSummary.includes("blocked") ? "error" : "muted"
    ),
    cockpitLine(footer, innerWidth, theme, display.status === "waiting" ? "accent" : "dim"),
    theme.fg("dim", `╰${border}╯`),
  ];
}

function renderPhaseGlyph(display: PipelineDisplay, phaseId: string, tick: number, theme: Theme): string {
  const status = phaseStatusForCockpit(display.phase, phaseId);
  if (status === "done") return theme.fg("success", "✓");
  if (status === "current" && phaseId === "work" && isWorkHalted(display)) {
    return theme.fg("error", "!");
  }
  if (status === "current") return theme.fg("accent", ACTIVE_PHASE_FRAMES[tick % ACTIVE_PHASE_FRAMES.length]);
  return theme.fg("dim", "○");
}

function phaseStatusForCockpit(
  displayPhase: string,
  phaseId: string
): "done" | "current" | "pending" {
  const currentIdx = PHASE_ORDER.indexOf(displayPhase as any);
  const idx = PHASE_ORDER.indexOf(phaseId as any);
  if (idx < 0 || currentIdx < 0) return "pending";
  if (idx < currentIdx) return "done";
  if (idx === currentIdx) return "current";
  return "pending";
}

function buildTokenRows(display: PipelineDisplay): string[] {
  const ledger = display.tokenLedger;
  return [
    formatTokenPair("spark", ledger.spark, "plan", ledger.plan),
    formatTokenPair("work", ledger.work, "review", ledger.review),
    formatTokenPair("ship", ledger.ship, "total", ledger.total),
  ];
}

function formatTokenPair(leftLabel: string, leftValue: number, rightLabel: string, rightValue: number): string {
  return `${pad(leftLabel, 6)} ${padLeft(formatDisplayTokens(leftValue), 7)}  ${pad(rightLabel, 7)} ${padLeft(formatDisplayTokens(rightValue), 7)}`;
}

function summarizeTasks(tasks: TaskDisplay[]): { done: number; blocked: number; failed: number; total: number } {
  return {
    done: tasks.filter((task) => task.status === "done").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    total: tasks.length,
  };
}

function formatUptime(startedAt?: string): string {
  if (!startedAt) return "--:--:--";
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return "--:--:--";
  const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return `${padLeft(String(hours), 2, "0")}:${padLeft(String(minutes), 2, "0")}:${padLeft(String(seconds), 2, "0")}`;
}

function formatEta(display: PipelineDisplay): string {
  if (display.phase !== "work" || !display.startedAt) return "--";
  const { done, total } = summarizeTasks(display.tasks);
  if (done <= 0 || done >= total || total <= 0) return "--";
  const startMs = Date.parse(display.startedAt);
  if (!Number.isFinite(startMs)) return "--";
  const elapsedMs = Math.max(0, Date.now() - startMs);
  if (elapsedMs <= 0) return "--";
  const remainingMs = Math.round((elapsedMs / done) * (total - done));
  return `~${formatDurationShort(remainingMs)}`;
}

function formatDurationShort(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function buildWorkSummary(done: number, total: number, blocked: number, failed: number): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `work ${done}/${total} · ${pct}%${failed > 0 ? ` · fail ${failed}` : ""}${blocked > 0 ? ` · block ${blocked}` : ""}`;
}

function cockpitLine(
  content: string,
  innerWidth: number,
  theme: Theme,
  color: "accent" | "muted" | "dim" | "error" = "muted"
): string {
  const paddedInnerWidth = Math.max(0, innerWidth - 2);
  const safeContent = truncateToWidth(content, paddedInnerWidth);
  const padWidth = Math.max(0, paddedInnerWidth - visibleWidth(safeContent));
  return `${theme.fg("dim", "│")} ${theme.fg(color, safeContent)}${" ".repeat(padWidth)} ${theme.fg("dim", "│")}`;
}

function centerText(content: string, width: number): string {
  const visible = visibleWidth(content);
  const totalPadding = Math.max(0, width - visible);
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;
  return `${" ".repeat(left)}${content}${" ".repeat(right)}`;
}

function padLeft(value: string, width: number, fill: string = " "): string {
  return value.length >= width ? value : fill.repeat(width - value.length) + value;
}

function buildCockpitStateLabel(display: PipelineDisplay): string {
  if (isWorkHalted(display)) return "halted";
  switch (display.status) {
    case "busy":
      return "active";
    case "waiting":
      return "waiting";
    case "ready":
    default:
      return "ready";
  }
}

function renderCockpitStatusGlyph(display: PipelineDisplay, tick: number, theme: Theme): string {
  if (isWorkHalted(display)) return theme.fg("error", "!");
  switch (display.status) {
    case "busy":
      return theme.fg("accent", ACTIVE_PHASE_FRAMES[tick % ACTIVE_PHASE_FRAMES.length]);
    case "waiting":
      return theme.fg("error", "◉");
    case "ready":
    default:
      return theme.fg("success", "●");
  }
}

function isWorkHalted(display: PipelineDisplay): boolean {
  return (
    display.phase === "work" &&
    !display.tasks.some((task) => task.status === "running") &&
    display.tasks.some((task) => task.status === "failed" || task.status === "blocked")
  );
}

function buildFooterHint(display: PipelineDisplay): string {
  if (display.footerHint) return display.footerHint;
  if (display.status === "waiting") return "awaiting approval · respond in Pi";
  if (display.status === "busy") return "working · /morph:status";
  if (
    display.phase === "work" &&
    display.tasks.some((task) => task.status === "failed" || task.status === "blocked") &&
    !display.tasks.some((task) => task.status === "running")
  ) {
    return "work halted · /morph:recover";
  }
  if (
    display.phase === "work" &&
    display.tasks.some((task) => task.status === "pending") &&
    !display.tasks.some((task) => task.status === "running") &&
    !(display.subagentActivities?.some((sub) => sub.status === "running") ?? false)
  ) {
    return "work idle · /morph:recover";
  }

  switch (display.phase) {
    case "spark":
      return "next: plan gate";
    case "plan":
      return "next: approve work spec";
    case "work":
      return "next: review gate";
    case "review":
      return "next: review verdict";
    case "ship":
      return "next: release handoff";
    default:
      return "/morph:run · /morph:status";
  }
}

function buildOperatorPanel(display: PipelineDisplay, theme: Theme, width: number): string[] {
  if (!display.phaseContext) return [];
  const innerWidth = Math.max(20, width - 4);
  const border = "─".repeat(innerWidth + 2);
  const activeSubs = display.subagentActivities?.filter((sub) => sub.status === "running") ?? [];
  const fileActivities = display.fileActivities ?? [];
  const activeFiles = fileActivities.filter((activity) => activity.status === "active");
  const recentFiles = fileActivities.filter((activity) => activity.status === "done");
  const fileCollisions = display.fileCollisions ?? [];
  const lines = [
    theme.fg("dim", `╭${border}╮`),
    buildOperatorHeader(display, theme, innerWidth),
    theme.fg("dim", `├${border}┤`),
  ];

  if (activeFiles.length === 0 && recentFiles.length === 0) {
    lines.push(theme.fg("dim", `│ ${pad("no file changes yet", innerWidth)} │`));
  } else {
    for (const activity of [...activeFiles, ...recentFiles].slice(0, 4)) {
      const op = activity.operation === "add" ? "A" : activity.operation === "delete" ? "D" : "M";
      const marker = activity.status === "active" ? ">" : "✓";
      const lineStats =
        activity.beforeLines !== undefined && activity.afterLines !== undefined
          ? ` ${activity.beforeLines} -> ${activity.afterLines} lines (${formatDelta(activity.delta ?? 0)})`
          : activity.beforeLines !== undefined
            ? ` ${activity.beforeLines} lines`
            : "";
      const row = `${marker} [${activity.taskId}] ${op} ${activity.path}${lineStats}`;
      const color =
        activity.status === "active"
          ? "accent"
          : activity.operation === "add" || (activity.delta ?? 0) > 0
            ? "success"
            : activity.operation === "delete" || (activity.delta ?? 0) < 0
              ? "error"
              : "muted";
      lines.push(theme.fg(color as any, `│ ${pad(truncateToWidth(row, innerWidth), innerWidth)} │`));
    }
  }

  if (activeSubs.length > 0) {
    lines.push(theme.fg("dim", `├${border}┤`));
    lines.push(theme.fg("accent", `│ ${pad("ACTIVE", innerWidth)} │`));
    for (const sub of activeSubs.slice(0, 3)) {
      const taskTag = sub.taskId && sub.taskId !== "-" ? ` [${sub.taskId}]` : "";
      const tool = sub.currentTool
        ? `${sub.currentTool}${sub.toolDetail ? ` ${sub.toolDetail}` : ""}`
        : "thinking...";
      const quietFor = formatQuietDuration(sub.lastEventAt);
      const summary = `${sub.role}${taskTag}  ${tool}${quietFor ? `  ·  ${quietFor}` : ""}`;
      lines.push(theme.fg("muted", `│ ${pad(truncateToWidth(summary, innerWidth), innerWidth)} │`));
      if (sub.lastAction) {
        lines.push(theme.fg("dim", `│ ${pad(truncateToWidth(`↳ ${sub.lastAction}`, innerWidth), innerWidth)} │`));
      }
    }
  }

  if (fileCollisions.length > 0) {
    lines.push(theme.fg("dim", `├${border}┤`));
    lines.push(theme.fg("error", `│ ${pad("FILE COLLISION", innerWidth)} │`));
    for (const collision of fileCollisions.slice(0, 2)) {
      const taskLabel = collision.taskIds
        .map((taskId) => collision.unexpectedTaskIds?.includes(taskId) ? `${taskId}!` : taskId)
        .join(" + ");
      const row = `${taskLabel} -> ${collision.path}`;
      lines.push(theme.fg("error", `│ ${pad(truncateToWidth(row, innerWidth), innerWidth)} │`));
    }
  }

  lines.push(theme.fg("dim", `├${border}┤`));
  lines.push(theme.fg("accent", `│ ${pad(display.phaseContext.title, innerWidth)} │`));
  const contextLineLimit =
    display.phaseContext.title === "PLAN INTELLIGENCE" ||
    display.phaseContext.title === "REVIEW INTELLIGENCE"
      ? 9
      : 2;
  for (const line of display.phaseContext.lines.slice(0, contextLineLimit)) {
    lines.push(theme.fg("muted", `│ ${pad(truncateToWidth(line, innerWidth), innerWidth)} │`));
  }

  lines.push(theme.fg("dim", `╰${border}╯`));
  return lines;
}

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function formatQuietDuration(lastEventAt?: number): string {
  if (!lastEventAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000));
  if (seconds < 15) return "active now";
  if (seconds < 60) return `quiet ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `quiet ${minutes}m`;
}

function buildOperatorHeader(display: PipelineDisplay, theme: Theme, innerWidth: number): string {
  const restored = display.restoredCheckpointCount ?? 0;
  if (restored <= 0) {
    return theme.fg("accent", `│ ${pad("WORKTREE CHANGES", innerWidth)} │`);
  }

  const label = "WORKTREE CHANGES";
  const badge = `RESTORED ${restored}`;
  const gap = Math.max(1, innerWidth - label.length - badge.length);
  return `│ ${theme.fg("accent", label)}${" ".repeat(gap)}${theme.fg("success", badge)} │`;
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
  return `${(count / 1000).toFixed(1)}k`;
}
