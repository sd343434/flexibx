// Reads a one-time code from standard input for scripts/admin/grant.ts.
//
// - Interactive terminal: the terminal is put in raw mode while the code is typed, so
//   nothing is echoed; the previous terminal mode is restored on every exit path (Enter,
//   Ctrl-C, Ctrl-D, an error, SIGTERM/SIGHUP — see restoreTerminal) and nothing of the
//   code is printed (no asterisks either).
// - Pipe or file: one line is read. Whether that is secret depends on how the caller
//   produced it (docs/runbooks/ADMIN_PROVISIONING.md § 2): stdin itself guarantees nothing.

import { createInterface } from "node:readline/promises";

/** The operator pressed Ctrl-C while typing the code. */
export class CodeInputCancelled extends Error {
  constructor() {
    super("code input cancelled");
  }
}

const MAX_LENGTH = 64;

let restoreHook: (() => void) | null = null;

/** Puts the terminal back as it was if a hidden read is in progress (idempotent). */
export function restoreTerminal(): void {
  const hook = restoreHook;
  restoreHook = null;
  hook?.();
}

function readHidden(stdin: NodeJS.ReadStream, prompt: NodeJS.WritableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          restoreTerminal();
          prompt.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          restoreTerminal();
          prompt.write("\n");
          reject(new CodeInputCancelled());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " " && value.length < MAX_LENGTH) {
          value += char;
        }
      }
    };
    restoreHook = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function readLine(stdin: NodeJS.ReadStream): Promise<string> {
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
  }
}

/** Prompts on `prompt` (stderr) and reads one code, without echo on a terminal. */
export async function readCode(
  label: string,
  stdin: NodeJS.ReadStream = process.stdin,
  prompt: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  prompt.write(label);
  const value = stdin.isTTY ? await readHidden(stdin, prompt) : await readLine(stdin);
  return value.trim();
}
