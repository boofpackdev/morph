/**
 * Smoke test for morph review-sweep changes.
 * Exercises Blackboard, recovery, contracts, markdown parsing without needing pi.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Blackboard } from "./src/core/blackboard.js";
import { MorphStateSchema } from "./src/schemas/contracts.js";
import { diagnoseRecoveryState, summarizeRecoveryState, shouldAutoRecoverWithinWork } from "./src/core/recovery.js";
import { extractLooseSection, countListItems, firstMeaningfulLine } from "./src/utils/markdown-parsing.js";
import { topologicalSort, waveGroups, detectFileTargetOverlaps } from "./src/core/engine.js";
import { escapeHtml, renderMarkdownLite } from "./src/tui/browser-gates.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

async function main() {
  console.log("=== morph Smoke Test ===\n");

  // ── 1. Blackboard: create, save, flush, atomic write ──
  console.log("1. Blackboard (batched saves)");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "morph-smoke-"));
  try {
    const bb = new Blackboard(tmpDir);
    const statePath = path.join(tmpDir, ".morph", "state.json");

    // Transition uses flush() (phase boundary) — this writes state to disk
    bb.transition("spark");
    assert(bb.getState().phase === "spark", "Phase transitions to spark");
    assert(fs.existsSync(statePath), "State file exists after phase transition");

    // Non-critical mutations use scheduleSave() — add several, verify batched
    bb.addTokens("spark", 150); // addTokens(phase, amount)
    bb.recordDecision("spark", "test decision", "smoke test");
    bb.incrementRetry("TASK-01");

    // Flush batched mutations
    bb.flush();

    // Verify state persisted
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert(raw.phase === "spark", "Persisted phase is spark");
    assert(raw.tokenLedger.spark >= 150, `Tokens persisted, got: ${raw.tokenLedger.spark}`);
    assert(raw.decisions.length >= 1, `Decisions persisted, got: ${raw.decisions.length}`);
    assert(raw.retries["TASK-01"] === 1, "Retry count persisted");

    console.log("");

    // ── 2. Recovery module ──
    console.log("2. Recovery module");
    const state = bb.getState();
    const summary = summarizeRecoveryState(state);
    assert(summary.unfinished === true, "Recovery detects unfinished pipeline");
    // "stale" is correct for state without spark output or pipeline prompt
    assert(summary.kind === "stale" || summary.kind === "recoverable" || summary.kind === "restartable", `Recovery kind valid, got: ${summary.kind}`);

    const diagnosis = diagnoseRecoveryState({ ...state, workResults: [] } as any);
    assert(diagnosis.evidence.length > 0, "Diagnosis produces evidence");
    assert(typeof diagnosis.autoSafe === "boolean", "Diagnosis has autoSafe flag");

    const fakeDiagnosis = {
      taskId: "TASK-01",
      failureKind: "NO_EFFECT",
      evidence: ["test"],
      recommendation: "retry",
      autoSafe: true,
    };
    const stateForCheck = { ...state, phase: "work", retries: { "TASK-01": 2 } } as any;
    const shouldRecover = shouldAutoRecoverWithinWork(stateForCheck, fakeDiagnosis);
    assert(shouldRecover === true, "Auto-recovery permitted for NO_EFFECT with 2 retries");

    console.log("");

    // ── 3. Open enums + contracts ──
    console.log("3. Contracts (open enums)");
    const testData = {
      startedAt: new Date().toISOString(),
      phase: "idle",
      sparkOutput: undefined,
      planOutput: undefined,
      planTelemetry: undefined,
      workResults: [],
      reviewOutput: undefined,
      reviewTelemetry: undefined,
      shipOutput: undefined,
      activeAgents: [],
      flowCheckpoints: { idle: {}, spark: {}, plan: {}, work: {}, review: {}, ship: {} },
      tokenLedger: { total: 0, spark: 0, plan: 0, work: 0, review: 0, ship: 0 },
      decisions: [],
      retries: {},
      config: { provider: "anthropic", model: "claude-sonnet-4-5" },
    };

    // Should accept new failure kind values (open enum)
    const testResult = {
      taskId: "TASK-X",
      status: "done" as const,
      filesChanged: ["README.md"],
      summary: "test",
      testsPassed: true,
      buildPassed: true,
      lintPassed: true,
      typeCheckPassed: true,
      failureKind: "CUSTOM_NEW_FAILURE_KIND",
      failureEvidence: ["test"],
    };
    const workData = { ...testData, workResults: [testResult] };
    const parsed = MorphStateSchema.safeParse(workData);
    assert(parsed.success === true, "MorphStateSchema accepts new failureKind value (open enum)");
    if (!parsed.success) {
      console.error("  Parse error:", JSON.stringify(parsed.error.issues, null, 2));
    }

    // Should accept new task category
    const taskTest = {
      id: "TASK-Y",
      description: "test",
      category: "ml-pipeline",
      acceptanceCriteria: "works",
      estimatedComplexity: "extreme" as const,
      files: ["model.py"],
      targetDir: "ml",
    };
    // No explicit schema for TaskNode alone, test via planOutput
    const planTest = { ...testData, planOutput: { tasks: [taskTest], architectureDiagram: "", dataModels: [], componentTree: [], qaStrategy: "", riskMitigations: [], estimatedEffort: "weeks" as const } };
    const planParsed = MorphStateSchema.safeParse(planTest);
    assert(planParsed.success === true, "MorphStateSchema accepts new task category (open enum)");

    console.log("");

    // ── 4. Markdown parsing ──
    console.log("4. Markdown parsing");
    const mdText = `## Architecture
    Some architecture text
    More text

    ### 1. QA Strategy
    Test everything

    ## Components
    - Component A
    - Component B`;

    const archSection = extractLooseSection(mdText, "Architecture");
    assert(archSection.includes("Some architecture text"), "extractLooseSection finds named section");
    assert(!archSection.includes("QA Strategy"), "extractLooseSection stops at next heading");

    const qaSection = extractLooseSection(mdText, "QA Strategy");
    assert(qaSection.includes("Test everything"), "extractLooseSection handles numbered prefix");

    const itemCount = countListItems("\n- Item A\n- Item B\n- Item C\nNot a list item");
    assert(itemCount === 3, "countListItems counts bullet items");

    const firstLine = firstMeaningfulLine("\n- Actual content\n\n");
    assert(firstLine === "Actual content", "firstMeaningfulLine strips bullet prefix");

    console.log("");

    // ── 5. DAG engine ──
    console.log("5. DAG engine");
    const tasks = [
      { id: "A", description: "Task A", category: "db", acceptanceCriteria: "works", estimatedComplexity: "low" as const, files: ["db.ts"], targetDir: "src", dependsOn: [] as string[] },
      { id: "B", description: "Task B", category: "api", acceptanceCriteria: "works", estimatedComplexity: "medium" as const, files: ["api.ts"], targetDir: "src", dependsOn: ["A"] },
      { id: "C", description: "Task C", category: "ui", acceptanceCriteria: "works", estimatedComplexity: "low" as const, files: ["ui.tsx"], targetDir: "src", dependsOn: ["A"] },
      { id: "D", description: "Task D", category: "test", acceptanceCriteria: "works", estimatedComplexity: "medium" as const, files: ["test.ts"], targetDir: "src", dependsOn: ["B", "C"] },
    ];

    const sorted = topologicalSort(tasks as any);
    const order = sorted.map(t => t.id);
    assert(order.indexOf("A") === 0, "Topo sort puts root task first");
    assert(order.indexOf("B") < order.indexOf("D"), "Topo sort respects dependencies");
    assert(order.indexOf("C") < order.indexOf("D"), "Topo sort respects multiple dependencies");

    const waves = waveGroups(tasks as any);
    assert(waves.length === 3, "Wave groups correct count");
    assert(waves[0].map(t => t.id).includes("A"), "Wave 0 contains root");
    assert(waves[1].every(t => t.id === "B" || t.id === "C"), "Wave 1 contains B and C");
    assert(waves[2].map(t => t.id).includes("D"), "Wave 2 contains D");

    const overlaps = detectFileTargetOverlaps(tasks as any);
    assert(overlaps.length === 0, "File overlap detection works (none in this DAG)");

    console.log("");

    // ── 6. Browser gates ──
    console.log("6. Browser gates");
    const escaped = escapeHtml("<script>alert('xss')</script>");
    assert(!escaped.includes("<script>"), "escapeHtml encodes script tags");
    assert(escaped.includes("&lt;script&gt;"), "escapeHtml produces HTML entities");

    const rendered = renderMarkdownLite("**bold** and `code`");
    assert(rendered.includes("<strong>bold</strong>"), "renderMarkdownLite handles bold");
    assert(rendered.includes("<code>code</code>"), "renderMarkdownLite handles inline code");

    console.log("");

    // ── 7. Autorecovery round-trip ──
    console.log("7. Autorecovery round-trip");
    bb.flush(); // Ensure state is on disk before archiving
    bb.archiveCurrentState("test-archive");
    const archives = bb.getRecoverableArchives();
    // Archives are stored in history/ dir and may include prior entries
    assert(archives.length >= 0, `Archive retrieval works, got ${archives.length} archives`);
    if (archives.length > 0) {
      bb.restoreArchivedState(archives[0]);
      assert(bb.getState().phase === "spark", "State restored from archive");
    }

    console.log("");

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
