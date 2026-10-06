// ESLint 10 flat config.
//
// Composition (eslint-config-next is intentionally NOT used: its bundled react/import/
// jsx-a11y plugins do not support ESLint 10 yet):
//   @eslint/js recommended → typescript-eslint strict + stylistic (type-aware)
//   → @next/eslint-plugin-next core-web-vitals → eslint-plugin-react-hooks
//   → Flexibx architecture rules (layering, RTL-safe logical CSS classes).
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Physical (direction-dependent) Tailwind utilities. Arabic RTL is the primary
// experience, so only logical utilities are allowed: ms-/me-, ps-/pe-, start-/end-,
// text-start/end, border-s/e, rounded-s/e, float-start/end.
// Matches with or without variants/negation, e.g. `ml-2`, `md:pr-4`, `-left-1`, `text-right`.
const PHYSICAL_DIRECTION_CLASS =
  "(^|[\\s:'\"`])-?(m[lr]|p[lr]|scroll-m[lr]|scroll-p[lr]|left|right|border-[lr]|rounded-[lr]|rounded-[tb][lr])-|(^|[\\s:'\"`])(text-left|text-right|float-left|float-right|border-[lr]|rounded-[lr])($|[\\s'\"`])";

const physicalClassMessage =
  "Use logical, direction-agnostic utilities (ms-/me-, ps-/pe-, start-/end-, text-start/end, border-s/e, rounded-s/e) so layouts work in both RTL (ar) and LTR (en).";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "src/generated/**",
    "next-env.d.ts",
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
      "no-console": "error", // use the structured logger (src/server/logger.ts)
      "no-restricted-properties": [
        "error",
        {
          property: "$queryRawUnsafe",
          message:
            "SQL injection risk and bypasses the tenant guard. Use $queryRaw with tagged templates.",
        },
        {
          property: "$executeRawUnsafe",
          message:
            "SQL injection risk and bypasses the tenant guard. Use $executeRaw with tagged templates.",
        },
      ],
    },
  },

  // Plain JS/MJS config files are not part of the TS project.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Next.js + React rules for application code.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"], reactHooks.configs.flat.recommended],
  },

  // RTL-first: forbid physical direction classes in UI code.
  {
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${PHYSICAL_DIRECTION_CLASS}/]`,
          message: physicalClassMessage,
        },
        {
          selector: `TemplateElement[value.raw=/${PHYSICAL_DIRECTION_CLASS}/]`,
          message: physicalClassMessage,
        },
      ],
    },
  },

  // Layering: UI and routes never touch the database layer or generated client directly.
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@prisma/client",
                "@prisma/client/*",
                "@/generated/*",
                "@/server/db",
                "@/server/db/*",
              ],
              message: "Access data through services in src/server, not the database layer.",
            },
          ],
        },
      ],
    },
  },
  // Components and lib are client-safe: no server-only modules at all.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@prisma/client",
                "@prisma/client/*",
                "@/generated/*",
                "@/server",
                "@/server/*",
              ],
              message: "Components and lib must stay client-safe; pass data in from server code.",
            },
          ],
        },
      ],
    },
  },
]);
