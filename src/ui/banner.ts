import chalk from "chalk";

const TAGLINES: string[] = [
  "Your AI pair programmer",
  "Let's build something together",
  "Ready when you are",
  "Thinking in code since 2025",
  "Ask me anything, I'll figure it out",
  "From idea to implementation",
  "Your terminal, supercharged",
  "Less typing, more shipping",
  "The CLI that talks back",
  "Code companion, always on call",
  "Ctrl+C is not the answer... usually",
  "sudo make me a sandwich",
  "It works on my machine, and yours too",
  "No ticket? No problem",
  "Rubber duck, upgraded",
  "git commit -m 'it works now'",
  "Have you tried turning it off and on again?",
  "Pair programming without the awkward silences",
  "Stack Overflow, but conversational",
  "Will code for context",
  "The debugger that debugs itself",
  "Making sense of spaghetti code since forever",
  "One prompt at a time",
  "Built different, ships faster",
  "I read the docs so you don't have to",
  "Where ideas meet implementation",
  "Not just another chatbot",
  "Your codebase whisperer",
  "Making TODO into DONE",
  "All your tools, one conversation",
];

export function showBanner(opts: {
  agentName: string;
  agentEmoji?: string;
  version: string;
  model: string;
  sessionKey: string;
  resumedCount?: number;
}): void {
  const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
  const nameDisplay = opts.agentEmoji ? `${opts.agentEmoji} ${opts.agentName}` : opts.agentName;

  console.log();
  console.log(chalk.hex("#CBA6F7").bold(nameDisplay));
  console.log(chalk.dim.italic(tagline));
  console.log(
    chalk.dim(`v${opts.version}`) +
      chalk.dim(` | ${opts.model}`) +
      chalk.dim(` | session: ${opts.sessionKey}`),
  );

  if (opts.resumedCount && opts.resumedCount > 0) {
    console.log(chalk.dim(`Resumed session with ${opts.resumedCount} messages`));
  }

  console.log(chalk.dim("Type /help for commands, /quit to exit\n"));
}
