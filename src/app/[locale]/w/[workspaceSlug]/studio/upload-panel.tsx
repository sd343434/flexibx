"use client";

import { UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { PendingLabel } from "@/components/common/loaders";
import { actionErrorMessage, inputClass } from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";

import type { ActionError } from "../marketing-actions";

import {
  beginMultipartUpload,
  beginUpload,
  cancelUpload,
  finishUpload,
  partsUploaded,
  signPart,
} from "./actions";

// The browser sends the file straight to private storage with short-lived signed URLs
// the server issues for exact sizes: one PUT for a small file, or — for large ones — a
// resumable upload in parts (three at a time). Every part's SHA-256 is declared before
// it is sent and checked by the worker against the bytes it receives. After a lost
// connection or a reload, choosing the same file again resumes with the parts storage
// does not hold yet. The type and size checks here are only for a quick answer: the
// server checks the declared values, and the analysis job checks the bytes themselves.

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "hashing" }
  | { readonly kind: "uploading"; readonly percent: number; readonly resumed: boolean }
  | { readonly kind: "paused"; readonly percent: number }
  | { readonly kind: "finishing" }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly message: string; readonly resumable: boolean };

const ACCEPT: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};
const PARALLEL_PARTS = 3;
const PART_ATTEMPTS = 3;
/** Headers the browser sets itself (setting them on an XHR is refused). */
const FORBIDDEN_HEADERS = new Set(["content-length", "host"]);

function contentTypeOf(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPT[extension] ?? file.type;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface SavedSession {
  readonly sourceId: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}

const sessionKey = (projectId: string) => `flexibx:studio-upload:${projectId}`;

function loadSession(projectId: string, file: File): SavedSession | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(projectId));
    if (raw === null) return null;
    const saved = JSON.parse(raw) as Partial<SavedSession>;
    return typeof saved.sourceId === "string" &&
      saved.name === file.name &&
      saved.size === file.size &&
      saved.lastModified === file.lastModified
      ? (saved as SavedSession)
      : null;
  } catch {
    return null;
  }
}

function saveSession(projectId: string, session: SavedSession | null) {
  try {
    if (session === null) window.localStorage.removeItem(sessionKey(projectId));
    else window.localStorage.setItem(sessionKey(projectId), JSON.stringify(session));
  } catch {
    // Private mode or blocked storage: the upload still works, it just cannot resume.
  }
}

export function UploadPanel({
  slug,
  locale,
  projectId,
  maxBytes,
  singleMaxBytes,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly projectId: string;
  readonly maxBytes: number;
  readonly singleMaxBytes: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The file of an interrupted upload, kept to resume it without choosing it again.
  const [interrupted, setInterrupted] = useState<File | null>(null);
  const requests = useRef(new Set<XMLHttpRequest>());
  const paused = useRef(false);
  const current = useRef<{ file: File; sourceId: string | null } | null>(null);
  const busy = phase.kind === "hashing" || phase.kind === "uploading" || phase.kind === "finishing";

  const message = (error: ActionError | string) =>
    typeof error === "string" ? t(`studio.upload.${error}` as never) : actionErrorMessage(t, error);

  /** One PUT; resolves with its outcome, reporting progress in bytes. */
  const put = (
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Blob,
    onProgress: (loaded: number) => void,
  ) =>
    new Promise<"ok" | "aborted" | "retry" | "failed">((resolve) => {
      const xhr = new XMLHttpRequest();
      requests.current.add(xhr);
      xhr.open("PUT", url);
      for (const [name, value] of Object.entries(headers)) {
        if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (event) => {
        onProgress(event.loaded);
      };
      const settle = (outcome: "ok" | "aborted" | "retry" | "failed") => {
        requests.current.delete(xhr);
        resolve(outcome);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) settle("ok");
        else settle(xhr.status >= 500 || xhr.status === 429 ? "retry" : "failed");
      };
      xhr.onerror = () => {
        settle("retry");
      };
      xhr.onabort = () => {
        settle("aborted");
      };
      xhr.send(body);
    });

  const single = async (file: File, contentType: string): Promise<ActionError | string | null> => {
    setPhase({ kind: "hashing" });
    const sha256 = await sha256Hex(await file.arrayBuffer());
    const started = await beginUpload(slug, projectId, {
      fileName: file.name.slice(0, 500),
      contentType,
      size: file.size,
      sha256,
    });
    if (!started.ok) return started.error;
    current.current = { file, sourceId: started.data.sourceId };
    setPhase({ kind: "uploading", percent: 0, resumed: false });
    const sent = await put(started.data.url, started.data.headers, file, (loaded) => {
      setPhase({
        kind: "uploading",
        percent: Math.floor((loaded / file.size) * 100),
        resumed: false,
      });
    });
    if (sent === "aborted") return "cancelled";
    if (sent !== "ok") return "transferFailed";
    return finish(started.data.sourceId);
  };

  const multipart = async (
    file: File,
    contentType: string,
  ): Promise<ActionError | string | null> => {
    let sourceId: string;
    let partSize: number;
    let partCount: number;
    const done = new Set<number>();
    const saved = loadSession(projectId, file);
    const status = saved === null ? null : await partsUploaded(slug, saved.sourceId);
    if (saved !== null && status?.ok === true) {
      ({ partSize, partCount } = status.data);
      sourceId = saved.sourceId;
      for (const part of status.data.uploadedParts) done.add(part);
    } else {
      if (saved !== null) saveSession(projectId, null);
      const started = await beginMultipartUpload(slug, projectId, {
        fileName: file.name.slice(0, 500),
        contentType,
        size: file.size,
      });
      if (!started.ok) return started.error;
      ({ sourceId, partSize, partCount } = started.data);
      saveSession(projectId, {
        sourceId,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      });
    }
    current.current = { file, sourceId };
    const resumed = done.size > 0;
    const sizeOf = (part: number) =>
      part < partCount ? partSize : file.size - partSize * (partCount - 1);
    let confirmed = [...done].reduce((sum, part) => sum + sizeOf(part), 0);
    const inFlight = new Map<number, number>();
    const report = () => {
      const moving = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
      setPhase({
        kind: "uploading",
        percent: Math.min(99, Math.floor(((confirmed + moving) / file.size) * 100)),
        resumed,
      });
    };
    report();
    const queue = Array.from({ length: partCount }, (_, index) => index + 1).filter(
      (part) => !done.has(part),
    );
    const result: { failure: ActionError | string | null } = { failure: null };
    const sendPart = async (part: number): Promise<boolean> => {
      const start = (part - 1) * partSize;
      const blob = file.slice(start, start + sizeOf(part));
      const sha256 = await sha256Hex(await blob.arrayBuffer());
      for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt += 1) {
        if (paused.current) return false;
        const signed = await signPart(slug, sourceId, {
          partNumber: part,
          size: blob.size,
          sha256,
        });
        if (!signed.ok) {
          result.failure = signed.error;
          return false;
        }
        const outcome = await put(signed.data.url, signed.data.headers, blob, (loaded) => {
          inFlight.set(part, loaded);
          report();
        });
        inFlight.delete(part);
        if (outcome === "ok") {
          confirmed += blob.size;
          report();
          return true;
        }
        if (outcome === "aborted" || outcome === "failed") {
          if (outcome === "failed") result.failure = "transferFailed";
          return false;
        }
        // A dropped connection or a storage hiccup: wait, then send this part again.
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
      result.failure = "transferFailed";
      return false;
    };
    const lanes = Array.from({ length: Math.min(PARALLEL_PARTS, queue.length) }, async () => {
      for (let part = queue.shift(); part !== undefined; part = queue.shift()) {
        if (!(await sendPart(part))) return;
      }
    });
    await Promise.all(lanes);
    if (paused.current) {
      setInterrupted(file);
      setPhase({ kind: "paused", percent: Math.floor((confirmed / file.size) * 100) });
      return null;
    }
    if (result.failure !== null) return result.failure;
    const finished = await finish(sourceId);
    if (finished === null) saveSession(projectId, null);
    return finished;
  };

  const finish = async (sourceId: string): Promise<ActionError | string | null> => {
    setPhase({ kind: "finishing" });
    const finished = await finishUpload(slug, locale, sourceId);
    if (!finished.ok) return finished.error;
    current.current = null;
    setPhase({ kind: "done" });
    router.refresh();
    return null;
  };

  const upload = async (file: File) => {
    paused.current = false;
    if (file.size > maxBytes) {
      setPhase({ kind: "error", message: message("tooLarge"), resumable: false });
      return;
    }
    const contentType = contentTypeOf(file);
    if (!Object.values(ACCEPT).includes(contentType)) {
      setPhase({ kind: "error", message: message("unsupported"), resumable: false });
      return;
    }
    const large = file.size > singleMaxBytes;
    const error = large ? await multipart(file, contentType) : await single(file, contentType);
    if (error === null || error === "cancelled") {
      if (error === "cancelled") setPhase({ kind: "idle" });
      return;
    }
    setInterrupted(large ? file : null);
    setPhase({ kind: "error", message: message(error), resumable: large });
  };

  const pause = () => {
    paused.current = true;
    for (const xhr of requests.current) xhr.abort();
  };

  const cancel = async () => {
    pause();
    const sourceId = current.current?.sourceId ?? null;
    current.current = null;
    setInterrupted(null);
    saveSession(projectId, null);
    setPhase({ kind: "idle" });
    if (sourceId !== null) {
      await cancelUpload(slug, locale, sourceId);
      router.refresh();
    }
  };

  const resume = () => {
    if (interrupted !== null) void upload(interrupted);
  };

  return (
    <div className="space-y-3" data-testid="studio-upload">
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center hover:bg-muted/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
        <UploadCloud aria-hidden="true" className="size-8 text-muted-foreground" />
        <span className="font-medium">{t("studio.upload.choose")}</span>
        <span className="text-sm text-muted-foreground">
          {t("studio.upload.limits", { mb: Math.floor(maxBytes / 1_048_576) })}
        </span>
        <input
          type="file"
          className={`${inputClass} sr-only`}
          accept={Object.entries(ACCEPT)
            .flatMap(([extension, type]) => [`.${extension}`, type])
            .join(",")}
          disabled={busy}
          data-testid="studio-upload-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file !== undefined) void upload(file);
          }}
        />
      </label>
      {phase.kind === "hashing" ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <PendingLabel pending idle="" busy={t("studio.upload.hashing")} surface="plain" />
        </p>
      ) : null}
      {phase.kind === "uploading" || phase.kind === "paused" ? (
        <div className="space-y-2" role="status" data-testid={`studio-upload-${phase.kind}`}>
          <progress
            className="w-full accent-primary"
            max={100}
            value={phase.percent}
            aria-label={t("studio.upload.progress")}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {phase.kind === "paused"
                ? t("studio.upload.paused", { percent: phase.percent })
                : t("studio.upload.percent", { percent: phase.percent })}
              {phase.kind === "uploading" && phase.resumed
                ? ` · ${t("studio.upload.resumed")}`
                : ""}
            </span>
            <div className="flex gap-2">
              {phase.kind === "uploading" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={pause}
                  data-testid="studio-upload-pause"
                >
                  {t("studio.upload.pause")}
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={resume} data-testid="studio-upload-resume">
                  {t("studio.upload.resume")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void cancel();
                }}
                data-testid="studio-upload-cancel"
              >
                {t("studio.upload.cancel")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {phase.kind === "finishing" ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <PendingLabel pending idle="" busy={t("studio.upload.finishing")} surface="plain" />
        </p>
      ) : null}
      {phase.kind === "done" ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="studio-upload-done">
          {t("studio.upload.done")}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive" data-testid="studio-upload-error">
            {phase.message}
          </p>
          {phase.resumable && interrupted !== null ? (
            <Button type="button" size="sm" onClick={resume} data-testid="studio-upload-retry">
              {t("studio.upload.resume")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
