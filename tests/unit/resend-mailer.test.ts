import { describe, expect, it, vi } from "vitest";

import { parseMailEnv } from "@/server/env-schema";
import { isAppError } from "@/server/errors/app-error";
import {
  createMailer,
  RESEND_ENDPOINT,
  ResendMailer,
  type MailMessage,
} from "@/server/mail/mailer";

const KEY = "re_test_not_a_real_key";
const message: MailMessage = {
  to: "invitee@example.com",
  locale: "ar",
  template: "workspace_invitation",
  data: {
    workspaceName: "Acme",
    inviterName: "Reem",
    role: "EDITOR",
    acceptUrl: "https://app.flexibx.test/ar/invite/TOKEN_abc",
    expiresAt: new Date("2026-10-14T10:00:00Z"),
  },
};

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(respond());
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

const failure = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const instant = () => Promise.resolve();
const keyOf = (call: { init: RequestInit } | undefined) =>
  (call?.init.headers as Record<string, string> | undefined)?.["idempotency-key"];

describe("Resend mailer", () => {
  it("sends the rendered message and reports sent only with an id", async () => {
    const fake = fakeFetch(() => Response.json({ id: "email_1" }));
    const mailer = new ResendMailer({
      apiKey: KEY,
      from: "Flexibx <no-reply@mail.test>",
      fetch: fake.fetch,
    });
    await expect(mailer.send(message)).resolves.toEqual({ status: "sent" });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    if (call === undefined) throw new Error("no call");
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body.to).toEqual(["invitee@example.com"]);
    expect(body.from).toBe("Flexibx <no-reply@mail.test>");
    expect(String(body.html)).toContain("TOKEN_abc");
    expect(typeof body.subject).toBe("string");
  });

  it.each([
    ["a rejection", () => new Response("{}", { status: 422 }), "mail_provider_rejected"],
    ["a 2xx without an id", () => Response.json({}), "mail_provider_unexpected"],
    ["a non-JSON answer", () => new Response("ok"), "mail_provider_unexpected"],
  ])("fails explicitly on %s (never sent)", async (_name, respond, reason) => {
    const mailer = new ResendMailer({
      apiKey: KEY,
      from: "a@b.c",
      fetch: fakeFetch(respond).fetch,
    });
    const error = await failure(mailer.send(message));
    expect(isAppError(error) && error.code).toBe("SERVICE_UNAVAILABLE");
    expect(isAppError(error) && error.metadata.reason).toBe(reason);
    // Neither the key nor the recipient travels in the error.
    expect(JSON.stringify(isAppError(error) ? error.metadata : {})).not.toMatch(/re_test|invitee/);
  });

  it("fails explicitly when the provider is unreachable", async () => {
    const down = vi.fn(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as unknown as typeof fetch;
    const error = await failure(
      new ResendMailer({ apiKey: KEY, from: "a@b.c", fetch: down, sleep: instant }).send(message),
    );
    expect(isAppError(error) && error.metadata.reason).toBe("mail_provider_unreachable");
    expect(down).toHaveBeenCalledTimes(3);
  });

  // Pass 38: retries reuse ONE idempotency key, so Resend delivers an email at most once
  // even when an accepted attempt's answer was lost.
  it("retries a lost answer, a 429 and a 5xx with the same idempotency key", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError("socket hang up")),
      () => new Response("{}", { status: 503 }),
      () => Response.json({ id: "email_2" }),
    ];
    const fake = fakeFetch(() => (answers.shift() ?? (() => new Response("", { status: 500 })))());
    const waits: number[] = [];
    const mailer = new ResendMailer({
      apiKey: KEY,
      from: "a@b.c",
      fetch: fake.fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await expect(mailer.send(message)).resolves.toEqual({ status: "sent" });
    expect(fake.calls).toHaveLength(3);
    const keys = fake.calls.map(keyOf);
    expect(keys[0]).toMatch(/^flexibx-mail-[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(new Set(fake.calls.map((call) => call.init.body)).size).toBe(1);
    expect(waits).toEqual([500, 1500]);
    // A new email gets a new key.
    const other = fakeFetch(() => Response.json({ id: "email_3" }));
    await new ResendMailer({ apiKey: KEY, from: "a@b.c", fetch: other.fetch }).send(message);
    expect(keyOf(other.calls[0])).not.toBe(keys[0]);
  });

  it("gives up after three attempts on 429, reporting the provider's status", async () => {
    const fake = fakeFetch(() => new Response("{}", { status: 429 }));
    const error = await failure(
      new ResendMailer({ apiKey: KEY, from: "a@b.c", fetch: fake.fetch, sleep: instant }).send(
        message,
      ),
    );
    expect(fake.calls).toHaveLength(3);
    expect(isAppError(error) && error.metadata).toMatchObject({
      reason: "mail_provider_rejected",
      status: 429,
    });
  });

  it("does not retry a request the provider refused (4xx other than 429)", async () => {
    const fake = fakeFetch(() => new Response("{}", { status: 422 }));
    await failure(
      new ResendMailer({ apiKey: KEY, from: "a@b.c", fetch: fake.fetch, sleep: instant }).send(
        message,
      ),
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("is selected only explicitly, with its key and sender", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const resend = { apiKey: KEY, from: "a@b.c" };
    expect(createMailer("production", log, { transport: "resend", resend })).toBeInstanceOf(
      ResendMailer,
    );
    expect(() => createMailer("production", log, { transport: "resend" })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => new ResendMailer({ apiKey: " ", from: "a@b.c" })).toThrow();
  });

  it("the env refuses resend without its key or sender", () => {
    expect(() => parseMailEnv({ MAIL_TRANSPORT: "resend", MAIL_FROM: "a@b.c" })).toThrow();
    expect(() => parseMailEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY })).toThrow();
    expect(
      parseMailEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "a@b.c" })
        .MAIL_TRANSPORT,
    ).toBe("resend");
    expect(parseMailEnv({}).MAIL_TRANSPORT).toBeUndefined();
  });
});
