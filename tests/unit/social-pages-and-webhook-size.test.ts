import { describe, expect, it } from "vitest";

import { readBodyCapped } from "@/server/http/read-body";
import { createMetaSocial, MAX_PAGE_LIST_REQUESTS } from "@/server/social/meta-social";

const page = (id: number) => ({
  id: String(700000 + id),
  name: `Page ${String(id)}`,
  access_token: `T${String(id)}`,
});

function graph(respond: (url: URL, call: number) => unknown) {
  const urls: URL[] = [];
  const fetchImpl = (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url);
    return Promise.resolve(Response.json(respond(url, urls.length)));
  };
  return {
    urls,
    meta: createMetaSocial({
      appSecret: "x".repeat(32),
      version: "v26.0",
      fetch: fetchImpl,
    }),
  };
}

describe("listing Pages beyond the first 100", () => {
  it("follows Graph's cursor until the last page", async () => {
    const g = graph((url) =>
      url.searchParams.get("after") === null
        ? {
            data: Array.from({ length: 100 }, (_, i) => page(i)),
            paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" },
          }
        : { data: [page(100)], paging: { cursors: { after: "c2" } } },
    );
    const pages = await g.meta.listPages("USER-TOKEN");
    expect(pages).toHaveLength(101);
    expect(pages.at(-1)?.id).toBe("700100");
    expect(g.urls).toHaveLength(2);
    expect(g.urls[1]?.searchParams.get("after")).toBe("c1");
    // Every request is signed (appsecret_proof), including the follow-ups.
    expect(g.urls.every((url) => url.searchParams.get("appsecret_proof") !== null)).toBe(true);
  });

  it("stops on a repeated cursor and after a bounded number of requests", async () => {
    const stuck = graph(() => ({
      data: [page(1)],
      paging: { cursors: { after: "same" }, next: "https://graph.facebook.com/next" },
    }));
    await stuck.meta.listPages("USER-TOKEN");
    expect(stuck.urls).toHaveLength(2);

    const endless = graph((_url, call) => ({
      data: [page(call)],
      paging: { cursors: { after: `c${String(call)}` }, next: "https://graph.facebook.com/next" },
    }));
    expect(await endless.meta.listPages("USER-TOKEN")).toHaveLength(MAX_PAGE_LIST_REQUESTS);
    expect(endless.urls).toHaveLength(MAX_PAGE_LIST_REQUESTS);
  });
});

/** A request whose body streams in 64 KiB chunks, with no Content-Length (chunked). */
function streamed(totalBytes: number, headers: Record<string, string> = {}) {
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(65_536, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
  });
  const request = new Request("https://app.test/api/integrations/meta/webhook", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
  return { request, pulls: () => pulls };
}

describe("webhook body size cap", () => {
  it("stops reading a chunked body as soon as it passes the cap", async () => {
    const big = streamed(50 * 1024 * 1024);
    expect(await readBodyCapped(big.request, 1024 * 1024)).toEqual({
      ok: false,
      reason: "too_large",
    });
    // 1 MiB cap in 64 KiB chunks: about 17 chunks read, not the 800 of a 50 MiB body.
    expect(big.pulls()).toBeLessThan(25);
  });

  it("refuses a declared length over the cap without reading, and reads a small body", async () => {
    const declared = streamed(10, { "content-length": String(5 * 1024 * 1024) });
    expect(await readBodyCapped(declared.request, 1024 * 1024)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(declared.pulls()).toBeLessThanOrEqual(1);

    const small = await readBodyCapped(
      new Request("https://app.test/x", { method: "POST", body: '{"object":"page"}' }),
      1024,
    );
    expect(small.ok && new TextDecoder().decode(small.bytes)).toBe('{"object":"page"}');
  });

  // Measured at about 3 s on an idle machine (it loads the route's whole module graph) and
  // about 5 s on a contended one — too close to the default 5 s limit (Phase D.2
  // diagnosis). The assertions are unchanged; only the time budget is widened.
  it("the Meta webhook answers 413 to an oversized chunked body", { timeout: 20_000 }, async () => {
    const { POST } = await import("@/app/api/integrations/meta/webhook/route");
    const big = streamed(5 * 1024 * 1024, { "x-hub-signature-256": "sha256=00" });
    const response = await POST(big.request);
    expect(response.status).toBe(413);
    expect(big.pulls()).toBeLessThan(25);
  });

  it(
    "the WhatsApp webhook and Meta's user callbacks answer 413 to an oversized chunked body",
    { timeout: 20_000 },
    async () => {
      const routes = [
        await import("@/app/api/integrations/whatsapp/webhook/route"),
        await import("@/app/api/integrations/meta/deauthorize/route"),
        await import("@/app/api/integrations/meta/data-deletion/route"),
      ];
      for (const { POST } of routes) {
        // No Content-Length: only the streaming cap can stop it. 20 MiB is 320 chunks; the
        // largest cap (WhatsApp, 3 MiB) is passed after about 49.
        const big = streamed(20 * 1024 * 1024, { "x-hub-signature-256": "sha256=00" });
        const response = await POST(big.request);
        expect(response.status).toBe(413);
        expect(big.pulls()).toBeLessThan(60);
      }
    },
  );
});
