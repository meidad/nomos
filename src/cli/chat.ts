import { config as loadDotenv } from "dotenv";
import type { Command } from "commander";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { loadEnvConfig, validateConfig } from "../config/env.ts";
import { runMigrations } from "../db/migrate.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { isSlackConfigured, createSlackMcpServer } from "../sdk/slack-mcp.ts";
import { isDiscordConfigured, createDiscordMcpServer } from "../sdk/discord-mcp.ts";
import { isTelegramConfigured, createTelegramMcpServer } from "../sdk/telegram-mcp.ts";
import {
  isGoogleWorkspaceConfigured,
  createGoogleWorkspaceMcpConfigs,
} from "../sdk/google-workspace-mcp.ts";
import { startRepl } from "../ui/repl.tsx";
import { loadMcpConfig } from "./mcp-config.ts";
import { shouldRunWizard, runSetupWizard } from "./wizard.ts";
import { isDaemonRunning } from "../daemon/lifecycle.ts";
import { GatewayClient } from "../ui/gateway-client.ts";

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-m, --model <model>", "Model to use")
    .option("-s, --session <key>", "Resume a session by key")
    .option("--fresh", "Start a new session (don't resume default)")
    .option("--direct", "Run the SDK in-process (skip daemon even if running)")
    .action(async (options) => {
      // First-run setup wizard
      if (shouldRunWizard()) {
        await runSetupWizard();
        // Re-load env vars after wizard writes .env
        loadDotenv({ path: [".env.local", ".env"], override: true, quiet: true });
      }

      const config = loadEnvConfig();

      // Apply CLI overrides
      if (options.model) config.model = options.model;

      // Validate
      const errors = validateConfig(config);
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`Error: ${error}`);
        }
        process.exit(1);
      }

      // Run DB migrations
      await runMigrations();

      // Build MCP server map
      const mcpServers: Record<string, McpServerConfig> = {};

      // Add external MCP servers from config file
      const mcpConfig = await loadMcpConfig();
      if (mcpConfig) {
        for (const [name, serverConfig] of Object.entries(mcpConfig)) {
          mcpServers[name] = serverConfig as McpServerConfig;
        }
      }

      // Add in-process memory search MCP server
      mcpServers["assistant-memory"] = createMemoryMcpServer();

      // Add in-process channel MCP servers (when tokens are configured)
      if (isSlackConfigured()) {
        mcpServers["assistant-slack"] = createSlackMcpServer();
      }
      if (isDiscordConfigured()) {
        mcpServers["assistant-discord"] = createDiscordMcpServer();
      }
      if (isTelegramConfigured()) {
        mcpServers["assistant-telegram"] = createTelegramMcpServer();
      }
      if (isGoogleWorkspaceConfigured()) {
        Object.assign(mcpServers, createGoogleWorkspaceMcpConfigs());
      }

      // Determine session key:
      // --session <key>  → use that key (explicit resume)
      // --fresh          → generate a new key (force new session)
      // default          → "cli:default" (auto-resume)
      const sessionKey = options.session ?? (options.fresh ? `cli:${Date.now()}` : undefined);

      // If a daemon is running, connect via WebSocket instead of running the SDK in-process
      let gatewayClient: GatewayClient | undefined;
      if (!options.direct) {
        const { running } = isDaemonRunning();
        if (running) {
          const port = process.env.DAEMON_PORT ?? "8765";
          const client = new GatewayClient({ url: `ws://localhost:${port}` });
          const reachable = await client.isDaemonReachable();
          if (reachable) {
            gatewayClient = client;
            console.log(`Connecting to daemon (ws://localhost:${port})...`);
          }
        }
      }

      // Start REPL
      await startRepl({
        config,
        mcpServers,
        sessionKey,
        gatewayClient,
      });
    });
}
