// scripts/admin/code-input.ts: on a terminal the code is read in raw mode (no echo) and
// the previous mode is restored immediately on every path — Enter, Ctrl-D, Ctrl-C and an
// external signal (restoreTerminal). Node also resets the terminal when the process exits,
// so the end-to-end check in tests/integration/admin-grant.test.ts cannot tell an
// in-process restore from that reset; this test can.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { CodeInputCancelled, readCode, restoreTerminal } from "../../scripts/admin/code-input";

class FakeTty extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  readonly modes: boolean[] = [];
  paused = true;
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  type(text: string) {
    this.emit("data", Buffer.from(text));
  }
}

function setup() {
  const stdin = new FakeTty();
  const prompt = new PassThrough();
  let written = "";
  prompt.on("data", (chunk: Buffer) => (written += chunk.toString()));
  const read = readCode("Code: ", stdin as unknown as NodeJS.ReadStream, prompt);
  return { stdin, read, written: () => written };
}

describe("code input on a terminal", () => {
  it("reads in raw mode, prints nothing of the code, and restores the mode on Enter", async () => {
    const { stdin, read, written } = setup();
    expect(stdin.isRaw).toBe(true);
    stdin.type("12");
    stdin.type("3x\u007f456\r");
    await expect(read).resolves.toBe("123456");
    expect(stdin.modes).toEqual([true, false]);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(written()).toBe("Code: \n");
  });

  it("restores the mode on Ctrl-D and on Ctrl-C (cancelled)", async () => {
    const eof = setup();
    eof.stdin.type("654321\u0004");
    await expect(eof.read).resolves.toBe("654321");
    expect(eof.stdin.isRaw).toBe(false);

    const interrupted = setup();
    interrupted.stdin.type("65\u0003");
    await expect(interrupted.read).rejects.toBeInstanceOf(CodeInputCancelled);
    expect(interrupted.stdin.modes).toEqual([true, false]);
    expect(interrupted.written()).not.toContain("65");
  });

  it("restoreTerminal() (signal handlers, exit) restores a read in progress, once", () => {
    const { stdin, read } = setup();
    void read.catch(() => undefined);
    stdin.type("99");
    restoreTerminal();
    restoreTerminal();
    expect(stdin.modes).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("reads one line from a pipe without touching terminal modes", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const prompt = new PassThrough();
    const read = readCode("Code: ", stdin, prompt);
    (stdin as unknown as PassThrough).end(" 112233 \nignored\n");
    await expect(read).resolves.toBe("112233");
  });
});
