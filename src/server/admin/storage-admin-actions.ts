import "server-only";

import { z } from "zod";

import { getDb, getSystemDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { parseInput } from "../validation/parse";
import { getStorageRouter } from "../storage/providers";
import {
  changeWriteProvider,
  checkProviderConnection,
  getStorageAdminView,
  saveWasabiSettings,
} from "../storage/storage-admin";

import { requirePlatformAdmin } from "./platform-admin";

// Platform admin → Storage settings. Every action authorizes FIRST (platform
// administrator, re-read from the database), then validates its input, so a caller who is
// not an administrator learns nothing but the standard 404 — not even which fields exist.
// Results carry outcome codes only: no keys, endpoints or provider messages.
//
// SYSTEM PATH (reviewed): platform-wide storage settings and per-provider object counts.

const providerSchema = z.enum(["LEGACY_S3", "WASABI"]);

/** The storage settings view for the admin page (administrators only). */
export async function getStorageAdminPageView() {
  await requirePlatformAdmin();
  return getStorageAdminView(getSystemDb(), getStorageRouter());
}

export const saveWasabiSettingsAction = withAction({
  name: "admin.storage.save_wasabi",
  input: z.unknown(),
  handler: async (input) => {
    const admin = await requirePlatformAdmin({ change: true });
    return saveWasabiSettings(getDb(), admin, input);
  },
});

export const checkStorageConnectionAction = withAction({
  name: "admin.storage.check_connection",
  input: z.unknown(),
  handler: async (input) => {
    await requirePlatformAdmin();
    const { provider } = parseInput(z.strictObject({ provider: providerSchema }), input, "action");
    return { provider, check: await checkProviderConnection(getStorageRouter(), provider) };
  },
});

export const changeWriteProviderAction = withAction({
  name: "admin.storage.change_write_provider",
  input: z.unknown(),
  handler: async (input) => {
    const admin = await requirePlatformAdmin({ change: true });
    const parsed = parseInput(
      z.strictObject({ target: providerSchema, confirmation: z.string().max(64) }),
      input,
      "action",
    );
    return changeWriteProvider(getSystemDb(), getDb(), getStorageRouter(), admin, parsed);
  },
});
