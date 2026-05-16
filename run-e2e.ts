import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeSparkFlow } from "./src/flows/spark.js";
import { executePlanFlow } from "./src/flows/plan.js";
import { executeWorkFlow } from "./src/flows/work.js";
import { executeReviewFlow } from "./src/flows/review.js";
import { executeShipFlow } from "./src/flows/ship.js";
import { Blackboard } from "./src/core/blackboard.js";

// ── Check if running as mock pi ──
if (process.argv.includes("--mode") && process.argv.includes("json")) {
  const taskArg = process.argv[process.argv.length - 1];
  const task =
    taskArg?.startsWith("@") && fs.existsSync(taskArg.slice(1))
      ? fs.readFileSync(taskArg.slice(1), "utf-8")
      : taskArg;
  let outputText = "Mocked output";
  
  if (task.includes("Refine this idea into a comprehensive PRD")) {
    outputText = `### VISION STATEMENT\nMock Vision\n### CORE FEATURES\n- Feat 1\n### TARGET USER PERSONA\nMock Persona\n### CONSTRAINTS\n- Const 1\n### TECHNICAL STACK RECOMMENDATION\nMock Stack\n### RISKS\n- Risk 1\n### SUCCESS CRITERIA\n- Criteria 1`;
  } else if (task.includes("Critique this PRD")) {
    outputText = "### STRENGTHS\n- Good\n### WEAKNESSES / GAPS\n- None\n### MISSING EDGE CASES\n- None\n### RISK REASSESSMENT\n- None\n### REFINEMENT SUGGESTIONS\n- None";
  } else if (task.includes("Synthesize a FINAL, refined PRD")) {
    outputText = `### VISION STATEMENT\nMock Vision\n### CORE FEATURES\n- Feat 1\n### TARGET USER PERSONA\nMock Persona\n### CONSTRAINTS\n- Const 1\n### TECHNICAL STACK RECOMMENDATION\nMock Stack\n### RISKS\n- Risk 1\n### SUCCESS CRITERIA\n- Criteria 1`;
  } else if (task.includes("Design the complete technical plan")) {
    outputText = `### ARCHITECTURE DIAGRAM\ngraph TB\n  A --> B\n### DATA MODELS\n- Model A\n### COMPONENT TREE\n- Component A : respons\n### TASKS (DAG)\n\`\`\`json\n[\n  {\n    "id": "TASK-01",\n    "description": "Mock task",\n    "category": "other",\n    "acceptanceCriteria": "Works",\n    "estimatedComplexity": "low"\n  }\n]\n\`\`\`\n### QA STRATEGY\nMock QA\n### RISK MITIGATIONS\n- Mock risk mitigation\n### ESTIMATED EFFORT\n1 days`;
  } else if (task.includes("Review for testability")) {
    outputText = "QA output";
  } else if (task.includes("Analyze for efficiency")) {
    outputText = "Efficiency output";
  } else if (task.includes("Synthesize the FINAL plan")) {
      outputText = `### ARCHITECTURE DIAGRAM\ngraph TB\n  A --> B\n### DATA MODELS\n- Model A\n### COMPONENT TREE\n- Component A : respons\n### TASKS (DAG)\n\`\`\`json\n[\n  {\n    "id": "TASK-01",\n    "description": "Mock task",\n    "category": "other",\n    "acceptanceCriteria": "Works",\n    "estimatedComplexity": "low"\n  }\n]\n\`\`\`\n### QA STRATEGY\nMock QA\n### RISK MITIGATIONS\n- Mock risk mitigation\n### ESTIMATED EFFORT\n1 days`;
  } else if (task.includes("Implement task")) {
    outputText = "Implemented task TASK-01";
  } else if (task.includes("Review the implementation")) {
    outputText = "APPROVED\nLooks good.";
  } else if (task.includes("Analyze performance:\n\n")) {
      outputText = "Looks good.";
  } else if (task.includes("Evaluate as an end user:\n\n")) {
      outputText = "Looks good.";
  } else if (task.includes("Synthesize the final review with verdict.")) {
    outputText = `### VERDICT\nAPPROVED\n### TECHNICAL AUDIT\nLooks good.\n### EFFICIENCY SCORE\n10\n### USER PERSPECTIVE FEEDBACK\nGreat.\n### REQUIRED CHANGES\n### SECURITY ISSUES`;
  } else if (task.includes("Prepare for release")) {
    outputText = "Deployment prepared.";
  } else if (task.includes("Generate release artifacts")) {
    outputText = "Artifacts generated.";
  } else if (task.includes("Synthesize the final ship output")) {
    outputText = `### STATUS\nSHIPPED\n### VERSION\n1.0.0\n### CHANGELOG\n- Initial release\n### DEPLOYMENT CHECKLIST\n- [x] Check 1\n### ROLLBACK PLAN\nRevert to previous commit.`;
  }

  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: outputText }],
      usage: { input: 10, output: 20 }
    }
  };
  console.log(JSON.stringify(event));
  process.exit(0);
}

// ── Orchestrator ──
async function runTests() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "morph-e2e-"));

  try {
  
  // Clean up any existing state
  const bb = new Blackboard(cwd);
  bb.clearActiveAgents();
  
  console.log("==> Running Spark Phase...");
  bb.transition("spark");
  const sparkOutput = await executeSparkFlow({ cwd, prompt: "Build a to-do app", blackboard: bb });
  bb.setSparkOutput(sparkOutput);
  console.log("Spark completed:", sparkOutput.visionStatement.slice(0, 50));

  console.log("\\n==> Running Plan Phase...");
  bb.transition("plan");
  const planOutput = await executePlanFlow({ cwd, blackboard: bb });
  bb.setPlanOutput(planOutput);
  console.log("Plan completed, tasks:", planOutput.tasks.length);

  console.log("\\n==> Running Work Phase...");
  bb.transition("work");
  const workResults = await executeWorkFlow({ 
      cwd, 
      blackboard: bb,
      onWaveStart: async () => true, // auto-approve wave
  });
  console.log("Work completed, tasks done:", workResults.filter((r: any) => r.status === "done").length);

  console.log("\\n==> Running Review Phase...");
  bb.transition("review");
  const reviewOutput = await executeReviewFlow({ cwd, blackboard: bb });
  bb.setReviewOutput(reviewOutput);
  console.log("Review completed, status:", reviewOutput.status);

  console.log("\\n==> Running Ship Phase...");
  bb.transition("ship");
  const shipOutput = await executeShipFlow({ cwd, blackboard: bb });
  bb.setShipOutput(shipOutput);
  console.log("Ship completed, version:", shipOutput.version);
  
  console.log("\n[SUCCESS] ALL PHASES COMPLETED SUCCESSFULLY.");


  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (!process.argv.includes("--mode")) {
  runTests().catch(err => {
      console.error("Test failed:", err);
      process.exit(1);
  });
}
