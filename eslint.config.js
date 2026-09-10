import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";
import configPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "artifacts/**",
      "drizzle.config.ts",
      "vite.config.ts",
      "server/vite.ts",
      "postcss.config.js",
      "tailwind.config.ts",
      "capacitor.config.ts",
      "scripts/**",
      "*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "unused-imports": unusedImports,
    },
    rules: {
      // Keep the repository's established React Hooks contract explicit. Newer
      // eslint-plugin-react-hooks releases add React Compiler rules to the
      // recommended preset; enabling those is a separate source-migration lane.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // ── Enabled tightening (formerly disabled) ─────────────────────────────
      // These are cheap to satisfy and were switched back on after the existing
      // violations were removed. Each is a hard error so new ones fail lint.
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-wrapper-object-types": "error",
      "@typescript-eslint/no-empty-interface": "error",
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",

      // ── Deliberately disabled, with a reason per rule ──────────────────────
      // Type escapes have their own zero-tolerance gate in
      // config/type-escape-boundaries.json. Keeping this ESLint rule enabled
      // would double-count the same backlog. The lint ratchet (warnings must
      // stay at zero) is enforced by scripts/run-lint.mjs against
      // config/lint-warning-ratchet.json.
      "@typescript-eslint/no-explicit-any": "off",
      // unused-imports/no-unused-vars below replaces the base rule to avoid duplicate reports.
      "@typescript-eslint/no-unused-vars": "off",
      // `no-undef` does not understand TypeScript types and interfaces; the
      // type-checker (npm run check) is the enforcement lane for undefined names.
      "no-undef": "off",
      // Non-null assertions are an established idiom across the codebase and a
      // separate, large migration lane. Not enabled to avoid a 1k+ violation sweep.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Empty functions (noop callbacks, empty catch handlers) are intentional
      // in many places. Not enabled to avoid a broad, low-signal cleanup.
      "@typescript-eslint/no-empty-function": "off",
      // The ESM server bundle deliberately keeps a `require` shim for lazy,
      // optional module loads (arabic-reshaper / bidi-js inside try/catch) and
      // inline Node builtins; converting those to static imports would change
      // their graceful-degradation behaviour. See the build shim.
      "@typescript-eslint/no-require-imports": "off",
      // Client code logs to console in offline/debug paths; routing those
      // through a client logger is a separate instrumentation migration.
      "no-console": "off",

      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      "no-case-declarations": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "no-var": "warn",
      "preserve-caught-error": "warn",
      "no-useless-assignment": "warn",
      "no-control-regex": "warn",
      "no-extra-boolean-cast": "warn",
    },
  },
  configPrettier
);
