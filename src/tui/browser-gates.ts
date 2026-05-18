import { waveGroups, detectFileTargetOverlaps } from "../core/engine.js";
import type { Blackboard } from "../core/blackboard.js";
import type { MorphState, PlanOutput, SparkOutput, ReviewOutput } from "../schemas/contracts.js";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderHtmlList(items: string[], fallback: string): string {
  const values = items.length ? items : [fallback];
  return `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function renderMarkdownLite(markdown: string, fallback = "No detail recorded."): string {
  const normalized = markdown.trim();
  if (!normalized || /^(nothing|none|n\/a)$/i.test(normalized)) {
    return `<p class="empty-note">${escapeHtml(fallback)}</p>`;
  }

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listKind: "ul" | "ol" | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length > 0 && listKind) {
      blocks.push(`<${listKind}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${listKind}>`);
      listItems = [];
      listKind = null;
    }
  };

  for (const rawLine of normalized.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, Math.max(3, heading[1].length + 1));
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (listKind && listKind !== "ul") flushList();
      listKind = "ul";
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listKind && listKind !== "ol") flushList();
      listKind = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return `<div class="rich-copy">${blocks.join("")}</div>`;
}

function summarizeMarkdown(markdown: string, fallback = "No detail recorded."): string {
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^(nothing|none|n\/a)$/i.test(line) || /^#{1,6}\s+/.test(line)) continue;
    return line
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1");
  }
  return fallback;
}

export const REVIEW_SCORE_FLOOR = 8;

export type ReviewGateDisposition = "ship_candidate" | "auto_repair" | "escalate";

export interface ReviewReadinessAssessment {
  disposition: ReviewGateDisposition;
  reasons: string[];
  actionableTaskIds: string[];
}

function hasMeaningfulReviewText(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized) && !["nothing", "none", "n/a", "no user feedback provided"].includes(normalized);
}

export function isWorkReadyForReview(state: MorphState): boolean {
  if (!state.planOutput) return false;
  const doneTaskIds = new Set(state.workResults.filter((result) => result.status === "done").map((result) => result.taskId));
  return state.planOutput.tasks.every((task) => doneTaskIds.has(task.id));
}

export function assessReviewReadiness(review: ReviewOutput): ReviewReadinessAssessment {
  const reasons: string[] = [];
  const blockingChanges = review.requiredChanges.filter((change) => change.severity === "critical" || change.severity === "major");
  const actionableTaskIds = [...new Set(review.requiredChanges.map((change) => change.taskId).filter((id): id is string => Boolean(id)))];

  if (review.status !== "APPROVED") reasons.push(`verdict is ${review.status}`);
  if (review.efficiencyScore < REVIEW_SCORE_FLOOR) reasons.push(`score ${review.efficiencyScore}/10 is below ${REVIEW_SCORE_FLOOR}/10`);
  if (blockingChanges.length > 0) reasons.push(`${blockingChanges.length} critical/major required change${blockingChanges.length === 1 ? "" : "s"} remain`);
  if (review.securityIssues.length > 0) reasons.push(`${review.securityIssues.length} unresolved security issue${review.securityIssues.length === 1 ? "" : "s"} remain`);
  if (!hasMeaningfulReviewText(review.technicalAudit)) reasons.push("technical audit is missing");
  if (!hasMeaningfulReviewText(review.userPerspectiveFeedback)) reasons.push("user-perspective feedback is missing");
  if (!hasMeaningfulReviewText(review.testCoverageAssessment)) reasons.push("coverage assessment is missing");

  if (reasons.length === 0) return { disposition: "ship_candidate", reasons, actionableTaskIds };
  if (actionableTaskIds.length > 0) return { disposition: "auto_repair", reasons, actionableTaskIds };
  return { disposition: "escalate", reasons, actionableTaskIds };
}

export type BrowserGateTone = "neutral" | "success" | "warning" | "danger";

export interface BrowserGateMetric {
  label: string;
  value: string;
  tone?: BrowserGateTone;
}

export interface BrowserGateFlag {
  label: string;
  detail: string;
  tone?: BrowserGateTone;
}

export interface BrowserGateCard {
  label: string;
  title: string;
  body: string;
}

export interface BrowserGateSection {
  title: string;
  summary: string;
  html: string;
  open?: boolean;
}

export interface BrowserGatePage {
  phase: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  recommendation: string;
  decisionSummary: string;
  metrics: BrowserGateMetric[];
  flags: BrowserGateFlag[];
  cards: BrowserGateCard[];
  approveIf: string[];
  pauseIf: string[];
  sections: BrowserGateSection[];
  primaryAction: string;
  secondaryAction: string;
}

export function renderBrowserGatePage(page: BrowserGatePage): string {
  const toneClass = (tone?: BrowserGateTone) => tone ?? "neutral";
  const toneIcon = (tone?: BrowserGateTone) => {
    switch (tone) {
      case "success":
        return `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.9-4.2 4.4a1 1 0 0 1-1.4 0L6.2 10.6l1.4-1.4 1.2 1.2 3.5-3.7 1.4 1.4Z"/></svg>`;
      case "warning":
        return `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 2 19 18H1L10 2Zm0 5.2a1 1 0 0 0-1 1v4.1h2V8.2a1 1 0 0 0-1-1Zm0 8a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z"/></svg>`;
      case "danger":
        return `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm2.8-10.4-1.4-1.4L10 7.6 8.6 6.2 7.2 7.6 8.6 9l-1.4 1.4 1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4L11.4 9l1.4-1.4Z"/></svg>`;
      default:
        return `<svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>`;
    }
  };
  const flags = page.flags.length
    ? page.flags.map((flag) => `
        <li class="flag ${toneClass(flag.tone)}">
          <strong>${escapeHtml(flag.label)}</strong>
          <span>${escapeHtml(flag.detail)}</span>
        </li>`).join("")
    : `<li class="flag success"><strong>No exceptions surfaced</strong><span>Morph did not surface a blocking concern for this gate.</span></li>`;
  const cards = page.cards.map((card) => `
    <article class="signal-card">
      <span>${escapeHtml(card.label)}</span>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.body)}</p>
    </article>`).join("");
  const sections = page.sections.map((section) => `
    <details ${section.open ? "open" : ""}>
      <summary>
        <span>${escapeHtml(section.title)}</span>
        <em>${escapeHtml(section.summary)}</em>
      </summary>
      <div class="detail-body">${section.html}</div>
    </details>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(page.title)}</title>
  <style>
    :root{
      color-scheme:light;
      --ink:#132033;--muted:#5b6475;--line:#dbe2ee;--paper:#f5f7fb;--card:#fff;
      --body-top:#fbfcff;--body-bottom:#f5f7fb;--subtle:#fafbff;
      --accent:#4057f4;--accent-soft:#eef1ff;--ok:#0f766e;--ok-soft:#ecfdf5;
      --warn:#b45309;--warn-soft:#fff7ed;--danger:#b91c1c;--danger-soft:#fef2f2;
      --ghost:#e8edf8;--ghost-ink:#334155;--code-bg:#eef2ff;--table-head:#f2f5fb;
      --pre-bg:#0f172a;--pre-ink:#e2e8f0;--action-surface:rgba(255,255,255,.94);
      --pause-bg:#e2e8f0;--pause-ink:#334155;--shadow:0 18px 60px rgba(15,23,42,.08);
      --action-bar-space:110px;
    }
    :root[data-theme="dark"]{
      color-scheme:dark;
      --ink:#e8eef8;--muted:#9ba8bc;--line:#273449;--paper:#0b1220;--card:#111827;
      --body-top:#0b1220;--body-bottom:#0b1220;--subtle:#0f172a;
      --accent:#93a5ff;--accent-soft:#1c2540;--ok:#34d399;--ok-soft:#08291f;
      --warn:#f59e0b;--warn-soft:#2c1d08;--danger:#f87171;--danger-soft:#321216;
      --ghost:#1f2937;--ghost-ink:#dbe4f0;--code-bg:#1e293b;--table-head:#162033;
      --pre-bg:#020617;--pre-ink:#e2e8f0;--action-surface:rgba(17,24,39,.92);
      --pause-bg:#243041;--pause-ink:#e8eef8;--shadow:0 18px 60px rgba(0,0,0,.34);
    }
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,var(--body-top) 0,var(--body-bottom) 240px);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5}
    main{max-width:1280px;margin:0 auto;padding:28px 24px var(--action-bar-space)}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;align-items:start;margin-bottom:18px}
    .hero-main,.decision-rail,.signal-card,.panel,details{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow)}
    .hero-main{padding:24px}
    .eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
    h1{font-size:2.15rem;line-height:1.08;margin:0 0 10px}
    h2{font-size:1.06rem;margin:0 0 12px}
    h3{font-size:1rem;margin:5px 0 8px}
    p{margin:0 0 10px}
    .subtitle{color:var(--muted);font-size:1rem;max-width:62ch}
    .metrics{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    .metric{display:flex;flex-direction:column;gap:3px;min-width:104px;padding:10px 12px;border-radius:16px;background:var(--accent-soft)}
    .metric-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
    .metric-value{display:flex;align-items:center;gap:7px;font-size:1rem}
    .metric-value svg{width:16px;height:16px;fill:currentColor;flex:0 0 auto}
    .metric.success{background:var(--ok-soft)}.metric.warning{background:var(--warn-soft)}.metric.danger{background:var(--danger-soft)}
    .decision-rail{padding:20px;position:sticky;top:18px}
    .rail-kicker{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
    .recommendation{font-size:1.08rem;font-weight:800;margin:6px 0 10px}
    .decision-copy{color:var(--muted);font-size:.94rem}
    .signal-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0}
    .signal-card{padding:16px;box-shadow:none}
    .signal-card span{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
    .signal-card p{color:var(--muted);font-size:.92rem}
    .panel{padding:18px;margin:16px 0;box-shadow:none}
    .flag-list{display:grid;gap:10px;padding:0;margin:0;list-style:none}
    .flag{display:grid;gap:2px;border-left:4px solid var(--line);padding:10px 12px;background:var(--subtle);border-radius:14px}
    .flag strong{font-size:.92rem}.flag span{color:var(--muted);font-size:.92rem}
    .flag.success{border-color:var(--ok);background:var(--ok-soft)}
    .flag.warning{border-color:var(--warn);background:var(--warn-soft)}
    .flag.danger{border-color:var(--danger);background:var(--danger-soft)}
    .check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .check-grid ul{margin:0;padding-left:18px}
    .check-grid li+li{margin-top:6px}
    .detail-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:22px 0 12px}
    .detail-actions{display:flex;gap:8px}
    button{border:0;border-radius:14px;padding:11px 14px;font:inherit;font-weight:750;cursor:pointer}
    button.ghost{background:var(--ghost);color:var(--ghost-ink)}
    details{overflow:hidden;margin-bottom:12px;box-shadow:none}
    summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 18px;font-weight:750}
    summary::-webkit-details-marker{display:none}
    summary em{font-style:normal;font-weight:500;color:var(--muted);font-size:.9rem;text-align:right}
    .detail-body{border-top:1px solid var(--line);padding:18px}
    .detail-body .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .detail-body .subpanel{border:1px solid var(--line);border-radius:16px;padding:16px}
    .rich-copy h3,.rich-copy h4,.rich-copy h5,.rich-copy h6{margin:12px 0 8px}
    .rich-copy>:first-child{margin-top:0}
    .rich-copy>:last-child{margin-bottom:0}
    .empty-note{color:var(--muted);font-style:italic}
    ul{margin-top:8px}
    li+li{margin-top:5px}
    pre{margin:0;background:var(--pre-bg);color:var(--pre-ink);padding:16px;border-radius:14px;overflow:auto;white-space:pre-wrap}
    code{background:var(--code-bg);padding:2px 5px;border-radius:6px}
    .wave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
    .wave{border:1px solid var(--line);border-radius:16px;padding:16px}
    table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
    th,td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;font-size:.91rem}
    th{background:var(--table-head);color:var(--ink)}tr:last-child td{border-bottom:0}
    .action-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;width:min(1232px,calc(100% - 32px));display:flex;justify-content:space-between;align-items:center;gap:16px;background:var(--action-surface);backdrop-filter:blur(12px);border:1px solid var(--line);border-radius:20px;padding:14px 16px;box-shadow:var(--shadow)}
    .action-copy{color:var(--muted);font-size:.92rem}
    .buttons{display:flex;gap:10px}
    .approve{background:var(--ok);color:white}.pause{background:var(--pause-bg);color:var(--pause-ink)}
    @media(max-width:980px){
      .hero{display:block}.decision-rail{position:static;margin-top:14px}.signal-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .check-grid,.detail-body .grid{display:block}.check-grid>*+*,.detail-body .grid>*+*{margin-top:14px}
    }
    @media(max-width:720px){
      main{padding:18px 16px var(--action-bar-space)}.signal-grid{display:block}.signal-card+.signal-card{margin-top:12px}
      summary{display:block}summary em{display:block;text-align:left;margin-top:5px}
      .action-bar{display:block}.buttons{margin-top:10px}.buttons button{flex:1}
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="hero-main">
        <div class="eyebrow">${escapeHtml(page.eyebrow)}</div>
        <h1>${escapeHtml(page.title)}</h1>
        <p class="subtitle">${escapeHtml(page.subtitle)}</p>
        <div class="metrics">
          ${page.metrics.map((metric) => `
            <div class="metric ${toneClass(metric.tone)}">
              <span class="metric-label">${escapeHtml(metric.label)}</span>
              <strong class="metric-value">${toneIcon(metric.tone)}<span>${escapeHtml(metric.value)}</span></strong>
            </div>`).join("")}
        </div>
      </div>
      <aside class="decision-rail">
        <div class="rail-kicker">Recommended move</div>
        <div class="recommendation">${escapeHtml(page.recommendation)}</div>
        <p class="decision-copy">${escapeHtml(page.decisionSummary)}</p>
      </aside>
    </section>

    <section class="signal-grid">${cards}</section>

    <section class="panel">
      <h2>Top flags</h2>
      <ul class="flag-list">${flags}</ul>
    </section>

    <section class="panel check-grid">
      <div>
        <h2>Approve if</h2>
        ${renderHtmlList(page.approveIf, "No explicit approve criteria captured.")}
      </div>
      <div>
        <h2>Pause if</h2>
        ${renderHtmlList(page.pauseIf, "No explicit pause criteria captured.")}
      </div>
    </section>

    <div class="detail-toolbar">
      <h2>Inspect as needed</h2>
      <div class="detail-actions">
        <button class="ghost" id="theme-toggle" onclick="toggleTheme()">Toggle theme</button>
        <button class="ghost" onclick="setAllDetails(true)">Expand all</button>
        <button class="ghost" onclick="setAllDetails(false)">Collapse all</button>
      </div>
    </div>
    ${sections}
  </main>

  <div class="action-bar">
    <div class="action-copy" id="browser-status">This gate is generated from live Morph state.</div>
    <div class="buttons">
      <button class="approve" onclick="sendDecision('approve')">${escapeHtml(page.primaryAction)}</button>
      <button class="pause" onclick="sendDecision('reject')">${escapeHtml(page.secondaryAction)}</button>
    </div>
  </div>

  <script>
    (function initTheme() {
      try {
        const stored = localStorage.getItem('morph-gate-theme');
        const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.dataset.theme = stored || preferred;
      } catch (err) {
        document.documentElement.dataset.theme = 'dark';
      }
    })();
    function syncThemeToggleLabel() {
      const button = document.getElementById('theme-toggle');
      if (!button) return;
      button.textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
    }
    function toggleTheme() {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('morph-gate-theme', next); } catch (err) {}
      syncThemeToggleLabel();
    }
    function setAllDetails(open) {
      document.querySelectorAll('details').forEach((detail) => detail.open = open);
    }
    function syncActionBarSpace() {
      const actionBar = document.querySelector('.action-bar');
      if (!actionBar) return;
      const pixels = Math.ceil(actionBar.getBoundingClientRect().height + 32);
      document.documentElement.style.setProperty('--action-bar-space', pixels + 'px');
    }
    syncThemeToggleLabel();
    syncActionBarSpace();
    window.addEventListener('resize', syncActionBarSpace);
    if ('ResizeObserver' in window) {
      new ResizeObserver(syncActionBarSpace).observe(document.querySelector('.action-bar'));
    }
    async function sendDecision(decision) {
      const status = document.getElementById('browser-status');
      status.textContent = decision === 'approve' ? 'Sending approval...' : 'Pausing pipeline...';
      try {
        await fetch('http://localhost:4040/api/' + decision, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: '${escapeHtml(page.phase)}' })
        });
        status.textContent = decision === 'approve'
          ? 'Approved in browser. Morph will continue in the pi session.'
          : 'Pipeline paused from browser.';
      } catch (err) {
        status.textContent = 'Could not reach Morph Mission Control on localhost:4040.';
      }
    }
  </script>
</body>
</html>`;
}

export function buildWorkSpecHtml(plan: PlanOutput, markdown: string, spark?: SparkOutput): string {
  const waves = waveGroups(plan.tasks);
  const fileOverlaps = detectFileTargetOverlaps(plan.tasks);
  const highOverlaps = fileOverlaps.filter((overlap) => overlap.severity === "high");
  const taskRows = plan.tasks.map((task) => `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${escapeHtml(task.description)}</td><td>${escapeHtml(task.category)}</td><td>${escapeHtml(task.estimatedComplexity)}</td><td>${escapeHtml(task.dependsOn.join(", ") || "none")}</td><td>${escapeHtml(task.acceptanceCriteria)}</td></tr>`).join("\n");
  const waveCards = waves.map((wave, index) => `
    <section class="wave">
      <h3>Wave ${index + 1}</h3>
      <ol>${wave.map((task) => `<li><strong>${escapeHtml(task.id)}</strong> ${escapeHtml(task.description)}</li>`).join("")}</ol>
    </section>`).join("");
  const overlapHtml = fileOverlaps.length
    ? `<ul>${fileOverlaps.map((overlap) => `<li><strong>${escapeHtml(overlap.severity.toUpperCase())}</strong> <code>${escapeHtml(overlap.file)}</code> | ${escapeHtml(overlap.taskIds.join(", "))} (waves ${escapeHtml(overlap.waveNumbers.join(", "))}). ${escapeHtml(overlap.suggestion)}</li>`).join("")}</ul>`
    : "<p>No concrete file-target overlaps detected.</p>";
  const productShape = spark
    ? `${spark.productShape.deliverableType} | ${spark.productShape.runtime} | ${spark.productShape.distribution}`
    : "Product shape not captured";
  const topFlags: BrowserGateFlag[] = [
    ...highOverlaps.slice(0, 2).map((overlap) => ({
      label: `HIGH overlap: ${overlap.taskIds.join(" + ")}`,
      detail: `${overlap.file} | ${overlap.suggestion}`,
      tone: "danger" as const,
    })),
    ...fileOverlaps.filter((overlap) => overlap.severity !== "high").slice(0, Math.max(0, 3 - highOverlaps.length)).map((overlap) => ({
      label: `Shared target: ${overlap.taskIds.join(" + ")}`,
      detail: `${overlap.file} | ${overlap.suggestion}`,
      tone: "warning" as const,
    })),
    ...plan.riskMitigations.slice(0, Math.max(0, 3 - fileOverlaps.length)).map((risk) => ({
      label: "Risk watch",
      detail: risk,
      tone: "warning" as const,
    })),
  ].slice(0, 3);

  return renderBrowserGatePage({
    phase: "pre-work",
    eyebrow: "morph approval gate | plan -> work",
    title: "Approve implementation scope",
    subtitle: "This is the final human checkpoint before Morph hands the plan to Engineer and Peer Reviewer agents.",
    recommendation:
      highOverlaps.length > 0
        ? "Review flagged overlaps before approving"
        : fileOverlaps.length > 0
          ? "Approve after checking shared-file edits"
          : "Approve if the product shape and task scope are right",
    decisionSummary:
      "Approving locks this edited spec as human guidance, then starts WORK automatically. Pausing keeps the plan intact without implementation.",
    metrics: [
      { label: "Tasks", value: String(plan.tasks.length) },
      { label: "Waves", value: String(waves.length) },
      { label: "Effort", value: plan.estimatedEffort },
      { label: "Overlaps", value: String(fileOverlaps.length), tone: highOverlaps.length > 0 ? "danger" : fileOverlaps.length > 0 ? "warning" : "success" },
    ],
    flags: topFlags,
    cards: [
      {
        label: "Why",
        title: "Product intent",
        body: spark?.visionStatement ?? "No product vision captured.",
      },
      {
        label: "Deliverable",
        title: productShape,
        body: spark?.productShape.explicitUserIntent ?? "Explicit user intent not captured.",
      },
      {
        label: "Scope",
        title: `${plan.tasks.length} tasks across ${waves.length} waves`,
        body: `${plan.componentTree.length} components | ${plan.dataModels.length} data-model notes`,
      },
      {
        label: "Risk",
        title: highOverlaps.length > 0 ? `${highOverlaps.length} high-risk overlap${highOverlaps.length === 1 ? "" : "s"}` : fileOverlaps.length > 0 ? `${fileOverlaps.length} shared-file target${fileOverlaps.length === 1 ? "" : "s"}` : "No overlap pressure",
        body: plan.riskMitigations[0] ?? "No explicit risk mitigation captured.",
      },
    ],
    approveIf: [
      "The product intent and deliverable shape match what you want built.",
      "The task count and execution waves feel like the right scope for this effort.",
      "Flagged overlaps and risks are acceptable or intentionally serialized.",
    ],
    pauseIf: [
      "The product shape is wrong or the task graph is solving the wrong problem.",
      "Acceptance criteria look vague, inflated, or incomplete.",
      "A flagged overlap or risk needs human clarification before implementation starts.",
    ],
    sections: [
      {
        title: "Scope and success criteria",
        summary: "Intent, features, constraints, and what success means",
        open: true,
        html: spark
          ? `<div class="grid">
              <section class="subpanel"><h3>Core features</h3>${renderHtmlList(spark.coreFeatures, "No features captured.")}</section>
              <section class="subpanel"><h3>Success criteria</h3>${renderHtmlList(spark.successCriteria, "No explicit success criteria captured.")}</section>
              <section class="subpanel"><h3>Constraints</h3>${renderHtmlList(spark.constraints, "No hard constraints captured.")}</section>
              <section class="subpanel"><h3>Target user</h3><p>${escapeHtml(spark.targetUserPersona)}</p></section>
            </div>`
          : "<p>No Spark context captured.</p>",
      },
      {
        title: "Execution waves",
        summary: `${waves.length} waves define implementation order and parallelism`,
        open: highOverlaps.length > 0,
        html: `<div class="wave-grid">${waveCards}</div>`,
      },
      {
        title: "File-target overlaps",
        summary: fileOverlaps.length ? `${fileOverlaps.length} shared targets to inspect` : "No shared targets detected",
        open: fileOverlaps.length > 0,
        html: overlapHtml,
      },
      {
        title: "Task DAG",
        summary: "All implementation tasks with dependencies and acceptance criteria",
        html: `<table><thead><tr><th>ID</th><th>Description</th><th>Category</th><th>Complexity</th><th>Dependencies</th><th>Acceptance</th></tr></thead><tbody>${taskRows}</tbody></table>`,
      },
      {
        title: "Architecture and QA",
        summary: "Technical shape, testing plan, and risk mitigations",
        html: `<div class="grid">
          <section class="subpanel"><h3>Architecture</h3><pre>${escapeHtml(plan.architectureDiagram)}</pre></section>
          <section class="subpanel"><h3>QA strategy</h3><p>${escapeHtml(plan.qaStrategy)}</p><h3>Risk mitigations</h3>${renderHtmlList(plan.riskMitigations, "No explicit mitigations captured.")}</section>
        </div>`,
      },
      {
        title: "Approved spec snapshot",
        summary: "Exact markdown guidance handed to implementation agents",
        html: `<pre>${escapeHtml(markdown)}</pre>`,
      },
    ],
    primaryAction: "Approve & start WORK",
    secondaryAction: "Pause pipeline",
  });
}

export function buildSparkApprovalHtml(spark: SparkOutput): string {
  const topFlags: BrowserGateFlag[] = spark.risks.slice(0, 3).map((risk) => ({
    label: "Risk to inspect",
    detail: risk,
    tone: "warning",
  }));
  return renderBrowserGatePage({
    phase: "spark",
    eyebrow: "morph approval gate · spark → plan",
    title: "Approve the product direction",
    subtitle: "Before Morph spends effort designing architecture and tasks, confirm that it understood the right product.",
    recommendation: "Approve if this is the right thing to build",
    decisionSummary:
      "Approving advances to PLAN, where Morph turns this product brief into architecture, QA strategy, and an implementation DAG.",
    metrics: [
      { label: "Features", value: String(spark.coreFeatures.length) },
      { label: "Risks", value: String(spark.risks.length), tone: spark.risks.length > 0 ? "warning" : "success" },
      { label: "Constraints", value: String(spark.constraints.length) },
      { label: "Criteria", value: String(spark.successCriteria.length) },
    ],
    flags: topFlags,
    cards: [
      {
        label: "Why",
        title: "Vision",
        body: spark.visionStatement,
      },
      {
        label: "User",
        title: "Target persona",
        body: spark.targetUserPersona,
      },
      {
        label: "Shape",
        title: `${spark.productShape.deliverableType} · ${spark.productShape.runtime}`,
        body: spark.productShape.explicitUserIntent,
      },
      {
        label: "Stack",
        title: "Recommended direction",
        body: spark.technicalStackRecommendation,
      },
    ],
    approveIf: [
      "Morph captured the real user intent, not just surface wording.",
      "The target user and product shape are correct enough to plan against.",
      "The listed risks are acceptable inputs to planning rather than signs of a wrong direction.",
    ],
    pauseIf: [
      "The product is for the wrong audience or solves the wrong problem.",
      "A hard constraint or must-have outcome is missing.",
      "You want to reshape the brief before any implementation architecture is created.",
    ],
    sections: [
      {
        title: "Product brief",
        summary: "Intent, target user, runtime, and delivery shape",
        open: true,
        html: `<div class="grid">
          <section class="subpanel"><h3>Explicit intent</h3><p>${escapeHtml(spark.productShape.explicitUserIntent)}</p></section>
          <section class="subpanel"><h3>Product shape</h3><ul>
            <li><strong>Deliverable:</strong> ${escapeHtml(spark.productShape.deliverableType)}</li>
            <li><strong>Runtime:</strong> ${escapeHtml(spark.productShape.runtime)}</li>
            <li><strong>Distribution:</strong> ${escapeHtml(spark.productShape.distribution)}</li>
          </ul></section>
        </div>`,
      },
      {
        title: "Features and success criteria",
        summary: "What Morph thinks the product must do and how success is judged",
        html: `<div class="grid">
          <section class="subpanel"><h3>Core features</h3>${renderHtmlList(spark.coreFeatures, "No features captured.")}</section>
          <section class="subpanel"><h3>Success criteria</h3>${renderHtmlList(spark.successCriteria, "No success criteria captured.")}</section>
        </div>`,
      },
      {
        title: "Constraints and risks",
        summary: "Inputs that should shape planning decisions",
        open: spark.risks.length > 0,
        html: `<div class="grid">
          <section class="subpanel"><h3>Constraints</h3>${renderHtmlList(spark.constraints, "No hard constraints captured.")}</section>
          <section class="subpanel"><h3>Risks</h3>${renderHtmlList(spark.risks, "No risks captured.")}</section>
        </div>`,
      },
    ],
    primaryAction: "Approve & start PLAN",
    secondaryAction: "Pause pipeline",
  });
}

export function buildReviewApprovalHtml(state: ReturnType<Blackboard["getState"]>): string {
  const review = state.reviewOutput!;
  const telemetry = state.reviewTelemetry;
  const severities: Record<string, number> = { critical: 0, major: 0, minor: 0, "nice-to-have": 0 };
  for (const change of review.requiredChanges) severities[change.severity]++;
  const completedTasks = state.workResults.filter((result) => result.status === "done");
  const changedFiles = [...new Set(state.workResults.flatMap((result) => result.filesChanged))];
  const specialistEvidence = telemetry
    ? `<div class="grid">
        <section class="subpanel"><h3>QA</h3>
          <p><strong>Signals:</strong> ${escapeHtml(String(telemetry.qa.signalsFound ?? 0))}</p>
          <p>${escapeHtml(telemetry.qa.notableGap ?? "No notable QA gap recorded.")}</p>
        </section>
        <section class="subpanel"><h3>Performance</h3>
          <p><strong>Signals:</strong> ${escapeHtml(String(telemetry.perf.signalsFound ?? 0))}</p>
          <p>${escapeHtml(telemetry.perf.notableConcern ?? "No notable performance concern recorded.")}</p>
        </section>
        <section class="subpanel"><h3>User</h3>
          <p><strong>Signals:</strong> ${escapeHtml(String(telemetry.user.signalsFound ?? 0))}</p>
          <p>${escapeHtml(telemetry.user.notableConcern ?? "No notable user concern recorded.")}</p>
        </section>
        <section class="subpanel"><h3>Synthesis</h3>
          <p><strong>Verdict:</strong> ${escapeHtml(telemetry.synthesis.verdict ?? "not recorded")}</p>
          <p><strong>Coverage:</strong> ${escapeHtml(telemetry.synthesis.coverageAssessment ?? "No coverage assessment recorded.")}</p>
        </section>
      </div>`
    : "<p>No specialist telemetry was recorded for this review run.</p>";
  const topFlags: BrowserGateFlag[] = [
    ...review.securityIssues.slice(0, 2).map((issue) => ({
      label: "Security issue",
      detail: issue,
      tone: "danger" as const,
    })),
    ...review.requiredChanges.slice(0, Math.max(0, 3 - review.securityIssues.length)).map((change) => ({
      label: `${change.severity.toUpperCase()} follow-up${change.taskId ? ` · ${change.taskId}` : ""}`,
      detail: change.description,
      tone: change.severity === "critical" || change.severity === "major" ? "danger" as const : "warning" as const,
    })),
  ].slice(0, 3);

  return renderBrowserGatePage({
    phase: "review",
    eyebrow: "morph approval gate · review → ship",
    title: "Approve release readiness",
    subtitle: "Review has finished. Confirm that the delivered work is ready to enter SHIP and become a release candidate.",
    recommendation:
      review.requiredChanges.some((change) => change.severity === "critical" || change.severity === "major") || review.securityIssues.length > 0
        ? "Pause unless you intentionally accept the flagged findings"
        : "Approve if the review verdict matches your release bar",
    decisionSummary:
      "Approving starts SHIP, where DevOps and Release Consultant agents prepare the release package, checklist, changelog, and final handoff.",
    metrics: [
      { label: "Verdict", value: review.status, tone: review.status === "APPROVED" ? "success" : "warning" },
      { label: "Score", value: `${review.efficiencyScore}/10` },
      { label: "Required", value: String(review.requiredChanges.length), tone: review.requiredChanges.length > 0 ? "warning" : "success" },
      { label: "Security", value: String(review.securityIssues.length), tone: review.securityIssues.length > 0 ? "danger" : "success" },
    ],
    flags: topFlags,
    cards: [
      {
        label: "Validation",
        title: review.testCoverageAssessment ? "Coverage assessed" : "Coverage note absent",
        body: review.testCoverageAssessment ?? "No test coverage assessment was captured.",
      },
      {
        label: "Delivered",
        title: `${completedTasks.length} completed tasks`,
        body: `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} recorded in WORK.`,
      },
      {
        label: "User view",
        title: "End-user perspective",
        body: summarizeMarkdown(review.userPerspectiveFeedback, "No end-user feedback recorded."),
      },
      {
        label: "Routing",
        title: telemetry
          ? `QA ${telemetry.routing.qa ? "used" : "skipped"} · Perf ${telemetry.routing.perf ? "used" : "skipped"} · User ${telemetry.routing.user ? "used" : "skipped"}`
          : "Routing unavailable",
        body: telemetry?.nextStep ?? "Review telemetry was not recorded.",
      },
    ],
    approveIf: [
      "The verdict and score satisfy your release bar.",
      "There are no unresolved major/critical changes you expect Morph to fix first.",
      "Security findings and coverage notes are acceptable for the release you are about to prepare.",
    ],
    pauseIf: [
      "A required change should return to WORK before any release prep begins.",
      "Security findings need triage, mitigation, or explicit acceptance.",
      "The user-perspective feedback reveals a product issue you do not want to ship.",
    ],
    sections: [
      {
        title: "Review summary",
        summary: `${severities.critical} critical · ${severities.major} major · ${severities.minor} minor`,
        open: true,
        html: `<div class="grid">
          <section class="subpanel"><h3>Technical audit</h3>${renderMarkdownLite(review.technicalAudit, "No technical audit recorded.")}</section>
          <section class="subpanel"><h3>User perspective</h3>${renderMarkdownLite(review.userPerspectiveFeedback, "No end-user feedback recorded.")}</section>
        </div>`,
      },
      {
        title: "Required changes and security",
        summary: `${review.requiredChanges.length} required changes · ${review.securityIssues.length} security issues`,
        open: review.requiredChanges.length > 0 || review.securityIssues.length > 0,
        html: `<div class="grid">
          <section class="subpanel"><h3>Required changes</h3>${renderHtmlList(review.requiredChanges.map((change) => `${change.severity}${change.taskId ? ` · ${change.taskId}` : ""}: ${change.description}`), "No required changes recorded.")}</section>
          <section class="subpanel"><h3>Security issues</h3>${renderHtmlList(review.securityIssues, "No security issues recorded.")}</section>
        </div>`,
      },
      {
        title: "Specialist evidence",
        summary: telemetry
          ? `QA ${telemetry.routing.qa ? "used" : "skipped"} · Perf ${telemetry.routing.perf ? "used" : "skipped"} · User ${telemetry.routing.user ? "used" : "skipped"}`
          : "No specialist telemetry recorded",
        html: specialistEvidence,
      },
      {
        title: "Delivered work",
        summary: `${completedTasks.length} completed tasks · ${changedFiles.length} changed files`,
        html: `<div class="grid">
          <section class="subpanel"><h3>Completed tasks</h3>${renderHtmlList(completedTasks.map((result) => `${result.taskId} — ${result.summary}`), "No completed work recorded.")}</section>
          <section class="subpanel"><h3>Changed files</h3>${renderHtmlList(changedFiles, "No changed files recorded.")}</section>
        </div>`,
      },
      {
        title: "What approving starts",
        summary: "Release preparation, not deployment",
        html: `<p>SHIP will ask DevOps and Release Consultant agents to prepare a release package, changelog, deployment checklist, rollback plan, and final handoff artifacts. Approval here does not hide review findings; it means you are comfortable moving into release preparation.</p>`,
      },
    ],
    primaryAction: "Approve & start SHIP",
    secondaryAction: "Pause pipeline",
  });
}

export function buildReviewExceptionHtml(
  state: ReturnType<Blackboard["getState"]>,
  readiness: ReviewReadinessAssessment
): string {
  const review = state.reviewOutput!;
  const telemetry = state.reviewTelemetry;
  const completedTasks = state.workResults.filter((result) => result.status === "done");
  const changedFiles = [...new Set(state.workResults.flatMap((result) => result.filesChanged))];
  const reasonFlags: BrowserGateFlag[] = readiness.reasons.map((reason) => ({
    label: "Ship-readiness floor missed",
    detail: reason,
    tone: reason.includes("security") || reason.includes("critical/major") ? "danger" : "warning",
  }));

  return renderBrowserGatePage({
    phase: "review-exception",
    eyebrow: "morph exception gate | review -> ship",
    title: "Resolve release exception",
    subtitle:
      "Morph could not satisfy the normal ship-readiness floor or map the issue to a safe targeted repair. Continuing now is an explicit human override.",
    recommendation: "Pause unless you consciously accept every exception",
    decisionSummary:
      "Accepting this exception bypasses the normal release-quality floor and starts SHIP anyway. Pausing keeps the review intact for human intervention or a later rerun.",
    metrics: [
      { label: "Verdict", value: review.status, tone: review.status === "APPROVED" ? "warning" : "danger" },
      { label: "Score", value: `${review.efficiencyScore}/10`, tone: review.efficiencyScore >= REVIEW_SCORE_FLOOR ? "neutral" : "warning" },
      { label: "Exceptions", value: String(readiness.reasons.length), tone: readiness.reasons.length > 0 ? "danger" : "neutral" },
      { label: "Security", value: String(review.securityIssues.length), tone: review.securityIssues.length > 0 ? "danger" : "success" },
    ],
    flags: reasonFlags,
    cards: [
      {
        label: "Why now",
        title: "Normal gate withheld",
        body: "This page appears only when Morph will not show the ordinary release approval gate.",
      },
      {
        label: "Automation",
        title: "No safe targeted repair",
        body: "The review is below bar, but Morph could not identify a precise task branch to repair automatically.",
      },
      {
        label: "Delivered",
        title: `${completedTasks.length} completed tasks`,
        body: `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} recorded in WORK.`,
      },
      {
        label: "Next move",
        title: telemetry?.nextStep ?? "Human judgment required",
        body: "Only accept when outside context makes the remaining exception worth shipping.",
      },
    ],
    approveIf: [
      "You understand each missed quality condition and are choosing to own it.",
      "You have external context Morph does not have that justifies shipping anyway.",
      "The cost of delaying release is higher than the known residual risk.",
    ],
    pauseIf: [
      "Any exception is surprising, unclear, or not explicitly accepted.",
      "You want a human or a future Morph run to repair the issue before release prep.",
      "The gate is missing evidence you would need to defend the override later.",
    ],
    sections: [
      {
        title: "Why this is an exception",
        summary: `${readiness.reasons.length} ship-readiness condition${readiness.reasons.length === 1 ? "" : "s"} missed`,
        open: true,
        html: renderHtmlList(readiness.reasons, "No exception reasons recorded."),
      },
      {
        title: "Review evidence",
        summary: "The evidence behind the blocked happy path",
        open: true,
        html: `<div class="grid">
          <section class="subpanel"><h3>Technical audit</h3>${renderMarkdownLite(review.technicalAudit, "No technical audit recorded.")}</section>
          <section class="subpanel"><h3>User perspective</h3>${renderMarkdownLite(review.userPerspectiveFeedback, "No end-user feedback recorded.")}</section>
        </div>`,
      },
      {
        title: "Coverage and security",
        summary: `${review.securityIssues.length} security issues | coverage ${review.testCoverageAssessment ? "recorded" : "missing"}`,
        open: review.securityIssues.length > 0 || !review.testCoverageAssessment,
        html: `<div class="grid">
          <section class="subpanel"><h3>Coverage</h3>${renderMarkdownLite(review.testCoverageAssessment ?? "", "No coverage assessment recorded.")}</section>
          <section class="subpanel"><h3>Security issues</h3>${renderHtmlList(review.securityIssues, "No security issues recorded.")}</section>
        </div>`,
      },
      {
        title: "What accepting does",
        summary: "Explicit override of the ordinary release-quality floor",
        html: `<p>Acceptance does not improve the review result. It records that a human knowingly chose to continue despite the unresolved exception, then moves Morph into SHIP for release preparation.</p>`,
      },
    ],
    primaryAction: "Accept exception & start SHIP",
    secondaryAction: "Pause for intervention",
  });
}
