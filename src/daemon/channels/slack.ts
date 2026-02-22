/**
 * Thin Slack channel adapter for the daemon.
 *
 * Handles Slack auth and event parsing. All agent logic lives in AgentRuntime.
 */

import SlackBolt from "@slack/bolt";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { randomUUID } from "node:crypto";

// CJS/ESM interop
const slackBoltModule = SlackBolt as typeof import("@slack/bolt") & {
  default?: typeof import("@slack/bolt");
};
const slackBolt =
  (slackBoltModule.App ? slackBoltModule : slackBoltModule.default) ?? slackBoltModule;
const { App } = slackBolt;

const MAX_LENGTH = 4000;

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

export class SlackAdapter implements ChannelAdapter {
  readonly platform = "slack";
  private app: InstanceType<typeof App> | null = null;
  private botUserId: string | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager | null;

  constructor(onMessage: (msg: IncomingMessage) => void, draftManager?: DraftManager) {
    this.onMessage = onMessage;
    this.draftManager = draftManager ?? null;
  }

  async start(): Promise<void> {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!botToken || !appToken) {
      throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN required");
    }

    this.app = new App({ token: botToken, appToken, socketMode: true });

    const auth = await this.app.client.auth.test({ token: botToken });
    this.botUserId = auth.user_id ?? null;

    this.app.event("app_mention", async ({ event }) => {
      if (!event.text || !event.user) return;
      const content = event.text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
      if (!content) return;
      this.onMessage({
        id: randomUUID(),
        platform: "slack",
        channelId: event.channel,
        userId: event.user,
        threadId: event.thread_ts ?? event.ts,
        content,
        timestamp: new Date(),
      });
    });

    this.app.event("message", async ({ event }) => {
      const e = event as {
        channel_type?: string;
        text?: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
        subtype?: string;
      };
      if (e.channel_type !== "im" || e.subtype || !e.text || !e.user) return;
      if (e.user === this.botUserId) return;
      this.onMessage({
        id: randomUUID(),
        platform: "slack",
        channelId: e.channel,
        userId: e.user,
        threadId: e.thread_ts ?? e.ts,
        content: e.text.trim(),
        timestamp: new Date(),
      });
    });

    // Register draft approval button handlers (only if DraftManager is available)
    if (this.draftManager) {
      const dm = this.draftManager;

      this.app.action("approve_draft", async ({ action, ack, respond }) => {
        await ack();
        const draftId = (action as { value?: string }).value;
        if (!draftId) return;
        const result = await dm.approve(draftId);
        await respond({
          replace_original: true,
          text: result.success
            ? `:white_check_mark: Draft ${draftId.slice(0, 8)} approved and sent`
            : `:x: Failed: ${result.error}`,
        });
      });

      this.app.action("reject_draft", async ({ action, ack, respond }) => {
        await ack();
        const draftId = (action as { value?: string }).value;
        if (!draftId) return;
        const result = await dm.reject(draftId);
        await respond({
          replace_original: true,
          text: result.success
            ? `:no_entry_sign: Draft ${draftId.slice(0, 8)} rejected`
            : `:x: Failed: ${result.error}`,
        });
      });
    }

    await this.app.start();
    console.log(`[slack-adapter] Running (bot: ${this.botUserId})`);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.app) return;
    const token = process.env.SLACK_BOT_TOKEN!;
    const chunks = chunk(message.content);
    for (const text of chunks) {
      await this.app.client.chat.postMessage({
        token,
        channel: message.channelId,
        text,
        thread_ts: message.threadId,
      });
    }
  }

  async postMessage(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string | undefined> {
    if (!this.app) return undefined;
    const result = await this.app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN!,
      channel: channelId,
      text,
      thread_ts: threadId,
    });
    return result.ts;
  }

  async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.app) return;
    await this.app.client.chat.update({
      token: process.env.SLACK_BOT_TOKEN!,
      channel: channelId,
      ts: messageId,
      text,
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.app) return;
    await this.app.client.chat.delete({
      token: process.env.SLACK_BOT_TOKEN!,
      channel: channelId,
      ts: messageId,
    });
  }
}
