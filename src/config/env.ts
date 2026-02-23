import process from "node:process";
import type { ScopeMode } from "../sessions/types.ts";
import type { ApprovalPolicy } from "../security/tool-approval.ts";

export interface NomosConfig {
  /** PostgreSQL connection URL */
  databaseUrl?: string;
  /** Default model to use (passed to SDK) */
  model: string;
  /** Google Cloud project ID (for Vertex AI and embeddings) */
  googleCloudProject?: string;
  /** Location for Vertex AI services like embeddings */
  vertexAiLocation: string;
  /** Embedding model for memory (default: gemini-embedding-001) */
  embeddingModel: string;
  /** Permission mode for the SDK session */
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  /** SDK betas to enable (comma-separated in env var) */
  betas?: "context-1m-2025-08-07"[];
  /** Fallback models to use if primary model fails */
  fallbackModels?: string[];
  /** Heartbeat interval in milliseconds (0 = disabled, default: 1800000 = 30 minutes) */
  heartbeatIntervalMs: number;
  /** Opt-in to V2 SDK session API (if available) */
  useV2Sdk?: boolean;
  /** Pairing request TTL in minutes (default: 60) */
  pairingTtlMinutes: number;
  /** Default DM policy: "pairing" | "allowlist" | "open" */
  defaultDmPolicy: "pairing" | "allowlist" | "open";
  /** Session scope mode: "channel" | "sender" | "peer" | "channel-peer" (default: "channel") */
  sessionScope: ScopeMode;
  /** Tool approval policy for dangerous operations (default: "block_critical") */
  toolApprovalPolicy: ApprovalPolicy;
}

export function loadEnvConfig(): NomosConfig {
  const betasEnv = process.env.NOMOS_BETAS;
  const fallbackModelsEnv = process.env.NOMOS_FALLBACK_MODELS;
  const isProduction = process.env.NODE_ENV === "production";

  return {
    databaseUrl: process.env.DATABASE_URL,
    model: process.env.NOMOS_MODEL ?? "claude-sonnet-4-6",
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    vertexAiLocation: process.env.VERTEX_AI_LOCATION ?? "global",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    permissionMode:
      (process.env.NOMOS_PERMISSION_MODE as NomosConfig["permissionMode"]) ?? "acceptEdits",
    betas: betasEnv
      ? (betasEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as "context-1m-2025-08-07"[])
      : undefined,
    fallbackModels: fallbackModelsEnv
      ? fallbackModelsEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    heartbeatIntervalMs: process.env.HEARTBEAT_INTERVAL_MS
      ? parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10)
      : 1800000,
    useV2Sdk: process.env.NOMOS_USE_V2_SDK === "true",
    pairingTtlMinutes: process.env.PAIRING_TTL_MINUTES
      ? parseInt(process.env.PAIRING_TTL_MINUTES, 10)
      : 60,
    defaultDmPolicy:
      (process.env.DEFAULT_DM_POLICY as "pairing" | "allowlist" | "open") ??
      (isProduction ? "pairing" : "open"),
    sessionScope: (process.env.NOMOS_SESSION_SCOPE as ScopeMode) ?? "channel",
    toolApprovalPolicy: (process.env.TOOL_APPROVAL_POLICY as ApprovalPolicy) ?? "block_critical",
  };
}

export function validateConfig(cfg: NomosConfig): string[] {
  const errors: string[] = [];

  // SDK handles provider auth via ANTHROPIC_API_KEY or CLAUDE_CODE_USE_VERTEX env vars.
  // We only require DATABASE_URL for our persistence layer.
  if (!cfg.databaseUrl) {
    errors.push("DATABASE_URL is required. Set it to your PostgreSQL connection string.");
  }

  return errors;
}
