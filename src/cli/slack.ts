/**
 * CLI commands for Slack multi-workspace management.
 *
 * Usage:
 *   assistant slack auth              — Connect a workspace via OAuth
 *   assistant slack auth --token ...  — Connect with a manual token
 *   assistant slack workspaces        — List connected workspaces
 *   assistant slack remove <team-id>  — Remove a workspace
 */

import type { Command } from "commander";

export function registerSlackCommand(program: Command): void {
  const slack = program.command("slack").description("Manage Slack workspace connections");

  slack
    .command("auth")
    .description("Connect a Slack workspace (OAuth or manual token)")
    .option("-t, --token <token>", "Manual xoxp- token (skips OAuth)")
    .option("-p, --port <port>", "OAuth callback port", "9876")
    .action(async (options) => {
      if (options.token) {
        await authWithToken(options.token);
      } else {
        await authWithOAuth(parseInt(options.port, 10));
      }
    });

  slack
    .command("workspaces")
    .description("List connected Slack workspaces")
    .action(async () => {
      await listWorkspaces();
    });

  slack
    .command("remove <team-id>")
    .description("Remove a connected Slack workspace")
    .action(async (teamId: string) => {
      await removeWorkspace(teamId);
    });
}

async function authWithToken(token: string): Promise<void> {
  if (!token.startsWith("xoxp-")) {
    console.error("Token must be a user token starting with xoxp-");
    process.exit(1);
  }

  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);

  let authResult;
  try {
    authResult = await client.auth.test();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`auth.test failed: ${message}`);
    process.exit(1);
  }

  const teamId = authResult.team_id;
  const teamName = authResult.team ?? "unknown";
  const userId = authResult.user_id;

  if (!teamId || !userId) {
    console.error("Could not resolve team or user from token");
    process.exit(1);
  }

  // Run migrations to ensure table exists
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { upsertWorkspace } = await import("../db/slack-workspaces.ts");
  await upsertWorkspace({
    teamId,
    teamName,
    userId,
    accessToken: token,
  });

  console.log(`Connected workspace: ${teamName} (${teamId})`);
  console.log(`  User: ${authResult.user} (${userId})`);
  console.log("  Restart the daemon to activate this workspace.");

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}

async function authWithOAuth(port: number): Promise<void> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required for OAuth.");
    console.error("Set them in .env or run with --token for manual entry.");
    process.exit(1);
  }

  const http = await import("node:http");
  const crypto = await import("node:crypto");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${port}/slack/oauth/callback`;
  const userScopes = [
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "mpim:history",
    "chat:write",
    "users:read",
  ].join(",");

  const authorizeUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${userScopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/slack/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (returnedState !== state) {
      res.writeHead(400);
      res.end("Invalid state parameter — possible CSRF. Please try again.");
      cleanup();
      return;
    }

    if (!code) {
      res.writeHead(400);
      res.end("No authorization code received.");
      cleanup();
      return;
    }

    try {
      const { WebClient } = await import("@slack/web-api");
      const client = new WebClient();
      const result = await client.oauth.v2.access({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });

      const authedUser = result.authed_user as
        | { access_token?: string; id?: string; scope?: string }
        | undefined;
      const team = result.team as { id?: string; name?: string } | undefined;

      if (!authedUser?.access_token || !team?.id) {
        res.writeHead(500);
        res.end("OAuth succeeded but response is missing user token or team info.");
        cleanup();
        return;
      }

      // Run migrations and store
      const { runMigrations } = await import("../db/migrate.ts");
      await runMigrations();

      const { upsertWorkspace } = await import("../db/slack-workspaces.ts");
      await upsertWorkspace({
        teamId: team.id,
        teamName: team.name ?? "unknown",
        userId: authedUser.id ?? "unknown",
        accessToken: authedUser.access_token,
        scopes: authedUser.scope ?? "",
      });

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h1>Workspace connected!</h1>
          <p><strong>${team.name}</strong> (${team.id})</p>
          <p>You can close this tab and return to the terminal.</p>
        </body></html>
      `);

      console.log(`\nConnected workspace: ${team.name} (${team.id})`);
      console.log(`  User: ${authedUser.id}`);
      console.log("  Restart the daemon to activate this workspace.");

      const { closeDb } = await import("../db/client.ts");
      await closeDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(`OAuth token exchange failed: ${message}`);
      console.error(`OAuth error: ${message}`);
    }

    cleanup();
  });

  let timeout: ReturnType<typeof setTimeout>;

  function cleanup() {
    clearTimeout(timeout);
    server.close();
  }

  server.listen(port, () => {
    console.log(`OAuth callback server listening on port ${port}`);
    console.log(`\nOpen this URL in your browser to authorize:\n`);
    console.log(`  ${authorizeUrl}\n`);

    // Try to open the browser automatically
    import("node:child_process")
      .then(({ exec }) => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${cmd} "${authorizeUrl}"`);
      })
      .catch(() => {
        // Silently fail — user can open manually
      });
  });

  // Timeout after 120 seconds
  timeout = setTimeout(() => {
    console.error("\nOAuth timed out (120s). Please try again.");
    server.close();
    process.exit(1);
  }, 120_000);

  // Keep process alive until callback or timeout
  await new Promise<void>((resolve) => {
    server.on("close", resolve);
  });
}

async function listWorkspaces(): Promise<void> {
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { listWorkspaces: dbList } = await import("../db/slack-workspaces.ts");
  const workspaces = await dbList();

  if (workspaces.length === 0) {
    console.log("No Slack workspaces connected.");
    console.log('Run "assistant slack auth" to connect one.');
  } else {
    console.log(`Connected workspaces (${workspaces.length}):\n`);
    for (const ws of workspaces) {
      const date =
        ws.created_at instanceof Date ? ws.created_at.toLocaleDateString() : String(ws.created_at);
      console.log(`  ${ws.team_name} (${ws.team_id})`);
      console.log(`    User: ${ws.user_id}  Connected: ${date}`);
    }
  }

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}

async function removeWorkspace(teamId: string): Promise<void> {
  const { runMigrations } = await import("../db/migrate.ts");
  await runMigrations();

  const { getWorkspace, removeWorkspace: dbRemove } = await import("../db/slack-workspaces.ts");
  const ws = await getWorkspace(teamId);

  if (!ws) {
    console.error(`No workspace found with team ID: ${teamId}`);
    const { closeDb } = await import("../db/client.ts");
    await closeDb();
    process.exit(1);
  }

  // Attempt to revoke the token
  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(ws.access_token);
    await client.auth.revoke();
    console.log("Token revoked with Slack.");
  } catch {
    console.log("Token revocation skipped (may already be invalid).");
  }

  await dbRemove(teamId);
  console.log(`Removed workspace: ${ws.team_name} (${ws.team_id})`);
  console.log("Restart the daemon to apply changes.");

  const { closeDb } = await import("../db/client.ts");
  await closeDb();
}
