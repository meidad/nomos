/**
 * Channel manager: registers and manages the lifecycle of channel adapters.
 */

import type { ChannelAdapter, OutgoingMessage } from "./types.ts";

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private started = false;

  /** Register a channel adapter. Must be called before start(). */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`Adapter for platform "${adapter.platform}" already registered`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  /** Start all registered adapters. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        try {
          await adapter.start();
          console.log(`[channel-manager] Started: ${adapter.platform}`);
        } catch (err) {
          console.error(`[channel-manager] Failed to start ${adapter.platform}:`, err);
          throw err;
        }
      }),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[channel-manager] ${failures.length}/${this.adapters.size} adapter(s) failed to start`,
      );
    }
  }

  /** Stop all adapters gracefully. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        try {
          await adapter.stop();
          console.log(`[channel-manager] Stopped: ${adapter.platform}`);
        } catch (err) {
          console.error(`[channel-manager] Error stopping ${adapter.platform}:`, err);
        }
      }),
    );
  }

  /** Send a message back through the appropriate channel adapter. */
  async send(message: OutgoingMessage): Promise<void> {
    const adapter = this.adapters.get(message.platform);
    if (!adapter) {
      console.warn(`[channel-manager] No adapter for platform "${message.platform}"`);
      return;
    }
    await adapter.send(message);
  }

  /** Look up a registered adapter by platform name. */
  getAdapter(platform: string): ChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  /** List registered platform names. */
  listPlatforms(): string[] {
    return [...this.adapters.keys()];
  }
}
