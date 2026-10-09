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
| 24.21.0 | ✅ Pinned and certified (`.node-version`) |
| Other 24.x | ⚠️ Meets the package engine but is not the CI reference runtime |
| 22.x and earlier | ❌ Unsupported |

---

## Database

- **PostgreSQL 16** is the certified production and CI baseline.
- Versioned SQL and idempotent startup migrations manage persistent databases.
- `drizzle-kit push` is limited to disposable CI/test databases; never use it to
  update a persistent or production database.

---

## Environment

- Linux is the production and CI runtime (`ubuntu-24.04` for final certification).
- Windows is supported for the packaged desktop application; use WSL2 for local
  server development.
- Required and optional environment variables are documented in `.env.example`.
