#!/usr/bin/env node

/**
 * morph — CLI Entry Point
 *
 * Standalone CLI for debugging/scripting:
 *   morph status   — Show pipeline state
 *   morph reset    — Reset pipeline
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const command = args[0] || "help";

const STATE_DIR = ".morph";
const STATE_FILE = path.join(STATE_DIR, "state.json");

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return null;
}

function printHelp() {
  console.log(`
morph — Agent Orchestration Layer for pi

Usage (inside pi interactive mode):
  /morph:spark <idea>   Refine idea into PRD
  /morph:plan           Create architecture plan
  /morph:work           Execute implementation tasks
  /morph:review         Audit implementation
  /morph:ship           Release with verification
  /morph:status         Show pipeline status
  /morph:reset [phase]  Reset pipeline
  /morph:team           Show agent team composition

Standalone CLI:
  morph status          Show current pipeline state
  morph reset           Reset pipeline
  morph help            Show this help
`);
}

function printStatus() {
  const state = loadState();
  if (!state) {
    console.log("No morph pipeline state found. Start with /morph:spark <idea> inside pi.");
    return;
  }

  console.log(`Phase: ${state.phase}`);
  console.log(`Started: ${state.startedAt || "unknown"}`);
  console.log(`Tokens: ${JSON.stringify(state.tokenLedger)}`);

  if (state.sparkOutput) {
    console.log(`\nSpark: ${(state.sparkOutput.visionStatement || "").slice(0, 100)}...`);
    console.log(`Features: ${(state.sparkOutput.coreFeatures || []).length}`);
  }

  if (state.planOutput) {
    console.log(`\nPlan: ${(state.planOutput.tasks || []).length} tasks`);
    const done = (state.workResults || []).filter(function(r) { return r.status === "done"; }).length;
    console.log(`Progress: ${done}/${(state.planOutput.tasks || []).length}`);
  }

  if (state.reviewOutput) {
    console.log(`\nReview: ${state.reviewOutput.status} (${state.reviewOutput.efficiencyScore}/10)`);
  }

  if (state.shipOutput) {
    console.log(`\nShip: ${state.shipOutput.status} v${state.shipOutput.version}`);
  }
}

function resetPipeline() {
  if (fs.existsSync(STATE_DIR)) {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    console.log("morph pipeline reset.");
  } else {
    console.log("No pipeline state to reset.");
  }
}

switch (command) {
  case "status":
    printStatus();
    break;
  case "reset":
    resetPipeline();
    break;
  case "help":
  case "--help":
  case "-h":
  default:
    printHelp();
}
