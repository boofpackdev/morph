/**
 * morph — Token Optimizer
 *
 * Strips internal reasoning tokens, manages context sliding windows,
 * and provides token estimation utilities.
 *
 * Key principles:
 *   - Strip <think> / reasoning_content blocks before handoffs
 *   - The "Last 3" Rule: keep only last 3 turns for bug-fixing loops
 *   - Recursive summarization: condense >4000 token discussions
 */

/**
 * Strip reasoning/thinking blocks from text.
 * Handles:
 *   - <think>...</think> (DeepSeek)
 *   - <thinking>...</thinking> (Claude)
 *   - <｜end▁of▁thinking｜> (Gemini)
 *   - `reasoning_content` fields in JSON
 */
export function stripReasoningTokens(text: string): string {
  // Remove XML-style thinking blocks
  let cleaned = text.replace(
    /<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi,
    ""
  );

  // Remove Gemini-style reasoning markers
  cleaned = cleaned.replace(
    /<gm\s*>/gi,
    ""
  );

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

/**
 * Strip reasoning_content from a JSON event object (mutates in place).
 * Pi's JSON mode wraps output in events that may contain reasoning fields.
 */
export function stripJsonReasoning(obj: Record<string, unknown>): void {
  if (obj.reasoning_content) {
    delete obj.reasoning_content;
  }
  if (obj.message && typeof obj.message === "object") {
    stripJsonReasoning(obj.message as Record<string, unknown>);
  }
  if (obj.content && Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (part && typeof part === "object") {
        stripJsonReasoning(part as Record<string, unknown>);
      }
    }
  }
}

/**
 * Apply the "Last N" sliding window to an array of items.
 * Keeps the first item (context origin) and the last N items.
 */
export function slidingWindow<T>(
  items: T[],
  keepFirst: number = 1,
  keepLast: number = 3
): T[] {
  if (items.length <= keepFirst + keepLast) return items;
  const first = items.slice(0, keepFirst);
  const last = items.slice(-keepLast);
  return [...first, ...last];
}

/**
 * Estimate token count from text (rough: ~4 chars per token for English).
 */
export function estimateTokens(text: string): number {
  // More accurate: count words and adjust for code
  const words = text.split(/\s+/).length;
  const chars = text.length;
  // Weighted estimate: words for prose, chars/4 for code
  return Math.ceil(Math.max(words, chars / 4));
}

/**
 * Summarize a long discussion into a compact bulleted list.
 * This is a template — in production this calls an LLM for summarization.
 */
export function compressHistory(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 500
): string {
  if (messages.length === 0) return "";

  // For now, extract key points from each message
  const lines: string[] = ["[Compressed History]"];
  let tokenBudget = maxTokens;

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "AI" : "User";
    const excerpt = msg.content.slice(0, 200).replace(/\n/g, " ");
    const line = `- ${role}: ${excerpt}`;
    const lineTokens = estimateTokens(line);

    if (tokenBudget - lineTokens < 0) break;
    lines.push(line);
    tokenBudget -= lineTokens;
  }

  return lines.join("\n");
}

/**
 * Format token count for human display.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/**
 * Format cost for display.
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate cost from token counts using standard rates.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  inputRate: number = 3.0,       // $ per 1M input tokens (Claude Sonnet)
  outputRate: number = 15.0,     // $ per 1M output tokens
  cacheReadRate: number = 0.3,   // $ per 1M cache read tokens
  cacheWriteRate: number = 3.75  // $ per 1M cache write tokens
): number {
  return (
    (inputTokens / 1_000_000) * inputRate +
    (outputTokens / 1_000_000) * outputRate +
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate
  );
}

/**
 * Check if a discussion should be compressed (over token threshold).
 */
export function shouldCompress(messages: string[], threshold: number = 4000): boolean {
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  return totalTokens > threshold;
}
