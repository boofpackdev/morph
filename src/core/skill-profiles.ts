export type SkillProfileId =
  | "spec-driven-development"
  | "planning-and-task-breakdown"
  | "debugging-and-error-recovery";

export interface SkillProfile {
  id: SkillProfileId;
  label: string;
  purpose: string;
  principles: string[];
  checks: string[];
}

const SKILL_PROFILES: Record<SkillProfileId, SkillProfile> = {
  "spec-driven-development": {
    id: "spec-driven-development",
    label: "Spec-Driven Development",
    purpose: "Turn vague intent into an implementation-ready product contract before design work begins.",
    principles: [
      "Separate explicit user intent from pipeline assumptions.",
      "Prefer falsifiable success criteria over attractive prose.",
      "Name the deliverable, runtime, distribution path, constraints, and non-goals early.",
    ],
    checks: [
      "Could a second team build the same thing from this spec?",
      "Are the success criteria observable rather than subjective?",
      "Did any requirement sneak in without support from the user's request?",
    ],
  },
  "planning-and-task-breakdown": {
    id: "planning-and-task-breakdown",
    label: "Planning & Task Breakdown",
    purpose: "Produce small, dependency-aware work units that are easy to execute, verify, and recover.",
    principles: [
      "Decompose by deliverable slice, not by abstract activity.",
      "Every task should have a verifiable outcome, file targets, and a reason to exist.",
      "Dependencies should express real blocking relationships, not ceremony.",
    ],
    checks: [
      "Would one broad task hide multiple failure modes?",
      "Can independent tasks run in parallel safely?",
      "Does each component map to concrete implementation work and acceptance criteria?",
    ],
  },
  "debugging-and-error-recovery": {
    id: "debugging-and-error-recovery",
    label: "Debugging & Error Recovery",
    purpose: "Convert failure into diagnosis, next evidence, and the smallest safe retry.",
    principles: [
      "Classify the failure before retrying it.",
      "Prefer one high-signal probe over a theatrical pile of guesses.",
      "Retry only the smallest scope that can falsify the current hypothesis.",
    ],
    checks: [
      "What changed, what did not, and what evidence proves that?",
      "Is this a task failure, a dependency failure, or a state failure?",
      "What is the next cheapest action that increases certainty?",
    ],
  },
};

export function renderSkillProfiles(ids: SkillProfileId[]): string {
  if (!ids.length) return "";

  return [
    "## Applied Skill Profiles",
    ...ids.flatMap((id) => {
      const profile = SKILL_PROFILES[id];
      return [
        `### ${profile.label}`,
        profile.purpose,
        "",
        "Principles:",
        ...profile.principles.map((item) => `- ${item}`),
        "",
        "Self-check before finalizing:",
        ...profile.checks.map((item) => `- ${item}`),
        "",
      ];
    }),
  ].join("\n").trim();
}

export function listSkillProfileLabels(ids: SkillProfileId[]): string[] {
  return ids.map((id) => SKILL_PROFILES[id].label);
}
