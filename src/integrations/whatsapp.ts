/**
 * WhatsApp bot integration.
 *
 * Connects to WhatsApp via @whiskeysockets/baileys (WhatsApp Web multi-device protocol),
 * listens for messages (individual + group), dispatches them to the Claude Agent SDK,
 * and relays responses back.
 *
 * Usage:
 *   npx tsx src/integrations/whatsapp.ts
 *
 * Required env:
 *   DATABASE_URL           - PostgreSQL connection string
 *
 * Optional env:
 *   WHATSAPP_ALLOWED_CHATS - Comma-separated JIDs to restrict to
 *   ASSISTANT_MODEL        - Model to use (default: claude-sonnet-4-6)
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSession } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { loadEnvConfig } from "../config/env.ts";
import { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";

/** Simple logger that implements ILogger interface for Baileys */
const logger = {
  level: "info",
  child: () => logger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

/** Split long messages into chunks respecting WhatsApp's limits. */
function chunkMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= WHATSAPP_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", WHATSAPP_MAX_MESSAGE_LENGTH);
    if (splitIdx < WHATSAPP_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", WHATSAPP_MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < WHATSAPP_MAX_MESSAGE_LENGTH / 2) {
      splitIdx = WHATSAPP_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Track per-chat sessions for multi-turn context. */
const chatSessions = new Map<string, string>();

/** Allowlist parsed from env. */
const allowedChats = process.env.WHATSAPP_ALLOWED_CHATS
  ? new Set(process.env.WHATSAPP_ALLOWED_CHATS.split(",").map((s) => s.trim()))
  : null;

function isAllowed(chatJid: string): boolean {
  if (!allowedChats) return true;
  return allowedChats.has(chatJid);
}

/** Check if message is from a group and if bot is mentioned or message starts with trigger. */
function shouldRespond(message: proto.IWebMessageInfo, botNumber: string): boolean {
  const remoteJid = message.key?.remoteJid;
  if (!remoteJid) return false;

  // Individual chats (ends with @s.whatsapp.net) — always respond
  if (remoteJid.endsWith("@s.whatsapp.net")) return true;

  // Group chats (ends with @g.us)
  if (remoteJid.endsWith("@g.us")) {
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text || "";

    // Check if mentioned
    const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentions.some((jid) => jid === botNumber)) return true;

    // Check if starts with trigger prefix (/, !, @)
    if (/^[\/!@]/.test(text.trim())) return true;

    return false;
  }

  return false;
}

/** Clean message content by removing mentions and trigger prefixes. */
function cleanContent(message: proto.IWebMessageInfo, botNumber: string): string {
  const text = message.message?.conversation || message.message?.extendedTextMessage?.text || "";

  // Remove mentions
  let cleaned = text.replace(new RegExp(`@${botNumber.split("@")[0]}`, "g"), "").trim();

  // Remove trigger prefix if present
  cleaned = cleaned.replace(/^[\/!@]\s*/, "");

  return cleaned;
}

async function handleMessage(message: proto.IWebMessageInfo, sock: WASocket) {
  const remoteJid = message.key?.remoteJid;
  if (!remoteJid) return;

  const botNumber = sock.user?.id;
  if (!botNumber) return;

  if (!shouldRespond(message, botNumber)) return;
  if (!isAllowed(remoteJid)) return;

  const prompt = cleanContent(message, botNumber);
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
  await sock.sendPresenceUpdate("composing", remoteJid);

  try {
    const sessionKey = `whatsapp:${remoteJid}`;
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
      fullResponse = "_(no response)_";
    }

    // Send response, chunked if necessary
    const chunks = chunkMessage(fullResponse);
    for (const chunk of chunks) {
      await sock.sendMessage(remoteJid, { text: chunk });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[whatsapp] Error handling message:", errMsg);
    await sock
      .sendMessage(remoteJid, {
        text: `Something went wrong: ${errMsg.slice(0, 200)}`,
      })
      .catch(() => {});
  } finally {
    // Stop typing indicator
    await sock.sendPresenceUpdate("paused", remoteJid);
  }
}

export async function startWhatsAppBot(): Promise<{ sock: WASocket | undefined }> {
  // Set up auth state storage
  const authDir = path.join(os.homedir(), ".assistant", "whatsapp-auth");
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[whatsapp] Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  let sock: WASocket | undefined;

  const connectToWhatsApp = async () => {
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true,
      generateHighQualityLinkPreview: true,
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[whatsapp] QR Code generated. Scan with your phone.");
      }

      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log(
          "[whatsapp] Connection closed. Reconnect:",
          shouldReconnect,
          "Error:",
          lastDisconnect?.error,
        );

        if (shouldReconnect) {
          await connectToWhatsApp();
        }
      } else if (connection === "open") {
        console.log(`[whatsapp] Connected as ${sock?.user?.id}`);
        if (allowedChats) {
          console.log(`[whatsapp] Restricted to chats: ${[...allowedChats].join(", ")}`);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        // Only process messages sent by others (not status updates or our own messages)
        if (msg.key?.fromMe || msg.key?.remoteJid === "status@broadcast") continue;

        if (sock) {
          handleMessage(msg, sock).catch((err) => {
            console.error("[whatsapp] Unhandled error:", err);
          });
        }
      }
    });
  };

  await connectToWhatsApp();

  return { sock };
}

// Run directly if this file is the entry point
const isMain = process.argv[1]?.endsWith("whatsapp.ts") || process.argv[1]?.endsWith("whatsapp.js");
if (isMain) {
  startWhatsAppBot().catch((err) => {
    console.error("[whatsapp] Failed to start:", err);
    process.exit(1);
  });
}
