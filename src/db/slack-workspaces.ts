/**
 * Slack workspace token CRUD operations.
 *
 * Stores per-workspace xoxp- tokens for multi-workspace Slack User Mode.
 * Each row maps a Slack team_id to an OAuth user token.
 */

import { getDb } from "./client.ts";

export interface SlackWorkspaceRow {
  id: string;
  team_id: string;
  team_name: string;
  user_id: string;
  access_token: string;
  scopes: string;
  created_at: Date;
  updated_at: Date;
}

export async function upsertWorkspace(params: {
  teamId: string;
  teamName: string;
  userId: string;
  accessToken: string;
  scopes?: string;
}): Promise<SlackWorkspaceRow> {
  const sql = getDb();
  const [row] = await sql<SlackWorkspaceRow[]>`
    INSERT INTO slack_user_tokens (team_id, team_name, user_id, access_token, scopes)
    VALUES (
      ${params.teamId},
      ${params.teamName},
      ${params.userId},
      ${params.accessToken},
      ${params.scopes ?? ""}
    )
    ON CONFLICT (team_id) DO UPDATE SET
      team_name = EXCLUDED.team_name,
      user_id = EXCLUDED.user_id,
      access_token = EXCLUDED.access_token,
      scopes = EXCLUDED.scopes,
      updated_at = now()
    RETURNING *
  `;
  return row;
}

export async function listWorkspaces(): Promise<SlackWorkspaceRow[]> {
  const sql = getDb();
  return sql<SlackWorkspaceRow[]>`
    SELECT * FROM slack_user_tokens ORDER BY team_name
  `;
}

export async function getWorkspace(teamId: string): Promise<SlackWorkspaceRow | null> {
  const sql = getDb();
  const [row] = await sql<SlackWorkspaceRow[]>`
    SELECT * FROM slack_user_tokens WHERE team_id = ${teamId}
  `;
  return row ?? null;
}

export async function getWorkspaceByPlatform(platform: string): Promise<SlackWorkspaceRow | null> {
  const teamId = platform.replace(/^slack-user:/, "");
  if (!teamId || teamId === platform) return null;
  return getWorkspace(teamId);
}

export async function removeWorkspace(teamId: string): Promise<SlackWorkspaceRow | null> {
  const sql = getDb();
  const [row] = await sql<SlackWorkspaceRow[]>`
    DELETE FROM slack_user_tokens WHERE team_id = ${teamId} RETURNING *
  `;
  return row ?? null;
}
