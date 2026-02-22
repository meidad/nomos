/**
 * Discord bot integration.
 *
 * Connects to Discord via discord.js, listens for messages (mentions + DMs),
 * dispatches them to the Claude Agent SDK, and relays responses back.
 *
 * Inspired by OpenClaw's discord monitor (src/discord/monitor/).
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... npx tsx src/integrations/discord.ts
 *
 * Required env:
 *   DISCORD_BOT_TOKEN  - Discord bot token
 *   DATABASE_URL       - PostgreSQL connection string
 *
 * Optional env:
 *   DISCORD_ALLOWED_CHANNELS - Comma-separated channel IDs to restrict to
 *   DISCORD_ALLOWED_GUILDS   - Comma-separated guild IDs to restrict to
 *   DISCORD_AUTO_THREAD      - Enable auto-threading for long conversations (default: false)
 *   ASSISTANT_MODEL          - Model to use (default: claude-sonnet-4-6)
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { runSession } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { loadEnvConfig } from "../config/env.ts";
import { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** Split long messages into chunks respecting Discord's 2000 char limit. */
function chunkMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf("\n", DISCORD_MAX_MESSAGE_LENGTH);
    if (splitIdx < DISCORD_MAX_MESSAGE_LENGTH / 2) {
      // Try space
      splitIdx = remaining.lastIndexOf(" ", DISCORD_MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < DISCORD_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = DISCORD_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Track per-channel sessions for multi-turn context. */
const channelSessions = new Map<string, string>();

/** Allowlists parsed from env. */
const allowedChannels = process.env.DISCORD_ALLOWED_CHANNELS
  ? new Set(process.env.DISCORD_ALLOWED_CHANNELS.split(",").map((s) => s.trim()))
  : null;
const allowedGuilds = process.env.DISCORD_ALLOWED_GUILDS
  ? new Set(process.env.DISCORD_ALLOWED_GUILDS.split(",").map((s) => s.trim()))
  : null;

/** Auto-threading configuration. */
const autoThreadEnabled = process.env.DISCORD_AUTO_THREAD === "true";

function isAllowed(message: Message): boolean {
  // Always allow DMs
  if (!message.guild) return true;

  if (allowedGuilds && !allowedGuilds.has(message.guild.id)) return false;
  if (allowedChannels && !allowedChannels.has(message.channelId)) return false;

  return true;
}

function shouldRespond(message: Message, botId: string): boolean {
  // Ignore own messages
  if (message.author.id === botId) return false;
  // Ignore other bots
  if (message.author.bot) return false;

  // DMs — always respond
  if (!message.guild) return true;

  // Guild messages — only respond when mentioned
  return message.mentions.has(botId);
}

/** Strip the bot mention from the message content. */
function cleanContent(message: Message, botId: string): string {
  return message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

async function handleMessage(message: Message, client: Client) {
  const botId = client.user?.id;
  if (!botId) return;

  if (!shouldRespond(message, botId)) return;
  if (!isAllowed(message)) return;

  const prompt = cleanContent(message, botId);
  if (!prompt) return;

  const cfg = loadEnvConfig();
  const [identity, profile] = await Promise.all([loadAgentIdentity(), loadUserProfile()]);

  const skills = loadSkills();
  const skillsPrompt = formatSkillsForPrompt(skills);
  const soulPrompt = loadSoulFile();

  const systemPromptAppend = buildSystemPromptAppend({
    profile,
    identity,
    skillsPrompt: skillsPrompt || undefined,
    soulPrompt: soulPrompt ?? undefined,
  });

  const memoryServer = createMemoryMcpServer();

  // Show typing indicator
  const channel = message.channel as TextChannel;
  const typing = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 5000);
  channel.sendTyping().catch(() => {});

  try {
    // Use thread channel ID if in a thread, otherwise use channel ID
    const isThread = message.channel.isThread();
    const channelId = isThread ? message.channelId : message.channelId;
    const sessionKey = `discord:${channelId}`;
    let resumeId = channelSessions.get(sessionKey);

    // Parent thread inheritance: if in a new thread, try to inherit parent channel session
    if (isThread && !resumeId && message.channel.isThread()) {
      const parentChannelId = message.channel.parentId;
      if (parentChannelId) {
        const parentSessionKey = `discord:${parentChannelId}`;
        const parentResumeId = channelSessions.get(parentSessionKey);
        if (parentResumeId) {
          resumeId = parentResumeId;
        }
      }
    }

    const session = runSession({
      prompt,
      model: cfg.model,
      systemPromptAppend,
      mcpServers: { "assistant-memory": memoryServer },
      allowedTools: ["mcp__assistant-memory"],
      permissionMode: cfg.permissionMode,
      resume: resumeId,
      maxTurns: 10,
    });

    let fullResponse = "";
    let sessionId: string | undefined;

    for await (const event of session) {
      if (event.type === "result") {
        sessionId = event.session_id;
        // Extract final text from result
        for (const block of event.result) {
          if (block.type === "text") {
            fullResponse += block.text;
          }
        }
      }
    }

    // Save session for resume
    if (sessionId) {
      channelSessions.set(sessionKey, sessionId);
    }

    if (!fullResponse.trim()) {
      fullResponse = "*(no response)*";
    }

    // Send response, chunked if necessary
    const chunks = chunkMessage(fullResponse);

    // Auto-threading: create thread for long conversations in non-thread channels
    if (autoThreadEnabled && !isThread && chunks.length > 1 && message.guild) {
      try {
        const thread = await message.startThread({
          name: `Conversation with ${message.author.username}`,
          autoArchiveDuration: 60,
        });
        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      } catch (err) {
        console.error("[discord] Failed to create thread, falling back to replies:", err);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      }
    } else {
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[discord] Error handling message:", errMsg);
    await message.reply(`Something went wrong: ${errMsg.slice(0, 200)}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

export async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN is required");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] Logged in as ${c.user.tag}`);
    if (allowedGuilds)
      console.log(`[discord] Restricted to guilds: ${[...allowedGuilds].join(", ")}`);
    if (allowedChannels)
      console.log(`[discord] Restricted to channels: ${[...allowedChannels].join(", ")}`);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message, client).catch((err) => {
      console.error("[discord] Unhandled error:", err);
    });
  });

  await client.login(token);
  return client;
}

// Run directly if this file is the entry point
const isMain = process.argv[1]?.endsWith("discord.ts") || process.argv[1]?.endsWith("discord.js");
if (isMain) {
  startDiscordBot().catch((err) => {
    console.error("[discord] Failed to start:", err);
    process.exit(1);
  });
}
