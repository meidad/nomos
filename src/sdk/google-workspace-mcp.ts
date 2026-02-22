/**
 * Google Workspace MCP server configuration.
 *
 * Unlike Slack/Discord/Telegram (in-process MCP servers), this is an
 * external stdio MCP server — the SDK spawns `uvx workspace-mcp` as
 * a child process. We just provide the configuration.
 *
 * Supports multiple Google accounts: set GOOGLE_WORKSPACE_EMAILS to a
 * comma-separated list of emails. Each email gets its own server instance,
 * authenticated independently. The agent sees separate tool sets per account.
 *
 * Requires: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env
 * Requires: Python 3.10+ and uvx (uv) installed on the system
 *
 * @see https://github.com/taylorwilsdon/google_workspace_mcp
 */

import { randomBytes } from "node:crypto";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Check if Google Workspace credentials are configured.
 */
export function isGoogleWorkspaceConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/**
 * Get the list of Google accounts to connect.
 *
 * Priority:
 * 1. GOOGLE_WORKSPACE_EMAILS — comma-separated list of emails
 * 2. USER_GOOGLE_EMAIL — single email
 * 3. Empty array (server will prompt for auth on first use)
 */
function getAccountEmails(): string[] {
  const multi = process.env.GOOGLE_WORKSPACE_EMAILS;
  if (multi) {
    return multi
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  }
  const single = process.env.USER_GOOGLE_EMAIL;
  if (single) {
    return [single.trim()];
  }
  return [];
}

/** Generate a short random suffix for MCP server names. */
function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** Build the base args for `uvx workspace-mcp`. */
function buildArgs(): string[] {
  const toolTier = process.env.GOOGLE_WORKSPACE_TOOL_TIER ?? "core";
  const tools = process.env.GOOGLE_WORKSPACE_TOOLS;

  const args = ["workspace-mcp"];
  if (tools) {
    args.push("--tools", ...tools.split(/[\s,]+/).filter(Boolean));
  } else {
    args.push("--tool-tier", toolTier);
  }
  return args;
}

/** Build the base env for the child process. */
function buildEnv(email?: string): Record<string, string> {
  const env: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    OAUTHLIB_INSECURE_TRANSPORT: "1",
  };

  if (email) {
    env.USER_GOOGLE_EMAIL = email;
  }
  if (process.env.GOOGLE_PSE_API_KEY) {
    env.GOOGLE_PSE_API_KEY = process.env.GOOGLE_PSE_API_KEY;
  }
  if (process.env.GOOGLE_PSE_ENGINE_ID) {
    env.GOOGLE_PSE_ENGINE_ID = process.env.GOOGLE_PSE_ENGINE_ID;
  }
  return env;
}

/**
 * Create MCP server configs for all configured Google accounts.
 *
 * Returns a map of server name → config:
 * - Single account: { "google-workspace": config }
 * - Multiple accounts: { "google-workspace-work": config, "google-workspace-personal": config, ... }
 *
 * Each account gets its own `uvx workspace-mcp` process with
 * USER_GOOGLE_EMAIL set to that account's email. Tokens are cached
 * per-email by the workspace-mcp server.
 */
export function createGoogleWorkspaceMcpConfigs(): Record<string, McpServerConfig> {
  const emails = getAccountEmails();
  const result: Record<string, McpServerConfig> = {};

  if (emails.length <= 1) {
    // Single account (or no email specified — server prompts on first use)
    result["google-workspace"] = {
      type: "stdio",
      command: "uvx",
      args: buildArgs(),
      env: buildEnv(emails[0]),
    } as McpServerConfig;
  } else {
    // Multiple accounts — one server instance per email
    for (const email of emails) {
      result[`google-workspace-${randomSuffix()}`] = {
        type: "stdio",
        command: "uvx",
        args: buildArgs(),
        env: buildEnv(email),
      } as McpServerConfig;
    }
  }

  return result;
}
