/**
 * Centralized agent runtime for the daemon.
 *
 * Loads config, identity, profile, skills, and MCP once at startup (cached).
 * Processes messages through the Claude Agent SDK via `runSession()`.
 * Manages SDK session IDs backed by the DB sessions table.
 */

import { randomUUID } from "node:crypto";
import { runSession, type McpServerConfig, type SDKMessage } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { isSlackConfigured, createSlackMcpServer } from "../sdk/slack-mcp.ts";
import { isDiscordConfigured, createDiscordMcpServer } from "../sdk/discord-mcp.ts";
import { isTelegramConfigured, createTelegramMcpServer } from "../sdk/telegram-mcp.ts";
import {
  isGoogleWorkspaceConfigured,
  createGoogleWorkspaceMcpConfigs,
} from "../sdk/google-workspace-mcp.ts";
import { loadEnvConfig, type AssistantConfig } from "../config/env.ts";
import {
  loadUserProfile,
  loadAgentIdentity,
  buildSystemPromptAppend,
  buildRuntimeInfo,
  type UserProfile,
  type AgentIdentity,
} from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadToolsFile } from "../config/tools-md.ts";
import { loadAgentConfigs, getActiveAgent } from "../config/agents.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";
import { loadMcpConfig } from "../cli/mcp-config.ts";
import { createSession as createDbSession, getSessionByKey } from "../db/sessions.ts";
import { runMigrations } from "../db/migrate.ts";
import type { IncomingMessage, OutgoingMessage, AgentEvent } from "./types.ts";

export class AgentRuntime {
  // Cached at startup
  private config!: AssistantConfig;
  private profile!: UserProfile;
  private identity!: AgentIdentity;
  private systemPromptAppend!: string;
  private mcpServers!: Record<string, McpServerConfig>;

  // SDK session ID cache: sessionKey → SDK session ID
  private sdkSessionIds = new Map<string, string>();

  private initialized = false;

  /** Initialize the runtime: run migrations, load all config. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Run DB migrations
    await runMigrations();

    // Load config
    this.config = loadEnvConfig();

    // Apply agent config overrides
    const agentConfigs = loadAgentConfigs();
    const activeAgent = getActiveAgent(agentConfigs);
    if (activeAgent.model) {
      this.config.model = activeAgent.model;
    }

    // Load personalization
    [this.profile, this.identity] = await Promise.all([loadUserProfile(), loadAgentIdentity()]);

    // Load skills
    const skills = loadSkills();
    const skillsPrompt = formatSkillsForPrompt(skills);

    // Load personality
    const soulPrompt = loadSoulFile();

    // Load environment config
    const toolsPrompt = loadToolsFile();

    // Build runtime info
    const runtimeInfo = buildRuntimeInfo();

    // Build system prompt
    this.systemPromptAppend = buildSystemPromptAppend({
      profile: this.profile,
      identity: this.identity,
      skillsPrompt: skillsPrompt || undefined,
      soulPrompt: soulPrompt ?? undefined,
      toolsPrompt: toolsPrompt ?? undefined,
      runtimeInfo,
      agentPrompt: activeAgent.systemPrompt || undefined,
    });

    // Build MCP servers
    this.mcpServers = {};
    const mcpConfig = await loadMcpConfig();
    if (mcpConfig) {
      for (const [name, serverConfig] of Object.entries(mcpConfig)) {
        this.mcpServers[name] = serverConfig as McpServerConfig;
      }
    }
    this.mcpServers["assistant-memory"] = createMemoryMcpServer();

    // Channel MCP servers (when tokens are configured)
    if (isSlackConfigured()) {
      this.mcpServers["assistant-slack"] = createSlackMcpServer();
    }
    if (isDiscordConfigured()) {
      this.mcpServers["assistant-discord"] = createDiscordMcpServer();
    }
    if (isTelegramConfigured()) {
      this.mcpServers["assistant-telegram"] = createTelegramMcpServer();
    }
    if (isGoogleWorkspaceConfigured()) {
      Object.assign(this.mcpServers, createGoogleWorkspaceMcpConfigs());
    }

    this.initialized = true;
    console.log("[agent-runtime] Initialized");
    console.log(`[agent-runtime]   Model: ${this.config.model}`);
    console.log(`[agent-runtime]   Identity: ${this.identity.emoji ?? ""} ${this.identity.name}`);
    console.log(`[agent-runtime]   MCP servers: ${Object.keys(this.mcpServers).join(", ")}`);
  }

  /** Get the loaded config. */
  getConfig(): AssistantConfig {
    return this.config;
  }

  /** Get the loaded identity. */
  getIdentity(): AgentIdentity {
    return this.identity;
  }

  /**
   * Process an incoming message through the agent.
   * Streams events via `emit` and returns the final response.
   */
  async processMessage(
    message: IncomingMessage,
    emit: (event: AgentEvent) => void,
  ): Promise<OutgoingMessage> {
    if (!this.initialized) {
      throw new Error("AgentRuntime not initialized — call initialize() first");
    }

    const sessionKey = `${message.platform}:${message.channelId}`;

    // Ensure DB session exists
    const dbSession = await createDbSession({
      sessionKey,
      model: this.config.model,
    });

    // Look up cached SDK session ID for resume
    let resumeId = this.sdkSessionIds.get(sessionKey);

    // Also check DB metadata for SDK session ID
    if (!resumeId) {
      const existingSession = await getSessionByKey(sessionKey);
      const sdkId = (existingSession?.metadata as Record<string, unknown>)?.sdkSessionId;
      if (typeof sdkId === "string") {
        resumeId = sdkId;
        this.sdkSessionIds.set(sessionKey, sdkId);
      }
    }

    emit({
      type: "system",
      subtype: "status",
      message: "Processing...",
    });

    try {
      const result = await this.runAgent(message.content, resumeId, emit);

      // Cache the new SDK session ID
      if (result.sessionId) {
        this.sdkSessionIds.set(sessionKey, result.sessionId);
      }

      return {
        inReplyTo: message.id,
        platform: message.platform,
        channelId: message.channelId,
        threadId: message.threadId,
        content: result.text || "_(no response)_",
        sessionId: result.sessionId,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // If resume failed, retry without resume
      if (resumeId && /session|conversation/i.test(errMsg)) {
        this.sdkSessionIds.delete(sessionKey);

        emit({
          type: "system",
          subtype: "status",
          message: "Session expired, starting fresh...",
        });

        try {
          const result = await this.runAgent(message.content, undefined, emit);

          if (result.sessionId) {
            this.sdkSessionIds.set(sessionKey, result.sessionId);
          }

          return {
            inReplyTo: message.id,
            platform: message.platform,
            channelId: message.channelId,
            threadId: message.threadId,
            content: result.text || "_(no response)_",
            sessionId: result.sessionId,
          };
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          emit({ type: "error", message: retryMsg });
          throw retryErr;
        }
      }

      emit({ type: "error", message: errMsg });
      throw err;
    }
  }

  /** Run the SDK agent and collect events. */
  private async runAgent(
    prompt: string,
    resumeId: string | undefined,
    emit: (event: AgentEvent) => void,
  ): Promise<{ text: string; sessionId?: string }> {
    // Auto-approve all tools from our MCP servers
    const allowedTools = Object.keys(this.mcpServers).map((name) => `mcp__${name}`);

    const sdkQuery = runSession({
      prompt,
      model: this.config.model,
      systemPromptAppend: this.systemPromptAppend,
      mcpServers: this.mcpServers,
      // Daemon runs unattended — no human to approve tool calls.
      // Use bypassPermissions so tools like filesystem search and web search work.
      permissionMode: "bypassPermissions",
      allowedTools,
      resume: resumeId,
      maxTurns: 50,
    });

    let fullText = "";
    let sessionId: string | undefined;

    for await (const msg of sdkQuery) {
      // Forward all SDK events to the emitter
      switch (msg.type) {
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              fullText += block.text;
            }
          }
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "stream_event": {
          emit({ type: "stream_event", event: msg });
          break;
        }

        case "tool_use_summary": {
          emit({
            type: "tool_use_summary",
            tool_name: (msg as { tool_name?: string }).tool_name ?? "unknown",
            summary: msg.summary,
          });
          break;
        }

        case "result": {
          sessionId = msg.session_id;
          for (const block of msg.result) {
            if (block.type === "text") {
              fullText += block.text;
            }
          }
          emit({
            type: "result",
            result: msg.result,
            usage: msg.usage,
            total_cost_usd: msg.total_cost_usd,
            session_id: msg.session_id,
          });
          break;
        }

        case "system": {
          const sysMsg = msg as {
            session_id?: string;
            subtype: string;
            tools?: unknown[];
            mcp_servers?: unknown[];
            status?: string;
            compact_metadata?: { trigger: string; pre_tokens: number };
          };
          if (sysMsg.session_id && !sessionId) {
            sessionId = sysMsg.session_id;
          }
          emit({
            type: "system",
            subtype: sysMsg.subtype,
            message: formatSystemMessage(sysMsg),
            data: sysMsg as unknown as Record<string, unknown>,
          });
          break;
        }

        default:
          break;
      }
    }

    return { text: fullText, sessionId };
  }
}

function formatSystemMessage(msg: {
  subtype: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  status?: string;
  compact_metadata?: { trigger: string; pre_tokens: number };
}): string {
  if (msg.subtype === "init") {
    const toolCount = (msg.tools as unknown[])?.length ?? 0;
    const mcpCount = (msg.mcp_servers as unknown[])?.length ?? 0;
    return `${toolCount} tools, ${mcpCount} MCP servers`;
  }
  if (msg.subtype === "status" && msg.status === "compacting") {
    return "Compacting conversation...";
  }
  if (msg.subtype === "compact_boundary" && msg.compact_metadata) {
    const preTokens = msg.compact_metadata.pre_tokens;
    const formatted = preTokens >= 1000 ? `${(preTokens / 1000).toFixed(1)}K` : String(preTokens);
    return `Context compacted (was ~${formatted} tokens)`;
  }
  return msg.subtype;
}
