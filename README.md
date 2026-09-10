# ERP / POS System

A comprehensive, multi-company **ERP and POS platform** for warehouse
management, inventory, and financials — with container tracking, factory
production, property rentals, offline-capable point of sale, and an AI
chatbot for querying ERP data.

It is a full-stack TypeScript application (React frontend + Express API +
PostgreSQL) that also ships as native mobile apps via Capacitor.

## Tech stack

| Layer | Technologies |
|-------|--------------|
| Frontend | React 19, TypeScript, Vite, TanStack Query, react-hook-form + Zod, wouter, shadcn/ui (Tailwind + Radix) |
| Backend | Express.js, TypeScript, Drizzle ORM, `pg`, Zod validation |
| Database | PostgreSQL |
| Auth / security | Passport (local), WebAuthn, Helmet, CSRF enforcement, rate limiting, per-tenant isolation |
| Offline | Dexie.js (IndexedDB) with a sync engine and draft autosave |
| Mobile / desktop | Capacitor (Android/iOS), Electron desktop |

## Prerequisites

- Node.js **24.21.0** (see `.node-version`)
- A PostgreSQL database

## Getting started

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env
# then edit .env and set DATABASE_URL and SESSION_SECRET

# 3. Restore an approved development database snapshot (see docs/fresh-db-bootstrap.md)
# Runtime startup migrations will bring that schema forward automatically.

# 4. Start the dev server (client + API on http://localhost:5000)
npm run dev
```

Do not run `db:push` against a persistent or production database. The command is
reserved for disposable CI/test databases while schema drift is being retired.

### Environment variables

`.env.example` documents every variable the server reads, with defaults and
effects. Only two must be set:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Signs sessions; the server exits without it in production |

Everything else has a working default — `NODE_ENV`, `PORT` (`5000`),
`CSRF_ENFORCE` (`0` = warn-only, otherwise hard 403), pool sizing, alert
thresholds, and the optional AI and container-tracking provider keys.
`npm run verify:env-docs` fails CI if a new variable is added without
documenting it.

## Common scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run client + server in development |
| `npm run build` | Production build (client bundle + server bundle) |
| `npm start` | Run the production build |
| `npm run check` | TypeScript type-check (`tsc --noEmit`) |
| `npm run lint` | ESLint over `client/`, `server/`, `shared/` |
| `npm run format` | Prettier write |
| `npm test` | Backend + frontend test suites (Vitest) |
| `npm run test:backend` / `npm run test:frontend` | Run one suite |
| `npm run db:push` | Provision a disposable CI/test database only |
| `npm run verify:env-docs` | Check `.env.example` covers every env var the server reads |
| `npm run verify:dependency-audit` | Fail on unreviewed high/critical production vulnerabilities |
| `npm run audit:coverage-ratchet` | Report coverage floors that measured coverage has outgrown |
| `npm run verify:runtime-dependencies` | Check everything production imports is in `dependencies` |
| `npm run audit:type-escapes` | Per-file ratchet on `any` and compiler suppressions |
| `npm run audit:write-routes` | Ledger and stock write routes with no test naming them |
| `npm run audit:doc-index` | Docs classified, records archived, documented figures still true |
| `npm run audit:toolchain` | One Node version across every file that states one |
| `npm run audit:scripts` | Every wired verification script passes; orphans only decrease |

## Project layout

```
client/src/        Frontend
  pages/           Screens, grouped by domain (factory/, pos/, properties/, …)
  components/      Shared UI primitives (shadcn/ui)
  contexts/        React contexts (company, currency, mode, …)
  hooks/           Reusable hooks
  lib/             API clients, utilities, offline logic
server/            Express API
  routes/          HTTP routes, grouped by domain (factory/, containers/, …)
  services/        Domain services (accounting, audit, security, …)
  lib/             Helpers (PDF, dates, request context, …)
  middleware/      Request logging, security, bandwidth diagnostics
shared/            Code shared between client and server
  schema/          Drizzle database schema — source of truth for DB + types
migrations/        SQL migrations
tests/             Vitest suites (backend + tests/ui frontend)
docs/              Architecture, flows, and audit documentation
```

## Dependency classification

Deployment runs `npm ci` with `NODE_ENV=production`, which **omits
`devDependencies`**. Anything production touches must therefore be in
`dependencies`:

- **Runtime** — every package the server bundle statically imports. The bundle
  is built with `packages: "external"`, so each import is a real resolution
  against `node_modules`. This includes `vite` and `nanoid`, because
  `server/index.ts` statically imports `server/vite.ts`; they load on boot even
  though the dev server never starts in production.
- **The `--import` preload bridges** in `npm start`. Node loads these from
  source before the bundle, so a missing package there kills the process before
  the server exists.
- **Build tooling** — `vite`, `esbuild`, `tailwindcss`, `postcss`,
  `autoprefixer`, `@vitejs/plugin-react`, `@tailwindcss/typography`. The
  deployment builds from source, so these are needed there too.

`devDependencies` is for things only CI and local development run: test
runners, linters, formatters, and `@types/*`.

`npm run verify:runtime-dependencies` enforces the split and runs as the last
step of `npm run build`, so a misclassification fails the deploy instead of the
boot. It reads esbuild's metafile rather than grepping the bundle — the output
embeds source text containing import statements inside template literals.

## Architecture notes

- **Full-stack TypeScript** — types flow from the Drizzle schema in
  `shared/schema/` through the API to the frontend.
- **Multi-tenancy** — `erp`, `factory`, and `properties` company types with
  isolated data and API namespaces, sharing a common accounting core.
- **Offline-first POS** — IndexedDB via Dexie with conflict resolution and
  autosaved drafts.
- **Centralized inventory mutations** — all stock changes route through a
  single `adjustInventory` helper with row-level locking and cost
  calculation for integrity.

## Continuous integration

GitHub Actions runs on every push / PR to `main`:

- **CI** (`.github/workflows/ci.yml`): env-doc check → static ratchets
  (type escapes, doc index, write-route coverage, toolchain coherence, script
  inventory) → type-check → build → lint → format → DB schema push →
  startup-migration smoke test → backend & frontend tests with coverage
  thresholds → API smoke sweep → coverage ratchet audit.

  The static ratchets run first because they need nothing but a checkout, so a
  baseline moved the wrong way fails in seconds rather than after the build.
  Each is a one-way gate: the number it guards may fall freely and never rise.

  Coverage floors live in `config/coverage-thresholds.json`: a global floor per
  suite plus per-file floors on the modules where a regression is most
  expensive — posting, inventory costing, and tenant isolation. They are a
  one-way ratchet, so `npm run audit:coverage-ratchet` reports floors that
  coverage has climbed past and should be raised.
- **Security** (`.github/workflows/security.yml`): dependency audit and
  TruffleHog secret scanning. The audit gate fails on any high or critical
  vulnerability in production dependencies unless it carries a written,
  dated exception in `scripts/verify-dependency-audit.mjs`.

## More documentation

`docs/README.md` is the index. Everything in `docs/` describes how the system
behaves now — architecture, accounting and inventory flows, deployment,
security, and operations runbooks. Finished work (phase write-ups, completion
records, dated audits) lives in `docs/archive/` and is history rather than
reference; the split is enforced by `npm run audit:doc-index`.

Start with `docs/architecture.md` and `docs/onboarding.md`.
