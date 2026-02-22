/**
 * Thin Discord channel adapter for the daemon.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import { randomUUID } from "node:crypto";

const MAX_LENGTH = 2000;

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

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord";
  private client: Client | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  // Map channelId → last Message for reply
  private lastMessages = new Map<string, Message>();

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error("DISCORD_BOT_TOKEN required");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord-adapter] Logged in as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (message) => {
      const botId = this.client?.user?.id;
      if (!botId) return;
      if (message.author.id === botId || message.author.bot) return;
      // DMs always, guilds only when mentioned
      if (message.guild && !message.mentions.has(botId)) return;

      const content = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
      if (!content) return;

      this.lastMessages.set(message.channelId, message);

      this.onMessage({
        id: randomUUID(),
        platform: "discord",
        channelId: message.channelId,
        userId: message.author.id,
        content,
        timestamp: new Date(),
        metadata: { guildId: message.guild?.id },
      });
    });

    await this.client.login(token);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.lastMessages.clear();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(message.channelId);
    if (!channel || !("send" in channel)) return;

    const chunks = chunk(message.content);
    const originalMsg = this.lastMessages.get(message.channelId);

    for (const text of chunks) {
      if (originalMsg) {
        await originalMsg.reply(text);
      } else {
        await (channel as TextChannel).send(text);
      }
    }
  }
}
