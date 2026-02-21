import { Command } from "commander";
import { registerChatCommand } from "./chat.ts";
import { registerConfigCommand } from "./config.ts";
import { registerSessionCommand } from "./session.ts";
import { registerDbCommand } from "./db.ts";
import { registerMemoryCommand } from "./memory.ts";
import { registerDaemonCommand } from "./daemon.ts";
import { registerSlackCommand } from "./slack.ts";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("assistant")
    .description("AI assistant powered by Anthropic Claude models")
    .version("0.1.0");

  registerChatCommand(program);
  registerConfigCommand(program);
  registerSessionCommand(program);
  registerDbCommand(program);
  registerMemoryCommand(program);
  registerDaemonCommand(program);
  registerSlackCommand(program);

  // Default command: run chat if no subcommand specified
  program.action(async (options) => {
    const chatCmd = program.commands.find((c) => c.name() === "chat");
    if (chatCmd) {
      await chatCmd.parseAsync(process.argv);
    }
  });

  return program;
}
