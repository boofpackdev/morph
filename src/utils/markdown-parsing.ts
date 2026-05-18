/**
 * morph — Shared Markdown Parsing Utilities
 *
 * Extracted from plan.ts and review.ts to eliminate duplication.
 */

/** Extract a loose section between ##/### headings by its marker text. */
export function extractLooseSection(text: string, marker: string): string {
  const regex = new RegExp(
    `(?:###|##)\\s*(?:\\d+\\.\\s*)?${marker}[\\s\\S]*?(?=(?:###|##)\\s*(?:\\d+\\.\\s*)?|$)`,
    "i"
  );
  const match = text.match(regex);
  return match
    ? match[0]
        .replace(new RegExp(`^(?:###|##)\\s*(?:\\d+\\.\\s*)?${marker}\\s*`, "i"), "")
        .trim()
    : "";
}

/** Count bullet (- *) or numbered (1. 2) list items in a text block. */
export function countListItems(text: string): number {
  return text
    .split("\n")
    .filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line.trim())).length;
}

/** Return the first non-empty meaningful line, stripping list markers. */
export function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .find((line) => line.length > 0 && !/^none\b/i.test(line));
}
