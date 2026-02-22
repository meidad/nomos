import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Constant returned by the agent to signal "no action needed" on heartbeat check.
 */
export const HEARTBEAT_OK = "HEARTBEAT_OK";

/**
 * Load HEARTBEAT.md file from filesystem.
 * Search locations (first found wins):
 * 1. ./.assistant/HEARTBEAT.md (project-local)
 * 2. ~/.assistant/HEARTBEAT.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadHeartbeatFile(): string | null {
  const searchPaths = [
    path.resolve(".assistant", "HEARTBEAT.md"),
    path.join(os.homedir(), ".assistant", "HEARTBEAT.md"),
  ];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        // Skip if unreadable
        continue;
      }
    }
  }

  return null;
}

/**
 * Check if heartbeat content is empty or contains only non-actionable content.
 * @param content - The heartbeat file content
 * @returns true if content is only whitespace, comments, or empty markdown headers
 */
export function isHeartbeatEmpty(content: string): boolean {
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === "") continue;

    // Skip comments (HTML-style or markdown <!-- -->)
    if (trimmed.startsWith("<!--") || trimmed.startsWith("//")) continue;

    // Skip markdown headers that are just headers (no content after #)
    if (/^#+\s*$/.test(trimmed)) continue;

    // If we find any non-empty, non-comment, non-empty-header line, it's not empty
    return false;
  }

  return true;
}

/**
 * Strip the HEARTBEAT_OK token from response text if present.
 * @param text - The assistant's response text
 * @returns null if response is just HEARTBEAT_OK (suppress), otherwise the original text
 */
export function stripHeartbeatToken(text: string): string | null {
  const trimmed = text.trim();

  // Check for plain HEARTBEAT_OK
  if (trimmed === HEARTBEAT_OK) {
    return null;
  }

  // Check for markdown-wrapped HEARTBEAT_OK (e.g., `HEARTBEAT_OK` or **HEARTBEAT_OK**)
  const markdownWrapped = /^[`*_]+HEARTBEAT_OK[`*_]+$/;
  if (markdownWrapped.test(trimmed)) {
    return null;
  }

  // Check for code block wrapped HEARTBEAT_OK
  const codeBlockPattern = /^```[\w]*\s*HEARTBEAT_OK\s*```$/s;
  if (codeBlockPattern.test(trimmed)) {
    return null;
  }

  // Return original text if not just the token
  return text;
}
