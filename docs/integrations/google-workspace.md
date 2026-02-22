# Google Workspace Integration

Give your assistant access to Gmail, Google Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, and Chat. The agent can read, create, and manage content across Google services on your behalf.

This integration runs as an MCP server — it doesn't add a "channel" for receiving messages, but gives the agent tools to interact with Google services when responding through any channel (Slack, Discord, terminal, etc.).

## Prerequisites

- A Google account (personal Gmail or Workspace)
- A Google Cloud project with OAuth 2.0 credentials
- Python 3.10+ installed
- `uvx` (from [uv](https://docs.astral.sh/uv/)) installed

### Install uv (if needed)

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or via Homebrew
brew install uv
```

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click the project dropdown at the top > **New Project**
3. Name it (e.g., "My Assistant") and click **Create**
4. Select the project from the dropdown

## Step 2: Enable APIs

Navigate to **APIs & Services** > **Library** and enable the APIs you need:

| API                 | Service                                 |
| ------------------- | --------------------------------------- |
| Gmail API           | Email access                            |
| Google Calendar API | Calendar events                         |
| Google Drive API    | File management                         |
| Google Docs API     | Document editing                        |
| Google Sheets API   | Spreadsheet access                      |
| Google Slides API   | Presentation access                     |
| Google Forms API    | Form creation and responses             |
| Google Tasks API    | Task management                         |
| People API          | Contacts                                |
| Google Chat API     | Chat messages (Workspace accounts only) |

You only need to enable the APIs you plan to use.

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Choose **External** (or **Internal** if using Google Workspace)
3. Fill in the required fields:
   - **App name:** Your assistant name
   - **User support email:** Your email
   - **Developer contact:** Your email
4. Click **Save and Continue**
5. On the **Scopes** page, click **Add or Remove Scopes** and add scopes for the APIs you enabled
6. Click **Save and Continue**
7. On the **Test users** page, add your Google email address
8. Click **Save and Continue**

> **Note:** While in "Testing" mode, only users listed as test users can authorize the app. You can publish the app later for broader access.

## Step 4: Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Desktop app** as the application type
4. Name it (e.g., "Assistant Desktop")
5. Click **Create**
6. Copy the **Client ID** and **Client Secret** from the dialog

## Step 5: Configure Environment Variables

Add the credentials to your `.env` file in the `assistant/` directory:

```bash
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

### Set Your Email

For a single Google account:

```bash
USER_GOOGLE_EMAIL=your.email@gmail.com
```

For multiple accounts (the agent will choose the right one based on context):

```bash
GOOGLE_WORKSPACE_EMAILS=work@company.com,personal@gmail.com
```

### Choose Tool Tier (Optional)

Control how many Google tools are exposed to the agent:

```bash
GOOGLE_WORKSPACE_TOOL_TIER=core
```

| Tier             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `core` (default) | Essential tools: search, read, create, basic modify       |
| `extended`       | Core + labels, folders, batch operations, advanced search |
| `complete`       | Full API access including admin functions                 |

Or specify exactly which services to enable:

```bash
GOOGLE_WORKSPACE_TOOLS=gmail drive calendar
```

### Google Custom Search (Optional)

For web search through Google's Programmable Search Engine:

```bash
GOOGLE_PSE_API_KEY=your-api-key
GOOGLE_PSE_ENGINE_ID=your-engine-id
```

## Step 6: Authorize on First Run

Start the daemon:

```bash
pnpm daemon:dev
```

On the first run, a browser window will open asking you to authorize the application. For each configured email account:

1. Select the Google account
2. Review the requested permissions
3. Click **Allow**

The OAuth tokens are cached locally for subsequent runs.

If you configured multiple accounts via `GOOGLE_WORKSPACE_EMAILS`, you'll authorize each account separately.

## Available Services and Tools

### Gmail

- Search emails by query
- Read individual emails
- Send new emails
- Create drafts
- Manage labels
- Thread operations

### Google Calendar

- List calendars
- Get, create, modify, and delete events
- Search events by date range

### Google Drive

- Search for files
- Read file contents
- Create new files
- Share files with others
- Copy files

### Google Docs

- Read document content
- Create new documents
- Update document content

### Google Sheets

- Read spreadsheet data
- Write to cells and ranges
- Add new sheets to workbooks

### Google Slides

- Create presentations
- Update slide content

### Google Forms

- Create forms
- Update form questions
- Get form responses

### Google Tasks

- List task lists
- Create, update, and delete tasks

### Contacts (People API)

- List contacts
- Search contacts by name or email
- Create new contacts

### Google Chat (Workspace Only)

- List chat spaces
- Send messages to spaces

> **Note:** Google Chat requires a Google Workspace account (not available with free Gmail).

## Multi-Account Setup

When multiple emails are configured, the assistant creates a separate MCP server for each account. The agent automatically selects the appropriate account based on context — for example, if you ask "check my work calendar," it uses the work account.

```bash
GOOGLE_WORKSPACE_EMAILS=work@company.com,personal@gmail.com
```

Each account authenticates independently and has its own set of tools.

## Troubleshooting

### "Access blocked: This app's request is invalid"

- Make sure you're using **Desktop app** credentials (not Web application)
- Verify the OAuth consent screen is configured
- Check that your email is listed as a test user

### "Access Not Configured" or API disabled errors

- Go to Google Cloud Console > APIs & Services > Library
- Search for and enable the specific API that's failing

### OAuth token expired

Tokens refresh automatically. If you encounter persistent auth errors:

1. Delete the cached tokens (check the daemon logs for the token file location)
2. Restart the daemon to re-authorize

### "uvx: command not found"

Install uv first:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Make sure `~/.local/bin` (or the uv install path) is in your `PATH`.

### MCP server fails to start

- Verify Python 3.10+ is installed: `python3 --version`
- Verify uv is installed: `uvx --version`
- Check that both `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are set
- Look at daemon logs for the specific error from the `workspace-mcp` process

### Rate limiting

Google API quotas vary by service. The MCP server handles rate-limit retries automatically. If you hit persistent quota errors, check your usage in the Google Cloud Console under **APIs & Services** > **Dashboard**.
