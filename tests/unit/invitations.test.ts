import { describe, expect, it, vi } from "vitest";

import { isAppError } from "@/server/errors/app-error";
import {
  createMailer,
  LogMailer,
  maskEmail,
  MemoryMailer,
  UnconfiguredMailer,
  type MailMessage,
} from "@/server/mail/mailer";
import { escapeHtml, renderMail } from "@/server/mail/templates";
import { INVITATION_URL_PATTERN, REDACTED, redactString } from "@/server/redact";
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
  invitationExpiry,
  isInvitationToken,
} from "@/server/workspaces/invitation-token";
import {
  acceptInvitationInputSchema,
  changeMemberRoleInputSchema,
  GRANTABLE_ROLES,
  inviteMemberInputSchema,
  removeMemberInputSchema,
} from "@/server/workspaces/member-input";

// Phase 2, step 7: invitation tokens, member input schemas, mailer transports and
// email templates (pure parts; the database flows are integration-tested).

const UUID = "3f6c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("invitation tokens", () => {
  it("are 256-bit random base64url strings, unique per call", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInvitationToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(isInvitationToken(token)).toBe(true);
    expect(Buffer.from([...tokens][0] ?? "", "base64url")).toHaveLength(32);
  });

  it("are stored only as a SHA-256 hex digest", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(generateInvitationToken())).not.toBe(hash);
  });

  it("rejects anything that is not exactly a token", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "short",
      `${"a".repeat(43)}=`,
      "a".repeat(44),
      `${"a".repeat(42)}/`,
      `${"a".repeat(42)}.`,
    ]) {
      expect(isInvitationToken(value)).toBe(false);
    }
  });

  it("expire after seven days", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(invitationExpiry(now).toISOString()).toBe("2026-10-14T10:00:00.000Z");
  });

  it("links use APP_URL's origin and the requested locale only", () => {
    const token = generateInvitationToken();
    expect(buildInvitationUrl("https://app.flexibx.test", "ar", token)).toBe(
      `https://app.flexibx.test/ar/invite/${token}`,
    );
    expect(buildInvitationUrl("https://app.flexibx.test/some/path/", "en", token)).toBe(
      `https://app.flexibx.test/en/invite/${token}`,
    );
  });
});

describe("member input schemas", () => {
  it("never accept OWNER or CLIENT as a grantable role", () => {
    expect(GRANTABLE_ROLES).toEqual(["ADMIN", "MANAGER", "EDITOR", "VIEWER"]);
    for (const role of ["OWNER", "CLIENT", "owner", "SUPERUSER"]) {
      const invite = { slug: "acme", email: "a@b.co", role, locale: "en" };
      expect(inviteMemberInputSchema.safeParse(invite).success).toBe(false);
      const change = { slug: "acme", memberId: UUID, role };
      expect(changeMemberRoleInputSchema.safeParse(change).success).toBe(false);
    }
  });

  it("reject smuggled authority (workspace id, user id, acting role)", () => {
    for (const extra of [{ workspaceId: UUID }, { userId: UUID }, { actorRole: "OWNER" }]) {
      const invite = { slug: "acme", email: "a@b.co", role: "VIEWER", locale: "en", ...extra };
      expect(inviteMemberInputSchema.safeParse(invite).success).toBe(false);
      expect(
        removeMemberInputSchema.safeParse({ slug: "acme", memberId: UUID, ...extra }).success,
      ).toBe(false);
    }
  });

  it("normalize the invited email and require ids and tokens in their exact shape", () => {
    const parsed = inviteMemberInputSchema.parse({
      slug: "acme",
      email: "  Reem@Example.COM ",
      role: "EDITOR",
      locale: "ar",
    });
    expect(parsed.email).toBe("reem@example.com");
    expect(
      inviteMemberInputSchema.safeParse({
        slug: "acme",
        email: "nope",
        role: "EDITOR",
        locale: "ar",
      }).success,
    ).toBe(false);
    expect(
      inviteMemberInputSchema.safeParse({
        slug: "acme",
        email: "a@b.co",
        role: "EDITOR",
        locale: "fr",
      }).success,
    ).toBe(false);
    expect(removeMemberInputSchema.safeParse({ slug: "acme", memberId: "1" }).success).toBe(false);
    expect(
      acceptInvitationInputSchema.safeParse({ token: generateInvitationToken() }).success,
    ).toBe(true);
    expect(acceptInvitationInputSchema.safeParse({ token: "../../etc" }).success).toBe(false);
  });
});

function message(
  overrides: Partial<MailMessage["data"]> = {},
  locale: "ar" | "en" = "en",
): MailMessage {
  return {
    to: "invitee@example.com",
    locale,
    template: "workspace_invitation",
    data: {
      workspaceName: "Acme",
      inviterName: "Reem",
      role: "EDITOR",
      acceptUrl: "https://app.flexibx.test/en/invite/TOKEN_abc",
      expiresAt: new Date("2026-10-14T10:00:00Z"),
      ...overrides,
    },
  };
}

describe("invitation email template", () => {
  it("renders a localized subject, text and HTML with the accept link", () => {
    const en = renderMail(message());
    expect(en.subject).toBe("You're invited to join Acme on Flexibx");
    expect(en.text).toContain("Reem invited you to join the workspace Acme on Flexibx as Editor.");
    expect(en.text).toContain("https://app.flexibx.test/en/invite/TOKEN_abc");
    expect(en.text).toContain("October 14, 2026");
    expect(en.html).toContain('<html lang="en" dir="ltr">');
    expect(en.html).toContain('<a href="https://app.flexibx.test/en/invite/TOKEN_abc">');

    const ar = renderMail(message({}, "ar"));
    expect(ar.subject).toBe("دعوة للانضمام إلى Acme على Flexibx");
    expect(ar.text).toContain("بدور محرر");
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
  });

  it("escapes every interpolated value in the HTML part", () => {
    const evil = '<script>alert("x")</script>&\'';
    const { html } = renderMail(message({ workspaceName: evil, inviterName: "<b>Mal</b>" }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Mal</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("keeps the subject on one line and accepts only http(s) links", () => {
    expect(renderMail(message({ workspaceName: "Acme\r\nBcc: x@evil.test" })).subject).not.toMatch(
      /[\r\n]/,
    );
    expect(() => renderMail(message({ acceptUrl: "javascript:alert(1)" }))).toThrow();
    expect(() => renderMail(message({ acceptUrl: "not a url" }))).toThrow();
  });
});

describe("mailer transports", () => {
  it("memory transport captures rendered messages and reports 'captured', never 'sent'", async () => {
    const mailer = new MemoryMailer();
    await expect(mailer.send(message())).resolves.toEqual({ status: "captured" });
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]?.to).toBe("invitee@example.com");
    expect(mailer.outbox[0]?.text).toContain("/en/invite/TOKEN_abc");
    mailer.clear();
    expect(mailer.outbox).toHaveLength(0);
  });

  it("development transport logs a redacted record without subject, body or link", async () => {
    const info = vi.fn();
    const mailer = new LogMailer({ info });
    await expect(mailer.send(message())).resolves.toEqual({ status: "logged" });
    expect(info).toHaveBeenCalledOnce();
    const logged = JSON.stringify(info.mock.calls[0]);
    expect(logged).not.toContain("TOKEN_abc");
    expect(logged).not.toContain("invite/");
    expect(logged).not.toContain("invitee@example.com");
    expect(logged).not.toContain("Acme");
    expect(logged).toContain("i***@example.com");
    expect(logged).toContain("workspace_invitation");
  });

  it("with no provider, sending fails explicitly", async () => {
    const error: unknown = await new UnconfiguredMailer()
      .send(message())
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("SERVICE_UNAVAILABLE");
    expect(isAppError(error) && error.metadata.reason).toBe("mailer_not_configured");
  });

  it("production never gets a development or test transport", () => {
    const log = { info: vi.fn() };
    expect(createMailer("production", log)).toBeInstanceOf(UnconfiguredMailer);
    expect(createMailer("test", log)).toBeInstanceOf(MemoryMailer);
    expect(createMailer("development", log)).toBeInstanceOf(LogMailer);
    expect(createMailer(undefined, log)).toBeInstanceOf(LogMailer);
  });

  it("masks recipient addresses", () => {
    expect(maskEmail("reem@example.com")).toBe("r***@example.com");
    expect(maskEmail("@example.com")).toBe("***");
    expect(maskEmail("no-at-sign")).toBe("***");
  });
});

describe("invitation links in logs", () => {
  const token = generateInvitationToken();
  const invitePath = `/ar/invite/${token}`;
  // Every URL shape a browser sends that carries the token: the page, its RSC and
  // server-action requests, and the auth pages' `next` return path.
  const tokenUrls = [
    invitePath,
    `${invitePath}?_rsc=1x2y3`,
    `/ar/sign-in?next=${encodeURIComponent(invitePath)}`,
    `/en/sign-in?registered=1&next=${encodeURIComponent(invitePath).toLowerCase()}`,
    `/en/sign-up?next=${encodeURIComponent(invitePath)}`,
  ];

  it("redacts the token from invitation paths and URLs, encoded or not", () => {
    expect(redactString(`GET ${invitePath}?x=1`)).toBe(`GET /ar/invite/${REDACTED}?x=1`);
    expect(redactString(`https://app.test/en/invite/${token}`)).not.toContain(token);
    for (const url of tokenUrls) expect(redactString(url)).not.toContain(token);
  });

  it("keeps token-bearing URLs out of the `next dev` request log", async () => {
    const { default: config } = await import("../../next.config");
    // Next's own dev-server filter; it only reads `request.url`.
    const { ignoreLoggingIncomingRequests } =
      (await import("next/dist/server/dev/log-requests.js")) as unknown as {
        ignoreLoggingIncomingRequests: (request: { url: string }, logging: unknown) => boolean;
      };
    const ignored = (url: string) => ignoreLoggingIncomingRequests({ url }, config.logging);

    for (const url of tokenUrls) {
      expect(INVITATION_URL_PATTERN.test(url), url).toBe(true);
      expect(ignored(url), url).toBe(true);
    }
    // Everything else is still logged.
    for (const url of [
      "/ar",
      "/en/w/acme/members",
      "/ar/sign-in?next=%2Far%2Fw%2Facme",
      "/api/health",
    ]) {
      expect(ignored(url), url).toBe(false);
    }
  });
});
