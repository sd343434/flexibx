import "server-only";

import { FakeVideoProvider } from "@/server/ai/providers/video/fake";
import type { VideoProvider } from "@/server/ai/providers/video/gateway";

import { getDb } from "../../db/client";
import { getVideoEnv } from "../../env";
import { logger } from "../../logger";
import { getStorageRouter } from "../../storage/providers";
import { videoNotConfigured, type VideoGenerationDeps } from "./video-generation-service";

// The application's video provider and runner dependencies. VIDEO_PROVIDER=disabled
// (default) refuses every request; `fake` uses the deterministic local provider, whose
// submissions live in this process only (a restarted dev server cannot resume them) and
// which finishes at once (no status polling, so no waiting between polls).

let fake: FakeVideoProvider | undefined;

export function getVideoProvider(): VideoProvider {
  if (getVideoEnv().VIDEO_PROVIDER === "fake") {
    fake ??= new FakeVideoProvider({ pollsBeforeDone: 0 });
    return fake;
  }
  throw videoNotConfigured();
}

export function getVideoGenerationDeps(): VideoGenerationDeps {
  return {
    db: getDb(),
    writeTarget: () => getStorageRouter().writeTarget(),
    provider: getVideoProvider(),
    logger,
  };
}
