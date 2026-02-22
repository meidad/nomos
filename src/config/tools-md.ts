import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load TOOLS.md environment config file from filesystem.
 * Search locations (first found wins):
 * 1. ./.assistant/TOOLS.md (project-local)
 * 2. ~/.assistant/TOOLS.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadToolsFile(): string | null {
  const searchPaths = [
    path.resolve(".assistant", "TOOLS.md"),
    path.join(os.homedir(), ".assistant", "TOOLS.md"),
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
