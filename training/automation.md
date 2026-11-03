# ERP & Factory automated training — private video storage

Updated: 2026-11-03. Implementation is on draft PR #2763, not merged into the live ERP.

## Infrastructure status

- **Vercel production gateway: READY.** Project: `erp-training-storage-access` (`prj_Ev2ficF3T5o43OciPNkIRmyg10lN`); deployment `dpl_GhYDfPv53Npd4i8mEKVnnm2xHmo6`. Production hostname: `https://erp-training-storage-access.vercel.app`.
- **Verified against production:** `GET /api/health` returned HTTP 200; an unsigned `GET /api/sign` with a valid training key returned HTTP 403; `GET /api/upload-url` returned HTTP 405. This verifies route startup and fail-closed unauthenticated access, **not** end-to-end uploads or signed playback.
- **Private Vercel Blob:** `erp-factory-training-media` (`store_TXyFGTsySrCeQhOj`, `pdx1`); connected to the gateway project. No approved videos uploaded yet.
- Vercel automatically rotates the gateway's Blob OIDC identity. The production gateway has a **sensitive** `TRAINING_GATEWAY_READ_SECRET` configured; its value must never enter source code, PR comments, screenshots, or logs.
- The gateway's code is under `training/gateway` on the feature branch. Changes to the ERP backend and the GitHub publication workflow are on the same branch.
- The Vercel project has been configured to disable automatic preview deployments to reduce unrelated builds. The connected monorepo's default production branch is still `main`; while `main` lacks `training/gateway`, auto-build attempts on `main` can still fail with `NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST`. These failures do not imply that the previously verified gateway production alias is down. Configure the Vercel project's production branch explicitly for the gateway source, or isolate the gateway in a dedicated repository, rather than turning on full monorepo builds.

## Design and security

1. Nightly workflow `.github/workflows/nightly-training-audit.yml` compares repository changes and records up to 16 predefined read-only browser tours against a **throwaway local** ERP/Factory database. It never connects to live production data.
2. A person reviews the H.264 MP4 (five guided on-screen steps, under 60 seconds), screenshots, VTT captions and Markdown instructions. The recording worker validates full MP4 decoding before uploading the review artifact.
3. The protected `training-publication` GitHub workflow validates the source recording; only a manually approved job from the intended repository, `main`, and the protected environment can acquire a short-lived PUT grant from `/api/upload-url` using GitHub Actions OIDC. No permanent Blob token is needed on GitHub.
4. The gateway limits object paths to `training/videos/{topic}/{40-char-source-sha}.{mp4|webm|vtt|png}` (MP4 preferred for new videos; legacy WebM remains readable), validates identity and constrains media types/sizes. It uses `@vercel/blob@2.4.0` signed URLs for immutable objects.
5. For reads, ERP `/api/training/media/:topic` first verifies logged-in user, selected company and role/page access. The Render server then HMAC-signs a request to `/api/sign`. The gateway returns a short-lived single-key signed GET URL, consumed by Render; employees never see the Blob credential or gateway HMAC secret. Video range requests and captions stream through the authenticated ERP route.
6. Manifest entries become visible only after a separate publication PR is reviewed, merged and deployed.

## Remaining activation steps

- **Complete CI on the latest PR commit.** Previous checks included a training-guide typing error (fixed in commit `1c737ecc12797d08a72f0d72bebe3f153c0ae789`), but many TypeScript errors in separate factory/accounting modules and an i18n ratchet failure remain. Do not merge while required checks fail.
- **Fix the Vercel Git auto-build scope.** Unrelated ERP branches lack `training/gateway` and must not be selected as the training app's deployment source. Use Vercel Project Settings → Git → Production Branch to choose the intended gateway branch or move the gateway to a separate repository. Re-enable previews only when their branch selection is safe.
- **Configure protected publication environment** `training-publication` with human required reviewers, `main` branch restriction and explicit `TRAINING_PUBLICATION_APPROVAL_ENABLED=true` only once reviewers are configured.
- **After testing, configure the ERP Render service** (merge these variables, do not replace unrelated values): `TRAINING_MEDIA_PROVIDER=vercel`, `TRAINING_MEDIA_GATEWAY_URL=https://erp-training-storage-access.vercel.app`, `TRAINING_GATEWAY_READ_SECRET` with the same secret as the protected gateway environment. This environment update may redeploy the ERP; defer it until main contains the approved integration.
- Verify a signed video grant and a denied grant, one disposable recording, one human-approved video upload, authenticated and unauthorized playback and byte-range support before enabling publication.

## Production data and limitations

No live ERP accounting, supplier balances, journal vouchers, payroll, attendance, stock or invoice data is used by the recorder. The implemented recorder tours are deterministic and read-only, not a generative AI that independently submits transactions. No tutorial has been recorded, approved and published end-to-end yet. No Railway infrastructure is used.
