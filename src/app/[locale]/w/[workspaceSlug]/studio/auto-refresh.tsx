"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page from the server while work is in progress (an upload being checked,
 * a job queued or running). Stops when the page no longer reports active work, and
 * pauses while the tab is hidden.
 */
export function AutoRefresh({
  active,
  everyMs = 4000,
}: {
  readonly active: boolean;
  readonly everyMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, everyMs, router]);
  return null;
}
