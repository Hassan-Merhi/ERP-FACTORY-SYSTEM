# Dead-code prevention standards

These rules came out of the 2026-10 dead-code cleanup (records in
[`archive/engineering/dead-code/`](archive/engineering/dead-code/), handoff in
[dead-code-cleanup-final-report.md](dead-code-cleanup-final-report.md)). They apply to people
and to AI coding agents. Most of the dead code that cleanup removed came from a few repeatable
habits; each rule below names the habit it stops.

## 1. Delete, do not rename to `_`

A leading `_` is allowed only for deliberately unused **parameters** and **caught errors**,
and for keys omitted with a rest pattern (`const { id: _id, ...rest } = row`, covered by
`ignoreRestSiblings`). It is **not** a way to keep code that no longer runs. The cleanup
removed more than a hundred `_handleX`, `_xMutation`, `_xSchema` declarations and about 400
`_`-prefixed destructured bindings that had been renamed instead of deleted, and then dropped
`varsIgnorePattern: "^_"` from `eslint.config.js`, so an unused `_local` is now a lint warning
(the warning ceiling is zero). When you stop using something, remove it and any state, query
or import that only it needed.

## 2. One registration path per route

- `server/routes/applicationRoutes.ts` is the only composition root. A folder `index.ts` must
  not keep a second `register*Routes` list; nothing may import a registry that the application
  does not mount.
- A later registration of the same method and path is dead unless the earlier handler can call
  `next()`. Before adding one, read the earlier handler. Deliberate layering (permission gates,
  pagination or language dispatch, response wrappers, lifecycle guards) must say so in a
  comment at the registration site.
- When a new implementation supersedes an old route, delete the old handler in the same change
  and update `config/route-manifest.json` (`UPDATE_ROUTE_MANIFEST=1`). The
  `MAX_SHADOWED_REGISTRATIONS` ceiling in `tests/route-manifest.test.ts` only goes down.
- A module loaded through `registerLazyRouteModule` may only register paths under its declared
  prefixes; anything else works in development and silently disappears in production.

## 3. Retiring a page or feature

- **Retire**: delete the page, its lazy export in `client/src/lazyPages.ts`, its
  `offlinePrep.ts` preload, its exclusive components and hooks, and the page-mount test cases
  that render it. Keep a `<Redirect>` for old URLs.
- **Hide**: if the feature may return, say "Hide …" in the commit message and leave a comment
  at the route or tab that hid it. The cleanup kept hidden features (container planner,
  remove-from-stock tab) and deleted retired ones; the commit wording is how it told them
  apart.
- Never leave a test or verify script certifying a UI that no route mounts. Either mount the
  UI or retire it together with the check.

## 4. Shared code ownership

- Before writing a helper, look for it: `shared/typeGuards.ts` (`isRecord`, …),
  `server/lib/listPagination.ts` (`parsePositiveInt`, list pagination),
  `client/src/lib/fetchRequestUtils.ts` (fetch-interceptor request shape), `server/lib/money.ts`.
- Copying a helper into a second module is acceptable only when the copies are expected to
  diverge (for example separately audited posting services). Say so in a comment.
- Export only what another module imports. An export that exists "for later" is dead code that
  every search finds.

## 5. Scripts, dependencies and docs

- One-shot source-rewriting scripts (`phaseN-*-patch.mjs`, PR self-fix scripts) are deleted in
  the change that applies them. Database repair, backfill and diagnostic tools are kept and
  should state their purpose in a header comment.
- Add a dependency only with its first import; remove it with its last. shadcn/Radix wrappers
  that are not used should not be generated into `client/src/components/ui/`.
- Records of finished work go to `docs/archive/` and are classified in
  `config/doc-index.json` (`npm run audit:doc-index`).

## Finding dead code

`npm run report:dead-code` (`scripts/report-dead-code.mjs`) prints unreachable modules,
modules reachable only from tests, and exports that nothing imports. It parses only — no
type check, no build — and is not a CI gate. Treat every line as a lead:

1. Search tests and `scripts/verify-*`/`audit-*` for the file path or bare name; many checks
   read source text by path.
2. Check the history of the last importer for "hide", "disable" or "temporarily".
3. Search `build/*.ts` for the file name and for the exact line you are about to change. The
   Vite plugins inject imports into `main.tsx` and rewrite exact source lines at build time,
   and they throw when a target is gone, so `vite build` fails although the type check and
   the tests pass. (The cleanup removed one injected module and one rewritten line this way;
   both were restored.)
4. Never remove `shared/schema/**` table definitions, migrations, or startup-schema modules
   because they look unused; drizzle-kit and live tables depend on them.
5. Re-run the route manifest, type check, the affected tests and `npm run build` before
   merging.
