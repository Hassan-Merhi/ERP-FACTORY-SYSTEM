# ERP POS System
A comprehensive ERP and POS system for multi-company warehouse management, optimizing operations, inventory, and financials, with an AI Chatbot for intelligent assistance.

## Run & Operate
- **Run Development**: `npm run dev` (client and server)
- **Build**: `npm run build`
- **Typecheck**: `npm run typecheck`
- **Database Migrations**: Drizzle Kit CLI for schema migrations. Runtime migrations are handled via an array in `server/index.ts`.
- **Environment Variables**:
    - `CSRF_ENFORCE`: "0" for warn-only, anything else (default) for hard 403.
    - `NODE_ENV`: "development" or "production".

## Stack
- **Frontend**: React 18, TypeScript, Vite, TanStack Query, `react-hook-form` with Zod, `wouter` (routing), `shadcn/ui` (Tailwind CSS, Radix UI).
- **Backend**: Express.js, TypeScript, Zod (validation), `pg` (PostgreSQL driver), Drizzle ORM.
- **Database**: PostgreSQL.
- **Build Tool**: Vite.

## Where things live
- **Client Source**: `client/src/`
    - **Pages**: `client/src/pages/` (categorized into `factory/`, `pos/`, `properties/`, and root for shared ERP pages)
    - **Components**: `client/src/components/` (shared UI primitives)
    - **Contexts**: `client/src/contexts/`
    - **Hooks**: `client/src/hooks/`
    - **Lib**: `client/src/lib/` (utilities, API clients, offline logic)
- **Server Source**: `server/`
    - **Routes**: `server/routes/` (categorized into `factory/` and root for ERP routes)
    - **Lib**: `server/lib/` (helpers, PDF generators, date utilities)
- **Shared Code**: `shared/`
    - **Database Schema**: `shared/schema.ts` (source of truth for DB structure and types)
- **Public Assets**: `client/public/` (service worker, label images)
- **Scripts**: `scripts/` (database backfills, CSRF smoke tests)

## Architecture decisions
- **Full-stack TypeScript**: Enhances type safety from database schema to frontend UI.
- **Drizzle ORM for Schema and Queries**: Provides type-safe database interactions and schema management. Runtime migrations are managed via a dedicated array, ensuring idempotent schema updates.
- **Offline-First with IndexedDB**: Utilizes Dexie.js and a robust sync engine for resilience against network outages, including conflict resolution and draft autosave.
- **Multi-Tenancy and Modularity**: Supports `erp`, `factory`, and `properties` company types with isolated data, API namespaces, and UI components, sharing core accounting.
- **Shared UI Primitives (`shadcn/ui`)**: Enforces visual consistency and improves developer velocity by providing a canonical set of reusable UI components.
- **Centralized `adjustInventory` Helper**: All inventory mutations are routed through a single helper with row-level locking and cost calculations for data integrity.

## Product
- Multi-company warehouse management.
- Robust inventory tracking across multiple locations.
- Streamlined purchase order management with freight costing.
- Container tracking for international shipments.
- Full financial accounting and reporting (P&L, balance sheet).
- AI Chatbot for ERP data queries.
- Multi-entity support with isolated data.
- POS system with custom pricing, profit comparison, and offline capabilities.
- Rental management for properties and warehouses.
- Factory production system with worker management, payroll, and bale tracking.
- Customer ledger and statement generation.
- Per-user date format and cost visibility control.
- Soft delete system for key entities.
- User-to-user chat.
- CSRF protection and tenant isolation.

## User preferences
Preferred communication style: Simple, everyday language.
Testing: do not add new test files unless absolutely necessary; only update existing tests if they break because of a change. For verification, run typecheck/build and manually explain what was checked instead of expanding the test suite.

## Gotchas
- **`tsc --noEmit` duration**: Typechecking can take longer than 2 minutes, making in-loop verification difficult.
- **Orphaned data**: Several `NOT VALID` foreign key constraints exist due to historical orphaned rows. Applying these as `VALIDATE` would require data cleanup decisions.
- **`console.log` usage**: Server-side code still contains many `console.log` calls; use `serverLog` for production logging.
- **Schema**: owned by numbered migrations in `migrations/`, applied with `npm run db:migrate`; the server only verifies it at startup. `drizzle-kit push` is not used (see `docs/database-migrations.md`).

## Pointers
- **Shadcn UI Docs**: [https://ui.shadcn.com/docs](https://ui.shadcn.com/docs)
- **Drizzle ORM Docs**: [https://orm.drizzle.team/docs/overview](https://orm.drizzle.team/docs/overview)
- **Dexie.js Docs**: [https://dexie.org/docs](https://dexie.org/docs)
- **Tailwind CSS Docs**: [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
- **React Hook Form Docs**: [https://react-hook-form.com/get-started](https://react-hook-form.com/get-started)
- **Zod Docs**: [https://zod.dev/](https://zod.dev/)
- **TanStack Query Docs**: [https://tanstack.com/query/latest/docs/react/overview](https://tanstack.com/query/latest/docs/react/overview)
- **PostgreSQL Docs**: [https://www.postgresql.org/docs/](https://www.postgresql.org/docs/)