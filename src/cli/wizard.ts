import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

/**
 * First-run setup wizard. Detects missing .env and walks the user
 * through creating one interactively.
 */
export async function runSetupWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue ? chalk.dim(` [${defaultValue}]`) : "";
    return new Promise((resolve) => {
      rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || "");
      });
    });
  };

  console.log();
  console.log(chalk.bold("Welcome to Nomos"));
  console.log(chalk.dim("Let's set up your environment.\n"));

  // 1. Database URL
  console.log(chalk.bold("1. Database"));
  console.log(
    chalk.dim(
      "  Nomos needs PostgreSQL with pgvector. Quick Docker setup:\n" +
        "  docker run -d --name nomos-db \\\n" +
        "    -e POSTGRES_USER=nomos -e POSTGRES_PASSWORD=nomos \\\n" +
        "    -e POSTGRES_DB=nomos -p 5432:5432 pgvector/pgvector:pg17\n",
    ),
  );
  const databaseUrl = await ask("  DATABASE_URL", "postgresql://nomos:nomos@localhost:5432/nomos");

  // 2. API Provider
  console.log();
  console.log(chalk.bold("2. API Provider"));
  const providerChoice = await ask(
    "  Use Anthropic API key or Vertex AI? (anthropic/vertex)",
    "anthropic",
  );

  let anthropicApiKey = "";
  let googleCloudProject = "";
  let cloudMlRegion = "";

  if (providerChoice.toLowerCase().startsWith("v")) {
    googleCloudProject = await ask("  GOOGLE_CLOUD_PROJECT");
    cloudMlRegion = await ask("  CLOUD_ML_REGION", "us-east5");
    console.log(chalk.dim("  Make sure to run: gcloud auth application-default login"));
  } else {
    anthropicApiKey = await ask("  ANTHROPIC_API_KEY");
  }

  // 3. Model
  console.log();
  console.log(chalk.bold("3. Model"));
  const model = await ask("  NOMOS_MODEL", "claude-sonnet-4-6");

  // Write .env
  const lines: string[] = ["# Nomos configuration", `DATABASE_URL=${databaseUrl}`, ""];

  if (anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${anthropicApiKey}`);
  }
  if (googleCloudProject) {
    lines.push("CLAUDE_CODE_USE_VERTEX=1");
    lines.push(`GOOGLE_CLOUD_PROJECT=${googleCloudProject}`);
    if (cloudMlRegion) {
      lines.push(`CLOUD_ML_REGION=${cloudMlRegion}`);
    }
  }

  lines.push("", `NOMOS_MODEL=${model}`, "");

  const envPath = path.resolve(".env");
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

  console.log();
  console.log(chalk.dim(`Wrote ${envPath}`));
  console.log(chalk.dim("You can edit this file anytime to change settings.\n"));

  rl.close();
}

/**
 * Check if the setup wizard should run.
 * Returns true if .env is missing or lacks DATABASE_URL.
 */
export function shouldRunWizard(): boolean {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return true;

  const content = fs.readFileSync(envPath, "utf-8");
  // Check for an actual DATABASE_URL value (not just a comment or empty)
  const lines = content.split("\n");
  return !lines.some(
    (line) =>
      line.startsWith("DATABASE_URL=") && line.slice("DATABASE_URL=".length).trim().length > 0,
  );
}
