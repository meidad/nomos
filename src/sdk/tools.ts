import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { handleBootstrapComplete } from "../ui/bootstrap.ts";
import { fetchRenderedPage, validateUrl } from "./browser.ts";

/**
 * Creates an in-process MCP server that exposes memory tools to the agent.
 * The agent can call `memory_search` to query the pgvector-backed memory store.
 */
export function createMemoryMcpServer(): McpSdkServerConfigWithInstance {
  const memorySearchTool = tool(
    "memory_search",
    "Search the long-term memory store using hybrid vector + text search. Returns relevant code snippets, documentation, and previously stored knowledge.",
    {
      query: z.string().describe("The search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum number of results (default: 5)"),
    },
    async (args) => {
      try {
        const { isEmbeddingAvailable, generateEmbedding } = await import("../memory/embeddings.ts");
        const { hybridSearch, textOnlySearch } = await import("../memory/search.ts");

        let results;

        if (!isEmbeddingAvailable()) {
          // Fall back to text-only search when embeddings are unavailable
          results = await textOnlySearch(args.query, args.limit ?? 5);
        } else {
          try {
            const embedding = await generateEmbedding(args.query);
            results = await hybridSearch(args.query, embedding, args.limit ?? 5);
          } catch (embeddingError) {
            // Fall back to text-only search if embedding generation fails
            console.warn(
              "\x1b[2mEmbedding generation failed, falling back to text-only search\x1b[0m",
            );
            results = await textOnlySearch(args.query, args.limit ?? 5);
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found in memory." }],
          };
        }

        const formatted = results
          .map((r, i) => {
            const source = r.path ?? r.source;
            return `[${i + 1}] ${source} (score: ${r.score.toFixed(4)})\n${r.text}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Memory search failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  const bootstrapCompleteTool = tool(
    "bootstrap_complete",
    "Save agent purpose, user profile, and agent identity after the first-run introduction conversation. Call this once you've discovered your purpose and the user's name.",
    {
      purpose: z
        .string()
        .describe(
          "What this agent is for — a clear, specific description of its role (e.g. 'Full-stack TypeScript coding assistant for a Next.js SaaS app')",
        ),
      user_name: z.string().describe("The user's name"),
      workspace: z.string().optional().describe("What the user is working on"),
      instructions: z
        .string()
        .optional()
        .describe("Communication preferences (e.g. concise, detailed)"),
      agent_name: z.string().optional().describe("Name the user chose for the assistant"),
      agent_emoji: z.string().optional().describe("Emoji the user chose for the assistant"),
    },
    async (args) => {
      try {
        await handleBootstrapComplete(args);

        const parts = [`Identity locked in. Nice to meet you, ${args.user_name}.`];
        parts.push(`My purpose: ${args.purpose}`);
        if (args.agent_name) parts.push(`I'll go by ${args.agent_name}.`);
        if (args.agent_emoji) parts.push(`My emoji: ${args.agent_emoji}`);
        parts.push("This will shape how I work with you from now on.");

        return {
          content: [{ type: "text", text: parts.join(" ") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to save profile: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        // Mark as non-destructive so permission modes don't block it
        readOnly: false,
      },
    },
  );

  const browserFetchTool = tool(
    "browser_fetch",
    "Fetch a web page with full JavaScript rendering using a headless browser. Use this for dynamic/JS-rendered pages (React, Vue, Angular, SPAs). For static HTML pages, prefer the built-in WebFetch tool which is faster.",
    {
      url: z.string().url().describe("The URL to fetch"),
      wait_for_selector: z
        .string()
        .optional()
        .describe('CSS selector to wait for before extracting content (e.g. "#main-content")'),
      wait_for_timeout: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe("Extra milliseconds to wait after page load"),
      timeout: z
        .number()
        .int()
        .min(1000)
        .max(60000)
        .optional()
        .describe("Navigation timeout in milliseconds (default: 30000)"),
    },
    async (args) => {
      const urlError = validateUrl(args.url);
      if (urlError) {
        return {
          content: [{ type: "text", text: urlError }],
          isError: true,
        };
      }

      try {
        const result = await fetchRenderedPage(args.url, {
          waitForSelector: args.wait_for_selector,
          waitForTimeout: args.wait_for_timeout,
          timeout: args.timeout,
        });

        const parts: string[] = [];
        if (result.title) parts.push(`# ${result.title}\n`);
        parts.push(result.content);

        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Browser fetch failed: ${message}` }],
          isError: true,
        };
      }
    },
    {
      annotations: {
        readOnly: true,
      },
    },
  );

  return createSdkMcpServer({
    name: "assistant-memory",
    version: "0.1.0",
    tools: [memorySearchTool, bootstrapCompleteTool, browserFetchTool],
  });
}
