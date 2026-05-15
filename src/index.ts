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
  type SubagentActivity,
  type PhaseContext,
  buildPipelineProgressWidget,
  buildTaskTracker,
  buildStatusBar,
} from "./tui/display.js";
import { startMorphServer, serverEvents } from "./server/server.js";
import type { Server } from "node:http";
import type { PlanOutput, SparkOutput } from "./schemas/contracts.js";

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

function buildWorkSpecMarkdown(plan: PlanOutput, spark?: SparkOutput): string {
  const waves = waveGroups(plan.tasks);
  const lines: string[] = [
    "# morph Pre-Work Specification Review",
    "",
    "Review this specification before WORK starts. Edit anything that needs clarification, scope adjustment, or constraints.",
    "The final text saved from this editor is passed to implementation and review agents as human-approved guidance.",
    "",
  ];

  if (spark) {
    lines.push(
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

  lines.push("", "## QA Strategy", plan.qaStrategy, "", "## Risk Mitigations", ...(plan.riskMitigations.length ? plan.riskMitigations.map((r) => `- ${r}`) : ["- None specified"]), "", "## Human Adjustments / Approval Notes", plan.humanReviewNotes || "Approved as written.");
  return lines.join("\n");
}

function renderHtmlList(items: string[], fallback: string): string {
  const values = items.length ? items : [fallback];
  return `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildWorkSpecHtml(plan: PlanOutput, markdown: string, spark?: SparkOutput): string {
  const taskRows = plan.tasks.map((task) => `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${escapeHtml(task.description)}</td><td>${escapeHtml(task.category)}</td><td>${escapeHtml(task.estimatedComplexity)}</td><td>${escapeHtml(task.dependsOn.join(", ") || "none")}</td><td>${escapeHtml(task.acceptanceCriteria)}</td></tr>`).join("\n");
  const waveCards = waveGroups(plan.tasks).map((wave, index) => `
    <section class="wave">
      <h3>Wave ${index + 1}</h3>
      <ol>${wave.map((task) => `<li><strong>${escapeHtml(task.id)}</strong> ${escapeHtml(task.description)}</li>`).join("")}</ol>
    </section>`).join("");
  const productIntent = spark
    ? `<section class="hero-grid">
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
    @media(max-width:800px){header,.hero-grid,.split{display:block}.metrics{margin-top:16px}.panel{margin-top:16px}}
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
  let currentAbortController: AbortController | null = null;
  let currentTick = 0;
  let animationInterval: NodeJS.Timeout | null = null;
  let requestAnimationRender: (() => void) | null = null;
  let webServer: Server | null = null;
  const subagentActivities = new Map<string, SubagentActivity>();

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
    const state = getBB().getState();
    const markdown = buildFinalReportMarkdown(state, ctx.cwd);
    const html = buildFinalReportHtml(state, markdown, ctx.cwd);
    const markdownPath = path.join(morphDir, "final-report.md");
    const htmlPath = path.join(morphDir, "final-report.html");
    fs.writeFileSync(markdownPath, markdown, "utf-8");
    fs.writeFileSync(htmlPath, html, "utf-8");
    return { markdownPath, htmlPath };
  }



  async function reviewWorkSpecGate(ctx: any, planOutput: PlanOutput): Promise<boolean> {
    const bb = getBB();
    const morphDir = getMorphDir(ctx.cwd);
    fs.mkdirSync(morphDir, { recursive: true });

    const sparkOutput = bb.getState().sparkOutput;
    const draftMarkdown = buildWorkSpecMarkdown(planOutput, sparkOutput);
    const markdownPath = path.join(morphDir, "work-spec.md");
    const htmlPath = path.join(morphDir, "work-approval.html");

    const edited = await ctx.ui.editor("Review/edit WORK specification before implementation", draftMarkdown);
    if (edited === undefined) {
      ctx.ui.notify("WORK paused. Re-run /morph:run or /morph:work when ready.", "info");
      return false;
    }

    fs.writeFileSync(markdownPath, edited, "utf-8");
    planOutput.humanReviewNotes = edited;
    bb.setPlanOutput(planOutput);
    fs.writeFileSync(htmlPath, buildWorkSpecHtml(planOutput, edited, sparkOutput), "utf-8");
    ensureWebServer();
    openFileInBrowser(htmlPath);

    pi.sendMessage({ customType: "morph", content: `# 🧭 Pre-Work Specification Review

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
    if (decision === "reject") {
      ctx.ui.notify("WORK paused before implementation. Re-run /morph:run or /morph:work when ready.", "info");
      return false;
    }

    bb.recordDecision("plan", "Human approved pre-work specification", `Approval artifact: ${htmlPath}`);
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

    const liveSubs = [...subagentActivities.values()].filter(
      (activity) => activity.status === "running" || activity.status === "idle"
    );

    return {
      phase: state.phase,
      tasks,
      agents,
      tokenLedger: state.tokenLedger,
      tick: currentTick,
      subagentActivities: liveSubs.length > 0 ? liveSubs : undefined,
      phaseContext: buildPhaseContext(state, tasks, liveSubs),
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

  function buildPhaseContext(
    state: ReturnType<Blackboard["getState"]>,
    tasks: TaskDisplay[],
    liveSubs: SubagentActivity[]
  ): PhaseContext | undefined {
    const activeAgents = liveSubs.length;
    const liveNames = new Set(liveSubs.map((agent) => agent.name));
    const agentMark = (name: string) => liveNames.has(name) ? "●" : "○";
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
          state.sparkOutput ? `features ${state.sparkOutput.coreFeatures.length}  ·  risks ${state.sparkOutput.risks.length}` : "shaping PRD  ·  pressure-testing idea",
          state.sparkOutput?.technicalStackRecommendation ? `stack -> ${state.sparkOutput.technicalStackRecommendation}` : "next -> synthesize final PRD",
        ]};
      case "plan":
        return { title: "PLAN BOARD", lines: [
          `Architect ${agentMark("architect")}`,
          `QA ${agentMark("qa-expert")}  +  Efficiency ${agentMark("efficiency-mgr")}`,
          state.planOutput ? `${state.planOutput.tasks.length} tasks  ·  ${waveGroups(state.planOutput.tasks).length} waves` : "building architecture + DAG",
          state.planOutput ? `next -> work spec (${state.planOutput.estimatedEffort})` : "next -> specialist review",
        ]};
      case "work": {
        const shownRunning = runningTasks.slice(0, 3).map(compactTask).join("   ");
        const shownPending = pendingTasks.slice(0, 3).map(compactTask).join("   ");
        const compactQueue = tasks.slice(0, 5).map((task) =>
          task.status === "done" ? "✓" : task.status === "running" ? "●" : task.status === "failed" || task.status === "blocked" ? "!" : "○"
        ).join(" ");
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
          review ? `VERDICT  ${review.status}  ·  score ${review.efficiencyScore}/10` : "VERDICT  waiting on synthesis",
          review ? `FINDINGS ${severities.critical} critical  ${severities.major} major  ${severities.minor} minor` : `NEXT     ${activeAgents > 0 ? "auditors active" : "awaiting auditors"}`,
        ]};
      }
      case "ship":
        return { title: "SHIP BOARD", lines: [
          `DevOps ${agentMark("devops-sre")}  ->  Release ${agentMark("release-consultant")}`,
          state.shipOutput ? `${state.shipOutput.status}  ·  v${state.shipOutput.version}` : "preparing release package",
          state.reviewOutput ? `review -> ${state.reviewOutput.status}` : "review -> pending",
        ]};
      default:
        return undefined;
    }
  }

  function updateSubagentEvent(agentName: string, role: string, taskId: string, event: any): void {
    let entry = subagentActivities.get(agentName);
    if (!entry) {
      entry = { name: agentName, role, taskId, status: "running", currentTool: "", lastAction: "", turns: 0, toolDetail: "" };
      subagentActivities.set(agentName, entry);
    }
    entry.taskId = taskId;
    entry.status = "running";
    switch (event.type) {
      case "message_start":
        entry.currentTool = "";
        entry.lastAction = "responding...";
        break;
      case "text":
        if (event.text?.trim()) entry.lastAction = event.text.trim();
        break;
      case "tool_use": {
        entry.currentTool = event.name || "";
        const args = event.input || event.args || {};
        entry.toolDetail = typeof args === "object" ? args.path || args.filePath || args.command || args.pattern || args.query || "" : String(args).slice(0, 40);
        break;
      }
      case "tool_result":
        if (event.content?.[0]?.text) entry.lastAction = event.content[0].text.slice(0, 60).replace(/\n/g, " ");
        break;
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
        requestAnimationRender?.();
      }, 100);
    }

    // Show persistent widget and status bar
    updateWidget(ctx as any);
    ctx.ui.setStatus("morph", "morph: READY -- Type /morph:run <idea>");
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

      // ── Fix 5: Protect untracked files from git stash checkpoints ──
      try {
        const { execSync } = require("node:child_process");
        execSync(`git add -A`, { cwd: ctx.cwd, timeout: 10000, stdio: "pipe" });
        const status = execSync(`git status --porcelain`, { cwd: ctx.cwd, encoding: "utf-8", timeout: 5000 }).trim();
        if (status) {
          execSync(`git stash push -m "morph: pre-work checkpoint" --include-untracked`, {
            cwd: ctx.cwd, timeout: 10000, stdio: "pipe"
          });
        }
      } catch {
        // git unavailable — skip
      }

      bb.transition("work");
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

        const results = await executeWorkFlow({
          cwd: ctx.cwd,
          blackboard: bb,
          maxParallel: 3,
          signal: currentAbortController.signal,

          onWaveStart: async (wave, waveIndex) => {
            // Update widget: mark wave tasks as "running"
            for (const t of wave) liveTasks.set(t.id, { ...liveTasks.get(t.id)!, status: "running" });
            setPipelineWidget(ctx as any, () => ({ ...buildPipelineDisplay(), tasks: [...liveTasks.values()] }));

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
            setPipelineWidget(ctx as any, () => ({ ...buildPipelineDisplay(), tasks: [...liveTasks.values()] }));

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
            clearSubagentActivity("engineer");
            clearSubagentActivity("peer-reviewer");
          },
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();

        // All done
        const done = results.filter((r) => r.status === "done").length;
        const failed = results.filter((r) => r.status === "failed").length;

        ctx.ui.setStatus("morph", `morph:review (ready) ✓  ${done}/${results.length} done`);
        setPipelineWidget(ctx as any, () => buildPipelineDisplay());

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
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();

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
          onAgentEvent: (agentName, role, taskId, event) => {
            updateSubagentEvent(agentName, role, taskId, event);
            requestAnimationRender?.();
          },
        });
        subagentActivities.clear();
        const finalState = bb.getState();
        const report = writeFinalReportArtifacts(ctx);
        openFileInBrowser(report.htmlPath);

        const icon = shipOutput.status === "SHIPPED" ? "🚀" : "⛔";
        ctx.ui.setStatus("morph", `morph:done ${icon}  v${shipOutput.version}`);
        ctx.ui.setWidget("morph", ["✅  morph pipeline complete!", `   Version: ${shipOutput.version}  •  Status: ${shipOutput.status}`]);

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
          `**Final Handoff Report**:`,
          `- Markdown: \`${report.markdownPath}\``,
          `- HTML: \`${report.htmlPath}\``,
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
            onAgentEvent: (agentName, role, taskId, event) => {
              updateSubagentEvent(agentName, role, taskId, event);
              requestAnimationRender?.();
            },
          });
          subagentActivities.clear();
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
              onAgentEvent: (agentName, role, taskId, event) => {
                updateSubagentEvent(agentName, role, taskId, event);
                requestAnimationRender?.();
              },
            });
            subagentActivities.clear();
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
        // ── Fix 5: Protect untracked files from git stash checkpoints ──
        try {
          const { execSync } = require("node:child_process");
          execSync(`git add -A`, { cwd: ctx.cwd, timeout: 10000, stdio: "pipe" });
        } catch {
          // git unavailable — skip
        }

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
              setPipelineWidget(ctx as any, () => ({ ...buildPipelineDisplay(), tasks: [...liveTasks.values()] }));

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
              setPipelineWidget(ctx as any, () => ({ ...buildPipelineDisplay(), tasks: [...liveTasks.values()] }));
              const done = [...liveTasks.values()].filter((t) => t.status === "done").length;
              ctx.ui.setStatus("morph", `morph:run ⏳  Work: ${done}/${liveTasks.size} tasks`);

              const icon = result.status === "done" ? "✓" : result.status === "blocked" ? "⊘" : "✗";
              ctx.ui.notify(`${icon} [${result.taskId}] ${result.summary.slice(0, 80)}`, 
                result.status === "done" ? "info" : "warning");
              clearSubagentActivity("engineer");
              clearSubagentActivity("peer-reviewer");
            },
            onAgentEvent: (agentName, role, taskId, event) => {
              updateSubagentEvent(agentName, role, taskId, event);
              requestAnimationRender?.();
            },
          });
          subagentActivities.clear();

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
            onAgentEvent: (agentName, role, taskId, event) => {
              updateSubagentEvent(agentName, role, taskId, event);
              requestAnimationRender?.();
            },
          });
          subagentActivities.clear();
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

          ensureWebServer();
          const proceed = await waitConfirm(
            ctx,
            "🚀 Proceed to Ship phase?",
            "Review approved! Review details in chat and confirm to release.",
            "review"
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

          ctx.ui.setStatus("morph", `morph:run 🚀  v${shipOutput.version} shipped`);
          updateWidget(ctx as any);
          pi.sendMessage({
            customType: "morph",
            content: `# 🚀 Final Handoff Report\n\nGenerated after ship:\n- Markdown: \`${report.markdownPath}\`\n- HTML: \`${report.htmlPath}\``,
            display: true,
            details: { phase: "ship", markdownPath: report.markdownPath, htmlPath: report.htmlPath },
          });
          ctx.ui.notify(`🚀 Shipped v${shipOutput.version}! Final report generated.`, "success" as any);
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
