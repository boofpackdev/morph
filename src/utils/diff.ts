/**
 * morph — Diff Utility
 *
 * Git-style diffing for token efficiency. Instead of outputting entire files,
 * agents produce patches (diffs) for review and application.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SAFE_FILENAME_RE = /^[a-zA-Z0-9._\-\/]+$/;

/**
 * Generate a unified diff between two strings (old and new content).
 * Uses git diff when available, falls back to simple line diff.
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filename: string = "file"
): string {
  // Try git diff for reliable unified diffs
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error(`Unsafe filename: ${filename.replace(/[^a-zA-Z0-9._\-\/]/g, "?")}`);
  }
  try {
    const tmpDir = fs.mkdtempSync("morph-diff-");
    const oldPath = path.join(tmpDir, `a_${filename}`);
    const newPath = path.join(tmpDir, `b_${filename}`);

    fs.writeFileSync(oldPath, oldContent, "utf-8");
    fs.writeFileSync(newPath, newContent, "utf-8");

    const diff = execFileSync(
      "git",
      ["diff", "--no-index", "--unified=3", "--", oldPath, newPath],
      { encoding: "utf-8", timeout: 5000 }
    );

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return diff;
  } catch {
    // git diff returns exit code 1 when files differ (expected)
    // If it failed entirely, fall back
    return simpleDiff(oldContent, newContent, filename);
  }
}

/**
 * Simple line-based diff fallback.
 */
function simpleDiff(
  oldContent: string,
  newContent: string,
  filename: string
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const output: string[] = [];

  output.push(`--- a/${filename}`);
  output.push(`+++ b/${filename}`);
  output.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  // Simple LCS-based diff
  const lcs = longestCommonSubsequence(oldLines, newLines);
  let oi = 0;
  let ni = 0;

  for (const line of lcs) {
    // Output removed lines
    while (oi < oldLines.length && oldLines[oi] !== line) {
      output.push(`-${oldLines[oi]}`);
      oi++;
    }
    // Output added lines
    while (ni < newLines.length && newLines[ni] !== line) {
      output.push(`+${newLines[ni]}`);
      ni++;
    }
    // Common line
    output.push(` ${line}`);
    oi++;
    ni++;
  }

  // Remaining removals
  while (oi < oldLines.length) {
    output.push(`-${oldLines[oi]}`);
    oi++;
  }
  // Remaining additions
  while (ni < newLines.length) {
    output.push(`+${newLines[ni]}`);
    ni++;
  }

  return output.join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Apply a unified diff patch to content. Returns new content.
 */
export function applyDiff(content: string, diff: string): string {
  try {
    const tmpDir = fs.mkdtempSync("morph-apply-");
    const filePath = path.join(tmpDir, "file");
    fs.writeFileSync(filePath, content, "utf-8");

    const diffPath = path.join(tmpDir, "patch.diff");
    fs.writeFileSync(diffPath, diff, "utf-8");

    execFileSync("git", ["apply", "--", diffPath], {
      cwd: tmpDir,
      encoding: "utf-8",
      timeout: 5000,
    });

    const result = fs.readFileSync(filePath, "utf-8");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  } catch {
    throw new Error("Failed to apply diff patch");
  }
}

/**
 * Check if two files differ (for change detection).
 */
export function hasChanges(
  oldContent: string,
  newContent: string
): boolean {
  return oldContent !== newContent;
}

/**
 * Extract changed line ranges from a diff.
 */
export function changedRanges(diff: string): Array<{
  start: number;
  end: number;
}> {
  const ranges: Array<{ start: number; end: number }> = [];
  const hunkRegex = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g;

  let match: RegExpExecArray | null;
  while ((match = hunkRegex.exec(diff)) !== null) {
    const start = parseInt(match[3], 10);
    const count = parseInt(match[4] || "1", 10);
    ranges.push({ start, end: start + count - 1 });
  }

  return ranges;
}
