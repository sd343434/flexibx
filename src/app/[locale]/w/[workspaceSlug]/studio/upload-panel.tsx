"use client";

import { UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { PendingLabel } from "@/components/common/loaders";
import { actionErrorMessage, inputClass } from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";

import type { ActionError } from "../marketing-actions";

import { beginUpload, finishUpload } from "./actions";

// The browser sends the file straight to storage with the short-lived signed URL the
// server issued for exactly this type and size, then tells the server it is done. The
// type and size checks here are only for a quick answer: the server checks the declared
// values, and the analysis job checks the bytes themselves.

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "uploading"; readonly percent: number }
  | { readonly kind: "finishing" }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly message: string };

const ACCEPT: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

function contentTypeOf(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPT[extension] ?? file.type;
}

export function UploadPanel({
  slug,
  locale,
  projectId,
  maxBytes,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly projectId: string;
  readonly maxBytes: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const request = useRef<XMLHttpRequest | null>(null);
  const busy = phase.kind === "uploading" || phase.kind === "finishing";

  const fail = (error: ActionError | string) => {
    setPhase({
      kind: "error",
      message:
        typeof error === "string"
          ? t(`studio.upload.${error}` as never)
          : actionErrorMessage(t, error),
    });
  };

  const send = (url: string, headers: Readonly<Record<string, string>>, file: File) =>
    new Promise<"ok" | "aborted" | "failed">((resolve) => {
      const xhr = new XMLHttpRequest();
      request.current = xhr;
      xhr.open("PUT", url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setPhase({ kind: "uploading", percent: Math.floor((event.loaded / event.total) * 100) });
        }
      };
      xhr.onload = () => {
        resolve(xhr.status >= 200 && xhr.status < 300 ? "ok" : "failed");
      };
      xhr.onerror = () => {
        resolve("failed");
      };
      xhr.onabort = () => {
        resolve("aborted");
      };
      xhr.send(file);
    });

  const run = async (file: File): Promise<ActionError | string | null> => {
    if (file.size > maxBytes) return "tooLarge";
    const contentType = contentTypeOf(file);
    if (!Object.values(ACCEPT).includes(contentType)) return "unsupported";
    setPhase({ kind: "uploading", percent: 0 });
    const started = await beginUpload(slug, projectId, {
      fileName: file.name.slice(0, 500),
      contentType,
      size: file.size,
    });
    if (!started.ok) return started.error;
    const sent = await send(started.data.url, started.data.headers, file);
    request.current = null;
    if (sent === "aborted") {
      setPhase({ kind: "idle" });
      return null;
    }
    if (sent === "failed") return "transferFailed";
    setPhase({ kind: "finishing" });
    const finished = await finishUpload(slug, locale, started.data.sourceId);
    if (!finished.ok) return finished.error;
    setPhase({ kind: "done" });
    router.refresh();
    return null;
  };

  const upload = async (file: File) => {
    const error = await run(file);
    if (error !== null) fail(error);
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
      {phase.kind === "uploading" ? (
        <div className="space-y-2" role="status">
          <progress
            className="w-full accent-primary"
            max={100}
            value={phase.percent}
            aria-label={t("studio.upload.progress")}
          />
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t("studio.upload.percent", { percent: phase.percent })}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                request.current?.abort();
              }}
              data-testid="studio-upload-cancel"
            >
              {t("studio.upload.cancel")}
            </Button>
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
        <p role="alert" className="text-sm text-destructive" data-testid="studio-upload-error">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}
