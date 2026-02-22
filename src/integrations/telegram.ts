/**
 * Telegram bot integration.
 *
 * Connects to Telegram via grammY (long polling), listens for messages
 * (DMs and group mentions), dispatches them to the Claude Agent SDK,
 * and relays responses back.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... npx tsx src/integrations/telegram.ts
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN  - Telegram bot token from @BotFather
 *   DATABASE_URL        - PostgreSQL connection string
 *
 * Optional env:
 *   TELEGRAM_ALLOWED_CHATS - Comma-separated chat IDs to restrict to
 *   ASSISTANT_MODEL        - Model to use (default: claude-sonnet-4-6)
 */

import { Bot, Context } from "grammy";
import { runSession } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { loadEnvConfig } from "../config/env.ts";
import { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Split long messages into chunks respecting Telegram's 4096 char limit. */
function chunkMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIdx < TELEGRAM_MAX_MESSAGE_LENGTH / 2) {
      // Try space
      splitIdx = remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < TELEGRAM_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = TELEGRAM_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Track per-chat sessions for multi-turn context. */
const chatSessions = new Map<string, string>();

/** Allowlist parsed from env. */
const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS
  ? new Set(process.env.TELEGRAM_ALLOWED_CHATS.split(",").map((s) => s.trim()))
  : null;

function isAllowed(chatId: number): boolean {
  if (!allowedChats) return true;
  return allowedChats.has(String(chatId));
}

function shouldRespond(ctx: Context): boolean {
  if (!ctx.message?.text) return false;

  const chat = ctx.chat;
  if (!chat) return false;

  // DMs (private chats) — always respond
  if (chat.type === "private") return true;

  // Group/supergroup — only respond when bot is mentioned
  if (chat.type === "group" || chat.type === "supergroup") {
    const botUsername = ctx.me.username;
    const text = ctx.message.text;
    return text.includes(`@${botUsername}`);
  }

  return false;
}

/** Strip bot mention from message text. */
function cleanContent(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
}

async function handleMessage(ctx: Context) {
  if (!shouldRespond(ctx)) return;
  if (!isAllowed(ctx.chat!.id)) return;

  const text = ctx.message?.text;
  if (!text) return;

  const botUsername = ctx.me.username;
  const prompt = cleanContent(text, botUsername);
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

  // Send typing indicator
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);

  try {
    const sessionKey = `telegram:${ctx.chat!.id}`;
    const resumeId = chatSessions.get(sessionKey);

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
      chatSessions.set(sessionKey, sessionId);
    }

    if (!fullResponse.trim()) {
      fullResponse = "*(no response)*";
    }

    // Send response, chunked if necessary
    const chunks = chunkMessage(fullResponse);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[telegram] Error handling message:", errMsg);
    await ctx.reply(`Something went wrong: ${errMsg.slice(0, 200)}`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is required");
    process.exit(1);
  }

  const bot = new Bot(token);

  // Log bot info on start
  const me = await bot.api.getMe();
  console.log(`[telegram] Logged in as @${me.username}`);
  if (allowedChats) {
    console.log(`[telegram] Restricted to chats: ${[...allowedChats].join(", ")}`);
  }

  // Handle all text messages
  bot.on("message:text", (ctx) => {
    handleMessage(ctx).catch((err) => {
      console.error("[telegram] Unhandled error:", err);
    });
  });

  // Start long polling
  await bot.start();
  console.log("[telegram] Bot is running (long polling)");

  return bot;
}

// Run directly if this file is the entry point
const isMain = process.argv[1]?.endsWith("telegram.ts") || process.argv[1]?.endsWith("telegram.js");
if (isMain) {
  startTelegramBot().catch((err) => {
    console.error("[telegram] Failed to start:", err);
    process.exit(1);
  });
}
