/**
 * Guard — detects critical Figma operations that could be destructive.
 *
 * Used by the Trust/Brave approval system to flag operations that
 * require explicit user approval regardless of approval mode.
 */

const CRITICAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\.remove\s*\(/, label: "node.remove()" },
  { pattern: /\.detachInstance\s*\(/, label: "detachInstance()" },
  { pattern: /\.flatten\s*\(/, label: "flatten()" },
  { pattern: /\.children\s*=\s*\[/, label: "children reassignment" },
  { pattern: /\.splice\s*\(/, label: "children.splice()" },
  { pattern: /figma\.currentPage\s*=/, label: "page switch" },
  { pattern: /\.close\s*\(\s*\)/, label: "close()" },
  { pattern: /for\s*\(.*children.*\)\s*{[^}]*\.remove/, label: "bulk remove in loop" },
  { pattern: /\.children\s*\.\s*forEach\s*\([^)]*=>\s*[^)]*\.remove/, label: "bulk remove via forEach" },
];

/**
 * Check if Figma code contains critical (potentially destructive) operations.
 * Returns the list of matched patterns, or empty array if safe.
 */
export function detectCriticalOperations(code: string): string[] {
  const matches: string[] = [];
  for (const { pattern, label } of CRITICAL_PATTERNS) {
    if (pattern.test(code)) {
      matches.push(label);
    }
  }
  return matches;
}

/**
 * Convenience: returns true if any critical operation is detected.
 */
export function isCriticalOperation(code: string): boolean {
  return detectCriticalOperations(code).length > 0;
}
