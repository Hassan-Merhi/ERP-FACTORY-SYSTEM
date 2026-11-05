# ERP & Factory automated training — private video storage

Updated: 2026-11-05. Recording and publication are merged and automatic; see "Nightly publication" below.

## Infrastructure status

- **Vercel production gateway: READY.** Project: `erp-training-storage-access` (`prj_Ev2ficF3T5o43OciPNkIRmyg10lN`); deployment `dpl_GhYDfPv53Npd4i8mEKVnnm2xHmo6`. Production hostname: `https://erp-training-storage-access.vercel.app`.
- **Verified against production:** `GET /api/health` returned HTTP 200; an unsigned `GET /api/sign` with a valid training key returned HTTP 403; `GET /api/upload-url` returned HTTP 405. This verifies route startup and fail-closed unauthenticated access, **not** end-to-end uploads or signed playback.
- **Private Vercel Blob:** `erp-factory-training-media` (`store_TXyFGTsySrCeQhOj`, `pdx1`); connected to the gateway project. No approved videos uploaded yet.
- Vercel automatically rotates the gateway's Blob OIDC identity. The production gateway has a **sensitive** `TRAINING_GATEWAY_READ_SECRET` configured; its value must never enter source code, PR comments, screenshots, or logs.
- The gateway's code is under `training/gateway` on the feature branch. Changes to the ERP backend and the GitHub publication workflow are on the same branch.
- The Vercel project has been configured to disable automatic preview deployments to reduce unrelated builds. The connected monorepo's default production branch is still `main`; while `main` lacks `training/gateway`, auto-build attempts on `main` can still fail with `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST`. These failures do not imply that the previously verified gateway production alias is down. Configure the Vercel project's production branch explicitly for the gateway source, or isolate the gateway in a dedicated repository, rather than turning on full monorepo builds.

## Nightly publication (automatic)

- The nightly audit's `publish` job validates every recording captured from the audited `main` commit and uploads it to the private Blob store with a GitHub OIDC identity issued in the `training-publication` environment. Allowed publishers are pinned in `training/gateway/api/upload-url.js`: the nightly audit (`schedule`, `workflow_dispatch`, `push`) and the manual single-topic workflow (`workflow_dispatch`), both only from `main`.
- The runtime manifest `training/manifest/current.json` is the one object the gateway allows to be overwritten. The ERP (`server/routes/trainingMediaRoutes.ts`) signs a read for it through `/api/sign`, caches it for 60 seconds, keeps the last good copy on a failed read, and exposes the non-sensitive listing at `/api/training/media`. `shared/publishedTrainingMedia.json` is only the fallback when `TRAINING_MEDIA_PROVIDER` is not `vercel`.
- Environment configuration required for automation: `TRAINING_PUBLICATION_APPROVAL_ENABLED=true` on `training-publication`, deployment branch restricted to `main`, and no required reviewers.
- Render (`system` service) carries `TRAINING_MEDIA_PROVIDER=vercel`, `TRAINING_MEDIA_GATEWAY_URL=https://erp-training-storage-access.vercel.app` and `TRAINING_GATEWAY_READ_SECRET` (same value as the gateway's sensitive variable).

## Design and security

1. Nightly workflow `.github/workflows/nightly-training-audit.yml` compares repository changes and records up to 16 predefined read-only browser tours against a **throwaway local** ERP/Factory database. It never connects to live production data. The recorder glides a pointer to each control and hovers it. Its only clicks are on already-visible tabs, on main-area buttons that reveal a menu, dropdown list or dialog (so the hidden controls inside can be explained; destructive, printing, exporting, saving and posting buttons are never pressed), and on a short allow-list of reversible demonstrations (typing a sample value into a search box, choosing one entry from an opened list). Every demonstration is undone by clearing the text, closing the layer, or reloading the untouched page; nothing is submitted or saved, printing, pop-ups and downloads are disabled in the browser, and all non-GET requests stay blocked at the network layer. The shared top bar and sidebar are narrated only in the overview tour of each mode.
2. A person reviews the narrated H.264 + AAC MP4 (1-20 minutes, one spoken sentence per visible and hidden control with an on-screen highlight and a smoothly moving pointer), screenshots, VTT captions and the Markdown transcript. The narration text is produced deterministically from the real control labels; the voice is the offline Piper `en_US-lessac-medium` model, installed from checksum-pinned files, so no text leaves the runner. The recording worker validates full MP4 decoding before uploading the review artifact.
3. The protected `training-publication` GitHub workflow validates the source recording; only a manually approved job from the intended repository, `main`, and the protected environment can acquire a short-lived PUT grant from `/api/upload-url` using GitHub Actions OIDC. No permanent Blob token is needed on GitHub.
4. The gateway limits object paths to `training/videos/{topic}/{40-char-source-sha}.{mp4|webm|vtt|png}` (MP4 preferred for new videos; legacy WebM remains readable), validates identity and constrains media types/sizes. It uses `@vercel/blob@2.4.0` signed URLs for immutable objects.
5. For reads, ERP `/api/training/media/:topic` first verifies logged-in user, selected company and role/page access. The Render server then HMAC-signs a request to `/api/sign`. The gateway returns a short-lived single-key signed GET URL, consumed by Render; employees never see the Blob credential or gateway HMAC secret. Video range requests and captions stream through the authenticated ERP route.
6. Manifest entries become visible as soon as the nightly publish job overwrites the runtime manifest; the previous objects remain for rollback through the manual single-topic workflow.

## Activation checklist

- Vercel project `erp-training-storage-access`: Root Directory `training/gateway`, Production Branch `main`, previews off. Every merge to `main` that touches the gateway redeploys it; confirm `/api/health` answers `ready` and an unsigned `/api/sign` answers 403 afterwards.
- GitHub environment `training-publication`: `TRAINING_PUBLICATION_APPROVAL_ENABLED=true`, branch restriction `main`, no required reviewers.
- Render `system` service: the three `TRAINING_*` variables above.
- First verification after enabling: one nightly run with a green `publish` job, then open Help & Training in the ERP and play the published topic; a user without that page's permission must get 403 from `/api/training/media/{topic}`.

## Production data and limitations

No live ERP accounting, supplier balances, journal vouchers, payroll, attendance, stock or invoice data is used by the recorder. The implemented recorder tours are deterministic and read-only, not a generative AI that independently submits transactions. Publication is automatic and unreviewed by design; the nightly issue is the audit trail and the manual workflow is the rollback. No Railway infrastructure is used.
