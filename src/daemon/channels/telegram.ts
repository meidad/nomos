/**
 * Thin Telegram channel adapter for the daemon.
 */

import { Bot } from "grammy";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import { randomUUID } from "node:crypto";

const MAX_LENGTH = 4096;

function chunk(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = MAX_LENGTH;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram";
  private bot: Bot | null = null;
  private onMessage: (msg: IncomingMessage) => void;

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN required");

    this.bot = new Bot(token);

    const me = await this.bot.api.getMe();
    console.log(`[telegram-adapter] Logged in as @${me.username}`);

    this.bot.on("message:text", (ctx) => {
      const chat = ctx.chat;
      if (!chat) return;

      // Private chats always respond; groups only when mentioned
      if (chat.type !== "private") {
        const botUsername = ctx.me.username;
        if (!ctx.message.text.includes(`@${botUsername}`)) return;
      }

      const botUsername = ctx.me.username;
      const content = ctx.message.text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
      if (!content) return;

      this.onMessage({
        id: randomUUID(),
        platform: "telegram",
        channelId: String(chat.id),
        userId: String(ctx.from?.id ?? "unknown"),
        content,
        timestamp: new Date(),
      });
    });

    // Start long polling (non-blocking)
    this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.bot) return;
    const chatId = message.channelId;
    const chunks = chunk(message.content);
    for (const text of chunks) {
      await this.bot.api.sendMessage(chatId, text);
    }
  }
}
