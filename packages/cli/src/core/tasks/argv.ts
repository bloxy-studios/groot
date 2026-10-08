/**
 * Acceptance commands are given as strings (`--accept "bun test"`) but run
 * WITHOUT a shell: the string is split into argv here, once, at task
 * creation, and stored as argv in the task. Quotes and backslash escapes work
 * as in a POSIX shell; anything that would need a shell to mean what it
 * looks like (pipes, chaining, redirects, substitutions, variables, globs of
 * `~`) is refused instead of being passed through literally.
 */
import { GrootV2Error } from "../errors.ts";

const SHELL_ONLY = new Set(["|", "&", ";", "<", ">", "(", ")", "`", "$"]);

function refuse(command: string, reason: string): GrootV2Error {
  return new GrootV2Error("GROOT_E_USAGE", `Acceptance command "${command}" ${reason}.`, {
    hint: "Acceptance commands run without a shell: one program and its arguments. Put pipelines or chained steps in a package.json script and accept `bun run <script>`.",
  });
}

/** Split a command string into argv without invoking a shell. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (
        ch === "\\" &&
        i + 1 < command.length &&
        '"\\$`'.includes(command[i + 1] as string)
      ) {
        current += command[++i];
      } else if (ch === "$" || ch === "`") {
        throw refuse(command, "uses shell substitution inside double quotes");
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\") {
      if (i + 1 < command.length) current += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else if (SHELL_ONLY.has(ch)) {
      throw refuse(command, `contains "${ch}", which only means something to a shell`);
    } else if (ch === "~" && !inWord) {
      throw refuse(command, 'starts an argument with "~", which only a shell expands');
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote !== null) throw refuse(command, "has an unterminated quote");
  if (inWord) args.push(current);
  if (args.length === 0) throw refuse(command, "is empty");
  return args;
}

/** Render argv back to a copy-pasteable command line (for prompts and summaries). */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`))
    .join(" ");
}
