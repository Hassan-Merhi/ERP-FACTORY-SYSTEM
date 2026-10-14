# Phase 8 — Unused dependencies

**Status: COMPLETE.** Branch `refactor/erp-dead-code-cleanup`. No package installation,
upgrade, build or test was run; `package.json` and `package-lock.json` were edited directly.

## Method

Usage evidence for every entry in the root `package.json` (112 production + 40 development
packages at the start of the program): static/dynamic imports, `require`/`createRequire`
calls (including `_require(...)` aliases), `vi.mock` specifiers, CSS `@import`/`@plugin`,
package scripts and CLI binaries, workflow files, configs, `postcss`/`vite`/`eslint`/`vitest`
configs, `@types/*` pairing, and lockfile peer relationships. A package was removed only with
no evidence in any of those places. `desktop/package.json` was audited separately (all four
packages are used by `desktop/main.js`, `desktop/scripts/generate-icons.js` and its scripts).

## Removed (22)

| Package | Why it was unused |
|---|---|
| `@radix-ui/react-accordion`, `-aspect-ratio`, `-context-menu`, `-menubar`, `-navigation-menu`, `-slider`, `-toggle`, `-toggle-group` | Their only importers were the never-used shadcn wrappers deleted in Phase 4. |
| `@radix-ui/react-tabs` | `client/src/components/ui/tabs.tsx` is a custom React implementation; nothing imports the Radix package. |
| `embla-carousel-react`, `input-otp`, `vaul`, `react-resizable-panels` | Only imported by the deleted `carousel`, `input-otp`, `drawer` and `resizable` wrappers. |
| `memorystore` | Sessions use `connect-pg-simple` (`server/startup/sessionMiddleware.ts`). |
| `passport`, `passport-local`, `@types/passport`, `@types/passport-local` | Authentication is implemented without Passport; no import anywhere. Also removed from the Renovate approval group. |
| `next-themes`, `react-icons`, `tw-animate-css` | No import; the CSS uses `tailwindcss-animate`, not `tw-animate-css`. |
| `zod-validation-error` (root 5.0.0) | No import. `eslint-plugin-react-hooks` 7.1.1 keeps its own nested 4.0.2 copy in the lockfile. |

`package-lock.json`: the 22 root declarations were removed and the lockfile graph was walked
with Node's resolution rules; 31 entries that became unreachable (the packages above and their
exclusive transitive dependencies such as `embla-carousel`, `passport-strategy`, `pause`,
`utils-merge`, `pseudomap`, `memorystore`'s nested `lru-cache`/`yallist`) were dropped. A dry
run without removals dropped nothing and round-tripped both files byte-for-byte. No version of
any remaining package changed.

## Kept although not imported

| Package | Reason |
|---|---|
| `@capacitor/android`, `@capacitor/ios` | Native platform packages consumed by the Capacitor CLI (`cap sync`, `android/`, `ios/`). |
| `tailwindcss`, `tailwindcss-animate`, `@tailwindcss/typography` | Loaded by `client/src/index.css` (`@import`/`@plugin`) and PostCSS. |
| `puppeteer-extra`, `puppeteer-extra-plugin-stealth` | Loaded with `createRequire` in the scraper modules. |
| `@typescript/native` (`npm:typescript@7.0.2`) | Ships its own `tsc` binary; removing it can change which compiler `npm run check` resolves. Toolchain decision for the owner. |
| `@jridgewell/trace-mapping` | Satisfies dependencies of `@replit/vite-plugin-runtime-error-modal`, `@vitest/mocker` and source-map tooling at the hoisted version; removing the root pin could change resolution. |
| `@testing-library/dom`, `jsdom`, `@types/jsdom`, `@vitest/coverage-v8`, `prettier`, `tsx`, `motion` | Test environment/peer, coverage provider, CLI tools used by scripts and workflows, and a runtime UI dependency. |

## Follow-up for final validation

Run `npm ci` once to confirm the edited lockfile installs cleanly, then the normal checks
(see the final report).
