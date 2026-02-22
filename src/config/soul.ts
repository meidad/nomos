import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load SOUL.md personality file from filesystem.
 * Search locations (first found wins):
 * 1. ./.assistant/SOUL.md (project-local)
 * 2. ~/.assistant/SOUL.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadSoulFile(): string | null {
  const searchPaths = [
    path.resolve(".assistant", "SOUL.md"),
    path.join(os.homedir(), ".assistant", "SOUL.md"),
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
