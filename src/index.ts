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
import { detectFileTargetOverlaps, formatDAG, formatProgress, waveGroups, estimatePhaseTokens } from "./core/engine.js";
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
  type SubagentActivity,
  type FileActivity,
  type FileCollision,
  type PhaseContext,
  buildPipelineProgressWidget,
  buildTaskTracker,
  buildStatusBar,
} from "./tui/display.js";
import { startMorphServer, serverEvents } from "./server/server.js";
import type { Server } from "node:http";
import type { PlanOutput, SparkOutput } from "./schemas/contracts.js";
import { renderSkillProfiles } from "./core/skill-profiles.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildWorkSpecMarkdown(plan: PlanOutput, spark?: SparkOutput): string {
  const waves = waveGroups(plan.tasks);
  const fileOverlaps = detectFileTargetOverlaps(plan.tasks);
  const lines: string[] = [
    "# morph Pre-Work Specification Review",
    "",
    "Review this specification before WORK starts. Edit anything that needs clarification, scope adjustment, or constraints.",
    "The final text saved from this editor is passed to implementation and review agents as human-approved guidance.",
    "",
  ];

  if (spark) {
    lines.push(
      "## Product Shape Contract",
      `- **Deliverable Type**: ${spark.productShape.deliverableType}`,
      `- **Runtime / Host**: ${spark.productShape.runtime}`,
      `- **Distribution**: ${spark.productShape.distribution}`,
      `- **Explicit User Intent**: ${spark.productShape.explicitUserIntent}`,
      "",
      "## Product Intent",
      spark.visionStatement,
      "",
      "### Core Features",
      ...spark.coreFeatures.map((feature) => `- ${feature}`),
      "",
      "### Success Criteria",
      ...(spark.successCriteria.length ? spark.successCriteria.map((item) => `- ${item}`) : ["- Not specified"]),
      "",
      "### Constraints",
      ...(spark.constraints.length ? spark.constraints.map((item) => `- ${item}`) : ["- None specified"]),
      ""
    );
  }

  lines.push(
    "## Architecture",
    plan.architectureDiagram,
    "",
    "## Data Models",
    ...(plan.dataModels.length ? plan.dataModels.map((m) => `- ${m}`) : ["- None specified"]),
    "",
    "## Components",
    ...(plan.componentTree.length ? plan.componentTree.map((c) => `- ${c.name}: ${c.responsibility}${c.dependsOn.length ? ` (depends on: ${c.dependsOn.join(", ")})` : ""}`) : ["- None specified"]),
    "",
    "## Execution Waves"
  );

  for (let i = 0; i < waves.length; i++) {
    lines.push("", `### Wave ${i + 1}`);
    for (const task of waves[i]) lines.push(`- [${task.id}] ${task.description}`, `  - Category: ${task.category}`, `  - Complexity: ${task.estimatedComplexity}`, `  - Depends on: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}`, `  - Acceptance: ${task.acceptanceCriteria}`);
  }

  lines.push(
    "",
    "## File Target Overlaps",
    ...(fileOverlaps.length
      ? fileOverlaps.map((overlap) =>
          `- [${overlap.severity.toUpperCase()}] ${overlap.file}: ${overlap.taskIds.join(", ")} (waves ${overlap.waveNumbers.join(", ")}) — ${overlap.suggestion}`
        )
      : ["- None detected"]),
    "",
    "## QA Strategy",
    plan.qaStrategy,
    "",
    "## Risk Mitigations",
    ...(plan.riskMitigations.length ? plan.riskMitigations.map((r) => `- ${r}`) : ["- None specified"]),
    "",
    "## Human Adjustments / Approval Notes",
    plan.humanReviewNotes || "Approved as written."
  );
  return lines.join("\n");
}

function renderHtmlList(items: string[], fallback: string): string {
  const values = items.length ? items : [fallback];
  return `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildWorkSpecHtml(plan: PlanOutput, markdown: string, spark?: SparkOutput): string {
  const fileOverlaps = detectFileTargetOverlaps(plan.tasks);
  const taskRows = plan.tasks.map((task) => `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${escapeHtml(task.description)}</td><td>${escapeHtml(task.category)}</td><td>${escapeHtml(task.estimatedComplexity)}</td><td>${escapeHtml(task.dependsOn.join(", ") || "none")}</td><td>${escapeHtml(task.acceptanceCriteria)}</td></tr>`).join("\n");
  const waveCards = waveGroups(plan.tasks).map((wave, index) => `
    <section class="wave">
      <h3>Wave ${index + 1}</h3>
      <ol>${wave.map((task) => `<li><strong>${escapeHtml(task.id)}</strong> ${escapeHtml(task.description)}</li>`).join("")}</ol>
    </section>`).join("");
  const productIntent = spark
    ? `<section class="panel identity">
        <h2>What morph believes it is building</h2>
        <div class="identity-grid">
          <div><span>Deliverable type</span><strong>${escapeHtml(spark.productShape.deliverableType)}</strong></div>
          <div><span>Runtime / host</span><strong>${escapeHtml(spark.productShape.runtime)}</strong></div>
          <div><span>Distribution</span><strong>${escapeHtml(spark.productShape.distribution)}</strong></div>
          <div><span>Explicit user intent</span><strong>${escapeHtml(spark.productShape.explicitUserIntent)}</strong></div>
        </div>
      </section>
      <section class="hero-grid">
        <div class="panel">
          <h2>What we are building</h2>
          <p>${escapeHtml(spark.visionStatement)}</p>
        </div>
        <div class="panel">
          <h2>Success criteria</h2>
          ${renderHtmlList(spark.successCriteria, "No explicit success criteria captured.")}
        </div>
      </section>
      <section class="split">
        <div class="panel">
          <h2>Core features</h2>
          ${renderHtmlList(spark.coreFeatures, "No features captured.")}
        </div>
        <div class="panel">
          <h2>Constraints</h2>
          ${renderHtmlList(spark.constraints, "No hard constraints captured.")}
        </div>
      </section>`
    : "";
  const overlapPanel = fileOverlaps.length
    ? `<section class="panel overlap">
        <h2>File target overlaps</h2>
        <p>These planned tasks name the same concrete file target. Same-wave overlaps are the ones most likely to turn into live collisions.</p>
        <ul>${fileOverlaps.map((overlap) => `<li><strong>${escapeHtml(overlap.severity.toUpperCase())}</strong> <code>${escapeHtml(overlap.file)}</code> — ${escapeHtml(overlap.taskIds.join(", "))} (waves ${escapeHtml(overlap.waveNumbers.join(", "))}). ${escapeHtml(overlap.suggestion)}</li>`).join("")}</ul>
      </section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>morph Work Approval</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#5b6475;--line:#dbe2ee;--paper:#f7f9fc;--card:#fff;--accent-soft:#eef1ff;--warn:#fff7ed;--warn-line:#fb923c;--ok:#0f766e}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55}
    main{max-width:1180px;margin:0 auto;padding:36px 24px 56px}
    header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}
    h1{font-size:2rem;line-height:1.1;margin:0 0 8px}h2{font-size:1rem;margin:0 0 10px}h3{margin:0 0 8px}
    .eyebrow{letter-spacing:.08em;text-transform:uppercase;font-size:.72rem;color:var(--muted);font-weight:700}
    .subtle{color:var(--muted);margin:0}.metrics{display:flex;gap:10px;flex-wrap:wrap}
    .metric{background:var(--accent-soft);color:#3343bf;padding:8px 12px;border-radius:999px;font-weight:700;font-size:.9rem}
    .notice{background:var(--warn);border-left:4px solid var(--warn-line);padding:16px 18px;border-radius:14px;margin:18px 0 22px}
    .hero-grid,.split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}
    .panel,.wave,.spec{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    .identity{border-color:#c7d2fe;background:#f8faff}.identity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.identity span{display:block;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}.identity strong{display:block;margin-top:4px}
    .overlap{border-color:#fdba74;background:#fff7ed}
    .wave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:16px 0}
    table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden}
    th,td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;font-size:.92rem}
    th{background:#f2f5fb;color:#334155}tr:last-child td{border-bottom:0}
    pre{margin:0;background:#0f172a;color:#e2e8f0;padding:16px;border-radius:14px;overflow:auto}
    code{background:#eef2ff;padding:2px 5px;border-radius:6px}
    .actions{position:sticky;bottom:16px;margin-top:24px;display:flex;gap:12px;align-items:center;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:18px;padding:14px 16px}
    button{border:0;border-radius:12px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer}
    .approve{background:var(--ok);color:white}.pause{background:#e2e8f0;color:#334155}
    #browser-status{color:var(--muted);font-size:.92rem}
    @media(max-width:800px){header,.hero-grid,.split{display:block}.identity-grid{display:block}.identity-grid>div+div{margin-top:12px}.metrics{margin-top:16px}.panel{margin-top:16px}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">morph approval gate</div>
        <h1>Pre-work specification review</h1>
        <p class="subtle">Final human checkpoint before implementation begins.</p>
      </div>
      <div class="metrics">
        <span class="metric">${plan.tasks.length} tasks</span>
        <span class="metric">${waveGroups(plan.tasks).length} waves</span>
        <span class="metric">${escapeHtml(plan.estimatedEffort)}</span>
      </div>
    </header>
    <div class="notice"><strong>Approval meaning:</strong> the implementation plan below is ready to hand to the Engineer and Peer Reviewer agents. Use the pi editor if you want to change the spec; approve here only when the plan is ready as shown.</div>
    ${productIntent}
    ${overlapPanel}
    <section class="panel">
      <h2>Architecture</h2>
      <pre>${escapeHtml(plan.architectureDiagram)}</pre>
    </section>
    <section>
      <h2>Execution waves</h2>
      <div class="wave-grid">${waveCards}</div>
    </section>
    <section class="panel">
      <h2>Task DAG</h2>
      <table><thead><tr><th>ID</th><th>Description</th><th>Category</th><th>Complexity</th><th>Dependencies</th><th>Acceptance</th></tr></thead><tbody>${taskRows}</tbody></table>
    </section>
    <section class="split">
      <div class="panel">
        <h2>QA strategy</h2>
        <p>${escapeHtml(plan.qaStrategy)}</p>
      </div>
      <div class="panel">
        <h2>Risk mitigations</h2>
        ${renderHtmlList(plan.riskMitigations, "No explicit mitigations captured.")}
      </div>
    </section>
    <section class="spec">
      <h2>Approved spec snapshot</h2>
      <pre>${escapeHtml(markdown)}</pre>
    </section>
    <div class="actions">
      <button class="approve" onclick="sendDecision('approve')">Approve &amp; start WORK</button>
      <button class="pause" onclick="sendDecision('reject')">Pause pipeline</button>
      <span id="browser-status">You can also approve from the pi session.</span>
    </div>
  </main>
  <script>
    async function sendDecision(decision) {
      const status = document.getElementById('browser-status');
      status.textContent = decision === 'approve' ? 'Sending approval…' : 'Pausing pipeline…';
      try {
        await fetch('http://localhost:4040/api/' + decision, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: 'pre-work' })
        });
        status.textContent = decision === 'approve'
          ? 'Approved in browser. WORK will begin in the pi session.'
          : 'Pipeline paused from browser.';
      } catch (err) {
        status.textContent = 'Could not reach morph Mission Control on localhost:4040.';
      }
    }
  </script>
</body>
</html>`;
}

function openFileInBrowser(filePath: string): void {
  const absolute = path.resolve(filePath);
  if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "", absolute], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [absolute], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [absolute], { detached: true, stdio: "ignore" }).unref();
}

function hasProjectMarker(dir: string): boolean {
  return [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "index.html",
  ].some((file) => fs.existsSync(path.join(dir, file)));
}

function inferProjectRoot(state: ReturnType<Blackboard["getState"]>, cwd: string): {
  absolutePath: string;
  relativePath: string;
  reason: string;
} {
  const targetDirs = (state.planOutput?.tasks ?? [])
    .map((task) => task.targetDir)
    .filter((dir): dir is string => Boolean(dir));
  const counts = new Map<string, number>();
  for (const dir of targetDirs) counts.set(dir, (counts.get(dir) ?? 0) + 1);

  const rankedTargets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => dir);

  for (const dir of rankedTargets) {
    const absolute = path.resolve(cwd, dir);
    if (fs.existsSync(absolute) && hasProjectMarker(absolute)) {
      return {
        absolutePath: absolute,
        relativePath: dir,
        reason: "Most planned work targeted this project directory.",
      };
    }
  }

  const firstLevelDirs = fs.readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  for (const dir of firstLevelDirs) {
    const absolute = path.join(cwd, dir);
    if (hasProjectMarker(absolute)) {
      return {
        absolutePath: absolute,
        relativePath: dir,
        reason: "Detected a nested project directory with runnable project files.",
      };
    }
  }

  return {
    absolutePath: cwd,
    relativePath: ".",
    reason: "Using the repository root.",
  };
}

function detectQuickstart(projectRoot: string, repoRoot: string): string[] {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const relativeRoot = path.relative(repoRoot, projectRoot) || ".";
  const maybeCd = relativeRoot === "." ? [] : [`\`cd ${relativeRoot.replace(/\\/g, "/")}\``];
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      const manager = fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(projectRoot, "yarn.lock"))
          ? "yarn"
          : "npm";
      const install = manager === "yarn" ? "yarn install" : `${manager} install`;
      const runDev = scripts.dev
        ? manager === "npm" ? "npm run dev" : `${manager} dev`
        : scripts.start
          ? manager === "npm" ? "npm start" : `${manager} start`
          : undefined;
      const runTest = scripts.test
        ? manager === "npm" ? "npm test" : `${manager} test`
        : undefined;
      return [
        ...maybeCd,
        `\`${install}\``,
        ...(runDev ? [`\`${runDev}\``] : []),
        ...(runTest ? [`\`${runTest}\` to verify the project`] : []),
      ];
    } catch {
      // Fall through to generic guidance.
    }
  }

  if (fs.existsSync(path.join(projectRoot, "pyproject.toml")) || fs.existsSync(path.join(projectRoot, "requirements.txt"))) {
    return [
      ...maybeCd,
      "`python -m venv .venv`",
      "Activate the virtual environment.",
      fs.existsSync(path.join(projectRoot, "requirements.txt"))
        ? "`pip install -r requirements.txt`"
        : "`pip install -e .`",
    ];
  }

  if (fs.existsSync(path.join(projectRoot, "index.html"))) {
    return [
      ...maybeCd,
      "Open `index.html` in a browser, or serve the directory with a simple static server.",
    ];
  }

  return [
    ...maybeCd,
    "Open the project directory.",
    "Review the changed files listed below.",
    "Use the repository README or stack-specific commands to run the project.",
  ];
}

function buildFinalReportMarkdown(state: ReturnType<Blackboard["getState"]>, cwd: string): string {
  const spark = state.sparkOutput;
  const plan = state.planOutput;
  const review = state.reviewOutput;
  const ship = state.shipOutput;
  const changedFiles = [...new Set(state.workResults.flatMap((result) => result.filesChanged))];
  const completedTasks = state.workResults.filter((result) => result.status === "done");
  const projectRoot = inferProjectRoot(state, cwd);
  const quickstart = detectQuickstart(projectRoot.absolutePath, cwd);
  const lines: string[] = [
    "# morph Final Handoff Report",
    "",
    ship ? `**Release**: v${ship.version} — ${ship.status}` : "**Release**: not recorded",
    "",
    "## Overview",
    spark?.visionStatement ?? "No product overview captured.",
    "",
    "## What was built",
    ...(spark?.coreFeatures.length ? spark.coreFeatures.map((feature) => `- ${feature}`) : ["- No feature summary captured."]),
    "",
    "## Quickstart",
    ...quickstart.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Primary deliverable",
    `- **Project root**: \`${projectRoot.relativePath}\``,
    `- **Why**: ${projectRoot.reason}`,
    "",
    "## Architecture",
    plan?.architectureDiagram ?? "No architecture diagram captured.",
    "",
    "## Main components",
    ...(plan?.componentTree.length
      ? plan.componentTree.map((component) => `- **${component.name}** — ${component.responsibility}`)
      : ["- No component breakdown captured."]),
    "",
    "## Delivered work",
    ...(completedTasks.length
      ? completedTasks.map((result) => `- **${result.taskId}** — ${result.summary}`)
      : ["- No completed work results recorded."]),
    "",
    "## Changed files",
    ...(changedFiles.length ? changedFiles.map((file) => `- \`${file}\``) : ["- No changed files recorded."]),
    "",
    "## Validation",
    review
      ? `Review status: **${review.status}** · efficiency score **${review.efficiencyScore}/10**`
      : "Review output not recorded.",
    ...(review?.testCoverageAssessment ? ["", review.testCoverageAssessment] : []),
    "",
    "## Release notes",
    ship?.changelog ?? "No changelog captured.",
    "",
    "## Deployment checklist",
    ...(ship?.deploymentChecklist.length
      ? ship.deploymentChecklist.map((item) => `- [${item.done ? "x" : " "}] ${item.item}`)
      : ["- No deployment checklist captured."]),
    "",
    "## Known limitations / follow-ups",
    ...(review?.requiredChanges.length
      ? review.requiredChanges.map((change) => `- ${change.severity}: ${change.description}`)
      : ["- No open review findings recorded."]),
    "",
    ...(ship?.rollbackPlan ? ["## Rollback plan", ship.rollbackPlan, ""] : []),
    ...(ship?.postReleaseNotes ? ["## Post-release monitoring", ship.postReleaseNotes, ""] : []),
  ];
  return lines.join("\n");
}

function buildFinalReportHtml(state: ReturnType<Blackboard["getState"]>, markdown: string, cwd: string): string {
  const spark = state.sparkOutput;
  const plan = state.planOutput;
  const review = state.reviewOutput;
  const ship = state.shipOutput;
  const projectRoot = inferProjectRoot(state, cwd);
  const quickstart = detectQuickstart(projectRoot.absolutePath, cwd);
  const quickstartHtml = quickstart
    .map((step) => escapeHtml(step).replace(/`([^`]+)`/g, "<code>$1</code>"));
  const changedFiles = [...new Set(state.workResults.flatMap((result) => result.filesChanged))];
  const completedTasks = state.workResults.filter((result) => result.status === "done");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>morph Final Handoff Report</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#5b6475;--line:#dbe2ee;--paper:#f7f9fc;--card:#fff;--accent:#4057f4;--accent-soft:#eef1ff;--ok:#0f766e}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55}
    main{max-width:1160px;margin:0 auto;padding:36px 24px 56px}
    header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:22px}
    h1{font-size:2rem;margin:0 0 8px}h2{font-size:1.1rem;margin:0 0 12px}pre{white-space:pre-wrap;margin:0}
    .eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;color:var(--muted);font-weight:700}
    .metrics{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
    .metric{background:var(--accent-soft);color:#3343bf;padding:8px 12px;border-radius:999px;font-weight:700;font-size:.9rem}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:16px}
    .wide{grid-column:1/-1}.muted{color:var(--muted)}
    code{background:#eef2ff;padding:2px 5px;border-radius:6px}
    .architecture{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:14px;overflow:auto}
    .callout{border-left:4px solid var(--ok)}
    .checklist li{list-style:none;margin-left:-1.4rem}
    @media(max-width:800px){header,.grid{display:block}.metrics{justify-content:flex-start;margin-top:12px}.metric{display:inline-block}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">morph final handoff</div>
        <h1>${spark ? escapeHtml(spark.visionStatement.slice(0, 90)) : "Completed project"}</h1>
        <p class="muted">${ship ? `Release v${escapeHtml(ship.version)} · ${escapeHtml(ship.status)}` : "Release not recorded"}</p>
      </div>
      <div class="metrics">
        <div class="metric">${completedTasks.length} completed tasks</div>
        <div class="metric">root ${escapeHtml(projectRoot.relativePath)}</div>
      </div>
    </header>
    <div class="grid">
      <section class="panel callout wide">
        <h2>Handoff summary</h2>
        <p>${escapeHtml(spark?.visionStatement ?? "No product overview captured.")}</p>
        <p class="muted">Primary deliverable: <code>${escapeHtml(projectRoot.relativePath)}</code> — ${escapeHtml(projectRoot.reason)}</p>
      </section>
      <section class="panel">
        <h2>What was built</h2>
        ${renderHtmlList(spark?.coreFeatures ?? [], "No feature summary captured.")}
      </section>
      <section class="panel">
        <h2>Quickstart</h2>
        <ol>${quickstartHtml.map((step) => `<li>${step}</li>`).join("")}</ol>
      </section>
      <section class="panel wide">
        <h2>Architecture</h2>
        <pre class="architecture">${escapeHtml(plan?.architectureDiagram ?? "No architecture diagram captured.")}</pre>
      </section>
      <section class="panel">
        <h2>Main components</h2>
        ${renderHtmlList(plan?.componentTree.map((component) => `${component.name} — ${component.responsibility}`) ?? [], "No component breakdown captured.")}
      </section>
      <section class="panel">
        <h2>Validation</h2>
        <p>${review ? `Review status: <strong>${escapeHtml(review.status)}</strong> · efficiency score <strong>${review.efficiencyScore}/10</strong>` : "Review output not recorded."}</p>
        ${review?.testCoverageAssessment ? `<p class="muted">${escapeHtml(review.testCoverageAssessment)}</p>` : ""}
      </section>
      <section class="panel">
        <h2>Delivered work</h2>
        ${renderHtmlList(completedTasks.map((result) => `${result.taskId} — ${result.summary}`), "No completed work results recorded.")}
      </section>
      <section class="panel">
        <h2>Changed files</h2>
        ${renderHtmlList(changedFiles, "No changed files recorded.")}
      </section>
      <section class="panel wide">
        <h2>Release notes</h2>
        <pre>${escapeHtml(ship?.changelog ?? "No changelog captured.")}</pre>
      </section>
      <section class="panel">
        <h2>Deployment checklist</h2>
        <div class="checklist">${renderHtmlList(ship?.deploymentChecklist.map((item) => `${item.done ? "✓" : "○"} ${item.item}`) ?? [], "No deployment checklist captured.")}</div>
      </section>
      <section class="panel">
        <h2>Known limitations / follow-ups</h2>
        ${renderHtmlList(review?.requiredChanges.map((change) => `${change.severity}: ${change.description}`) ?? [], "No open review findings recorded.")}
      </section>
      ${ship?.rollbackPlan ? `<section class="panel"><h2>Rollback plan</h2><pre>${escapeHtml(ship.rollbackPlan)}</pre></section>` : ""}
      ${ship?.postReleaseNotes ? `<section class="panel"><h2>Post-release monitoring</h2><pre>${escapeHtml(ship.postReleaseNotes)}</pre></section>` : ""}
      <section class="panel wide">
        <h2>Markdown snapshot</h2>
        <pre>${escapeHtml(markdown)}</pre>
      </section>
    </div>
  </main>
</body>
</html>`;
}

export default function (pi: ExtensionAPI) {
  // ── Shared state ──
  let blackboard: Blackboard | null = null;
  let blackboardCwd: string | null = null;
  let activeWorkspaceCwd: string | null = null;
  let currentAbortController: AbortController | null = null;
  let currentTick = 0;
  let currentStatus: PipelineDisplay["status"] = "ready";
  let currentHint: string | undefined;
  let animationInterval: NodeJS.Timeout | null = null;
  let requestAnimationRender: (() => void) | null = null;
  let webServer: Server | null = null;
  const subagentActivities = new Map<string, SubagentActivity>();
  const activeFileActivities = new Map<string, FileActivity>();
  const recentFileActivities: FileActivity[] = [];

  function setCurrentStatus(status: PipelineDisplay["status"], hint?: string): void {
    currentStatus = status;
    currentHint = hint;
  }

  async function waitConfirm(ctx: any, title: string, desc: string, phase: string): Promise<boolean> {
    const previousStatus = currentStatus;
    const previousHint = currentHint;
    currentStatus = "waiting";
    currentHint = "approval needed  |  browser or Pi";
    updateWidget(ctx);

    return new Promise((resolve) => {
      let resolved = false;

      // Web UI approval listener
      const onApprove = (p: string) => {
        if (p === phase && !resolved) {
          resolved = true;
          serverEvents.removeListener("approve", onApprove);
          ctx.ui.notify(`Approved via Web UI`, "success" as any);
          currentStatus = previousStatus;
          currentHint = previousHint;
          updateWidget(ctx);
          resolve(true);
        }
      };
      serverEvents.on("approve", onApprove);

      // Terminal confirmation
      ctx.ui.confirm(title, desc).then((proceed: boolean) => {
        if (!resolved) {
          resolved = true;
          serverEvents.removeListener("approve", onApprove);
          currentStatus = previousStatus;
          currentHint = previousHint;
          updateWidget(ctx);
          resolve(proceed);
        }
      });
    });
  }

  function getBB(cwd?: string): Blackboard {
    const workspaceCwd = path.resolve(cwd || activeWorkspaceCwd || process.cwd());
    if (!blackboard || blackboardCwd !== workspaceCwd) {
      blackboard = new Blackboard(workspaceCwd);
      blackboardCwd = workspaceCwd;
    }
    return blackboard;
  }

  function resetBB(): void {
    blackboard = null;
    blackboardCwd = null;
    currentAbortController?.abort();
    currentAbortController = null;
    activeFileActivities.clear();
    recentFileActivities.length = 0;
  }

  function bindWorkspace(cwd: string): Blackboard {
    activeWorkspaceCwd = path.resolve(cwd);
    return getBB(activeWorkspaceCwd);
  }

  function summarizeRecoveryState(state: ReturnType<Blackboard["getState"]>): {
    unfinished: boolean;
    kind: "none" | "recoverable" | "restartable" | "stale";
    checkpointCount: number;
    doneTasks: number;
    totalTasks: number;
    failedTasks: number;
    blockedTasks: number;
    message: string;
  } {
    const checkpointCount = Object.keys(state.flowCheckpoints[state.phase] || {}).length;
    const doneTasks = state.workResults.filter((result) => result.status === "done").length;
    const failedTasks = state.workResults.filter((result) => result.status === "failed").length;
    const blockedTasks = state.workResults.filter((result) => result.status === "blocked").length;
    const totalTasks = state.planOutput?.tasks.length ?? 0;
    const unfinished = state.phase !== "idle" && state.phase !== "done";
    const hasPhaseCheckpoints = checkpointCount > 0;
    const hasRestartContext =
      state.phase === "spark"
        ? Boolean(state.pipelinePrompt?.trim())
        : state.phase === "plan"
          ? Boolean(state.sparkOutput)
          : state.phase === "work"
            ? Boolean(state.planOutput)
            : state.phase === "review"
              ? Boolean(state.planOutput && state.workResults.length > 0)
              : state.phase === "ship"
                ? Boolean(state.reviewOutput)
                : false;
    const hasMaterialProgress =
      Boolean(state.sparkOutput) ||
      Boolean(state.planOutput) ||
      state.workResults.length > 0 ||
      Boolean(state.reviewOutput) ||
      Boolean(state.shipOutput) ||
      state.tokenLedger.total > 0 ||
      state.decisions.length > 0;
    const kind: "none" | "recoverable" | "restartable" | "stale" =
      !unfinished
        ? "none"
        : !hasRestartContext
          ? "stale"
          : hasPhaseCheckpoints || hasMaterialProgress
          ? "recoverable"
          : "restartable";

    if (!unfinished) {
      return {
        unfinished,
        kind,
        checkpointCount,
        doneTasks,
        totalTasks,
        failedTasks,
        blockedTasks,
        message: "",
      };
    }

    const progress =
      totalTasks > 0
        ? `tasks ${doneTasks}/${totalTasks}${failedTasks > 0 ? `, ${failedTasks} failed` : ""}${blockedTasks > 0 ? `, ${blockedTasks} blocked` : ""}`
        : "no task DAG yet";
    const checkpoints =
      checkpointCount > 0
        ? `${checkpointCount} checkpoint${checkpointCount === 1 ? "" : "s"} available`
        : "no checkpoints saved";

    return {
      unfinished,
      kind,
      checkpointCount,
      doneTasks,
      totalTasks,
      failedTasks,
      blockedTasks,
      message:
        kind === "restartable"
          ? `unfinished morph setup found in this folder: ${state.phase} · ${progress} · ${checkpoints}`
          : `unfinished morph flow detected in this folder: ${state.phase} · ${progress} · ${checkpoints}`,
    };
  }

  function diagnoseRecoveryState(state: ReturnType<Blackboard["getState"]>): {
    taskId?: string;
    failureKind?: string;
    evidence: string[];
    recommendation: string;
    autoSafe: boolean;
  } {
    const latestFailed = [...state.workResults]
      .reverse()
      .find((result) => result.status === "failed" || result.status === "blocked");
    const latestRecoverableFailure = findLatestRecoverableFailure(state, latestFailed);
    const impossibleSuccess = [...state.workResults]
      .reverse()
      .find((result) => result.status === "done" && result.filesChanged.length === 0);

    if (impossibleSuccess) {
      return {
        taskId: impossibleSuccess.taskId,
        failureKind: "STATE_INCONSISTENT",
        evidence: [
          "Task is marked done but has no recorded file changes.",
          "Persisted success no longer passes the stricter completion standard.",
        ],
        recommendation: "Clear the untrusted task result and rerun it from Work.",
        autoSafe: true,
      };
    }

    if (!latestRecoverableFailure) {
      return {
        evidence: ["No failed or blocked task result is currently recorded."],
        recommendation: "Resume the current phase from its saved state.",
        autoSafe: true,
      };
    }

    const kind = latestRecoverableFailure.failureKind;
    switch (kind) {
      case "NO_EFFECT":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Rerun the task with explicit completion evidence and expected file targets.",
          autoSafe: true,
        };
      case "TOOL_FAILURE":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Retry the task; the last failure came from the execution layer rather than the task itself.",
          autoSafe: true,
        };
      case "AUTH_OR_QUOTA_FAILURE":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Fix provider access or credits, or switch provider/model config, before retrying this task.",
          autoSafe: false,
        };
      case "REVIEW_REJECTED":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Rerun the task with reviewer feedback injected into the next attempt.",
          autoSafe: true,
        };
      case "REVIEW_FORMAT_INVALID":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Retry the review path; implementation may be fine, but the reviewer response was malformed.",
          autoSafe: true,
        };
      case "VERIFICATION_FAILED":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Rerun the task against the missing expected artifacts before trusting another approval.",
          autoSafe: true,
        };
      case "DEPENDENCY_BLOCKED":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Recover the failed dependency first; blocked children should not be retried in isolation.",
          autoSafe: false,
        };
      case "TASK_UNDERSPECIFIED":
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Replan the task before spending more implementation attempts on fog.",
          autoSafe: false,
        };
      default:
        return {
          taskId: latestRecoverableFailure.taskId,
          failureKind: kind,
          evidence: latestRecoverableFailure.failureEvidence,
          recommendation: "Resume cautiously from the current phase and inspect the task if it fails again.",
          autoSafe: true,
        };
    }
  }

  function findLatestRecoverableFailure(
    state: ReturnType<Blackboard["getState"]>,
    latestFailed: ReturnType<Blackboard["getState"]>["workResults"][number] | undefined
  ): ReturnType<Blackboard["getState"]>["workResults"][number] | undefined {
    if (!latestFailed || latestFailed.failureKind !== "DEPENDENCY_BLOCKED") {
      return latestFailed;
    }

    const tasksById = new Map(state.planOutput?.tasks.map((task) => [task.id, task]) ?? []);
    const resultsById = new Map(state.workResults.map((result) => [result.taskId, result]));
    const visited = new Set<string>();
    const rootFailures: ReturnType<Blackboard["getState"]>["workResults"] = [];

    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const result = resultsById.get(taskId);
      if (result && result.status === "failed") {
        rootFailures.push(result);
        return;
      }

      const task = tasksById.get(taskId);
      for (const dependencyId of task?.dependsOn ?? []) {
        visit(dependencyId);
      }
    };

    visit(latestFailed.taskId);

    if (rootFailures.length === 0) return latestFailed;

    const resultOrder = new Map(state.workResults.map((result, index) => [result.taskId, index]));
    return rootFailures.sort(
      (a, b) => (resultOrder.get(b.taskId) ?? -1) - (resultOrder.get(a.taskId) ?? -1)
    )[0];
  }

  function buildRecoveryReport(
    state: ReturnType<Blackboard["getState"]>,
    diagnosis: ReturnType<typeof diagnoseRecoveryState>
  ): string {
    const task = diagnosis.taskId
      ? state.planOutput?.tasks.find((candidate) => candidate.id === diagnosis.taskId)
      : undefined;
    const result = diagnosis.taskId
      ? [...state.workResults].reverse().find((candidate) => candidate.taskId === diagnosis.taskId)
      : undefined;
    const changedFiles = result?.filesChanged ?? [];
    const verification = result?.verification;
    const lines = [
      `# Recovery Report${diagnosis.taskId ? ` — ${diagnosis.taskId}` : ""}`,
      "",
      `- **Generated**: ${new Date().toISOString()}`,
      `- **Phase**: ${state.phase}`,
      `- **Failure kind**: ${diagnosis.failureKind || "RESUME"}`,
      `- **Auto-safe**: ${diagnosis.autoSafe ? "yes" : "no"}`,
      "",
      "## Diagnosis",
      diagnosis.evidence.length > 0
        ? diagnosis.evidence.map((item) => `- ${item}`).join("\n")
        : "- No specific failure evidence recorded.",
      "",
      "## Recommended Next Move",
      diagnosis.recommendation,
      "",
    ];

    if (task) {
      lines.push(
        "## Task Context",
        `- **Description**: ${task.description}`,
        `- **Category**: ${task.category}`,
        `- **Acceptance criteria**: ${task.acceptanceCriteria}`,
        `- **Expected files**: ${task.files?.length ? task.files.join(", ") : "none declared"}`,
        ""
      );
    }

    if (result) {
      lines.push(
        "## Latest Task Result",
        `- **Status**: ${result.status}`,
        `- **Attempts**: ${result.attemptCount ?? "unknown"}`,
        `- **Summary**: ${result.summary}`,
        `- **Changed files**: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`,
        ""
      );
    }

    if (verification) {
      lines.push(
        "## Verification",
        `- **Changed files detected**: ${verification.changedFilesDetected ? "yes" : "no"}`,
        `- **Expected files satisfied**: ${
          verification.expectedFilesSatisfied === undefined
            ? "not applicable"
            : verification.expectedFilesSatisfied
              ? "yes"
              : "no"
        }`,
        `- **Matched expected files**: ${
          verification.matchedExpectedFiles.length > 0
            ? verification.matchedExpectedFiles.join(", ")
            : "none"
        }`,
        ...(verification.notes.length > 0 ? ["", ...verification.notes.map((note) => `- ${note}`)] : []),
        ""
      );
    }

    lines.push(
      "## Operator Notes",
      diagnosis.autoSafe
        ? "- Morph can safely attempt the recommended recovery automatically."
        : "- Morph should not pretend this is routine. Human judgment or upstream repair is recommended before continuing.",
      "",
      renderSkillProfiles(["debugging-and-error-recovery"]),
      ""
    );

    return lines.join("\n");
  }

  function persistRecoveryReport(
    bb: Blackboard,
    state: ReturnType<Blackboard["getState"]>,
    diagnosis: ReturnType<typeof diagnoseRecoveryState>
  ): string | undefined {
    if (!diagnosis.taskId) return undefined;
    return bb.writeRecoveryReport(diagnosis.taskId, buildRecoveryReport(state, diagnosis));
  }

  function shouldAutoRecoverWithinWork(
    state: ReturnType<Blackboard["getState"]>,
    diagnosis: ReturnType<typeof diagnoseRecoveryState>
  ): boolean {
    const historicalRetries = diagnosis.taskId ? state.retries[diagnosis.taskId] || 0 : 0;
    return (
      state.phase === "work" &&
      Boolean(diagnosis.taskId) &&
      diagnosis.autoSafe &&
      historicalRetries < 6 &&
      ["NO_EFFECT", "TOOL_FAILURE", "REVIEW_REJECTED", "REVIEW_FORMAT_INVALID", "VERIFICATION_FAILED", "STATE_INCONSISTENT"]
        .includes(diagnosis.failureKind || "")
    );
  }

  function clearAutoRecoverableTaskResult(
    bb: Blackboard,
    diagnosis: ReturnType<typeof diagnoseRecoveryState>
  ): void {
    if (!diagnosis.taskId) return;
    const state = bb.getState();
    const taskIdsToClear = new Set<string>([diagnosis.taskId]);
    const tasks = state.planOutput?.tasks ?? [];
    let changed = true;

    // Any descendant that was only blocked because of the failed root must be
    // reconsidered after the root is retried. Leaving those stale blocked
    // results in place makes the DAG appear permanently processed even after
    // the dependency is healthy again.
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (taskIdsToClear.has(task.id)) continue;
        const result = state.workResults.find((candidate) => candidate.taskId === task.id);
        const dependsOnClearedTask = task.dependsOn.some((dependencyId) => taskIdsToClear.has(dependencyId));
        if (dependsOnClearedTask && result?.status === "blocked") {
          taskIdsToClear.add(task.id);
          changed = true;
        }
      }
    }

    bb.clearWorkResults([...taskIdsToClear]);
  }

  function deletePipelineState(cwd: string): void {
    currentAbortController?.abort();
    currentAbortController = null;
    blackboard = null;
    blackboardCwd = null;
    activeFileActivities.clear();
    recentFileActivities.length = 0;
    fs.rmSync(getMorphDir(cwd), { recursive: true, force: true });
  }

  function ensureDefaultModelConfig(ctx: any): void {
    const bb = bindWorkspace(ctx.cwd);
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

  function ensureWebServer(): void {
    if (!webServer) {
      webServer = startMorphServer(getBB(), 4040);
    }
  }

  function createBrowserDecisionWaiter(phase: string): {
    promise: Promise<"approve" | "reject">;
    dispose: () => void;
  } {
    let dispose = () => {};
    const promise = new Promise<"approve" | "reject">((resolve) => {
      dispose = () => {
        serverEvents.removeListener("approve", onApprove);
        serverEvents.removeListener("reject", onReject);
      };
      const onApprove = (p: string) => {
        if (p === phase) {
          dispose();
          resolve("approve");
        }
      };
      const onReject = (p: string) => {
        if (p === phase) {
          dispose();
          resolve("reject");
        }
      };
      serverEvents.on("approve", onApprove);
      serverEvents.on("reject", onReject);
    });
    return { promise, dispose };
  }

  function writeFinalReportArtifacts(ctx: any): { markdownPath: string; htmlPath: string } {
    const morphDir = getMorphDir(ctx.cwd);
    fs.mkdirSync(morphDir, { recursive: true });
    const state = bindWorkspace(ctx.cwd).getState();
    const markdown = buildFinalReportMarkdown(state, ctx.cwd);
    const html = buildFinalReportHtml(state, markdown, ctx.cwd);
    const markdownPath = path.join(morphDir, "final-report.md");
    const htmlPath = path.join(morphDir, "final-report.html");
    fs.writeFileSync(markdownPath, markdown, "utf-8");
    fs.writeFileSync(htmlPath, html, "utf-8");
    return { markdownPath, htmlPath };
  }



  async function reviewWorkSpecGate(ctx: any, planOutput: PlanOutput): Promise<boolean> {
    const bb = bindWorkspace(ctx.cwd);
    const morphDir = getMorphDir(ctx.cwd);
    fs.mkdirSync(morphDir, { recursive: true });

    const sparkOutput = bb.getState().sparkOutput;
    const draftMarkdown = buildWorkSpecMarkdown(planOutput, sparkOutput);
    const markdownPath = path.join(morphDir, "work-spec.md");
    const htmlPath = path.join(morphDir, "work-approval.html");

    const previousStatus = currentStatus;
    const previousHint = currentHint;
    currentStatus = "waiting";
    currentHint = "approve work spec  |  browser or Pi";
    updateWidget(ctx);

    const edited = await ctx.ui.editor("Review/edit WORK specification before implementation", draftMarkdown);
    if (edited === undefined) {
      ctx.ui.notify("WORK paused. Re-run /morph:run or /morph:work when ready.", "info");
      setCurrentStatus("ready");
      currentHint = "work paused  |  /morph:run";
      updateWidget(ctx);
      return false;
    }

    fs.writeFileSync(markdownPath, edited, "utf-8");
    planOutput.humanReviewNotes = edited;
    bb.setPlanOutput(planOutput);
    fs.writeFileSync(htmlPath, buildWorkSpecHtml(planOutput, edited, sparkOutput), "utf-8");
    ensureWebServer();
    openFileInBrowser(htmlPath);

    pi.sendMessage({ customType: "morph", content: `# Pre-Work Specification Review

Opened \`${htmlPath}\` for the final visual approval gate. Approve there or from the pi prompt to begin WORK.`, display: true, details: { phase: "pre-work", htmlPath, markdownPath } });

    const browserDecision = createBrowserDecisionWaiter("pre-work");
    const decision = await Promise.race([
      browserDecision.promise,
      ctx.ui.confirm(
        "Approve WORK specification?",
        "The final approval report is open in your browser. Continue with implementation?"
      ).then((approved: boolean) => approved ? "approve" as const : "reject" as const),
    ]);
    browserDecision.dispose();

    currentStatus = previousStatus;
    currentHint = previousHint;
    updateWidget(ctx);

    if (decision === "reject") {
      ctx.ui.notify("WORK paused before implementation. Re-run /morph:run or /morph:work when ready.", "info");
      return false;
    }

    bb.recordDecision("plan", "Human approved pre-work specification", `Approval artifact: ${htmlPath}`);
    ctx.ui.notify("Pre-work specification approved. Starting WORK...", "success" as any);
    return true;
  }

  // ── Build display state from blackboard ──
  function buildPipelineDisplay(taskOverride?: TaskDisplay[]): PipelineDisplay {
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

    const liveSubs = [...subagentActivities.values()].filter(
      (activity) => activity.status === "running" || activity.status === "idle"
    );

    const hasLiveAgent = liveSubs.length > 0 || state.activeAgents.length > 0;
    const visibleTasks: TaskDisplay[] = (taskOverride ?? tasks).map((task) =>
      !hasLiveAgent && task.status === "running"
        ? { ...task, status: "pending" as const }
        : task
    );

    const visibleActiveFiles = hasLiveAgent
      ? [...activeFileActivities.values()]
      : [...activeFileActivities.values()].map((activity) => ({ ...activity, status: "done" as const }));
    const fileActivities = [...visibleActiveFiles, ...recentFileActivities].slice(0, 6);
    const fileCollisions = buildFileCollisions([...activeFileActivities.values()]);

    return {
      phase: state.phase,
      status: currentStatus,
      tasks: visibleTasks,
      agents,
      tokenLedger: state.tokenLedger,
      tick: currentTick,
      subagentActivities: liveSubs.length > 0 ? liveSubs : undefined,
      fileActivities,
      fileCollisions,
      phaseContext: buildPhaseContext(state, visibleTasks, liveSubs),
      footerHint: currentHint,
      restoredCheckpointCount: Object.keys(state.flowCheckpoints[state.phase] || {}).length,
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

  function clearSubagentActivity(name: string): void {
    subagentActivities.delete(name);
  }

  function pushRecentFileActivity(activity: FileActivity): void {
    recentFileActivities.unshift(activity);
    recentFileActivities.splice(5);
  }

  function setTaskFileActivities(taskId: string, activities: FileActivity[]): void {
    for (const key of [...activeFileActivities.keys()]) {
      if (key.startsWith(`${taskId}:`)) activeFileActivities.delete(key);
    }
    for (const activity of activities) {
      activeFileActivities.set(`${taskId}:${activity.path}`, activity);
    }
  }

  function completeTaskFileActivities(taskId: string): void {
    for (const [key, activity] of [...activeFileActivities.entries()]) {
      if (!key.startsWith(`${taskId}:`)) continue;
      activeFileActivities.delete(key);
      pushRecentFileActivity({ ...activity, status: "done" });
    }
  }

  function buildFileCollisions(activities: FileActivity[]): FileCollision[] {
    const taskIdsByPath = new Map<string, Set<string>>();
    for (const activity of activities) {
      if (activity.status !== "active") continue;
      const taskIds = taskIdsByPath.get(activity.path) ?? new Set<string>();
      taskIds.add(activity.taskId);
      taskIdsByPath.set(activity.path, taskIds);
    }

    return [...taskIdsByPath.entries()]
      .filter(([, taskIds]) => taskIds.size > 1)
      .map(([path, taskIds]) => ({
        path,
        taskIds: [...taskIds].sort(),
        unexpectedTaskIds: [...taskIds]
          .filter((taskId) => !isExpectedTaskFile(taskId, path))
          .sort(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  function isExpectedTaskFile(taskId: string, filePath: string): boolean {
    const task = getBB().getState().planOutput?.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;
    return (task.files ?? []).some((pattern) => matchesTaskFilePattern(filePath, pattern));
  }

  function matchesTaskFilePattern(filePath: string, pattern: string): boolean {
    const normalizedFile = filePath.replace(/\\/g, "/");
    const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalizedPattern.endsWith("/**")) {
      const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
      return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
    }
    return normalizedFile === normalizedPattern;
  }

  function buildPhaseContext(
    state: ReturnType<Blackboard["getState"]>,
    tasks: TaskDisplay[],
    liveSubs: SubagentActivity[]
  ): PhaseContext | undefined {
    const activeAgents = liveSubs.length;
    const liveNames = new Set(liveSubs.map((agent) => agent.name));
    const checkpoints = state.flowCheckpoints[state.phase] || {};
    const checkpointKeys = new Set(Object.keys(checkpoints));
    const restoredMark = "↺";
    const agentCheckpointKey: Record<string, string> = {
      visionary: state.phase === "spark" ? "visionary" : "",
      critic: state.phase === "spark" ? "critic" : "",
      architect: state.phase === "plan" ? "architect" : "",
      "qa-expert": state.phase === "plan" ? "qa" : "",
      "efficiency-mgr": state.phase === "plan" ? "efficiency" : "",
      "qa-auditor": state.phase === "review" ? "qa" : "",
      "perf-guru": state.phase === "review" ? "perf" : "",
      "end-user": state.phase === "review" ? "user" : "",
      "tech-lead": state.phase === "review" ? "techLead" : "",
      "devops-sre": state.phase === "ship" ? "devops" : "",
      "release-consultant": state.phase === "ship" ? "consultant" : "",
    };
    const agentMark = (name: string) => {
      const checkpoint = agentCheckpointKey[name];
      if (checkpoint && checkpointKeys.has(checkpoint)) return restoredMark;
      return liveNames.has(name) ? "●" : "○";
    };
    const compactTask = (task: TaskDisplay) =>
      `${task.status === "done" ? "✓" : task.status === "running" ? "●" : task.status === "failed" || task.status === "blocked" ? "!" : "○"} ${task.id}`;
    const runningTasks = tasks.filter((task) => task.status === "running");
    const pendingTasks = tasks.filter((task) => task.status === "pending");
    const doneTasks = tasks.filter((task) => task.status === "done");
    const blockedTasks = tasks.filter((task) => task.status === "blocked" || task.status === "failed");

    switch (state.phase) {
      case "spark":
        return { title: "SPARK BOARD", lines: [
          `Visionary ${agentMark("visionary")}  ->  Critic ${agentMark("critic")}`,
          checkpointKeys.size > 0 ? `restored ${[...checkpointKeys].join(", ")}` : "restored —",
          state.sparkOutput ? `features ${state.sparkOutput.coreFeatures.length}  ·  risks ${state.sparkOutput.risks.length}` : "shaping PRD  ·  pressure-testing idea",
          state.sparkOutput?.technicalStackRecommendation ? `stack -> ${state.sparkOutput.technicalStackRecommendation}` : "next -> synthesize final PRD",
        ]};
      case "plan":
        return buildPlanIntelligenceContext(state);
      case "work": {
        const workIsBusy = currentStatus === "busy";
        const shownRunning = runningTasks.slice(0, 3).map(compactTask).join("   ");
        const shownPending = pendingTasks.slice(0, 3).map(compactTask).join("   ");
        const compactQueue = tasks.slice(0, 5).map((task) =>
          task.status === "done" ? "✓" : task.status === "running" ? "●" : task.status === "failed" || task.status === "blocked" ? "!" : "○"
        ).join(" ");
        const lastFailure = [...state.workResults].reverse().find((result) => result.status !== "done");
        const halted = blockedTasks.length > 0 && runningTasks.length === 0;
        if (halted) {
          return { title: "WORK HALTED", lines: [
            `done ${doneTasks.length}/${tasks.length}  ·  blocked ${blockedTasks.length}`,
            lastFailure ? `task ${lastFailure.taskId} ${lastFailure.status}` : "task failure recorded",
            lastFailure ? `files ${lastFailure.filesChanged.length} changed` : "files —",
            lastFailure ? lastFailure.summary.replace(/\s+/g, " ").slice(0, 72) : "inspect task history",
            "next -> recover or inspect status",
          ]};
        }
        if (!workIsBusy && runningTasks.length === 0 && pendingTasks.length > 0 && activeAgents === 0) {
          return { title: "WORK CONTROL", lines: [
            `done ${doneTasks.length}/${tasks.length}  ·  blocked ${blockedTasks.length}`,
            compactQueue ? `queue  ${compactQueue}` : "queue  —",
            shownPending ? `next   ${shownPending}` : "next   work pending",
            "lanes  no active agent",
            "next -> resume or recover",
          ]};
        }
        return { title: "WORK CONTROL", lines: [
          `done ${doneTasks.length}/${tasks.length}  ·  blocked ${blockedTasks.length}`,
          compactQueue ? `queue  ${compactQueue}` : "queue  —",
          shownRunning ? `doing  ${shownRunning}` : "doing  —",
          shownPending ? `next   ${shownPending}` : "next   review gate",
          activeAgents > 0 ? `lanes  engineer ${agentMark("engineer")}  ->  reviewer ${agentMark("peer-reviewer")}` : "next -> review when queue clears",
        ]};
      }
      case "review": {
        const review = state.reviewOutput;
        const severities = { critical: 0, major: 0, minor: 0, "nice-to-have": 0 };
        for (const change of review?.requiredChanges ?? []) severities[change.severity]++;
        return { title: "REVIEW BOARD", lines: [
          `QA       ${agentMark("qa-auditor")}────┐`,
          `PERF     ${agentMark("perf-guru")}────┼──> LEAD ${agentMark("tech-lead")}`,
          `USER     ${agentMark("end-user")}────┘`,
          checkpointKeys.size > 0 ? `RESTORED ${[...checkpointKeys].join(", ")}` : "RESTORED —",
          review ? `VERDICT  ${review.status}  ·  score ${review.efficiencyScore}/10` : "VERDICT  waiting on synthesis",
          review ? `FINDINGS ${severities.critical} critical  ${severities.major} major  ${severities.minor} minor` : `NEXT     ${activeAgents > 0 ? "auditors active" : "awaiting auditors"}`,
        ]};
      }
      case "ship":
        return { title: "SHIP BOARD", lines: [
          `DevOps ${agentMark("devops-sre")}  ->  Release ${agentMark("release-consultant")}`,
          checkpointKeys.size > 0 ? `restored ${[...checkpointKeys].join(", ")}` : "restored —",
          state.shipOutput ? `${state.shipOutput.status}  ·  v${state.shipOutput.version}` : "preparing release package",
          state.reviewOutput ? `review -> ${state.reviewOutput.status}` : "review -> pending",
        ]};
      default:
        return undefined;
    }
  }

  function buildPlanIntelligenceContext(
    state: ReturnType<Blackboard["getState"]>
  ): PhaseContext {
    const telemetry = state.planTelemetry;
    const shape = state.sparkOutput?.productShape;
    const target = shape
      ? `${shape.deliverableType} · ${shape.runtime} · ${shape.distribution}`
      : "product shape not captured";
    const lines = [`Target       ${target}`];

    if (telemetry?.architect.tasksDrafted || telemetry?.architect.componentsMapped) {
      const parts = [
        telemetry.architect.tasksDrafted !== undefined
          ? `${telemetry.architect.tasksDrafted} tasks drafted`
          : undefined,
        telemetry.architect.componentsMapped !== undefined
          ? `${telemetry.architect.componentsMapped} components mapped`
          : undefined,
      ].filter(Boolean);
      lines.push(`Architect    ${parts.join(" · ")}`);
    } else {
      lines.push("Architect    drafting architecture");
    }

    lines.push(
      telemetry?.qa.issuesFound !== undefined
        ? `QA           ${telemetry.qa.issuesFound} review signals${telemetry.qa.notableGap ? ` · ${telemetry.qa.notableGap}` : ""}`
        : "QA           waiting for task graph"
    );
    lines.push(
      telemetry?.efficiency.observationsFound !== undefined
        ? `Efficiency   ${telemetry.efficiency.observationsFound} optimization signals${telemetry.efficiency.notableChange ? ` · ${telemetry.efficiency.notableChange}` : ""}`
        : "Efficiency   waiting for task graph"
    );

    if (telemetry?.recovery) {
      lines.push(`Recovery     ${telemetry.recovery.issue}`);
      lines.push(`Next         ${telemetry.recovery.action}`);
    } else if (telemetry?.finalPlan.tasks !== undefined) {
      lines.push(
        `Final plan   ${telemetry.finalPlan.tasks} tasks · ${telemetry.finalPlan.waves ?? "?"} waves · ${telemetry.finalPlan.estimatedEffort ?? "effort ?"}`
      );
      if (telemetry.watchlist.length) {
        lines.push(`Watchlist    ${telemetry.watchlist[0]}`);
      }
      if (telemetry.fileOverlaps.length) {
        const first = telemetry.fileOverlaps[0];
        lines.push(`Overlap      ${first.severity.toUpperCase()} ${first.taskIds.join(" + ")} -> ${first.file}`);
      }
      if (telemetry.fileOverlapRepairs.length) {
        const firstRepair = telemetry.fileOverlapRepairs[0];
        lines.push(`Serialized   ${firstRepair.serializedTaskIds.join(" -> ")} -> ${firstRepair.file}`);
      }
      lines.push(`Next         ${telemetry.nextStep}`);
    } else {
      lines.push(`Next         ${telemetry?.nextStep ?? "draft first plan"}`);
    }

    return { title: "PLAN INTELLIGENCE", lines };
  }

  function updateSubagentEvent(agentName: string, role: string, taskId: string, event: any): void {
    let entry = subagentActivities.get(agentName);
    if (!entry) {
      entry = { name: agentName, role, taskId, status: "running", currentTool: "", lastAction: "", turns: 0, toolDetail: "", lastEventAt: Date.now() };
      subagentActivities.set(agentName, entry);
    }
    entry.taskId = taskId;
    entry.status = "running";
    entry.lastEventAt = Date.now();
    switch (event.type) {
      case "message_start":
        entry.currentTool = "";
        entry.lastAction = "responding...";
        break;
      case "text":
        if (event.text?.trim()) entry.lastAction = event.text.trim();
        break;
      case "tool_use": {
        entry.currentTool = String(event.name || "").toLowerCase();
        const args = event.input || event.args || {};
        entry.toolDetail = typeof args === "object" ? args.path || args.filePath || args.file_path || args.command || args.pattern || args.query || "" : String(args).slice(0, 40);
        break;
      }
      case "tool_result":
      case "tool_result_end": {
        if (event.content?.[0]?.text) entry.lastAction = event.content[0].text.slice(0, 60).replace(/\n/g, " ");
        break;
      }
      case "message_end":
        entry.turns++;
        entry.currentTool = "";
        entry.lastAction = `turn ${entry.turns} complete`;
        break;
    }
  }

  // ── Update the phase widget with colored pipeline progress ──
  function updateWidget(ctx: {
    ui: {
      setWidget: (id: string, lines: string[] | ((tui: any, theme: any) => { render: (w: number) => string[]; invalidate: () => void }), opts?: any) => void;
    };
  }) {
    setPipelineWidget(ctx as any, () => buildPipelineDisplay());
  }

  function setPipelineWidget(
    ctx: {
      ui: {
        setWidget: (id: string, lines: string[] | ((tui: any, theme: any) => { render: (w: number) => string[]; invalidate: () => void }), opts?: any) => void;
      };
    },
    getDisplay: () => PipelineDisplay
  ) {
    ctx.ui.setWidget(
      "morph",
      (tui: any, theme: any) => {
        requestAnimationRender = () => tui.requestRender();
        return buildPipelineProgressWidget(getDisplay, theme);
      },
      { placement: "aboveEditor" }
    );
  }

  // ── Session lifecycle ──
  pi.on("session_start", async (_event, ctx) => {
    const bb = bindWorkspace(ctx.cwd);
    let state = bb.getState();

    if (state.activeAgents.length > 0) {
      bb.clearActiveAgents();
      state = bb.getState();
    }

    // Default to the parent session's active model if no morph config is set.
    ensureDefaultModelConfig(ctx as any);

    let recovery = summarizeRecoveryState(state);
    const archivedRecovery =
      recovery.kind === "stale" || state.phase === "idle"
        ? bb.getRecoverableArchives()[0]
        : undefined;

    if (archivedRecovery) {
      const archived = summarizeRecoveryState(archivedRecovery.state);
      const restoreArchive = await ctx.ui.confirm(
        "Restore archived morph flow?",
        `The active state is empty, but Morph found a newer recoverable ${archivedRecovery.state.phase.toUpperCase()} snapshot from ${archivedRecovery.modifiedAt.toLocaleString()} with ${archived.totalTasks > 0 ? `${archived.doneTasks}/${archived.totalTasks} tasks done` : "saved progress"}. Restore it now?`
      );
      if (restoreArchive) {
        bb.restoreArchivedState(archivedRecovery);
        state = bb.getState();
        recovery = summarizeRecoveryState(state);
        ctx.ui.notify(`Restored archived ${state.phase} flow from history.`, "info");
      }
    }

    if (recovery.kind === "stale") {
      bb.transition("idle");
      state = bb.getState();
      recovery = summarizeRecoveryState(state);
      ctx.ui.notify("morph cleared an empty stale flow marker in this folder. Ready for a new run.", "info");
    } else if (recovery.kind === "recoverable") {
      ctx.ui.notify(
        `${recovery.message} — /morph:recover to resume`,
        recovery.failedTasks > 0 || recovery.blockedTasks > 0 ? "warning" : "info"
      );
      pi.sendMessage({
        customType: "morph",
        content: [
          "# Recovery detected",
          "",
          `Morph found an unfinished flow in this folder.`,
          "",
          `- **Phase**: ${state.phase}`,
          `- **Tasks**: ${recovery.totalTasks > 0 ? `${recovery.doneTasks}/${recovery.totalTasks} done` : "not planned yet"}`,
          `- **Failed**: ${recovery.failedTasks}`,
          `- **Blocked**: ${recovery.blockedTasks}`,
          `- **Checkpoints**: ${recovery.checkpointCount}`,
          "",
          recovery.checkpointCount > 0
            ? "**Next**: choose Resume now to continue from the last safe checkpoint, or decline to inspect first."
            : "**Next**: choose Resume now to continue from the current phase, or decline to inspect first.",
        ].join("\n"),
        display: true,
        details: { phase: "recovery-detected" },
      });
    } else if (recovery.kind === "restartable") {
      ctx.ui.notify(`${recovery.message} — /morph:run to continue`, "info");
      pi.sendMessage({
        customType: "morph",
        content: [
          "# Unfinished setup found",
          "",
          `Morph found an unfinished ${state.phase.toUpperCase()} setup in this folder, but no saved checkpoint yet.`,
          "",
          `- **Phase**: ${state.phase}`,
          `- **Checkpoints**: ${recovery.checkpointCount}`,
          "",
          "**Next**: choose Continue now to restart the current phase from saved context, or decline to inspect first.",
        ].join("\n"),
        display: true,
        details: { phase: "restartable-detected" },
      });
    } else if (state.phase === "done") {
      ctx.ui.notify("morph — completed flow found in this folder. /morph:status for details or /morph:reset to start over.", "info");
    } else {
      ctx.ui.notify("morph — Type /morph:run <idea> to start your project", "info");
    }

    // Start animation loop
    if (!animationInterval) {
      animationInterval = setInterval(() => {
        currentTick++;
        requestAnimationRender?.();
      }, 100);
    }

    // Show persistent widget and status bar
    updateWidget(ctx as any);
    ctx.ui.setStatus(
      "morph",
      recovery.kind === "recoverable"
        ? `morph: RECOVERY ${state.phase.toUpperCase()} -- /morph:recover`
        : recovery.kind === "restartable"
          ? `morph: CONTINUE ${state.phase.toUpperCase()} -- /morph:run`
        : state.phase === "done"
          ? "morph: DONE -- /morph:status"
        : "morph: READY -- Type /morph:run <idea>"
    );

    if (recovery.kind === "recoverable") {
      const resumeNow = await ctx.ui.confirm(
        "Resume unfinished morph flow?",
        recovery.checkpointCount > 0
          ? `${state.phase.toUpperCase()} has ${recovery.checkpointCount} saved checkpoint${recovery.checkpointCount === 1 ? "" : "s"}. Resume from the last safe point now?`
          : `${state.phase.toUpperCase()} is unfinished. Continue from the current phase now?`
      );
      if (resumeNow) {
        ctx.ui.notify("Resuming unfinished morph flow...", "info");
        await runMorphPipeline("", ctx as any);
      } else {
        ctx.ui.notify("Recovery paused. Use /morph:recover when you are ready.", "info");
      }
    } else if (recovery.kind === "restartable") {
      const continueNow = await ctx.ui.confirm(
        "Continue unfinished morph setup?",
        `${state.phase.toUpperCase()} has saved context but no checkpoint yet. Restart the current phase now?`
      );
      if (continueNow) {
        ctx.ui.notify("Continuing unfinished morph setup...", "info");
        await runMorphPipeline("", ctx as any);
      } else {
        ctx.ui.notify("Continuation paused. Use /morph:run when you are ready.", "info");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = null;
    requestAnimationRender = null;
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
      const bb = bindWorkspace(ctx.cwd);
      const state = bb.getState();

      if (!state.sparkOutput) {
        ctx.ui.notify("No spark output. Run /morph:run <idea> first.", "error");
        return;
      }

      bb.transition("plan");
      setCurrentStatus("busy");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:plan Architect designing...");
      ctx.ui.notify("Plan: Architect + QA + Efficiency Manager working...", "info");

      try {
        currentAbortController = new AbortController();

        // Stage 1: Architect
        ctx.ui.setStatus("morph", "morph:plan Architect -> architecture + tasks");
        updateWidget(ctx as any);

        // Stage 2: QA + Efficiency (parallel) — status updates
        ctx.ui.setStatus("morph", "morph:plan QA + Efficiency reviewing...");

        const planOutput = await executePlanFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();

        // Done
        const waves = waveGroups(planOutput.tasks);
        const dagText = formatDAG(planOutput.tasks);
        const estTokens = estimatePhaseTokens(planOutput.tasks);

        setCurrentStatus("ready");
        ctx.ui.setStatus(
          "morph",
          `morph:work (ready) [DONE] ${planOutput.tasks.length} tasks, ${waves.length} waves`
        );
        updateWidget(ctx as any);

        const summary = [
          `# Plan Complete`,
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
          `State -> \`.morph/state.json\`  •  Next -> /morph:work`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "plan" } });
          ctx.ui.notify(
            `Plan done! ${planOutput.tasks.length} tasks in ${waves.length} waves. /morph:work to implement.`,
            "success" as any
          );
      } catch (err: any) {
        setCurrentStatus("ready");
        ctx.ui.setStatus("morph", `morph:plan FAILED ${err.message.slice(0, 40)}`);
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
      const bb = bindWorkspace(ctx.cwd);
      const state = bb.getState();

      if (!state.planOutput) {
        ctx.ui.notify("No plan output. Run /morph:plan first.", "error");
        return;
      }

      const specApproved = await reviewWorkSpecGate(ctx, state.planOutput);
      if (!specApproved) return;

      // ── Fix 5: Protect untracked files from git stash checkpoints ──
      try {
        const { execSync } = require("node:child_process");
        execSync(`git add -A`, { cwd: ctx.cwd, timeout: 10000, stdio: "pipe" });
        const status = execSync(`git status --porcelain`, {
          cwd: ctx.cwd,
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (status) {
          execSync(`git stash push -m "morph: pre-work checkpoint" --include-untracked`, {
            cwd: ctx.cwd, timeout: 10000, stdio: "pipe"
          });
        }
      } catch {
        // git unavailable — skip
      }

      bb.transition("work");
      setCurrentStatus("busy");
      const display = buildPipelineDisplay();
      ctx.ui.setStatus("morph", buildStatusBar(display));
      setPipelineWidget(ctx as any, () => buildPipelineDisplay());
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
        const plannedWaves = waveGroups(state.planOutput.tasks);
        const originalWaveByTaskId = new Map<string, number>();
        plannedWaves.forEach((wave, index) => wave.forEach((task) => originalWaveByTaskId.set(task.id, index + 1)));

        const results = await executeWorkFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          maxParallel: 3,
          signal: currentAbortController.signal,

          onWaveStart: async (wave, waveIndex) => {
            // Update widget: mark wave tasks as "running"
            for (const t of wave) liveTasks.set(t.id, { ...liveTasks.get(t.id)!, status: "running" });
            setPipelineWidget(ctx as any, () => buildPipelineDisplay([...liveTasks.values()]));
            const originalWaveNumber = Math.min(
              ...wave.map((task) => originalWaveByTaskId.get(task.id) ?? waveIndex + 1)
            );
            ctx.ui.notify(
              `Work wave ${originalWaveNumber}/${plannedWaves.length}: executing ${wave.length} approved task${wave.length === 1 ? "" : "s"} automatically.`,
              "info"
            );
            return true;
          },

          onTaskComplete: (result) => {
            // Update live task status
            liveTasks.set(result.taskId, {
              ...liveTasks.get(result.taskId)!,
              status: result.status === "done" ? "done" : result.status === "blocked" ? "blocked" : "failed",
            });

            // Refresh widget
            setPipelineWidget(ctx as any, () => buildPipelineDisplay([...liveTasks.values()]));

            // Update status bar
            const done = [...liveTasks.values()].filter((t) => t.status === "done").length;
            const total = liveTasks.size;
            ctx.ui.setStatus("morph", `morph:work ${done}/${total} tasks running...`);

            // Per-task notification
            const icon = result.status === "done" ? "[DONE]" : result.status === "blocked" ? "[BLOCKED]" : "[FAILED]";
            ctx.ui.notify(
              `${icon} [${result.taskId}] ${result.summary.slice(0, 80)}`,
              result.status === "done" ? "info" : "warning"
            );
            completeTaskFileActivities(result.taskId);
            clearSubagentActivity("engineer");
            clearSubagentActivity("peer-reviewer");
          },
          onTaskActivity: (taskId, activities) => {
            setTaskFileActivities(
              taskId,
              activities.map((activity) => ({ ...activity, status: "active" }))
            );
            requestAnimationRender?.();
          },
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();
        const latestWorkState = bb.getState();

        // Summarize outcome. Incomplete work remains in WORK; only a fully
        // successful DAG is allowed to advance to REVIEW.
        const done = results.filter((r) => r.status === "done").length;
        const failed = results.filter((r) => r.status === "failed").length;
        const blocked = results.filter((r) => r.status === "blocked").length;
        const incomplete = done !== latestWorkState.planOutput!.tasks.length || failed > 0 || blocked > 0;
        const failedResults = results.filter((result) => result.status !== "done");

        setCurrentStatus("ready");
        ctx.ui.setStatus(
          "morph",
          incomplete
            ? `morph:work HALTED ${done}/${results.length} done`
            : `morph:review (ready) [DONE] ${done}/${results.length} done`
        );
        setPipelineWidget(ctx as any, () => buildPipelineDisplay());

        const progressText = formatProgress(results, latestWorkState.planOutput!.tasks);
        if (incomplete) {
          const diagnosis = diagnoseRecoveryState(latestWorkState);
          persistRecoveryReport(bb, latestWorkState, diagnosis);
          if (shouldAutoRecoverWithinWork(latestWorkState, diagnosis)) {
            clearAutoRecoverableTaskResult(bb, diagnosis);
            ctx.ui.notify(
              `Auto-recovering ${diagnosis.taskId}: ${diagnosis.failureKind}. ${diagnosis.recommendation}`,
              "info"
            );
            setCurrentStatus("busy");
            return await (async () => {
              await runMorphPipeline("", ctx as any);
            })();
          }
        }
        const summary = [
          incomplete ? `# Work Halted` : `# Work Complete`,
          ``,
          `**${done} done**${failed > 0 ? `  •  ${failed} failed` : ""}${blocked > 0 ? `  •  ${blocked} blocked` : ""}`,
          ``,
          progressText,
          ``,
          ...(incomplete
            ? [
                `## Failure details`,
                ...failedResults.map((result) =>
                  `- **${result.taskId}** — ${result.summary}${result.filesChanged.length === 0 ? " (no files changed)" : ` (${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"} changed)`}`
                ),
                ``,
              ]
            : []),
          incomplete
            ? `**Next**: inspect the failed task, then use \`/morph:recover\` or \`/morph:run\` after fixing the cause.`
            : `State -> \`.morph/state.json\`  •  Next -> /morph:review`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "work" } });
        ctx.ui.notify(
          incomplete
            ? `Work halted: ${done}/${results.length} tasks complete. Review is blocked until work succeeds.`
            : `Work done! ${done}/${results.length} tasks. /morph:review to audit.`,
          (incomplete ? "warning" : "success") as any
        );
        } catch (err: any) {
          subagentActivities.clear();
          activeFileActivities.clear();
          bb.clearActiveAgents();
          setCurrentStatus("ready");
          ctx.ui.setStatus("morph", `morph:work FAILED ${err.message.slice(0, 40)}`);
          updateWidget(ctx as any);
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
      const bb = bindWorkspace(ctx.cwd);
      const state = bb.getState();

      if (!state.planOutput) {
        ctx.ui.notify("No plan output. Run /morph:run <idea> and /morph:plan first.", "error");
        return;
      }

      const allowPartialReview = /\b--partial\b/.test(args || "");
      const doneTaskIds = new Set(state.workResults.filter((result) => result.status === "done").map((result) => result.taskId));
      const allPlannedTasksDone = state.planOutput.tasks.every((task) => doneTaskIds.has(task.id));
      if (!allPlannedTasksDone && !allowPartialReview) {
        ctx.ui.notify(
          "Review blocked: work is incomplete. Finish WORK first, or use /morph:review --partial intentionally.",
          "warning"
        );
        return;
      }

      bb.transition("review");
      setCurrentStatus("busy");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:review 4 reviewers auditing...");
      ctx.ui.notify("Review: Tech Lead + QA Auditor + Performance Guru + End User...", "info");

      try {
        currentAbortController = new AbortController();

        // Stage updates as agents run
        ctx.ui.setStatus("morph", "morph:review QA + Perf + User reviewing...");

        const reviewOutput = await executeReviewFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
          focus: args || undefined,
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();

        ctx.ui.setStatus("morph", "morph:review Tech Lead synthesizing verdict...");

        // Done
        setCurrentStatus("ready");
        ctx.ui.setStatus(
          "morph",
          reviewOutput.status === "APPROVED"
            ? "morph:ship (ready) [DONE]"
            : `morph:work (fixes needed) [${reviewOutput.status}]`
        );
        updateWidget(ctx as any);

        const summary = [
          `# Review — ${reviewOutput.status}`,
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
            ? `State -> \`.morph/state.json\`  •  Next -> /morph:ship`
            : `State -> \`.morph/state.json\`  •  Fix issues and re-run /morph:review`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "review" } });
          ctx.ui.notify(
            reviewOutput.status === "APPROVED"
              ? "Review APPROVED! /morph:ship to release."
              : `Review: ${reviewOutput.status} — ${reviewOutput.requiredChanges.length} changes needed`,
            (reviewOutput.status === "APPROVED" ? "success" : "warning") as any
          );
      } catch (err: any) {
        setCurrentStatus("ready");
        ctx.ui.setStatus("morph", `morph:review FAILED ${err.message.slice(0, 40)}`);
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
      const bb = bindWorkspace(ctx.cwd);
      const state = bb.getState();

      if (!state.reviewOutput || state.reviewOutput.status !== "APPROVED") {
        ctx.ui.notify("Review must be APPROVED before shipping. Run /morph:review.", "error");
        return;
      }

      bb.transition("ship");
      setCurrentStatus("busy");
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", "morph:ship DevOps verifying...");
      ctx.ui.notify("Ship: DevOps + Release Consultant preparing release...", "info");

      try {
        currentAbortController = new AbortController();

        ctx.ui.setStatus("morph", "morph:ship DevOps + Consultant...");

        const shipOutput = await executeShipFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          signal: currentAbortController.signal,
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();
        const finalState = bb.getState();
        const report = writeFinalReportArtifacts(ctx);
        openFileInBrowser(report.htmlPath);

        setCurrentStatus("ready");
        ctx.ui.setStatus("morph", `morph:done [DONE] v${shipOutput.version}`);
        ctx.ui.setWidget("morph", ["[DONE] morph pipeline complete!", `   Version: ${shipOutput.version}  •  Status: ${shipOutput.status}`]);

        const costBreakdown = [
          `  Spark:  ${formatTokens(finalState.tokenLedger?.spark || 0)}`,
          `  Plan:   ${formatTokens(finalState.tokenLedger?.plan || 0)}`,
          `  Work:   ${formatTokens(finalState.tokenLedger?.work || 0)}`,
          `  Review: ${formatTokens(finalState.tokenLedger?.review || 0)}`,
          `  Ship:   ${formatTokens(finalState.tokenLedger?.ship || 0)}`,
          `  ─────────────────`,
          `  Total:  ${formatTokens(finalState.tokenLedger?.total || 0)} tokens`,
        ].join("\n");

        const summary = [
          `# Shipped — v${shipOutput.version}`,
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
          `**Final Handoff Report**:`,
          `- Markdown: \`${report.markdownPath}\``,
          `- HTML: \`${report.htmlPath}\``,
          ``,
          `Pipeline complete!`,
        ].join("\n");

        pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "ship" } });
        ctx.ui.notify(`Shipped v${shipOutput.version}! Pipeline complete.`, "success" as any);
      } catch (err: any) {
        setCurrentStatus("ready");
        ctx.ui.setStatus("morph", `morph:ship FAILED ${err.message.slice(0, 40)}`);
        ctx.ui.setWidget("morph", undefined);
        ctx.ui.notify(`Ship failed: ${err.message}`, "error");
      }
    },
  });

  // ═══════════════════════════════════════════
  // GUIDED PIPELINE
  // ═══════════════════════════════════════════

  const runMorphPipeline = async (args: string, ctx: any) => {
      const bb = bindWorkspace(ctx.cwd);
      let state = bb.getState();

      while (state.phase !== "done") {
        // ── Determine starting point ──
        if (state.phase === "idle" || state.phase === "spark") {
          const prompt = args?.trim() || state.pipelinePrompt?.trim();
          if (!prompt) {
            ctx.ui.notify("Usage: /morph:run <your idea> to start a new pipeline", "error");
            return;
          }
          if (state.phase === "idle") {
            bb.setPipelinePrompt(prompt);
            bb.transition("spark");
          } else {
            ctx.ui.notify("Restoring interrupted Spark phase from checkpoint...", "info");
          }
          setCurrentStatus("busy");
          updateWidget(ctx as any);
          ctx.ui.setStatus("morph", "morph:run Spark phase...");
          ctx.ui.notify("morph pipeline started! Beginning Spark phase...", "info");

          try {
            currentAbortController = new AbortController();
            const sparkOutput = await executeSparkFlow({
              cwd: ctx.cwd,
              prompt,
              blackboard: bb,
              signal: currentAbortController.signal,
              onAgentEvent: (agentName, role, taskId, event) => {
                updateSubagentEvent(agentName, role, taskId, event);
                requestAnimationRender?.();
              },
            });
            subagentActivities.clear();
            bb.setSparkOutput(sparkOutput);
            state = bb.getState();

            setCurrentStatus("ready");
            ctx.ui.setStatus("morph", "morph:run Spark complete");
            updateWidget(ctx as any);
            ctx.ui.notify("Spark complete! Review summary below.", "success" as any);

            // Gate: Spark → Plan
            const sparkSummary = [
              `# Spark Complete`,
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
              "Proceed to Plan phase?",
              "Review the Spark output in chat. Confirm to continue.",
              "spark"
            );
            if (!proceed) {
              ctx.ui.notify("Pipeline paused after Spark. Run /morph:run to continue.", "info");
              return;
            }
          } catch (err: any) {
            setCurrentStatus("ready");
            ctx.ui.setStatus("morph", `morph:run Spark failed: ${err.message.slice(0, 40)}`);
            ctx.ui.notify(`Spark failed: ${err.message}`, "error");
            return;
          }
        }

        // ── Plan ──
        if (state.phase === "plan") {
            setCurrentStatus("busy");
            ctx.ui.setStatus("morph", "morph:run Plan phase...");
            ctx.ui.notify("Plan: Architect + QA + Efficiency working...", "info");
            updateWidget(ctx as any);

            try {
              currentAbortController = new AbortController();
              const planOutput = await executePlanFlow({
                cwd: ctx.cwd,
                blackboard: bb,
                signal: currentAbortController.signal,
                onAgentEvent: (agentName, role, taskId, event) => {
                  updateSubagentEvent(agentName, role, taskId, event);
                  requestAnimationRender?.();
                },
              });
              subagentActivities.clear();
              bb.setPlanOutput(planOutput);
              state = bb.getState();

              const waves = waveGroups(planOutput.tasks);
              setCurrentStatus("ready");
              ctx.ui.setStatus("morph", `morph:run ${planOutput.tasks.length} tasks planned`);
              updateWidget(ctx as any);
              ctx.ui.notify("Plan complete! Review below.", "success" as any);

              // Gate: Plan → Work
              const planSummary = [
                `# Plan Complete`,
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
              setCurrentStatus("ready");
              ctx.ui.setStatus("morph", `morph:run Plan failed: ${err.message.slice(0, 40)}`);
              ctx.ui.notify(`Plan failed: ${err.message}`, "error");
              return;
            }
        }

        // ── Work ──
        if (state.phase === "work") {
          // ── Fix 5: Protect untracked files from git stash checkpoints ──
          try {
            const { execSync } = require("node:child_process");
            execSync(`git add -A`, { cwd: ctx.cwd, timeout: 10000, stdio: "pipe" });
          } catch {
            // git unavailable — skip
          }

          setCurrentStatus("busy");
          ctx.ui.setStatus("morph", "morph:run Work phase...");
          ctx.ui.notify("Work: executing task DAG...", "info");
          updateWidget(ctx as any);

          try {
            currentAbortController = new AbortController();

            const liveTasks = new Map<string, TaskDisplay>();
            for (const t of state.planOutput!.tasks) {
              const existingResult = state.workResults.find(r => r.taskId === t.id);
              liveTasks.set(t.id, { 
                id: t.id, 
                description: t.description, 
                status: existingResult 
                  ? (existingResult.status === "done" ? "done" : existingResult.status === "blocked" ? "blocked" : "failed")
                  : "pending" 
              });
            }
            const plannedWaves = waveGroups(state.planOutput!.tasks);
            const originalWaveByTaskId = new Map<string, number>();
            plannedWaves.forEach((wave, index) => wave.forEach((task) => originalWaveByTaskId.set(task.id, index + 1)));

            const results = await executeWorkFlow({
              cwd: ctx.cwd,
              blackboard: bb,
              maxParallel: 3,
              signal: currentAbortController.signal,

              onWaveStart: async (wave, waveIndex) => {
                // If all tasks in this wave are already done (from a previous loop), skip confirm
                const allDone = wave.every(t => liveTasks.get(t.id)?.status === "done");
                if (allDone) return true;

                for (const t of wave) {
                  if (liveTasks.get(t.id)?.status !== "done") {
                    liveTasks.set(t.id, { ...liveTasks.get(t.id)!, status: "running" });
                  }
                }
                setPipelineWidget(ctx as any, () => buildPipelineDisplay([...liveTasks.values()]));
                const originalWaveNumber = Math.min(
                  ...wave.map((task) => originalWaveByTaskId.get(task.id) ?? waveIndex + 1)
                );
                ctx.ui.notify(
                  `Work wave ${originalWaveNumber}/${plannedWaves.length}: executing ${wave.length} approved task${wave.length === 1 ? "" : "s"} automatically.`,
                  "info"
                );
                return true;
              },

              onTaskComplete: (result) => {
                liveTasks.set(result.taskId, {
                  ...liveTasks.get(result.taskId)!,
                  status: result.status === "done" ? "done" : result.status === "blocked" ? "blocked" : "failed",
                });
                setPipelineWidget(ctx as any, () => buildPipelineDisplay([...liveTasks.values()]));
                const done = [...liveTasks.values()].filter((t) => t.status === "done").length;
                ctx.ui.setStatus("morph", `morph:run Work: ${done}/${liveTasks.size} tasks running...`);

                const icon = result.status === "done" ? "[DONE]" : result.status === "blocked" ? "[BLOCKED]" : "[FAILED]";
                ctx.ui.notify(`${icon} [${result.taskId}] ${result.summary.slice(0, 80)}`, 
                  result.status === "done" ? "info" : "warning");
                completeTaskFileActivities(result.taskId);
                clearSubagentActivity("engineer");
                clearSubagentActivity("peer-reviewer");
              },
              onTaskActivity: (taskId, activities) => {
                setTaskFileActivities(
                  taskId,
                  activities.map((activity) => ({ ...activity, status: "active" }))
                );
                requestAnimationRender?.();
              },
              onAgentEvent: (agentName, role, taskId, event) => {
                updateSubagentEvent(agentName, role, taskId, event);
                requestAnimationRender?.();
              },
            });
            subagentActivities.clear();

            state = bb.getState();

            const done = results.filter((r) => r.status === "done").length;
            const failed = results.filter((r) => r.status === "failed").length;
            const blocked = results.filter((r) => r.status === "blocked").length;
            const incomplete = done !== state.planOutput!.tasks.length || failed > 0 || blocked > 0;
            const failedResults = results.filter((result) => result.status !== "done");
            setCurrentStatus("ready");
            ctx.ui.setStatus(
              "morph",
              incomplete
                ? `morph:run Work HALTED: ${done}/${results.length} done`
                : `morph:run Work: ${done}/${results.length} done`
            );
            updateWidget(ctx as any);
            ctx.ui.notify(
              incomplete
                ? `Work halted: ${done}/${results.length} tasks complete. Review is blocked until work succeeds.`
                : `Work complete! ${done}/${results.length} tasks done.`,
              (incomplete ? "warning" : "success") as any
            );

            const progressText = formatProgress(results, state.planOutput!.tasks);
            if (incomplete) {
              const diagnosis = diagnoseRecoveryState(state);
              persistRecoveryReport(bb, state, diagnosis);
            }
            const workSummary = [
              incomplete ? `# Work Halted` : `# Work Complete`,
              ``,  
              `**${done} done**${failed > 0 ? `  •  ${failed} failed` : ""}${blocked > 0 ? `  •  ${blocked} blocked` : ""}`,
              ``,  
              progressText,
              ``,
              ...(incomplete
                ? [
                    `## Failure details`,
                    ...failedResults.map((result) =>
                      `- **${result.taskId}** — ${result.summary}${result.filesChanged.length === 0 ? " (no files changed)" : ` (${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"} changed)`}`
                    ),
                    ``,
                  ]
                : []),
              incomplete
                ? `**Next**: inspect the failed task, then use \`/morph:recover\` or \`/morph:run\` after fixing the cause.`
                : `**Next**: Confirm to proceed to REVIEW phase.`,
            ].join("\n");

            pi.sendMessage({ customType: "morph", content: workSummary, display: true, details: { phase: "work" } });

            if (incomplete) {
              const diagnosis = diagnoseRecoveryState(state);
              persistRecoveryReport(bb, state, diagnosis);
              if (shouldAutoRecoverWithinWork(state, diagnosis)) {
                clearAutoRecoverableTaskResult(bb, diagnosis);
                state = bb.getState();
                ctx.ui.notify(
                  `Auto-recovering ${diagnosis.taskId}: ${diagnosis.failureKind}. ${diagnosis.recommendation}`,
                  "info"
                );
                continue;
              }
              return;
            }

            const proceed = await waitConfirm(
              ctx,
              "Proceed to Review phase?",
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
              subagentActivities.clear();
              activeFileActivities.clear();
              bb.clearActiveAgents();
              setCurrentStatus("ready");
              ctx.ui.setStatus("morph", `morph:run Work failed: ${err.message.slice(0, 40)}`);
              updateWidget(ctx as any);
              ctx.ui.notify(`Work failed: ${err.message}`, "error");
              return;
            }
        }

        // ── Review ──
        if (state.phase === "review") {
          setCurrentStatus("busy");
          ctx.ui.setStatus("morph", "morph:run Review phase...");
          ctx.ui.notify("Review: Tech Lead + QA + Perf + End User auditing...", "info");
          updateWidget(ctx as any);

          try {
            currentAbortController = new AbortController();
            const reviewOutput = await executeReviewFlow({
              cwd: ctx.cwd,
              blackboard: bb,
              signal: currentAbortController.signal,
              onAgentEvent: (agentName, role, taskId, event) => {
                updateSubagentEvent(agentName, role, taskId, event);
                requestAnimationRender?.();
              },
            });
            subagentActivities.clear();
            bb.setReviewOutput(reviewOutput);
            state = bb.getState();

            setCurrentStatus("ready");
            const verdictIcon = reviewOutput.status === "APPROVED" ? "[APPROVED]" : "[REJECTED]";
            ctx.ui.setStatus("morph", `morph:run Review: ${reviewOutput.status}`);
            updateWidget(ctx as any);
              ctx.ui.notify(
                `Review: ${reviewOutput.status}`,
                (reviewOutput.status === "APPROVED" ? "success" : "warning") as any
              );

            if (reviewOutput.status !== "APPROVED") {
              const taskIdsToReset = reviewOutput.requiredChanges
                .map(c => c.taskId)
                .filter((id): id is string => !!id);
              
              if (taskIdsToReset.length > 0) {
                bb.clearWorkResults(taskIdsToReset);
              } else {
                // If no specific tasks, reset all tasks to be safe
                bb.clearWorkResults();
              }
              
              ctx.ui.notify(
                `Review ${reviewOutput.status}: auto-recovering ${taskIdsToReset.length > 0 ? taskIdsToReset.length : "all"} task${taskIdsToReset.length === 1 ? "" : "s"} inside the approved work scope.`,
                "info"
              );
              state = bb.getState(); // Refresh state after transition in setReviewOutput
              continue;
            }

            // Gate: Review → Ship
            const reviewSummary = [
              `# Review — ${reviewOutput.status}`,
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

            ensureWebServer();
            const proceed = await waitConfirm(
              ctx,
              "Proceed to Ship phase?",
              "Review approved! Review details in chat and confirm to release.",
              "review"
            );
            if (!proceed) {
              ctx.ui.notify("Pipeline paused after Review. Run /morph:run to continue.", "info");
              return;
            }
          } catch (err: any) {
            setCurrentStatus("ready");
            ctx.ui.setStatus("morph", `morph:run Review failed: ${err.message.slice(0, 40)}`);
            ctx.ui.notify(`Review failed: ${err.message}`, "error");
            return;
          }
        }

        // ── Ship ──
        if (state.phase === "ship") {
          setCurrentStatus("busy");
          ctx.ui.setStatus("morph", "morph:run Ship phase...");
          ctx.ui.notify("Ship: DevOps + Release Consultant preparing release...", "info");
          updateWidget(ctx as any);

          try {
            currentAbortController = new AbortController();
            const shipOutput = await executeShipFlow({
              cwd: ctx.cwd,
              blackboard: bb,
              signal: currentAbortController.signal,
              onAgentEvent: (agentName, role, taskId, event) => {
                updateSubagentEvent(agentName, role, taskId, event);
                requestAnimationRender?.();
              },
            });
            subagentActivities.clear();
            bb.setShipOutput(shipOutput);
            state = bb.getState();
            const report = writeFinalReportArtifacts(ctx);
            openFileInBrowser(report.htmlPath);

            setCurrentStatus("ready");
            ctx.ui.setStatus("morph", `morph:run v${shipOutput.version} shipped`);
            updateWidget(ctx as any);
            pi.sendMessage({
              customType: "morph",
              content: `# Final Handoff Report\n\nGenerated after ship:\n- Markdown: \`${report.markdownPath}\`\n- HTML: \`${report.htmlPath}\``,
              display: true,
              details: { phase: "ship", markdownPath: report.markdownPath, htmlPath: report.htmlPath },
            });
            ctx.ui.notify(`Shipped v${shipOutput.version}! Final report generated.`, "success" as any);
          } catch (err: any) {
            setCurrentStatus("ready");
            ctx.ui.setStatus("morph", `morph:run Ship failed: ${err.message.slice(0, 40)}`);
            ctx.ui.notify(`Ship failed: ${err.message}`, "error");
            return;
          }
        }
      }

      // ── Done ──
      ctx.ui.notify("morph pipeline complete! /morph:status for details.", "success" as any);
  };

  pi.registerCommand("morph:run", {
    description: "Run the full pipeline with review gates: spark -> plan -> work -> review -> ship",
    handler: runMorphPipeline,
  });

  // ═══════════════════════════════════════════
  // UTILITY COMMANDS
  // ═══════════════════════════════════════════

  pi.registerCommand("morph:config", {
    description: "Configure the model for morph agents (e.g. /morph:config provider=anthropic model=claude-3-5-sonnet-20241022)",
    handler: async (args, ctx) => {
      const bb = bindWorkspace(ctx.cwd);
      
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

      const previousConfig = { ...bb.getState().config };
      bb.setConfig(newConfig);
      const currentConfig = bb.getState().config;
      const providerChanged =
        Boolean(newConfig.provider) && newConfig.provider !== previousConfig.provider;
      const modelChanged =
        Boolean(newConfig.model) && newConfig.model !== previousConfig.model;
      const staleToolFailures = bb
        .getState()
        .workResults
        .filter((result) => result.status === "failed" && result.failureKind === "TOOL_FAILURE")
        .map((result) => result.taskId);

      if ((providerChanged || modelChanged) && staleToolFailures.length > 0) {
        bb.clearWorkResults(staleToolFailures);
        ctx.ui.notify(
          `Updated morph config: provider=${currentConfig?.provider || "default"}, model=${currentConfig?.model || "default"}. Cleared ${staleToolFailures.length} stale tool-failure result${staleToolFailures.length === 1 ? "" : "s"} so the next run retries against the new config.`,
          "success" as any
        );
        return;
      }

      ctx.ui.notify(`Updated morph config: provider=${currentConfig?.provider || "default"}, model=${currentConfig?.model || "default"}`, "success" as any);
    }
  });

  pi.registerCommand("morph:status", {
    description: "Show morph pipeline status (widget + detailed summary)",
    handler: async (_args, ctx) => {
      const bb = bindWorkspace(ctx.cwd);
      const state = bb.getState();

      if (state.phase === "idle") {
        ctx.ui.notify("morph: idle — /morph:run <idea> to begin", "info");
        ctx.ui.setWidget("morph", ["morph — Ready", "   /morph:run <idea> to begin"]);
        return;
      }

      // Update widget + status
      updateWidget(ctx as any);
      ctx.ui.setStatus("morph", buildStatusBar(buildPipelineDisplay()));

      // Send detailed summary as message
      const summary = bb.getContextualSummary(4000);
      pi.sendMessage({ customType: "morph", content: summary, display: true, details: { phase: "status" } });
      const checkpointCount = Object.keys(state.flowCheckpoints[state.phase] || {}).length;
      ctx.ui.notify(
        checkpointCount > 0
          ? `morph: phase=${state.phase}  •  ${checkpointCount} checkpoint${checkpointCount === 1 ? "" : "s"} available  •  ${formatTokens(state.tokenLedger?.total || 0)} tokens`
          : `morph: phase=${state.phase}  •  ${formatTokens(state.tokenLedger?.total || 0)} tokens`,
        "info"
      );
    },
  });

  pi.registerCommand("morph:recover", {
    description: "Resume the pipeline from the last safe checkpoint",
    handler: async (_args, ctx) => {
      const bb = bindWorkspace(ctx.cwd);
      let state = bb.getState();
      if (state.phase === "idle") {
        ctx.ui.notify("Nothing to recover yet. Start with /morph:run <idea>.", "info");
        return;
      }
      if (state.phase === "done") {
        ctx.ui.notify("Pipeline already complete. Nothing to recover.", "info");
        return;
      }

      const diagnosis = diagnoseRecoveryState(state);
      const reportPath = persistRecoveryReport(bb, state, diagnosis);
      if (diagnosis.taskId && diagnosis.failureKind === "STATE_INCONSISTENT") {
        bb.clearWorkResults([diagnosis.taskId]);
        state = bb.getState();
      } else if (
        diagnosis.taskId &&
        diagnosis.autoSafe &&
        state.phase === "work" &&
        state.workResults.some((result) => result.taskId === diagnosis.taskId && result.status !== "done")
      ) {
        bb.clearWorkResults([diagnosis.taskId]);
        state = bb.getState();
      }

      const checkpointCount = Object.keys(state.flowCheckpoints[state.phase] || {}).length;
      const recoveryBrief = [
        `Recovery diagnosis${diagnosis.taskId ? ` for ${diagnosis.taskId}` : ""}: ${diagnosis.failureKind || "RESUME"}`,
        diagnosis.evidence.length > 0 ? `Evidence: ${diagnosis.evidence.join(" ")}` : "",
        `Next move: ${diagnosis.recommendation}`,
        reportPath ? `Report: ${reportPath}` : "",
      ].filter(Boolean).join(" ");
      ctx.ui.notify(
        checkpointCount > 0
          ? `${recoveryBrief} Recovering ${state.phase} from ${checkpointCount} checkpoint${checkpointCount === 1 ? "" : "s"}...`
          : `${recoveryBrief} No saved checkpoint in ${state.phase}; resuming from the start of the phase...`,
        "info"
      );
      await runMorphPipeline("", ctx as any);
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

      const bb = bindWorkspace(ctx.cwd);
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
        "## Spark (2)",
        ...SPARK_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## Plan (3)",
        ...PLAN_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## Work (2 per task)",
        ...WORK_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## Review (4)",
        ...REVIEW_AGENTS.map((a) => `- **${a.role}** \`${a.name}\` — ${a.description}`),
        "",
        "## Ship (2)",
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
        const bb = bindWorkspace(ctx.cwd);
        webServer = startMorphServer(bb, 4040);
        ctx.ui.notify("Mission Control started at http://localhost:4040", "success" as any);
      } catch (err: any) {
        ctx.ui.notify(`Failed to start server: ${err.message}`, "error" as any);
      }
    },
  });
}
