# Slack User Mode

Slack User Mode lets Nomos act **as you** in Slack. Instead of replying as a bot, it listens to DMs and @mentions directed at your Slack account, drafts responses using the agent, and queues them for your approval. Once approved, the message is posted with your user token — so it appears as if you typed it yourself.

This runs alongside the regular bot-mode Slack adapter. Both use Socket Mode and can operate simultaneously.

## How It Works

```
1. Someone DMs you or @mentions you in a channel
     ↓
2. SlackUserAdapter picks up the message via Socket Mode
     ↓
3. The agent generates a response
     ↓
4. Instead of sending, a draft is created in the database
     ↓
5. You're notified in two places:
   • CLI: a system event appears; use /drafts to view
   • Slack: the bot sends you a DM with Approve / Reject buttons
     ↓
6. You approve (or reject):
   • CLI: /approve <id>
   • Slack: click the Approve button
     ↓
7. On approval, the message is posted via your xoxp- token
   → It appears in Slack as if you typed it
```

## Prerequisites

- A working bot-mode Slack integration (see [slack.md](slack.md))
- A Slack User OAuth Token (`xoxp-`) with the required scopes
- The same App-Level Token (`xapp-`) already used for bot mode

## Step 1: Add User Token Scopes

Your Slack app needs **User Token Scopes** in addition to the existing Bot Token Scopes.

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Go to **OAuth & Permissions** in the sidebar
3. Scroll to **User Token Scopes** (below Bot Token Scopes)
4. Add the following scopes:

| Scope              | Purpose                                 |
| ------------------ | --------------------------------------- |
| `channels:history` | Read messages in public channels        |
| `channels:read`    | List public channels (for name lookups) |
| `groups:history`   | Read messages in private channels       |
| `groups:read`      | List private channels                   |
| `im:history`       | Read your direct messages               |
| `im:read`          | View DM metadata                        |
| `mpim:history`     | Read multi-party DMs                    |
| `chat:write`       | Send messages as you                    |
| `users:read`       | Look up sender names                    |
| `search:read`      | Search messages across channels and DMs  |

## Step 2: Subscribe to Team Events

Team events fire for messages directed at the **user** (not the bot).

1. Go to **Event Subscriptions** in the sidebar
2. Under **Subscribe to events on behalf of users** (not "bot events"), add:

| Event              | Description                  |
| ------------------ | ---------------------------- |
| `message.channels` | Messages in public channels  |
| `message.groups`   | Messages in private channels |
| `message.im`       | Direct messages to the user  |
| `message.mpim`     | Multi-party DMs              |

3. Click **Save Changes**

## Step 3: Enable Interactivity

Interactivity is needed for the Approve/Reject buttons sent via bot DM. If you're using Socket Mode (which you are), Bolt handles interactivity through the socket connection — no Request URL is needed.

1. Go to **Interactivity & Shortcuts** in the sidebar
2. Toggle **Interactivity** to On
3. Click **Save Changes**

> With Socket Mode enabled, you don't need to enter a Request URL. Bolt receives interaction payloads through the socket.

## Step 4: Reinstall the App

After adding new scopes and events, you must reinstall:

1. Go to **Install App** in the sidebar
2. Click **Reinstall to Workspace**
3. Review and approve the updated permissions
4. Copy the **User OAuth Token** (starts with `xoxp-`) — this is your `SLACK_USER_TOKEN`

> The User OAuth Token appears at the top of the OAuth & Permissions page, above the Bot User OAuth Token.

## Step 5: Configure Environment

You can connect workspaces in two ways:

### Option A: Multi-workspace via OAuth (recommended)

Add your Slack app's OAuth credentials to `.env`:

```bash
SLACK_APP_TOKEN=xapp-...           # Same as bot mode
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
```

Then connect each workspace:

```bash
nomos slack auth
```

This opens a browser for OAuth authorization. The token is stored in the database. Repeat for each workspace.

You can also provide a token directly:

```bash
nomos slack auth --token xoxp-...
```

Manage connected workspaces:

```bash
nomos slack workspaces       # List all connected workspaces
nomos slack remove T01ABC    # Disconnect a workspace
```

### Option B: Single workspace via env var (legacy)

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_USER_TOKEN=xoxp-...
```

Both `SLACK_APP_TOKEN` and `SLACK_USER_TOKEN` are required for user mode. The app token is shared with bot mode — Slack supports up to 10 concurrent Socket Mode connections per app.

> **Note:** If both DB workspaces and `SLACK_USER_TOKEN` are present, DB workspaces take priority. The env var is only used as a fallback when no workspaces are stored in the database.

### OAuth Redirect URL

If using OAuth, add this redirect URL to your Slack app settings under **OAuth & Permissions**:

```
http://localhost:9876/slack/oauth/callback
```

## Step 6: Run Migrations and Start the Daemon

User mode stores drafts and workspace tokens in database tables. Run migrations to create them:

```bash
pnpm dev -- db migrate
```

Then start the daemon:

```bash
pnpm daemon:dev
```

You should see adapters start for each connected workspace:

```
[slack-adapter] Running (bot: U0XXXXXX)
[slack-user-adapter] Running (user: U0YYYYYY, team: T01ABC)
[slack-user-adapter] Running (user: U0YYYYYY, team: T02DEF)
[gateway]   Channels: slack, slack-user:T01ABC, slack-user:T02DEF
```

## Usage

### Receiving Messages

The adapter triggers on two types of incoming messages:

- **Direct messages** to your Slack account — any DM from another user
- **@mentions** of your Slack account in channels — when someone writes `@YourName` in a message

Your own messages are ignored (no echo loop).

### Reviewing Drafts

When the agent finishes generating a response, you'll see it in two places:

**In the CLI:**

```
/drafts
```

Shows all pending drafts with short IDs, context, age, and a content preview:

```
Pending drafts (2):
  a1b2c3d4 [DM from Alice] 3m ago
    Thanks for the update! I'll review the PR this afternoon and...
  e5f6g7h8 [#engineering] 12m ago
    Good point — we should add integration tests before merging...

Use /approve <id> or /reject <id>
```

**In Slack:**

The bot sends you a DM with the draft content and two buttons:

```
┌──────────────────────────────────────┐
│ Draft response ready                  │
│ DM from Alice                         │
│                                       │
│ ┌──────────────────────────────────┐ │
│ │ Thanks for the update! I'll     │ │
│ │ review the PR this afternoon... │ │
│ └──────────────────────────────────┘ │
│                                       │
│  [Approve]  [Reject]                  │
└──────────────────────────────────────┘
```

### Approving or Rejecting

**From the CLI:**

```bash
/approve a1b2c3d4    # Approve by short ID (first 8 chars)
/reject e5f6g7h8     # Reject by short ID
```

**From Slack:**

Click the **Approve** or **Reject** button in the bot's DM. The message updates in-place to confirm the action.

### What Happens on Approval

The approved message is posted to the original channel or DM thread using your `xoxp-` user token. In Slack, it appears as a normal message from you — other users cannot tell it was agent-assisted.

### What Happens on Rejection

The draft is marked as rejected. No message is sent. The draft remains in the database for audit purposes but won't appear in `/drafts`.

### Draft Expiry

Drafts expire after 24 hours. Expired drafts are automatically cleaned up and won't appear in `/drafts`.

## WebSocket Events

When a draft is created, approved, or rejected, system events are broadcast to all connected WebSocket clients:

```typescript
// Draft created
{ type: "system", subtype: "draft_created", message: "Draft response ready (a1b2c3d4)", data: { draftId: "...", platform: "slack-user", channelId: "...", preview: "..." } }

// Draft approved
{ type: "system", subtype: "draft_approved", message: "Draft a1b2c3d4 approved and sent", data: { draftId: "..." } }

// Draft rejected
{ type: "system", subtype: "draft_rejected", message: "Draft a1b2c3d4 rejected", data: { draftId: "..." } }
```

WebSocket clients can also send approval/rejection commands:

```typescript
// Approve a draft
{ type: "approve_draft", draftId: "full-uuid-here" }

// Reject a draft
{ type: "reject_draft", draftId: "full-uuid-here" }
```

## Database

User mode adds two tables to the schema:

```sql
-- Draft messages (for approve-before-send)
CREATE TABLE draft_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     TEXT NOT NULL,          -- "slack-user:T01ABC"
  channel_id   TEXT NOT NULL,          -- Slack channel ID
  thread_id    TEXT,                   -- thread_ts (if threaded)
  user_id      TEXT NOT NULL,          -- your Slack user ID
  in_reply_to  TEXT NOT NULL,          -- original message ID
  content      TEXT NOT NULL,          -- the drafted response
  context      JSONB NOT NULL,         -- metadata (sender, channel name, etc.)
  status       TEXT NOT NULL,          -- pending → approved/rejected → sent
  created_at   TIMESTAMPTZ NOT NULL,
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL    -- 24h from creation
);

-- Slack workspace tokens (for multi-workspace support)
CREATE TABLE slack_user_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      TEXT UNIQUE NOT NULL,   -- Slack team ID (e.g., "T01ABC")
  team_name    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  access_token TEXT NOT NULL,          -- xoxp- token
  scopes       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
```

Status flow: `pending` → `approved` → `sent`, or `pending` → `rejected`.

## Troubleshooting

### Adapter doesn't start

- If using OAuth: run `nomos slack workspaces` to verify stored tokens. Ensure `SLACK_APP_TOKEN` is set.
- If using env var: verify `SLACK_USER_TOKEN` and `SLACK_APP_TOKEN` are both set in `.env`
- Check that user tokens start with `xoxp-` (not `xoxb-`)
- Run `pnpm dev -- db migrate` to ensure tables exist

### No drafts created for DMs

- Confirm `message.im` is added under **Subscribe to events on behalf of users** (team events), not just under bot events
- Reinstall the app after adding team events
- Check daemon logs for `[slack-user-adapter]` messages

### No drafts created for @mentions

- The adapter listens for `<@YOUR_USER_ID>` in message text — this is your personal Slack user ID, not the bot's
- Make sure `message.channels` and `message.groups` team events are subscribed
- The user must be a member of the channel for events to fire

### Approve button doesn't work

- Interactivity must be enabled in the Slack app settings
- The bot adapter must be running (buttons are handled by the `SlackAdapter`, not the user adapter)
- Check daemon logs for action handler errors

### `missing_scope` errors from the MCP server

If Slack API calls return `missing_scope`, the user token is valid but lacks required OAuth scopes. This commonly happens after reinstalling the app without re-adding all scopes, or when new features require scopes not in the original setup.

**Diagnosis:** Try different operations to identify which scopes are missing:

| Operation | Required Scope |
|---|---|
| List channels | `channels:read` |
| Read channel messages | `channels:history` |
| Search messages | `search:read` |
| Look up users | `users:read` |
| Send messages | `chat:write` |
| Read DMs | `im:history`, `im:read` |

**Fix:**
1. Go to your Slack app's **OAuth & Permissions** page
2. Under **User Token Scopes**, add the missing scope(s)
3. **Reinstall the app** to your workspace — scope changes don't take effect until you reinstall
4. Copy the new `xoxp-` token and update your configuration

> **Tip:** `search:read` is often overlooked because it isn't required for basic messaging, but it's needed for the MCP server's `slack_search` tool.

### "not_in_channel" when sending approved message

The user token can only post to channels the user is a member of. Join the channel first.

### Draft appears but message sends as bot

Make sure you're using `/approve` in the CLI or the Slack button — both use the `xoxp-` user token. If the agent's response is going through the normal bot flow instead, check that the message came in on the `slack-user` platform (not `slack`).

## Security Considerations

- The `xoxp-` token has permissions tied to your personal Slack account. Treat it with the same care as your password.
- Drafts contain the full message content in the database. Ensure your PostgreSQL instance is secured.
- The approval flow is intentional — the agent never sends messages as you without explicit approval.
- Draft expiry (24h) limits the window of exposure for pending drafts.
- Only the authenticated user's DMs and mentions trigger drafts — the adapter filters out messages from the user themselves to prevent echo loops.
