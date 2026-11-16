# Compatibility

## Browsers

| Browser | Support |
|---------|---------|
| Chrome 110+ | ✅ Fully supported |
| Edge 110+ | ✅ Fully supported |
| Firefox 110+ | ✅ Fully supported |
| Safari 16+ | ✅ Fully supported |
| Mobile Chrome / Safari | ✅ Responsive layout supported |
| Internet Explorer | ❌ Not supported |

---

## Devices

The UI is responsive and works on:
- Desktop (1280px+) — full experience
- Tablet (768px+) — sidebar collapses, tables scroll horizontally
- Mobile — core pages usable; complex tables require horizontal scroll

PDF exports and print layouts are optimized for A4 paper.

---

## Node.js

| Version | Status |
|---------|--------|
| 24.22.2 | ✅ Pinned and certified (`.node-version`) |
| Other 24.x | ⚠️ Meets the package engine but is not the CI reference runtime |
| 22.x and earlier | ❌ Unsupported |

---

## Database

- **PostgreSQL 18** is the production and CI baseline (both Render databases run 18.x; CI uses `postgres:18`).
- Numbered SQL migrations in `migrations/` (applied with `npm run db:migrate`) are the only schema authority; startup only verifies.
- `drizzle-kit push` is not used; `shared/schema` is a typed query layer only.

---

## Environment

- Linux is the production and CI runtime (`ubuntu-24.04` for final certification).
- Windows is supported for the packaged desktop application; use WSL2 for local
  server development.
- Required and optional environment variables are documented in `.env.example`.
