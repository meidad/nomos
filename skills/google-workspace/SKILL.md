---
name: google-workspace
description: "Interact with Google Workspace — Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, and Chat. Use when the user asks to send emails, manage calendar events, search/create Drive files, edit documents, or manage any Google Workspace service. Requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to be configured in .env."
emoji: "🔷"
---

# Google Workspace

Interact with Google Workspace using the MCP tools provided by the `google-workspace` server. This is an external MCP server (`workspace-mcp`) that connects to Google APIs via OAuth 2.0.

## Available Tools

### Gmail

| Tool                               | Description                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `search_gmail_messages`            | Search emails using Gmail query operators (e.g. `is:unread`, `from:user@example.com`) |
| `get_gmail_message_content`        | Retrieve a specific email's content by ID                                             |
| `get_gmail_messages_content_batch` | Batch retrieve multiple emails                                                        |
| `send_gmail_message`               | Send an email (supports attachments, CC, BCC)                                         |
| `draft_gmail_message`              | Create an email draft                                                                 |
| `get_gmail_thread_content`         | Get full email thread                                                                 |
| `modify_gmail_message_labels`      | Add/remove labels on a message                                                        |
| `list_gmail_labels`                | List all Gmail labels                                                                 |

### Calendar

| Tool             | Description                                  |
| ---------------- | -------------------------------------------- |
| `list_calendars` | List accessible calendars                    |
| `get_events`     | Retrieve events with time range filtering    |
| `create_event`   | Create events with attachments and reminders |
| `modify_event`   | Update existing events                       |
| `delete_event`   | Remove events                                |

### Drive

| Tool                     | Description                                  |
| ------------------------ | -------------------------------------------- |
| `search_drive_files`     | Search files with query syntax               |
| `get_drive_file_content` | Read file content (supports Office formats)  |
| `create_drive_file`      | Create files or fetch from URLs              |
| `import_to_google_doc`   | Import files (MD, DOCX, HTML) as Google Docs |
| `share_drive_file`       | Share file with users/groups/domains         |
| `list_drive_items`       | List folder contents                         |
| `copy_drive_file`        | Copy existing files (templates)              |

### Docs

| Tool              | Description                                |
| ----------------- | ------------------------------------------ |
| `get_doc_content` | Read document content                      |
| `create_doc`      | Create a new Google Doc                    |
| `update_doc`      | Update document content with batch updates |

### Sheets

| Tool                   | Description                   |
| ---------------------- | ----------------------------- |
| `get_spreadsheet_info` | Get spreadsheet metadata      |
| `get_sheet_values`     | Read cell values from a range |
| `update_sheet_values`  | Write values to cells         |
| `create_spreadsheet`   | Create a new spreadsheet      |
| `add_sheet`            | Add a sheet to a spreadsheet  |

### Slides

| Tool                  | Description                   |
| --------------------- | ----------------------------- |
| `create_presentation` | Create a new presentation     |
| `get_presentation`    | Get presentation details      |
| `add_slide`           | Add a slide to a presentation |
| `update_slide`        | Update slide content          |

### Forms

| Tool                 | Description                    |
| -------------------- | ------------------------------ |
| `create_form`        | Create a new Google Form       |
| `get_form`           | Get form details               |
| `update_form`        | Update form questions/settings |
| `get_form_responses` | Get form responses             |

### Tasks

| Tool              | Description               |
| ----------------- | ------------------------- |
| `list_task_lists` | List task lists           |
| `list_tasks`      | List tasks in a task list |
| `create_task`     | Create a new task         |
| `update_task`     | Update a task             |
| `delete_task`     | Delete a task             |

### Contacts

| Tool              | Description                      |
| ----------------- | -------------------------------- |
| `list_contacts`   | List contacts                    |
| `search_contacts` | Search contacts by name or email |
| `create_contact`  | Create a new contact             |

### Chat (Google Workspace accounts only)

| Tool             | Description                    |
| ---------------- | ------------------------------ |
| `list_spaces`    | List Chat spaces               |
| `create_message` | Send a message in a Chat space |

## Usage Examples

### Search and read emails

Use `search_gmail_messages` with Gmail query syntax:

- `is:unread` — unread emails
- `from:boss@company.com` — emails from a specific sender
- `subject:invoice after:2024/01/01` — subject and date filters
- `has:attachment filename:pdf` — attachments

Then use `get_gmail_message_content` with the message ID to read the full email.

### Send an email

Use `send_gmail_message` with `to`, `subject`, and `body`. Supports:

- HTML body content
- CC and BCC recipients
- File attachments (by path or base64-encoded)

### Manage calendar events

Use `get_events` with a time range to see upcoming events. Use `create_event` with title, start/end times, attendees, and location. Events support all-day, recurring, and multi-attendee formats.

### Work with Drive files

Use `search_drive_files` to find files by name, type, or content. Use `get_drive_file_content` to read file content (works with Google Docs, Sheets, PDFs, and Office formats). Use `create_drive_file` to create new files or import from URLs.

### Edit Google Docs

Use `get_doc_content` to read the current document, then `update_doc` with batch update requests to insert, delete, or format text.

## Configuration

### Required Environment Variables

```bash
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

### Optional Environment Variables

| Variable                     | Description                                                               |
| ---------------------------- | ------------------------------------------------------------------------- |
| `USER_GOOGLE_EMAIL`          | Default email for single-account auth                                     |
| `GOOGLE_WORKSPACE_EMAILS`    | Comma-separated emails for multi-account (see below)                      |
| `GOOGLE_WORKSPACE_TOOL_TIER` | Tool tier: `core` (default), `extended`, or `complete`                    |
| `GOOGLE_WORKSPACE_TOOLS`     | Specific tools to load: `gmail drive calendar` (space or comma separated) |
| `GOOGLE_PSE_API_KEY`         | API key for Google Custom Search                                          |
| `GOOGLE_PSE_ENGINE_ID`       | Search Engine ID for Custom Search                                        |

### Multiple Google Accounts

To manage multiple Gmail inboxes, calendars, and Drive accounts, set `GOOGLE_WORKSPACE_EMAILS`:

```bash
GOOGLE_WORKSPACE_EMAILS=work@company.com,personal@gmail.com,shared@company.com
```

Each email gets its own MCP server instance, authenticated independently:

- `google-workspace-work` — tools for work@company.com
- `google-workspace-personal` — tools for personal@gmail.com
- `google-workspace-shared` — tools for shared@company.com

The server names are derived from the email prefix. When calling tools, use the server that corresponds to the account you want to act on. Each account has the same set of tools (Gmail, Calendar, Drive, etc.) but operates on its own data.

Each account goes through OAuth independently on first use — a browser window opens for each.

For a single account, use `USER_GOOGLE_EMAIL` instead (or omit both — the server prompts on first use).

### Tool Tiers

- **core** (default): Essential tools — search, read, create, basic modify across all services
- **extended**: Core + management tools — labels, folders, batch operations, advanced search
- **complete**: Full API access — comments, headers/footers, publishing settings, admin functions

### First-Time OAuth Setup

On first use, the server will open a browser window for Google OAuth authorization. You'll need to:

1. Sign in with your Google account
2. Grant the requested permissions
3. The token is cached locally for subsequent use

With multiple accounts, each account authenticates separately on first use.

## Autonomous Email & Calendar Monitoring

Nomos can autonomously triage emails, prep for meetings, and send calendar briefings using the daemon and autonomous loops. When a user asks you to "watch my inbox", "monitor my email", "prep for meetings", or "brief me on my calendar", guide them to enable the built-in loops:

1. **Start the daemon** (if not already running):

   ```bash
   nomos daemon start
   ```

2. **Enable the built-in loops**:

   ```bash
   # Triage inbox for unread emails and draft replies (every 15 min)
   nomos cron enable email-triage

   # Morning calendar briefing with meeting context (daily at 8 AM)
   nomos cron enable calendar-prep

   # Pre-meeting preparation for upcoming meetings (every 15 min)
   nomos cron enable calendar-upcoming
   ```

3. **Create custom loops** for specific workflows:

   ```bash
   nomos cron create vip-inbox "*/5 * * * *" --prompt "Check for unread emails from CEO or CTO. If any, summarize and flag as urgent."
   ```

4. **Check loop status**:
   ```bash
   nomos cron list
   ```

## Tips

- **Gmail queries**: Use the same syntax as Gmail's search bar (`is:unread`, `from:`, `subject:`, `after:`, `before:`, `has:attachment`)
- **Calendar time format**: Use ISO 8601 (`2024-01-15T09:00:00Z`)
- **Drive file IDs**: Found in the URL of any Google Drive file (`https://docs.google.com/document/d/{FILE_ID}/edit`)
- **Rate limits**: Google API quotas apply. The server handles retries automatically.
- **Workspace vs free accounts**: Chat and Spaces require a Google Workspace plan. Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, and Tasks work with free Google accounts.
- **Multi-account**: When using multiple accounts, tell the agent which account to use (e.g. "check my work email" or "add to my personal calendar"). The agent will use the correct server based on the account label.
