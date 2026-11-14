# File upload and export policy — 13 November 2026

The shared source of truth is `shared/fileSizePolicy.ts` (binary MiB).

| Operation | Limit |
| --- | ---: |
| Regular spreadsheet imports | 50 MiB |
| Spreadsheet imports by signed-in Admin, Owner, Developer | 100 MiB |
| General uploaded images | 10 MiB |
| PDF and general document attachments | 25 MiB |
| Excel export size target | 100 MiB |

Enforcement happens in Multer before upload bytes accumulate beyond the
per-request cap. The general file store further rejects images over 10 MiB.
Existing stricter security/operational limits, including LAN edge (10 MiB),
chat images, ticket attachments and branded logos, remain intact.

The 100 MiB Excel export value is a **practical target**, not a blanket hard
stop: exports should use the existing heavy-export coordinator and buffer bridge,
and very large reports should be paginated or generated as artifacts. A workbook
below 100 MiB can still expand to much more memory when parsed. Validate row
counts and process heavy files in batches for production safety.

No database migrations or SQL are required.
