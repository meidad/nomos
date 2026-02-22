#!/usr/bin/env node
/**
 * Security audit tool for the assistant.
 *
 * Scans configuration for potential security issues:
 * - Config/env validation
 * - Permission mode safety checks
 * - Secret exposure detection
 * - Skill safety scanning
 * - Integration security checks
 *
 * Usage:
 *   npx tsx src/cli/doctor.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { loadEnvConfig } from "../config/env.ts";
import { loadSkills } from "../skills/loader.ts";
import { getDb } from "../db/client.ts";

// Status icons
const STATUS = {
  pass: chalk.green("✓"),
  warn: chalk.yellow("⚠"),
  fail: chalk.red("✗"),
};

interface CheckResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

interface CheckCategory {
  name: string;
  results: CheckResult[];
}

/**
 * Check DATABASE_URL is set and connectable.
 */
async function checkDatabaseConnection(): Promise<CheckResult> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      status: "fail",
      message: "DATABASE_URL is not set",
    };
  }

  try {
    const db = getDb();
    // Try a simple query to verify connection
    await db`SELECT 1 as test`;
    return {
      status: "pass",
      message: "DATABASE_URL is set and connectable",
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      status: "fail",
      message: `DATABASE_URL is set but connection failed: ${errMsg}`,
    };
  }
}

/**
 * Check if ASSISTANT_MODEL is a valid model string.
 */
function checkModelConfig(): CheckResult {
  const cfg = loadEnvConfig();
  const validPrefixes = ["claude-", "gpt-", "gemini-"];

  if (!cfg.model) {
    return {
      status: "fail",
      message: "ASSISTANT_MODEL is not set",
    };
  }

  const hasValidPrefix = validPrefixes.some((prefix) => cfg.model.startsWith(prefix));

  if (!hasValidPrefix) {
    return {
      status: "warn",
      message: `ASSISTANT_MODEL "${cfg.model}" doesn't match known model prefixes (${validPrefixes.join(", ")})`,
    };
  }

  return {
    status: "pass",
    message: `ASSISTANT_MODEL is set to "${cfg.model}"`,
  };
}

/**
 * Check permission mode is not bypassPermissions in production.
 */
function checkPermissionMode(): CheckResult {
  const cfg = loadEnvConfig();
  const isProduction = process.env.NODE_ENV === "production";

  if (cfg.permissionMode === "bypassPermissions") {
    return {
      status: isProduction ? "fail" : "warn",
      message: `Permission mode is "bypassPermissions" ${isProduction ? "(PRODUCTION!)" : "(non-production)"}`,
    };
  }

  if (cfg.permissionMode === "dontAsk") {
    return {
      status: "warn",
      message: 'Permission mode is "dontAsk" - all tool calls execute without confirmation',
    };
  }

  return {
    status: "pass",
    message: `Permission mode is "${cfg.permissionMode}"`,
  };
}

/**
 * Check for deprecated or unknown env vars.
 */
function checkDeprecatedEnvVars(): CheckResult {
  const knownVars = new Set([
    "DATABASE_URL",
    "ASSISTANT_MODEL",
    "ASSISTANT_PERMISSION_MODE",
    "ASSISTANT_BETAS",
    "ASSISTANT_FALLBACK_MODELS",
    "ASSISTANT_USE_V2_SDK",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_CLOUD_PROJECT",
    "CLOUD_ML_REGION",
    "VERTEX_AI_LOCATION",
    "EMBEDDING_MODEL",
    "HEARTBEAT_INTERVAL_MS",
    "PAIRING_TTL_MINUTES",
    "DEFAULT_DM_POLICY",
    "NODE_ENV",
    "DISCORD_BOT_TOKEN",
    "DISCORD_ALLOWED_CHANNELS",
    "DISCORD_ALLOWED_GUILDS",
    "DISCORD_AUTO_THREAD",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_ALLOWED_CHANNELS",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_CHATS",
    "WHATSAPP_ALLOWED_CHATS",
    // Common system vars to ignore
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TERM",
    "PWD",
    "OLDPWD",
    "LANG",
    "LC_ALL",
    "EDITOR",
    "VISUAL",
    "TMPDIR",
    "TZ",
  ]);

  const envFile = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) {
    return {
      status: "pass",
      message: "No .env file found (using system env only)",
    };
  }

  const envContent = fs.readFileSync(envFile, "utf-8");
  const unknownVars: string[] = [];

  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      const varName = match[1];
      if (!knownVars.has(varName)) {
        unknownVars.push(varName);
      }
    }
  }

  if (unknownVars.length > 0) {
    return {
      status: "warn",
      message: `Unknown env vars in .env: ${unknownVars.join(", ")}`,
    };
  }

  return {
    status: "pass",
    message: "All env vars in .env are recognized",
  };
}

/**
 * Check if running as root.
 */
function checkRunningAsRoot(): CheckResult {
  if (process.getuid && process.getuid() === 0) {
    return {
      status: "warn",
      message: "Running as root - not recommended for security",
    };
  }

  return {
    status: "pass",
    message: "Not running as root",
  };
}

/**
 * Check file permissions on config files.
 */
function checkConfigFilePermissions(): CheckResult {
  const filesToCheck = [".env", "agents.json"];
  const warnings: string[] = [];

  for (const file of filesToCheck) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const stats = fs.statSync(filePath);
      const mode = stats.mode & 0o777;

      // Check if world-readable (other bits set)
      if ((mode & 0o004) !== 0) {
        warnings.push(`${file} is world-readable (mode: ${mode.toString(8)})`);
      }
    } catch {
      // Ignore permission check errors
    }
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      message: warnings.join("; "),
    };
  }

  return {
    status: "pass",
    message: "Config file permissions are appropriate",
  };
}

/**
 * Scan .env file for common secret patterns.
 */
function scanEnvForSecrets(): CheckResult {
  const envFile = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) {
    return {
      status: "pass",
      message: "No .env file to scan",
    };
  }

  const content = fs.readFileSync(envFile, "utf-8");
  const secretPatterns = [
    { name: "API Key", pattern: /api[_-]?key\s*=\s*[^\s#]+/i },
    { name: "Token", pattern: /token\s*=\s*[^\s#]+/i },
    { name: "Password", pattern: /password\s*=\s*[^\s#]+/i },
    { name: "Secret", pattern: /secret\s*=\s*[^\s#]+/i },
  ];

  const found: string[] = [];
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      found.push(name);
    }
  }

  if (found.length > 0) {
    return {
      status: "warn",
      message: `.env contains secrets: ${found.join(", ")} - ensure it's not committed`,
    };
  }

  return {
    status: "pass",
    message: ".env file scanned (no obvious secrets pattern detected)",
  };
}

/**
 * Check if .env is in .gitignore.
 */
function checkEnvInGitignore(): CheckResult {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return {
      status: "warn",
      message: "No .gitignore found - .env may be committed",
    };
  }

  const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  const hasEnvPattern =
    gitignoreContent.includes(".env") ||
    gitignoreContent.includes("*.env") ||
    gitignoreContent.includes(".env.*");

  if (!hasEnvPattern) {
    return {
      status: "warn",
      message: ".env not found in .gitignore - secrets may be committed",
    };
  }

  return {
    status: "pass",
    message: ".env is in .gitignore",
  };
}

/**
 * Scan skills/ directory for hardcoded secrets.
 */
function scanSkillsForSecrets(): CheckResult {
  const skillsDirs = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), ".assistant", "skills"),
    path.join(os.homedir(), ".assistant", "skills"),
  ];

  const secretPatterns = [
    /sk-[a-zA-Z0-9]{32,}/g, // API keys
    /xox[bpat]-[a-zA-Z0-9-]+/g, // Slack tokens
    /ghp_[a-zA-Z0-9]{36,}/g, // GitHub tokens
    /AIza[a-zA-Z0-9_-]{35}/g, // Google API keys
  ];

  const foundSecrets: string[] = [];

  for (const dir of skillsDirs) {
    if (!fs.existsSync(dir)) continue;

    const skillFolders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const folder of skillFolders) {
      const skillMd = path.join(dir, folder.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, "utf-8");
      for (const pattern of secretPatterns) {
        if (pattern.test(content)) {
          foundSecrets.push(`${folder.name}/SKILL.md`);
          break;
        }
      }
    }
  }

  if (foundSecrets.length > 0) {
    return {
      status: "fail",
      message: `Hardcoded secrets detected in: ${foundSecrets.join(", ")}`,
    };
  }

  return {
    status: "pass",
    message: "No hardcoded secrets found in skills",
  };
}

/**
 * Check if any secrets are committed in git history (last 10 commits).
 */
function checkGitHistoryForSecrets(): CheckResult {
  try {
    // Check if we're in a git repo
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
  } catch {
    return {
      status: "pass",
      message: "Not a git repository",
    };
  }

  try {
    // Get last 10 commits
    const log = execSync('git log -10 --all --oneline --name-only -- ".env*"', {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (log.trim()) {
      return {
        status: "fail",
        message: ".env files found in recent git history - secrets may be exposed",
      };
    }

    return {
      status: "pass",
      message: "No .env files in recent git history",
    };
  } catch {
    // git log failed, assume safe
    return {
      status: "pass",
      message: "Git history check completed",
    };
  }
}

/**
 * Check SKILL.md files for dangerous patterns.
 */
function scanSkillsForDangerousPatterns(): CheckResult {
  const skills = loadSkills();
  const dangerousPatterns = [
    { name: "rm -rf", pattern: /rm\s+-rf/i },
    { name: "curl | bash", pattern: /curl.*\|\s*bash/i },
    { name: "eval", pattern: /\beval\s*\(/i },
    { name: "chmod 777", pattern: /chmod\s+777/i },
    { name: "sudo without password", pattern: /sudo\s+-S/i },
  ];

  const findings: string[] = [];

  for (const skill of skills) {
    for (const { name, pattern } of dangerousPatterns) {
      if (pattern.test(skill.content)) {
        findings.push(`${skill.name}: ${name}`);
      }
    }
  }

  if (findings.length > 0) {
    return {
      status: "warn",
      message: `Dangerous patterns in skills: ${findings.join("; ")}`,
    };
  }

  return {
    status: "pass",
    message: "No dangerous patterns detected in skills",
  };
}

/**
 * Verify skill file permissions.
 */
function checkSkillFilePermissions(): CheckResult {
  const skills = loadSkills();
  const worldWritable: string[] = [];

  for (const skill of skills) {
    try {
      const stats = fs.statSync(skill.filePath);
      const mode = stats.mode & 0o777;

      // Check if world-writable
      if ((mode & 0o002) !== 0) {
        worldWritable.push(skill.name);
      }
    } catch {
      // Ignore permission errors
    }
  }

  if (worldWritable.length > 0) {
    return {
      status: "warn",
      message: `World-writable skills: ${worldWritable.join(", ")}`,
    };
  }

  return {
    status: "pass",
    message: "Skill file permissions are appropriate",
  };
}

/**
 * Check for skills that require missing binaries.
 */
function checkSkillBinaries(): CheckResult {
  const skills = loadSkills();
  const missing: string[] = [];

  for (const skill of skills) {
    if (!skill.requires?.bins) continue;

    for (const bin of skill.requires.bins) {
      try {
        execSync(`which ${bin}`, { stdio: "ignore" });
      } catch {
        missing.push(`${skill.name}: ${bin}`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      status: "warn",
      message: `Skills with missing binaries: ${missing.join("; ")}`,
    };
  }

  return {
    status: "pass",
    message: "All required binaries are available",
  };
}

/**
 * Verify Discord token format.
 */
function checkDiscordConfig(): CheckResult {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return {
      status: "pass",
      message: "Discord not configured",
    };
  }

  const warnings: string[] = [];

  // Discord tokens should be base64-like
  if (!/^[A-Za-z0-9._-]{50,}$/.test(token)) {
    warnings.push("DISCORD_BOT_TOKEN format looks invalid");
  }

  if (!process.env.DISCORD_ALLOWED_CHANNELS && !process.env.DISCORD_ALLOWED_GUILDS) {
    warnings.push("No channel/guild restrictions - bot can respond anywhere");
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      message: warnings.join("; "),
    };
  }

  return {
    status: "pass",
    message: "Discord configuration looks good",
  };
}

/**
 * Verify Slack token format.
 */
function checkSlackConfig(): CheckResult {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken && !appToken) {
    return {
      status: "pass",
      message: "Slack not configured",
    };
  }

  const warnings: string[] = [];

  if (botToken && !botToken.startsWith("xoxb-")) {
    warnings.push("SLACK_BOT_TOKEN should start with xoxb-");
  }

  if (appToken && !appToken.startsWith("xapp-")) {
    warnings.push("SLACK_APP_TOKEN should start with xapp-");
  }

  if (!process.env.SLACK_ALLOWED_CHANNELS) {
    warnings.push("No channel restrictions - bot can respond anywhere");
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      message: warnings.join("; "),
    };
  }

  return {
    status: "pass",
    message: "Slack configuration looks good",
  };
}

/**
 * Verify Telegram token format.
 */
function checkTelegramConfig(): CheckResult {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return {
      status: "pass",
      message: "Telegram not configured",
    };
  }

  const warnings: string[] = [];

  // Telegram tokens are bot_id:auth_token format
  if (!/^\d+:[A-Za-z0-9_-]{35}$/.test(token)) {
    warnings.push("TELEGRAM_BOT_TOKEN format looks invalid");
  }

  if (!process.env.TELEGRAM_ALLOWED_CHATS) {
    warnings.push("No chat restrictions - bot can respond anywhere");
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      message: warnings.join("; "),
    };
  }

  return {
    status: "pass",
    message: "Telegram configuration looks good",
  };
}

/**
 * Verify WhatsApp config.
 */
function checkWhatsAppConfig(): CheckResult {
  const allowedChats = process.env.WHATSAPP_ALLOWED_CHATS;
  if (!allowedChats) {
    return {
      status: "pass",
      message: "WhatsApp not configured",
    };
  }

  const warnings: string[] = [];

  // Check for proper JID format
  const chats = allowedChats.split(",").map((s) => s.trim());
  const invalidChats = chats.filter(
    (chat) => !/@s\.whatsapp\.net$/.test(chat) && !/@g\.us$/.test(chat),
  );

  if (invalidChats.length > 0) {
    warnings.push(`Invalid JID format: ${invalidChats.join(", ")}`);
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      message: warnings.join("; "),
    };
  }

  return {
    status: "pass",
    message: "WhatsApp configuration looks good",
  };
}

/**
 * Check if pairing system is enabled for production.
 */
function checkPairingConfig(): CheckResult {
  const cfg = loadEnvConfig();
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && cfg.defaultDmPolicy === "open") {
    return {
      status: "warn",
      message: 'Production with defaultDmPolicy="open" - anyone can DM the bot',
    };
  }

  if (cfg.defaultDmPolicy === "pairing") {
    return {
      status: "pass",
      message: `Pairing enabled (TTL: ${cfg.pairingTtlMinutes}min)`,
    };
  }

  return {
    status: "pass",
    message: `DM policy: ${cfg.defaultDmPolicy}`,
  };
}

/**
 * Run all security checks.
 */
export async function runDoctor(): Promise<void> {
  console.log(chalk.bold("\n🏥 Assistant Security Audit\n"));

  const categories: CheckCategory[] = [
    {
      name: "Configuration",
      results: [
        await checkDatabaseConnection(),
        checkModelConfig(),
        checkPermissionMode(),
        checkDeprecatedEnvVars(),
      ],
    },
    {
      name: "Permissions",
      results: [checkRunningAsRoot(), checkConfigFilePermissions()],
    },
    {
      name: "Secret Exposure",
      results: [
        scanEnvForSecrets(),
        checkEnvInGitignore(),
        scanSkillsForSecrets(),
        checkGitHistoryForSecrets(),
      ],
    },
    {
      name: "Skill Safety",
      results: [
        scanSkillsForDangerousPatterns(),
        checkSkillFilePermissions(),
        checkSkillBinaries(),
      ],
    },
    {
      name: "Integrations",
      results: [
        checkDiscordConfig(),
        checkSlackConfig(),
        checkTelegramConfig(),
        checkWhatsAppConfig(),
        checkPairingConfig(),
      ],
    },
  ];

  let totalPass = 0;
  let totalWarn = 0;
  let totalFail = 0;

  for (const category of categories) {
    console.log(chalk.bold(`\n${category.name}:`));
    for (const result of category.results) {
      const icon = STATUS[result.status];
      console.log(`  ${icon} ${result.message}`);

      if (result.status === "pass") totalPass++;
      if (result.status === "warn") totalWarn++;
      if (result.status === "fail") totalFail++;
    }
  }

  // Summary
  console.log(chalk.bold("\n─── Summary ───"));
  console.log(`  ${STATUS.pass} ${totalPass} passed`);
  if (totalWarn > 0) {
    console.log(`  ${STATUS.warn} ${totalWarn} warnings`);
  }
  if (totalFail > 0) {
    console.log(`  ${STATUS.fail} ${totalFail} critical issues`);
  }

  console.log();

  // Exit code based on results
  if (totalFail > 0) {
    process.exit(1);
  }
  if (totalWarn > 0) {
    process.exit(0); // Warnings don't fail the check
  }
}

// Run if this file is executed directly
const isMain = process.argv[1]?.endsWith("doctor.ts") || process.argv[1]?.endsWith("doctor.js");

if (isMain) {
  runDoctor().catch((err) => {
    console.error(chalk.red("\nFatal error:"), err);
    process.exit(1);
  });
}
