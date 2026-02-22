/**
 * Slack bot integration.
 *
 * Connects to Slack via @slack/bolt (Socket Mode), listens for mentions
 * and DMs, dispatches them to the Claude Agent SDK, and relays responses back.
 *
 * Inspired by OpenClaw's slack monitor (src/slack/monitor/).
 *
 * Usage:
 *   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... npx tsx src/integrations/slack.ts
 *
 * Required env:
 *   SLACK_BOT_TOKEN   - Slack bot OAuth token (xoxb-...)
 *   SLACK_APP_TOKEN   - Slack app-level token for Socket Mode (xapp-...)
 *   DATABASE_URL      - PostgreSQL connection string
 *
 * Optional env:
 *   SLACK_ALLOWED_CHANNELS - Comma-separated channel IDs to restrict to
 *   ASSISTANT_MODEL        - Model to use (default: claude-sonnet-4-6)
 */

import SlackBolt from "@slack/bolt";
import { runSession } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { loadEnvConfig } from "../config/env.ts";
import { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";

// Handle CJS/ESM interop for @slack/bolt
const slackBoltModule = SlackBolt as typeof import("@slack/bolt") & {
  default?: typeof import("@slack/bolt");
};
const slackBolt =
  (slackBoltModule.App ? slackBoltModule : slackBoltModule.default) ?? slackBoltModule;
const { App } = slackBolt;

const SLACK_MAX_MESSAGE_LENGTH = 4000;

/** Split long messages into chunks respecting Slack's limits. */
function chunkMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", SLACK_MAX_MESSAGE_LENGTH);
    if (splitIdx < SLACK_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", SLACK_MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < SLACK_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = SLACK_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Track per-channel sessions for multi-turn context. */
const channelSessions = new Map<string, string>();

/** Allowlist parsed from env. */
const allowedChannels = process.env.SLACK_ALLOWED_CHANNELS
  ? new Set(process.env.SLACK_ALLOWED_CHANNELS.split(",").map((s) => s.trim()))
  : null;

function isAllowed(channelId: string): boolean {
  if (!allowedChannels) return true;
  return allowedChannels.has(channelId);
}

/** Strip bot mention from message text. */
function cleanContent(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

async function handleMessage(params: {
  text: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  userId: string;
  botUserId: string;
  say: (args: { text: string; thread_ts?: string }) => Promise<unknown>;
}) {
  const { text, channelId, threadTs, messageTs, botUserId, say } = params;

  if (!isAllowed(channelId)) return;

  const prompt = cleanContent(text, botUserId);
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

  // Use thread_ts for threading context, fall back to message_ts
  const replyTs = threadTs ?? messageTs;
  const sessionKey = `slack:${channelId}:${replyTs}`;
  let resumeId = channelSessions.get(sessionKey);

  // Parent thread inheritance: if starting a new thread, carry over channel-level session
  if (!threadTs && !resumeId) {
    // This is a new message in the channel (not in a thread)
    const channelSessionKey = `slack:${channelId}:channel`;
    const channelResumeId = channelSessions.get(channelSessionKey);
    if (channelResumeId) {
      resumeId = channelResumeId;
    }
  } else if (threadTs && !resumeId) {
    // This is a new thread being started, try to inherit from channel session
    const channelSessionKey = `slack:${channelId}:channel`;
    const channelResumeId = channelSessions.get(channelSessionKey);
    if (channelResumeId) {
      resumeId = channelResumeId;
    }
  }

  try {
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
        for (const block of event.result) {
          if (block.type === "text") {
            fullResponse += block.text;
          }
        }
      }
    }

    if (sessionId) {
      channelSessions.set(sessionKey, sessionId);
      // Also update channel-level session for inheritance
      if (!threadTs) {
        const channelSessionKey = `slack:${channelId}:channel`;
        channelSessions.set(channelSessionKey, sessionId);
      }
    }

    if (!fullResponse.trim()) {
      fullResponse = "_(no response)_";
    }

    // Send response in thread, chunked if necessary
    const chunks = chunkMessage(fullResponse);
    for (const chunk of chunks) {
      await say({ text: chunk, thread_ts: replyTs });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[slack] Error handling message:", errMsg);
    await say({
      text: `Something went wrong: ${errMsg.slice(0, 200)}`,
      thread_ts: replyTs,
    }).catch(() => {});
  }
}

export async function startSlackBot() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken) {
    console.error("SLACK_BOT_TOKEN is required");
    process.exit(1);
  }
  if (!appToken) {
    console.error("SLACK_APP_TOKEN is required (for Socket Mode)");
    process.exit(1);
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Resolve bot user ID on startup
  const authResult = await app.client.auth.test({ token: botToken });
  const botUserId = authResult.user_id;
  if (!botUserId) {
    console.error("[slack] Could not resolve bot user ID");
    process.exit(1);
  }

  console.log(`[slack] Bot user ID: ${botUserId}`);

  // Handle app_mention events (when @mentioned in channels)
  app.event("app_mention", async ({ event, say }) => {
    if (!event.text || !event.user) return;
    handleMessage({
      text: event.text,
      channelId: event.channel,
      threadTs: event.thread_ts,
      messageTs: event.ts,
      userId: event.user,
      botUserId,
      say,
    }).catch((err) => {
      console.error("[slack] Unhandled error in app_mention:", err);
    });
  });

  // Handle direct messages and thread_broadcast messages
  app.event("message", async ({ event, say }) => {
    const msgEvent = event as {
      channel_type?: string;
      text?: string;
      user?: string;
      ts: string;
      thread_ts?: string;
      channel: string;
      subtype?: string;
      thread_broadcast?: boolean;
    };

    // Handle DMs
    if (msgEvent.channel_type === "im") {
      if (msgEvent.subtype) return; // Ignore message_changed, etc.
      if (!msgEvent.text || !msgEvent.user) return;
      // Ignore bot's own messages
      if (msgEvent.user === botUserId) return;

      handleMessage({
        text: msgEvent.text,
        channelId: msgEvent.channel,
        threadTs: msgEvent.thread_ts,
        messageTs: msgEvent.ts,
        userId: msgEvent.user,
        botUserId,
        say,
      }).catch((err) => {
        console.error("[slack] Unhandled error in DM:", err);
      });
      return;
    }

    // Handle thread_broadcast messages (messages in thread also posted to channel)
    // These are already handled by app_mention if the bot is mentioned
    // We just need to ensure we don't double-process them
    if (msgEvent.thread_broadcast && msgEvent.text?.includes(`<@${botUserId}>`)) {
      // Let app_mention handle this
      return;
    }
  });

  await app.start();

  console.log("[slack] Bot is running (Socket Mode)");
  if (allowedChannels) {
    console.log(`[slack] Restricted to channels: ${[...allowedChannels].join(", ")}`);
  }

  return app;
}

// Run directly if this file is the entry point
const isMain = process.argv[1]?.endsWith("slack.ts") || process.argv[1]?.endsWith("slack.js");
if (isMain) {
  startSlackBot().catch((err) => {
    console.error("[slack] Failed to start:", err);
    process.exit(1);
  });
}
