import type { ReactNode } from "react";

import { FlexibxLoader } from "@/components/ui/flexibx-loader";
import { cn } from "@/lib/utils";

// Brand loading states (flexibx loader skill): the Loop, never a generic spinner. The tone
// follows the background: "light" on the light page surface, "dark" on the dark one,
// "violet" on primary (Violet) buttons. Only one of the two themed loaders is displayed;
// the other is display:none, so screen readers see a single status.

/** A loader on the page background, in the tone of the current theme. */
export function ThemedLoader({
  size,
  label,
  className,
}: {
  readonly size: number;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <>
      <FlexibxLoader
        tone="light"
        size={size}
        label={label}
        className={cn("dark:hidden", className)}
      />
      <FlexibxLoader
        tone="dark"
        size={size}
        label={label}
        className={cn("hidden dark:inline-block", className)}
      />
    </>
  );
}

/**
 * Route-level loading state (loading.tsx): the loader centred in the content area. It
 * appears only after 300 ms, so fast navigations never flash it.
 */
export function PageLoader({ label }: { readonly label: string }) {
  return (
    <div
      className="fx-loader-delay flex min-h-[40vh] flex-col items-center justify-center gap-3"
      aria-busy="true"
      data-testid="page-loading"
    >
      <ThemedLoader size={40} label={label} />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Button content while its action runs: the loader (20 px, the minimum) and the verb in
 * progress, e.g. "Saving…". The visible text names the button and disabled state is set
 * by the caller, so the loader itself is hidden from assistive technology. `surface` is
 * the button's background: "primary" (Violet) or "plain" (outline/ghost, page colours).
 */
export function PendingLabel({
  pending,
  idle,
  busy,
  surface = "primary",
}: {
  readonly pending: boolean;
  readonly idle: ReactNode;
  readonly busy: string;
  readonly surface?: "primary" | "plain";
}) {
  if (!pending) return <>{idle}</>;
  return (
    <>
      <span aria-hidden="true" className="inline-flex">
        {surface === "primary" ? (
          <FlexibxLoader tone="violet" size={20} label={busy} className="size-5!" />
        ) : (
          <ThemedLoader size={20} label={busy} className="size-5!" />
        )}
      </span>
      {busy}
    </>
  );
}
