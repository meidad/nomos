# System Design

## 1. Overview

A TypeScript CLI and multi-channel AI assistant built on the `@anthropic-ai/claude-agent-sdk`. It wraps Claude Code as its agent runtime, inheriting the full tool suite (Bash, Read, Write, Edit, Glob, Grep, WebSearch, sub-agents, context compaction) and adds persistent sessions, vector memory with automatic conversation indexing, a daemon gateway with channel integrations, scheduled tasks, and a skills system.

### Design Principles

- **Claude Code IS the runtime** -- don't reimplement the agent loop, tool execution, context management, or sub-agents
- **MCP for extensibility** -- in-process and external MCP servers extend the agent's capabilities
- **PostgreSQL as the single persistence layer** -- sessions, transcripts, memory, config, cron jobs, and access control all live in one database
- **Anthropic-only provider** -- Anthropic direct API or Google Vertex AI; no multi-provider abstraction

## 2. Architecture

```
+-----------------------------------------------------------------+
|  Channels                                                       |
|  +-------+ +---------+ +----------+ +----------+ +----------+  |
|  | Slack | | Discord | | Telegram | | WhatsApp | | Terminal |  |
|  |Adapter| | Adapter | | Adapter  | | Adapter  | | (WS CLI) |  |
|  +---+---+ +----+----+ +----+-----+ +----+-----+ +----+-----+  |
|      +----------+-----------+-----------+----------+            |
|                             |                                   |
+-----------------------------------------------------------------+
                              v
+-----------------------------------------------------------------+
|  Daemon (Gateway)                                               |
|  +--------------+  +--------------+  +------------------------+ |
|  | ChannelMgr   |  | MessageQueue |  | CronEngine             | |
|  | (adapters)   |  | (per-session |  | (DB-backed scheduled   | |
|  |              |  |  FIFO)       |  |  jobs -> message queue) | |
|  +--------------+  +------+-------+  +------------------------+ |
|                           |                                     |
|       +-----------+-------+-------+-----------+                 |
|       |           |               |           |                 |
|  +----v----+ +----v--------+ +----v-----+ +---v-------------+  |
|  | Agent   | | Streaming   | | Memory   | | Pairing /       |  |
|  | Runtime | | Responder   | | Indexer  | | Access Control  |  |
|  | (SDK    | | (progressive| | (auto    | | (codes, allow-  |  |
|  |  query) | |  updates)   | |  index)  | |  lists, DM pol) |  |
|  +---------+ +-------------+ +----------+ +-----------------+  |
+-----------------------------------------------------------------+
                              v
+-----------------------------------------------------------------+
|                    Claude Code (Agent SDK)                       |
|          (Agent runtime + conversation management)              |
|                                                                 |
|   Built-in tools:              MCP Servers:                     |
|   - Bash                       - assistant-memory (in-process)  |
|   - Read / Write / Edit          memory_search, bootstrap       |
|   - Glob / Grep               - external MCP servers            |
|   - WebSearch / WebFetch         (from .assistant/mcp.json)     |
|   - Task (sub-agents)                                           |
+-----------------------------------------------------------------+
               |
     +---------+---------+
     |                   |
     v                   v
+----------+     +--------------+
| Anthropic|     |  Vertex AI   |
|   API    |     | (Anthropic   |
|          |     |   models)    |
+----------+     +--------------+
               |
               v
+-----------------------------------------------------------------+
|                  PostgreSQL + pgvector                           |
|                                                                 |
|  Tables:                                                        |
|  - config              (key-value settings)                     |
|  - sessions            (session metadata + SDK session IDs)     |
|  - transcript_messages (conversation messages, JSONB)           |
|  - memory_chunks       (text chunks + 768-dim embeddings)       |
|  - memory_files        (source file tracking for indexer)       |
|  - cron_jobs           (scheduled task definitions)             |
|  - pairing_requests    (channel pairing codes with TTL)         |
|  - channel_allowlists  (per-platform user allowlists)           |
+-----------------------------------------------------------------+
```

## 3. Component Design

### 3.1 Provider Layer

Two authentication modes, both using the Anthropic SDK:

- **Anthropic Direct**: `ANTHROPIC_API_KEY` env var
- **Vertex AI**: Google Cloud ADC (`CLAUDE_CODE_USE_VERTEX=1`, `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION`)

Provider switching is handled entirely by the SDK based on which environment variables are set. No custom failover logic -- the SDK manages retries and errors.

### 3.2 Persistence Layer (PostgreSQL + pgvector)

All state lives in PostgreSQL. The actual schema (`src/db/schema.sql` + migrations in `src/db/migrate.ts`):

```sql
-- Key-value configuration store
CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Sessions with stable session keys for auto-resume
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT UNIQUE NOT NULL,   -- e.g., "cli:default", "slack:C04ABCDEF"
  agent_id    TEXT NOT NULL DEFAULT 'default',
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  metadata    JSONB NOT NULL DEFAULT '{}',     -- SDK session ID, model overrides
  token_usage JSONB NOT NULL DEFAULT '{"input": 0, "output": 0}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Transcript messages (replaces file-based JSONL)
CREATE TABLE transcript_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,          -- user, assistant, system, tool
  content     JSONB NOT NULL,
  usage       JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Memory chunks with vector embeddings (768-dim, gemini-embedding-001)
CREATE TABLE memory_chunks (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,          -- 'memory', 'conversation', 'document'
  path        TEXT,                   -- source file path or session key
  text        TEXT NOT NULL,
  embedding   vector(768),            -- pgvector (gemini-embedding-001)
  start_line  INT,
  end_line    INT,
  hash        TEXT,
  model       TEXT,                   -- embedding model used
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Source file tracking for incremental re-indexing
CREATE TABLE memory_files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  hash        TEXT,
  mtime       BIGINT,
  size        BIGINT
);

-- Pairing requests for secure channel access
CREATE TABLE pairing_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  code        TEXT UNIQUE NOT NULL,   -- 8-char pairing code
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);

-- Per-platform user allowlists
CREATE TABLE channel_allowlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  added_by    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, user_id)
);

-- Scheduled tasks
CREATE TABLE cron_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  schedule       TEXT NOT NULL,
  schedule_type  TEXT NOT NULL,        -- 'at', 'every', 'cron'
  session_target TEXT NOT NULL DEFAULT 'isolated',  -- 'main' or 'isolated'
  delivery_mode  TEXT NOT NULL DEFAULT 'none',      -- 'none' or 'announce'
  prompt         TEXT NOT NULL,
  platform       TEXT,
  channel_id     TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  error_count    INT NOT NULL DEFAULT 0,
  last_run       TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
```

Full-text search is enabled via a GIN index on `memory_chunks.text`. The vector similarity index (IVFFlat) is created manually after initial data load for best performance.

### 3.3 MCP Server: `assistant-memory`

A single in-process MCP server (`src/sdk/tools.ts`) created via `createSdkMcpServer()` from the Agent SDK. It exposes two tools:

- **`memory_search`** -- hybrid vector + full-text search over `memory_chunks`. Generates an embedding for the query via Vertex AI, runs both pgvector cosine similarity and PostgreSQL `ts_rank`, then merges results using Reciprocal Rank Fusion (RRF). Falls back to text-only search when embeddings are unavailable.
- **`bootstrap_complete`** -- saves agent purpose, user profile, and identity during the first-run introduction conversation.

External MCP servers are loaded from `.assistant/mcp.json` (project-local or `~/.assistant/mcp.json` global) and passed to the SDK alongside the in-process server.

### 3.4 Claude Code as Agent Runtime

The Agent SDK provides natively (no reimplementation needed):

| Capability              | SDK Feature                                   |
| ----------------------- | --------------------------------------------- |
| Agent conversation loop | Built-in multi-turn agent loop                |
| Tool execution          | Bash, Read, Write, Edit, Glob, Grep           |
| Sub-agent spawning      | Task tool with specialized agent types        |
| Context management      | Automatic summarization for unlimited context |
| Web access              | WebSearch + WebFetch tools                    |
| Streaming               | Real-time token streaming                     |
| Parallel execution      | Concurrent tool calls                         |

What we add via MCP and the daemon:

- Persistent memory across sessions and channels (`memory_search`)
- Automatic conversation indexing into vector memory
- Multi-channel message routing (Slack, Discord, Telegram, WhatsApp)
- Scheduled task execution (cron)
- Streaming progressive updates to channel platforms

### 3.5 Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions injected into the system prompt.

Three-tier loading order:

1. **Bundled** -- `skills/` directory shipped with the project (24 built-in skills)
2. **Personal** -- `~/.assistant/skills/<name>/SKILL.md`
3. **Project** -- `./skills/<name>/SKILL.md`

Skills support metadata for binary/OS dependencies (`requires`), installation commands (`install`), and display emoji. The bundled `skill-creator` skill enables the agent to author new SKILL.md files via conversation.

## 4. Daemon / Gateway Architecture

### Problem

Running each messaging integration as a standalone script duplicates config loading, session management, MCP server creation, and SDK calls. It also means no message serialization -- two messages arriving simultaneously for the same conversation can trigger concurrent agent runs and session conflicts.

### Solution

A single long-running Node.js process (the **daemon**) hosts all subsystems. The `Gateway` class (`src/daemon/gateway.ts`) is the top-level orchestrator.

```
Daemon Process (Gateway)
|
+-- AgentRuntime
|     Config, identity, profile, skills, MCP servers loaded once at startup.
|     Processes messages through Claude Agent SDK (runSession).
|     Caches SDK session IDs per conversation for multi-turn resume.
|
+-- MessageQueue
|     Per-session FIFO queues (in-memory Maps).
|     Same session key -> sequential processing.
|     Different session keys -> concurrent processing.
|
+-- StreamingResponder
|     Posts a placeholder message, then throttles progressive updates
|     as text streams in. Used for platforms that support message editing
|     (Slack, Discord). Falls back to chunked send for long responses.
|
+-- MemoryIndexer
|     After each agent turn, formats the exchange (user + assistant),
|     chunks it, generates embeddings, and stores in memory_chunks
|     with source "conversation". Runs fire-and-forget.
|
+-- WebSocketServer (ws://localhost:8765)
|     Terminal UI client connections.
|     Streams AgentEvent objects back in real time.
|     30s heartbeat ping/pong.
|
+-- ChannelManager
|     Registers and manages channel adapter lifecycle.
|     Only starts adapters whose env vars are present.
|     |
|     +-- SlackAdapter      (@slack/bolt, Socket Mode)
|     +-- DiscordAdapter    (discord.js)
|     +-- TelegramAdapter   (grammy, long polling)
|     +-- WhatsAppAdapter   (Baileys, QR code auth)
|
+-- CronEngine
      DB-backed scheduled jobs (cron expressions, at/every schedules).
      Fires jobs as IncomingMessages into the message queue.
      Delivery modes: none (silent) or announce (send to channel).
      Auto-disables after 3 consecutive failures.
```

### Channel Adapters

Each adapter implements the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly platform: string; // "slack", "discord", "telegram", "whatsapp"
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  // Optional: for streaming progressive updates
  postMessage?(channelId: string, text: string, threadId?: string): Promise<string | undefined>;
  updateMessage?(channelId: string, messageId: string, text: string): Promise<void>;
  deleteMessage?(channelId: string, messageId: string): Promise<void>;
}
```

Adapters are intentionally thin (50-100 lines each). They handle only platform authentication, inbound event parsing, and outbound message formatting. All agent logic lives in the shared `AgentRuntime`.

| Adapter  | Required Env Vars                    |
| -------- | ------------------------------------ |
| Slack    | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| Discord  | `DISCORD_BOT_TOKEN`                  |
| Telegram | `TELEGRAM_BOT_TOKEN`                 |
| WhatsApp | `WHATSAPP_ENABLED=true`              |

### Streaming Responder

The `StreamingResponder` (`src/daemon/streaming-responder.ts`) provides real-time progressive message updates for platforms that support message editing:

1. Posts a "_Thinking..._" placeholder when agent processing begins
2. Throttles message updates at a configurable interval (default 1.5s) as text streams in
3. Shows tool-in-progress indicators (e.g., "_Using Bash..._")
4. On completion, either updates the placeholder with the final text or deletes it and falls back to the adapter's chunked `send()` for responses exceeding 4000 characters

The gateway creates a `StreamingResponder` for any adapter that implements `postMessage` and `updateMessage`.

### Automatic Conversation Memory Indexing

The `MemoryIndexer` (`src/daemon/memory-indexer.ts`) runs after each completed agent turn:

1. Formats the user message + agent response as a timestamped text block
2. Chunks the text using the standard chunker
3. Generates embeddings via `gemini-embedding-001` (falls back to text-only if unavailable)
4. Stores chunks in `memory_chunks` with `source = "conversation"` and `path` set to the session key

This runs fire-and-forget so it never delays message delivery. The result is that all conversations -- across all channels -- become searchable via `memory_search`, enabling cross-session and cross-channel recall.

### Message Flow

```
Channel message arrives
  -> Adapter parses it into IncomingMessage
  -> Gateway creates StreamingResponder (if adapter supports it)
  -> MessageQueue.enqueue(sessionKey, message, emit)
  -> Queue serializes: one message at a time per session key
  -> AgentRuntime.processMessage() -> Claude Agent SDK
  -> SDK streams events -> emit() -> StreamingResponder updates placeholder
  -> Final OutgoingMessage returned
  -> StreamingResponder.finalize() or adapter.send()
  -> MemoryIndexer.indexConversationTurn() (fire-and-forget)
```

### Terminal UI Modes

The interactive terminal (`assistant chat`) operates in two modes:

1. **Direct mode** (default): runs the Agent SDK in-process, no daemon needed
2. **Daemon mode**: terminal UI connects via WebSocket using `GatewayClient` with auto-reconnect and exponential backoff

### Lifecycle Management

- **PID file**: `~/.assistant/daemon.pid` (written on start, removed on shutdown)
- **Signal handlers**: SIGTERM, SIGINT, SIGHUP trigger graceful shutdown
- **Shutdown order** (reverse of startup): CronEngine -> ChannelManager -> WebSocketServer
- **Stale PID detection**: checks if PID file references a running process on startup

## 5. Implementation Status

### Phase 1: Foundation -- DONE

- PostgreSQL schema + migrations
- Session, transcript, and config CRUD
- Provider layer (Anthropic SDK + Vertex AI)
- Claude Code Agent SDK integration (session management, streaming, tool execution)
- CLI REPL with styled banner, slash commands, user profile, agent identity

### Phase 2: Memory -- DONE

- Embedding pipeline (`gemini-embedding-001` via Vertex AI, 768 dimensions)
- `memory_search` in-process MCP tool (hybrid pgvector + full-text search with RRF)
- File indexing with chunking, deduplication, and incremental updates
- FTS fallback when embeddings are unavailable

### Phase 3: Skills -- DONE

- SKILL.md format with YAML frontmatter
- Three-tier loading: bundled, personal, project
- 24 bundled skills
- Skill creator skill (agent can author new SKILL.md files)

### Phase 4: Channels + Daemon -- DONE

- Daemon gateway (single long-running process)
- Channel adapters: Slack, Discord, Telegram, WhatsApp
- Per-session FIFO message queue
- WebSocket server for terminal UI clients
- CronEngine with DB-backed scheduled jobs
- Streaming responder for progressive message updates
- Automatic conversation memory indexing
- Lifecycle management (PID file, signal handlers, graceful shutdown)
- Pairing system (8-char codes, per-channel allowlists, DM policies)
- Conversation scoping (per-sender, per-peer, per-channel-peer)

### Phase 5: Future Work

- Signal integration (signal-cli based)
- Microsoft Teams integration (Bot Framework SDK)
- Google Chat integration (Chat API)
- Audio/voice support (transcription + TTS)
- Web UI dashboard for administration
- Multi-user / multi-tenant support
- Containerized deployment (Docker, Cloud Run)

## 6. Open Questions

1. **Conversation compaction**: Claude Code handles in-flight context automatically, but should stored transcripts also be compacted for long-term memory efficiency?
2. **Multi-user**: The system is currently single-user. Multi-tenancy would require per-user config isolation, separate memory namespaces, and auth changes.
3. **Offline/local mode**: Should there be a local SQLite fallback for offline use, or is PostgreSQL always required?
4. **Embedding model**: Currently using Gemini `gemini-embedding-001` via Vertex AI. Evaluate Anthropic's embedding API if/when available.
