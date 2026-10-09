import { cn } from "@/lib/utils";

const LOOP =
  "M16 6C8 6 4 11 4 16s4 10 12 10 12-10 16-10 8-10 16-10 12 5 12 10-4 10-12 10-12-10-16-10S24 6 16 6Z";
const TAIL = "M33 15.5C37 14 41 6 48 6c8 0 12 5 12 10";

/**
 * The flexibx loop symbol: a violet infinity with a lime tail (brand guidelines v2.0).
 * On a violet surface the loop turns white: set `--brand-loop` on a parent.
 */
export function BrandSymbol({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 64 32" aria-hidden="true" className={cn("h-6 w-12 shrink-0", className)}>
      <path
        d={LOOP}
        fill="none"
        stroke="var(--brand-loop, #6b3bff)"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      <path d={TAIL} fill="none" stroke="#d4ff3a" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Symbol plus the lowercase wordmark. The wordmark is the brand's Latin logotype in
 * every locale; `label` (the localized app name) is what assistive technology reads.
 */
export function BrandMark({
  label,
  className,
}: {
  readonly label: string;
  readonly className?: string;
}) {
  return (
    // The logo reads symbol-then-wordmark in every locale (left to right, never mirrored).
    <span dir="ltr" className={cn("flex items-center gap-2", className)}>
      <BrandSymbol />
      <span
        aria-hidden="true"
        className="font-[family-name:var(--font-latin)] text-2xl leading-none font-extrabold tracking-tighter"
      >
        flexibx
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
