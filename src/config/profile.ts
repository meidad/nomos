import { getConfigValue } from "../db/config.ts";

export interface UserProfile {
  name?: string;
  timezone?: string;
  workspace?: string;
  instructions?: string;
}

export interface AgentIdentity {
  name: string;
  emoji?: string;
  purpose?: string;
}

export async function loadUserProfile(): Promise<UserProfile> {
  const [name, timezone, workspace, instructions] = await Promise.all([
    getConfigValue<string>("user.name"),
    getConfigValue<string>("user.timezone"),
    getConfigValue<string>("user.workspace"),
    getConfigValue<string>("user.instructions"),
  ]);
  return {
    name: name ?? undefined,
    timezone: timezone ?? undefined,
    workspace: workspace ?? undefined,
    instructions: instructions ?? undefined,
  };
}

export async function loadAgentIdentity(): Promise<AgentIdentity> {
  const [name, emoji, purpose] = await Promise.all([
    getConfigValue<string>("agent.name"),
    getConfigValue<string>("agent.emoji"),
    getConfigValue<string>("agent.purpose"),
  ]);
  return {
    name: name ?? "Nomos",
    emoji: emoji ?? undefined,
    purpose: purpose ?? undefined,
  };
}

export function buildRuntimeInfo(): string {
  const parts: string[] = [];

  // OS
  parts.push(`OS: ${process.platform}`);

  // Architecture
  parts.push(`Arch: ${process.arch}`);

  // Shell
  const shell = process.env.SHELL ?? "unknown";
  parts.push(`Shell: ${shell}`);

  // Node version
  parts.push(`Node: ${process.version}`);

  // Current working directory
  parts.push(`CWD: ${process.cwd()}`);

  return parts.join("\n");
}

export function buildSystemPromptAppend(params: {
  profile: UserProfile;
  identity: AgentIdentity;
  skillsPrompt?: string;
  soulPrompt?: string;
  toolsPrompt?: string;
  runtimeInfo?: string;
  agentPrompt?: string;
}): string {
  const sections: string[] = [];

  // Personality (from SOUL.md)
  if (params.soulPrompt) {
    sections.push(
      `## Personality\n${params.soulPrompt}\n\nEmbody this personality in all responses.`,
    );
  }

  // Environment Configuration (from TOOLS.md)
  if (params.toolsPrompt) {
    sections.push(`## Environment Configuration\n${params.toolsPrompt}`);
  }

  // Agent identity and purpose
  const identityParts: string[] = [];
  if (params.identity.purpose) {
    identityParts.push(
      `## Purpose\nYou are: ${params.identity.purpose}\nThis is your core role. Let it shape how you respond, what you prioritize, and how you approach problems.`,
    );
  }
  if (params.identity.name !== "Nomos") {
    identityParts.push(`Your name is ${params.identity.name}.`);
  }
  if (identityParts.length > 0) {
    sections.push(identityParts.join("\n"));
  }

  // User profile
  const profileParts: string[] = [];
  if (params.profile.name) {
    profileParts.push(`The user's name is ${params.profile.name}.`);
  }
  if (params.profile.timezone) {
    profileParts.push(
      `The user's timezone is ${params.profile.timezone}. Use this for time-aware responses.`,
    );
  }
  if (params.profile.workspace) {
    profileParts.push(`Project context: ${params.profile.workspace}`);
  }
  if (profileParts.length > 0) {
    sections.push("## User Profile\n" + profileParts.join("\n"));
  }

  // Custom instructions
  if (params.profile.instructions) {
    sections.push("## Custom Instructions\n" + params.profile.instructions);
  }

  // Runtime environment
  if (params.runtimeInfo) {
    sections.push("## Runtime Environment\n" + params.runtimeInfo);
  }

  // Agent-specific instructions (from agents.json)
  if (params.agentPrompt) {
    sections.push("## Agent Instructions\n" + params.agentPrompt);
  }

  // Memory instructions
  sections.push(
    `## Memory
You have access to a memory_search tool that queries a PostgreSQL-backed vector store.
- At the start of each conversation, proactively search memory for context about the user and their current projects.
- When the user shares important facts, preferences, or project details, note them for future reference.
- Reference relevant information from previous conversations when it helps provide better responses.
- Use memory search when the user asks about previously discussed topics, code, or knowledge.`,
  );

  // Skills
  if (params.skillsPrompt) {
    sections.push(params.skillsPrompt);
  }

  return sections.filter(Boolean).join("\n\n");
}
