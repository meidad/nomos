# Contributing

Thanks for your interest in contributing to Nomos. This guide covers the essentials for getting set up and submitting changes.

## Development Setup

**Requirements:** Node.js >= 22, pnpm >= 10.23, PostgreSQL with [pgvector](https://github.com/pgvector/pgvector).

```bash
# Clone and install
git clone <repo-url>
cd nomos
pnpm install

# Set up the database
docker run -d \
  --name nomos-db \
  -e POSTGRES_USER=nomos \
  -e POSTGRES_PASSWORD=nomos \
  -e POSTGRES_DB=nomos \
  -p 5432:5432 \
  pgvector/pgvector:pg17

# Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL and ANTHROPIC_API_KEY (or Vertex AI credentials)

# Run migrations and start
pnpm dev -- db migrate
pnpm dev -- chat
```

## Build and Test

```bash
pnpm build              # Build with tsdown -> dist/index.js
pnpm dev                # Run via tsx (no build step)
pnpm test               # Run tests (vitest)
pnpm test:watch         # Tests in watch mode
pnpm typecheck          # TypeScript type check (tsc --noEmit)
pnpm lint               # Lint with oxlint
pnpm format:check       # Check formatting with oxfmt
pnpm check              # Full CI check: format + typecheck + lint
```

Run a single test file:

```bash
npx vitest run src/config/env.test.ts
```

Tests are colocated with source files as `*.test.ts`.

## Code Conventions

- **ESM-only** -- `"type": "module"` throughout, target ES2023
- **TypeScript strict mode** -- avoid `any`, never add `@ts-nocheck`
- **Formatting** -- oxfmt (not Prettier). Run `pnpm format` before committing
- **Linting** -- oxlint (not ESLint). Run `pnpm lint:fix` to auto-fix
- Keep files under ~500 lines; extract helpers when they grow
- Prefer simple, direct code. Don't add abstractions for one-time operations
- Don't add features, error handling, or validation beyond what's needed for the change

## Project Structure

```
src/
  cli/          # Commander.js CLI commands
  config/       # Environment, profile, personality, agent configs
  daemon/       # Gateway, agent runtime, message queue, WebSocket, cron
    channels/   # Channel adapters (Slack, Discord, Telegram, WhatsApp)
  db/           # PostgreSQL client, schema, migrations, CRUD
  memory/       # Embeddings, chunking, hybrid vector+FTS search
  routing/      # Message routing between channels
  sdk/          # Claude Agent SDK wrapper, in-process MCP server
  security/     # Tool approval policies
  sessions/     # Session identity and scope management
  skills/       # Skill loader and frontmatter parser
  ui/           # REPL, slash commands, banner
skills/         # Bundled SKILL.md files
docs/           # Integration setup guides
```

## Adding a Channel Adapter

Channel adapters live in `src/daemon/channels/` and are thin wrappers (~50-100 lines) that handle platform auth and message parsing. All agent logic is centralized in `AgentRuntime`.

To add a new channel:

1. Create `src/daemon/channels/<platform>.ts`
2. Implement the `ChannelAdapter` interface (see existing adapters for the pattern)
3. Register it in `src/daemon/channel-manager.ts` with its required env vars
4. Add env var documentation to `.env.example` and the README configuration table
5. Create a setup guide at `docs/integrations/<platform>.md`

The adapter should:

- Auto-register when its env vars are present
- Convert platform messages into the standard `IncomingMessage` format
- Handle platform-specific features (threads, typing indicators, etc.)
- Implement `start()` and `stop()` lifecycle methods

## Creating a Skill

Skills are `SKILL.md` files with YAML frontmatter. They inject domain-specific instructions into the agent's system prompt.

1. Create a directory: `mkdir -p skills/my-skill`
2. Create `skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: "What this skill does"
emoji: "wrench"
requires:
  bins: [some-cli-tool]
  os: [darwin, linux]
install:
  - brew install some-cli-tool
---

# My Skill

Instructions for the agent when this skill is active...
```

Skills are loaded from three locations (in priority order):

1. `./skills/` -- project-local
2. `~/.nomos/skills/` -- personal
3. `skills/` -- bundled with the project

You can also use the built-in `skill-creator` skill to generate new skills through conversation.

## Submitting Changes

1. Fork the repository and create a branch from `main`
2. Make your changes, keeping commits focused and well-described
3. Ensure all checks pass: `pnpm check && pnpm test`
4. Open a pull request against `main`
5. Describe what changed and why in the PR description

For larger changes, consider opening an issue first to discuss the approach.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
