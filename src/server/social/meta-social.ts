import { createHmac } from "node:crypto";

import { graphFailureKind } from "../meta/graph-errors";

// Meta Graph calls for the AI Social Manager: the Pages (and their Instagram professional
// accounts) a person manages, the Page webhook subscription, replies to comments and
// messages, and reading recent comments. Pure (no `server-only`) for tests; `fetch` is
// injected. Every call carries `appsecret_proof`. Page access tokens come from
// /me/accounts with the workspace's user token right before use and are never stored.
//
// Endpoints (Graph API, documented):
// - GET  /me/accounts?fields=id,name,tasks,access_token,instagram_business_account{id,username}
// - POST /{page-id}/subscribed_apps  subscribed_fields=feed,messages
// - POST /{comment-id}/comments  message=…          (Facebook comment reply)
// - POST /{ig-comment-id}/replies message=…         (Instagram comment reply)
// - POST /{page-id}/messages  recipient, messaging_type=RESPONSE, message (Messenger /
//   Instagram Direct, only inside the 24-hour window after the person's last message)
// - GET  /{page-id}/feed?fields=id,comments{…}     /  GET /{ig-id}/media?fields=id,comments{…}
// - POST /{page-id}/feed  message=…, link=…          (publish a Page post)
// - GET  /{page-id}/feed?fields=id,message,created_time (find a post after a lost answer)

export const SOCIAL_REQUEST_TIMEOUT_MS = 15_000;
/** A photo upload carries up to MAX_PAGE_PHOTO_BYTES: it gets longer than other calls. */
export const SOCIAL_UPLOAD_TIMEOUT_MS = 60_000;

/** An image published with a Page post: the bytes themselves (never a storage URL). */
export interface PagePhoto {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

export type SocialFailure =
  | "token_expired"
  | "permission_missing"
  | "rate_limited"
  | "invalid_request"
  | "window_closed"
  | "provider_error";

export class SocialPlatformError extends Error {
  readonly kind: SocialFailure;
  /** A write that may still have taken effect (network error, 5xx, unknown error). */
  readonly uncertain: boolean;

  constructor(kind: SocialFailure, uncertain = false) {
    super(kind);
    this.name = "SocialPlatformError";
    this.kind = kind;
    this.uncertain = uncertain;
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const ID = /^[0-9_]{1,64}$/;
const cleanId = (value: unknown) => {
  const text = str(value);
  return text !== null && ID.test(text) ? text : null;
};

/** Graph error codes → failures: the shared table, plus the closed 24-hour window. */
function failureOf(code: number | null, subcode: number | null): SocialFailure {
  if (code === 10 && subcode === 2018278) return "window_closed";
  return graphFailureKind(code) ?? "provider_error";
}

export interface ManagedPage {
  readonly id: string;
  readonly name: string;
  /** Transient: used for the call at hand, never stored or logged. */
  readonly accessToken: string;
  readonly tasks: readonly string[];
  readonly instagram: { readonly id: string; readonly username: string } | null;
}

export interface RecentComment {
  readonly id: string;
  readonly postId: string;
  readonly text: string;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly createdAt: Date;
}

export interface MetaSocial {
  listPages(userToken: string): Promise<readonly ManagedPage[]>;
  subscribePage(page: ManagedPage): Promise<void>;
  replyToComment(
    page: ManagedPage,
    platform: "FACEBOOK" | "INSTAGRAM",
    commentId: string,
    message: string,
  ): Promise<string>;
  sendMessage(page: ManagedPage, recipientId: string, message: string): Promise<string>;
  /** The id of the account's own reply to a comment with exactly this text, if any. */
  findCommentReply(
    page: ManagedPage,
    platform: "FACEBOOK" | "INSTAGRAM",
    commentId: string,
    ownerId: string,
    message: string,
  ): Promise<Lookup>;
  recentComments(
    page: ManagedPage,
    platform: "FACEBOOK" | "INSTAGRAM",
    accountId: string,
  ): Promise<readonly RecentComment[]>;
  /** Publishes a text post (with an optional link) on the Page; returns the post id. */
  publishToPage(page: ManagedPage, message: string, link: string | null): Promise<string>;
  /**
   * Publishes a photo post on the Page: the image is uploaded as multipart `source` (Meta
   * never fetches it from our storage) with the message as its caption. Returns the feed
   * post id, which the same caption lookup (findPagePost) finds after a lost answer.
   */
  publishPhotoToPage(page: ManagedPage, message: string, photo: PagePhoto): Promise<string>;
  /** The id of the Page's own post with exactly this text since `since`, if any. */
  findPagePost(page: ManagedPage, message: string, since: Date): Promise<Lookup>;
}

/**
 * Looking for something we may have sent: found (its id), conclusively absent (every
 * candidate was read), or unknown (more candidates than one lookup reads) — unknown is
 * never treated as "not sent", so nothing is sent twice on a partial look.
 */
export type Lookup = { readonly id: string } | "not_found" | "unknown";

/** Pages of 100 replies (or 25 posts) read by one lookup before it answers "unknown". */
export const MAX_LOOKUP_REQUESTS = 10;

/** At most this many /me/accounts requests per listing (100 Pages each). */
export const MAX_PAGE_LIST_REQUESTS = 20;

export function createMetaSocial(config: {
  readonly appSecret: string;
  readonly version: string;
  readonly fetch?: typeof fetch;
}): MetaSocial {
  const http = config.fetch ?? fetch;
  const graph = `https://graph.facebook.com/${config.version}`;
  const proof = (token: string) =>
    createHmac("sha256", config.appSecret).update(token).digest("hex");

  async function request(
    method: "GET" | "POST",
    path: string,
    token: string,
    params: Json = {},
    file?: { readonly field: string; readonly photo: PagePhoto },
  ): Promise<Json> {
    const url = new URL(`${graph}${path}`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("appsecret_proof", proof(token));
    let body: URLSearchParams | FormData | undefined;
    const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
    if (method === "GET") {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, text(value));
    } else if (file === undefined) {
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) body.set(key, text(value));
    } else {
      // Multipart: the fields, then the file part (copied, so the caller's buffer is not
      // shared with the request body).
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) form.set(key, text(value));
      form.set(
        file.field,
        new Blob([file.photo.bytes.slice()], { type: file.photo.contentType }),
        file.photo.filename,
      );
      body = form;
    }
    let response: Response;
    try {
      response = await http(url, {
        method,
        headers: { accept: "application/json" },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(
          file === undefined ? SOCIAL_REQUEST_TIMEOUT_MS : SOCIAL_UPLOAD_TIMEOUT_MS,
        ),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new SocialPlatformError("provider_error", method === "POST");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok || (isRecord(json) && isRecord(json.error))) {
      const error = isRecord(json) && isRecord(json.error) ? json.error : {};
      const code = typeof error.code === "number" ? error.code : null;
      const subcode = typeof error.error_subcode === "number" ? error.error_subcode : null;
      const uncertain =
        method === "POST" && (response.status >= 500 || json === null || code === 1 || code === 2);
      throw new SocialPlatformError(failureOf(code, subcode), uncertain);
    }
    if (!isRecord(json)) throw new SocialPlatformError("provider_error", method === "POST");
    return json;
  }

  const data = (json: Json): Json[] => (Array.isArray(json.data) ? json.data.filter(isRecord) : []);
  /** Graph's cursor to the next page, or null on the last page. */
  const nextCursor = (json: Json): string | null => {
    const paging = isRecord(json.paging) ? json.paging : null;
    const cursors = isRecord(paging?.cursors) ? paging.cursors : null;
    return typeof paging?.next === "string" ? str(cursors?.after) : null;
  };

  return {
    async listPages(userToken) {
      // Cursor pagination (100 per request, Graph's page size here), bounded so a huge
      // Business Manager cannot turn one sync into an unbounded run of calls.
      const items: Json[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGE_LIST_REQUESTS; page += 1) {
        const json = await request("GET", "/me/accounts", userToken, {
          fields: "id,name,tasks,access_token,instagram_business_account{id,username}",
          limit: "100",
          ...(after === null ? {} : { after }),
        });
        items.push(...data(json));
        const paging = isRecord(json.paging) ? json.paging : null;
        const cursors = isRecord(paging?.cursors) ? paging.cursors : null;
        const next = str(cursors?.after);
        // Graph omits `next` on the last page; an unchanged cursor would loop forever.
        if (typeof paging?.next !== "string" || next === null || next === after) break;
        after = next;
      }
      return items.flatMap((item): ManagedPage[] => {
        const id = cleanId(item.id);
        const token = str(item.access_token);
        if (id === null || token === null || token === "") return [];
        const ig = isRecord(item.instagram_business_account)
          ? item.instagram_business_account
          : null;
        const igId = cleanId(ig?.id);
        return [
          {
            id,
            name: (str(item.name) ?? id).slice(0, 200),
            accessToken: token,
            tasks: Array.isArray(item.tasks)
              ? item.tasks.filter((t): t is string => typeof t === "string")
              : [],
            instagram:
              igId === null
                ? null
                : { id: igId, username: (str(ig?.username) ?? igId).slice(0, 200) },
          },
        ];
      });
    },

    async subscribePage(page) {
      await request("POST", `/${page.id}/subscribed_apps`, page.accessToken, {
        subscribed_fields: "feed,messages",
      });
    },

    async replyToComment(page, platform, commentId, message) {
      const id = cleanId(commentId);
      if (id === null) throw new SocialPlatformError("invalid_request");
      const edge = platform === "INSTAGRAM" ? "replies" : "comments";
      const json = await request("POST", `/${id}/${edge}`, page.accessToken, { message });
      const created = cleanId(json.id);
      if (created === null) throw new SocialPlatformError("provider_error", true);
      return created;
    },

    async sendMessage(page, recipientId, message) {
      const recipient = cleanId(recipientId);
      if (recipient === null) throw new SocialPlatformError("invalid_request");
      const json = await request("POST", `/${page.id}/messages`, page.accessToken, {
        recipient: { id: recipient },
        messaging_type: "RESPONSE",
        message: { text: message },
      });
      const created = str(json.message_id);
      if (created === null || created === "") throw new SocialPlatformError("provider_error", true);
      return created.slice(0, 128);
    },

    async findCommentReply(page, platform, commentId, ownerId, message) {
      const id = cleanId(commentId);
      if (id === null) return "not_found";
      const edge = platform === "INSTAGRAM" ? "replies" : "comments";
      const fields = platform === "INSTAGRAM" ? "id,text,from" : "id,message,from";
      let after: string | null = null;
      for (let call = 0; call < MAX_LOOKUP_REQUESTS; call += 1) {
        const json = await request("GET", `/${id}/${edge}`, page.accessToken, {
          fields,
          limit: "100",
          ...(after === null ? {} : { after }),
        });
        for (const item of data(json)) {
          const from = isRecord(item.from) ? cleanId(item.from.id) : null;
          const text = str(platform === "INSTAGRAM" ? item.text : item.message);
          const replyId = cleanId(item.id);
          if (from === ownerId && text?.trim() === message.trim() && replyId !== null) {
            return { id: replyId };
          }
        }
        const next = nextCursor(json);
        if (next === null || next === after) return "not_found";
        after = next;
      }
      return "unknown";
    },

    async recentComments(page, platform, accountId) {
      const path = platform === "INSTAGRAM" ? `/${accountId}/media` : `/${accountId}/feed`;
      const comment =
        platform === "INSTAGRAM"
          ? "comments.limit(25){id,text,username,from,timestamp}"
          : "comments.limit(25){id,message,from,created_time}";
      const json = await request("GET", path, page.accessToken, {
        fields: `id,${comment}`,
        limit: "10",
      });
      const found: RecentComment[] = [];
      for (const post of data(json)) {
        const postId = cleanId(post.id);
        const comments = isRecord(post.comments) ? data(post.comments) : [];
        if (postId === null) continue;
        for (const item of comments) {
          const id = cleanId(item.id);
          const text = str(platform === "INSTAGRAM" ? item.text : item.message);
          const created = new Date(
            str(platform === "INSTAGRAM" ? item.timestamp : item.created_time) ?? "",
          );
          if (id === null || text === null || text.trim() === "" || Number.isNaN(created.getTime()))
            continue;
          const from = isRecord(item.from) ? item.from : {};
          const authorId = cleanId(from.id);
          // The account's own comments are not customer interactions.
          if (authorId === accountId) continue;
          found.push({
            id,
            postId,
            text: text.slice(0, 8000),
            authorId,
            authorName:
              (str(from.name) ?? str(from.username) ?? str(item.username))?.slice(0, 200) ?? null,
            createdAt: created,
          });
        }
      }
      return found;
    },

    async publishToPage(page, message, link) {
      const json = await request("POST", `/${page.id}/feed`, page.accessToken, {
        message,
        ...(link === null ? {} : { link }),
      });
      const created = str(json.id);
      if (created === null || !/^[0-9_]{1,128}$/.test(created)) {
        throw new SocialPlatformError("provider_error", true);
      }
      return created;
    },

    async publishPhotoToPage(page, message, photo) {
      const json = await request(
        "POST",
        `/${page.id}/photos`,
        page.accessToken,
        { caption: message, published: "true" },
        { field: "source", photo },
      );
      // `post_id` is the feed post (what published_posts lists); `id` is the photo object.
      const created = str(json.post_id) ?? str(json.id);
      if (created === null || !/^[0-9_]{1,128}$/.test(created)) {
        throw new SocialPlatformError("provider_error", true);
      }
      return created;
    },

    async findPagePost(page, message, since) {
      // Newest first: reading stops (conclusively) at the first post older than `since`.
      const from = since.getTime() - 5 * 60_000;
      let after: string | null = null;
      for (let call = 0; call < MAX_LOOKUP_REQUESTS; call += 1) {
        const json = await request("GET", `/${page.id}/published_posts`, page.accessToken, {
          fields: "id,message,created_time",
          limit: "25",
          ...(after === null ? {} : { after }),
        });
        for (const item of data(json)) {
          const created = new Date(str(item.created_time) ?? "");
          const id = str(item.id);
          if (id === null || Number.isNaN(created.getTime())) continue;
          if (created.getTime() < from) return "not_found";
          if (str(item.message)?.trim() === message.trim()) return { id: id.slice(0, 128) };
        }
        const next = nextCursor(json);
        if (next === null || next === after) return "not_found";
        after = next;
      }
      return "unknown";
    },
  };
}
