// Brand loading states (flexibx loader): the Loop in the right tone for its background,
// 20 px minimum in buttons, one announced status, and no generic spinners anywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageLoader, PendingLabel } from "@/components/common/loaders";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe("PendingLabel (button content)", () => {
  it("shows only the idle label when nothing is pending", () => {
    const markup = html(
      createElement(PendingLabel, { pending: false, idle: "Save", busy: "Saving…" }),
    );
    expect(markup).toBe("Save");
  });

  it("on a Violet button: the violet-tone Loop (light track, Lime runner) at 20 px plus the verb", () => {
    const markup = html(
      createElement(PendingLabel, { pending: true, idle: "Save", busy: "Saving…" }),
    );
    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).toContain('stroke="#8F70FF"');
    expect(markup).toContain('stroke="#D4FF3A"');
    expect(markup).toContain('width="20"');
    expect(markup).toContain("size-5!"); // beats the button's 16 px svg rule
    // The visible verb names the button; the loader is not announced twice.
    expect(markup).toMatch(/^<span aria-hidden="true"/);
    expect(markup.endsWith("Saving…")).toBe(true);
  });

  it("on an outline button: the light tone in light theme, the dark tone in dark theme", () => {
    const markup = html(
      createElement(PendingLabel, {
        pending: true,
        idle: "Save",
        busy: "Saving…",
        surface: "plain",
      }),
    );
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup).toMatch(/class="fx-loader dark:hidden[^"]*"[^>]*>[\s\S]*?stroke="#E3DDFF"/);
    expect(markup).toMatch(
      /class="fx-loader hidden dark:inline-block[^"]*"[^>]*>[\s\S]*?stroke="#D4FF3A"/,
    );
    // Lime is never drawn on the light surface.
    const light = markup.slice(0, markup.indexOf("</svg>"));
    expect(light).not.toContain("#D4FF3A");
  });
});

describe("PageLoader (loading.tsx)", () => {
  it("is one labelled status per theme, 40 px, appearing after a delay", () => {
    const markup = html(createElement(PageLoader, { label: "جارٍ تحميل مساحة العمل" }));
    expect(markup).toContain('data-testid="page-loading"');
    expect(markup).toContain("fx-loader-delay");
    expect(markup.match(/role="status"/g)).toHaveLength(2); // one is display:none per theme
    expect(markup.match(/aria-label="جارٍ تحميل مساحة العمل"/g)).toHaveLength(2);
    expect(markup.match(/width="40"/g)).toHaveLength(2);
    // Direction-neutral: never mirrored for RTL.
    expect(markup).not.toMatch(/scale-x|rotate|rtl:/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe("loading states across the app", () => {
  const files = sourceFiles("src");

  it("uses no generic spinner", () => {
    const offenders = files.filter((path) =>
      /animate-spin|\bLoader2\b|\bLoaderCircle\b|<Spinner\b/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("renders the brand loader in every loading.tsx, with a localised label", () => {
    const loadingFiles = files.filter((path) => path.endsWith("loading.tsx"));
    expect(loadingFiles.length).toBeGreaterThanOrEqual(5);
    for (const path of loadingFiles) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("<PageLoader");
      expect(source, path).toContain('useTranslations("common.loading")');
    }
  });
});
