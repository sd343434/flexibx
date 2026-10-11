import * as React from "react";

/**
 * flexibx loader — the brand Loop as a loading state.
 * Zero dependencies. Pair with flexibx-loader.css (imported once) or rely on the inline keyframes below.
 *
 * <FlexibxLoader />                              spinner, dark background (default)
 * <FlexibxLoader tone="light" size={32} />       on white / Paper
 * <FlexibxLoader tone="violet" />                on brand Violet
 * <FlexibxProgress value={65} />                 determinate, 0–100
 * <FlexibxLoader variant="splash" size={96} />   one-shot brand reveal (launch screens)
 */

export const FX_LOOP_PATH =
  "M60 60 C50 38, 18 38, 18 60 C18 82, 50 82, 60 60 C70 38, 102 38, 102 60 C102 82, 70 82, 60 60";
export const FX_LOOP_LENGTH = 233.2;

export type FlexibxTone = "dark" | "light" | "violet";

const TONES: Record<FlexibxTone, { track: string; runner: string }> = {
  dark: { track: "#6C3BFF", runner: "#D4FF3A" }, // on Ink #0E0B1F / any dark surface
  light: { track: "#E3DDFF", runner: "#6C3BFF" }, // on white / Paper #F6F5FB
  violet: { track: "#8F70FF", runner: "#D4FF3A" }, // on Violet #6C3BFF
};

const KEYFRAMES = `@keyframes fx-loader-run{from{stroke-dashoffset:0}to{stroke-dashoffset:${-FX_LOOP_LENGTH}}}
@keyframes fx-loader-draw{from{stroke-dashoffset:${FX_LOOP_LENGTH}}to{stroke-dashoffset:0}}
@keyframes fx-loader-glow{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.fx-loader__runner{animation-duration:2.8s!important}}`;

export interface FlexibxLoaderProps {
  /** Pick by background, not by taste. */
  tone?: FlexibxTone;
  /** Pixel size. Minimum 20. */
  size?: number;
  /** "spinner" (default, infinite) or "splash" (plays once: draws the loop, then lights the highlight). */
  variant?: "spinner" | "splash";
  /** Seconds per lap for the spinner. */
  speed?: number;
  /** Accessible label — pass the localised string (e.g. "Loading" / "جارٍ التحميل"). */
  label?: string;
  className?: string;
}

export function FlexibxLoader({
  tone = "dark",
  size = 48,
  variant = "spinner",
  speed = 1.4,
  label = "Loading",
  className,
}: FlexibxLoaderProps) {
  const c = TONES[tone];
  const spinner = variant === "spinner";
  return (
    <svg
      className={["fx-loader", className].filter(Boolean).join(" ")}
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="status"
      aria-label={label}
    >
      <style>{KEYFRAMES}</style>
      <path
        d={FX_LOOP_PATH}
        fill="none"
        stroke={c.track}
        strokeWidth={16}
        strokeLinecap="round"
        style={
          spinner
            ? undefined
            : {
                strokeDasharray: FX_LOOP_LENGTH,
                animation: "fx-loader-draw 1.1s cubic-bezier(.2,0,0,1) forwards",
              }
        }
      />
      <path
        className="fx-loader__runner"
        d={FX_LOOP_PATH}
        fill="none"
        stroke={c.runner}
        strokeWidth={16}
        strokeLinecap="round"
        style={
          spinner
            ? {
                strokeDasharray: `${FX_LOOP_LENGTH * 0.28} ${FX_LOOP_LENGTH}`,
                animation: `fx-loader-run ${speed}s linear infinite`,
              }
            : {
                // the brand highlight: the quarter from the crossing to the right edge
                strokeDasharray: `${FX_LOOP_LENGTH * 0.25} ${FX_LOOP_LENGTH}`,
                strokeDashoffset: -FX_LOOP_LENGTH * 0.5,
                opacity: 0,
                animation: "fx-loader-glow .3s ease-out 1s forwards",
              }
        }
      />
    </svg>
  );
}

export interface FlexibxProgressProps {
  /** 0–100. Never fake a percentage — use FlexibxLoader when the duration is unknown. */
  value: number;
  tone?: FlexibxTone;
  size?: number;
  label?: string;
  className?: string;
}

export function FlexibxProgress({
  value,
  tone = "dark",
  size = 48,
  label = "Progress",
  className,
}: FlexibxProgressProps) {
  const c = TONES[tone];
  const v = Math.min(100, Math.max(0, value));
  return (
    <svg
      className={["fx-loader", "fx-loader--progress", className].filter(Boolean).join(" ")}
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <path d={FX_LOOP_PATH} fill="none" stroke={c.track} strokeWidth={16} strokeLinecap="round" />
      <path
        d={FX_LOOP_PATH}
        fill="none"
        stroke={c.runner}
        strokeWidth={16}
        strokeLinecap="round"
        style={{
          strokeDasharray: FX_LOOP_LENGTH,
          strokeDashoffset: FX_LOOP_LENGTH * (1 - v / 100),
          transition: "stroke-dashoffset .4s cubic-bezier(.2,0,0,1)",
        }}
      />
    </svg>
  );
}

export default FlexibxLoader;
