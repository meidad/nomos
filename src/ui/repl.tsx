import React from "react";
import { render } from "ink";
import chalk from "chalk";
import type { AssistantConfig } from "../config/env.ts";
import {
  loadUserProfile,
  loadAgentIdentity,
  buildSystemPromptAppend,
  buildRuntimeInfo,
} from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadToolsFile } from "../config/tools-md.ts";
import { loadAgentConfigs, getActiveAgent } from "../config/agents.ts";
import { closeDb } from "../db/client.ts";
import { getTranscript } from "../db/transcripts.ts";
import { createSession } from "../db/sessions.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";
import { showBanner } from "./banner.ts";
import type { McpServerConfig } from "../sdk/session.ts";
import { App } from "./components/App.tsx";
import type { GatewayClient } from "./gateway-client.ts";

export interface ReplOptions {
  config: AssistantConfig;
  /** MCP server configs to pass to the SDK (external + in-process) */
  mcpServers: Record<string, McpServerConfig>;
  sessionKey?: string;
  /** When provided, the REPL connects to the daemon via WebSocket instead of running the SDK in-process. */
  gatewayClient?: GatewayClient;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  // Use a stable session key so the same conversation resumes across restarts.
  // Only use a timestamp key when the user explicitly asks for a new session.
  const sessionKey = options.sessionKey ?? "cli:default";

  const session = await createSession({
    sessionKey,
    model: options.config.model,
  });

  // Load existing transcript
  const existingTranscript = await getTranscript(session.id);
  const transcript: Array<{ role: string; content: string }> = existingTranscript.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  // Load saved SDK session ID from DB for conversation resume
  const savedSdkSessionId =
    typeof (session.metadata as Record<string, unknown>)?.sdkSessionId === "string"
      ? ((session.metadata as Record<string, unknown>).sdkSessionId as string)
      : null;

  // Load personalization from DB
  const profile = await loadUserProfile();
  const identity = await loadAgentIdentity();

  // Load skills from filesystem
  const skills = loadSkills();
  const skillsPrompt = formatSkillsForPrompt(skills);

  // Load personality from SOUL.md
  const soulPrompt = loadSoulFile();

  // Load environment config from TOOLS.md
  const toolsPrompt = loadToolsFile();

  // Load agent configs and apply overrides
  const agentConfigs = loadAgentConfigs();
  const activeAgent = getActiveAgent(agentConfigs);
  if (activeAgent.model) {
    options.config.model = activeAgent.model;
  }

  // Build runtime info
  const runtimeInfo = buildRuntimeInfo();

  // Build dynamic system prompt
  const systemPromptAppend = buildSystemPromptAppend({
    profile,
    identity,
    skillsPrompt: skillsPrompt || undefined,
    soulPrompt: soulPrompt || undefined,
    toolsPrompt: toolsPrompt || undefined,
    runtimeInfo,
    agentPrompt: activeAgent.systemPrompt || undefined,
  });

  // Show banner (before ink takes over stdout)
  showBanner({
    agentName: identity.name,
    agentEmoji: identity.emoji,
    version: "0.1.0",
    model: options.config.model,
    sessionKey: session.session_key,
    resumedCount: transcript.length > 0 ? transcript.length : undefined,
  });

  if (skills.length > 0) {
    console.log(chalk.dim(`  ${skills.length} skill(s) loaded`));
  }

  // Render the ink app
  const instance = render(
    <App
      config={options.config}
      mcpServers={options.mcpServers}
      session={session}
      transcript={transcript}
      systemPromptAppend={systemPromptAppend}
      identity={identity}
      gatewayClient={options.gatewayClient}
      savedSdkSessionId={savedSdkSessionId}
    />,
  );

  await instance.waitUntilExit();

  const name = identity.name !== "Assistant" ? identity.name : "";
  console.log(chalk.dim(`\nGoodbye${name ? ` from ${name}` : ""}!`));
  await closeDb();
  process.exit(0);
}
