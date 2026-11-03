# Automated ERP & Factory training — private Vercel Blob storage

This implementation records the REAL UI in a disposable, local test company, detects changed screens nightly, prepares review artifacts and publishes only after a human approval and a reviewed PR merge. Live ERP accounting, inventory, payroll and company data are never used by the recorder.

## Provisioned storage — 2026-11-03

- Provider: **Vercel Blob**, private store.
- Name: `erp-factory-training-media`.
- Store ID: `store_TXyFGTsySrCeQhOj` (not a credential).
- Region: `pdx1` (Oregon, close to the ERP Render service).
- At creation: status `available`, access `private`, 0 objects.
- Vercel team access was approved in the conversation. Created an empty Vercel project **`erp-training-storage-access`** (`prj_Ev2ficF3T5o43OciPNkIRmyg10lN`) solely to manage the store connection. This project has NO deployment and does not host the ERP. The Blob store currently has **zero connected projects**, so an owner must connect the existing private store to this project in the Vercel dashboard before retrieving its token.

A private store **does not have publicly accessible media URLs**. Only the server-side token can fetch the files. The application exposes a permission-checked, authenticated streaming route at `/api/training/media/:topic`, plus `/captions` and `/screenshot`.

### One-time credential setup — still required

Vercel team access has been approved. The remaining manual step is connecting the existing private Blob store to the empty `erp-training-storage-access` project in Vercel (this operation is not exposed by the connected management actions). After it is connected:

1. Open the Vercel team's **Storage** area, select the existing `erp-factory-training-media` store, choose **Connect Project**, and select `erp-training-storage-access` (production environment). It will provision a `BLOB_READ_WRITE_TOKEN` in that project's environment. Copy that value securely or retrieve a token through the store settings. **Do not paste it into chat, an issue, a commit, or documentation.**
2. In GitHub repository Settings → Environments, create `training-publication` with **required human reviewers** and allow deployments only from `main`. Protect the approval environment.
3. Only after required reviewers are configured, add environment variables:
   - `TRAINING_PUBLICATION_APPROVAL_ENABLED=true`
   - `TRAINING_MEDIA_VERCEL_STORE_ID=store_TXyFGTsySrCeQhOj`
   And add the environment **secret** `TRAINING_MEDIA_VERCEL_TOKEN` containing that store's `BLOB_READ_WRITE_TOKEN`.
4. In the **ERP production service on Render**, set (merge, never replace unrelated variables):
   - `TRAINING_MEDIA_PROVIDER=vercel`
   - `TRAINING_MEDIA_VERCEL_STORE_ID=store_TXyFGTsySrCeQhOj`
   - `TRAINING_MEDIA_VERCEL_TOKEN=<token stored as a private environment variable>`.
   The Render service must not expose that token to the browser or build output. Configure only once the training PR and integration are ready to deploy.
5. Record a disposable test tour successfully after Actions runners are working. Review the WebM, VTT, screenshot and Markdown, especially any unexpected data, login dialogs or blocked requests.
6. Trigger **Approve & Publish ERP Training Video** with one reviewed topic and successful run ID. The protected workflow checks the source run, verifies artifacts, installs a pinned `@vercel/blob` client in an isolated temporary folder, and uploads to the private store with immutable `training/videos/{topic}/{sourceSha}.*` pathnames. It opens a PR updating `shared/publishedTrainingMedia.json`. Only a reviewed merge and ERP deployment enable playback.
7. Verify with a properly authorized user that the WebM, screenshot and captions stream via the authenticated ERP API; verify an unauthenticated user is rejected and a user denied access to the training topic cannot read it.

**Security trade-off:** Vercel Blob's `BLOB_READ_WRITE_TOKEN` can write as well as read within the dedicated store. The token must remain protected on both Render and GitHub; there is no claim that a separate read-only token exists. Restrict this store to training media, revoke/rotate credentials if exposed, and never expose its token from a frontend response.

## Nightly recording and review

1. `.github/workflows/nightly-training-audit.yml` runs at 02:15 UTC (04:15 Beirut winter / 05:15 summer). The first run covers all 16 predefined tours.
2. Subsequent runs compare `main` against the last successful nightly commit, choose affected known modules and record in a disposable PostgreSQL-backed local instance. Shared-code changes conservatively recapture all registered topics. Unknown modules are flagged for review, not automatically described as functional tutorials.
3. A GitHub issue links to review artifacts, retained 30 days, including screen capture, screenshot, captions and instructions.
4. A **person** approves each topic before it is uploaded. Recording never self-publishes or runs arbitrary production-account mutations.
5. The approved publication PR carries immutable keys and the reviewed written guide. Only users allowed to access the corresponding page can stream that material after merge/deployment.

## Blockers and limitations

- **GitHub Actions:** jobs for this repository were failing before runner assignment, preventing a successful end-to-end CI recording as of 2026-11-02. See issue #2764.
- **Vercel Blob store:** created successfully, but token and Vercel team connection approval not yet completed. No tutorial videos have been uploaded.
- **GitHub protected environment:** must have a human reviewer and publication opt-in enabled in GitHub settings. The connector here does not manage GitHub environment secrets directly.
- **Render:** the training-specific token and provider settings have not been added to production; no live deployment has been made.
- **Recording scope:** deterministic real-page read-only browser tours, not free-form AI software exploration; no generated voiceover or full real transaction simulations.
- **Costs:** Vercel Blob storage, requests and private media bandwidth are metered according to the account's plan and usage; do not assume free unlimited video playback. Keep recordings small and review usage.
- The existing S3-compatible signing utility remains in the server as an alternative, but **Vercel Blob is now the selected and configured publishing workflow**. No other storage provider is required.

## Developer verification

Check the type-check and client tests, `node --test scripts/plan-nightly-training.test.mjs`, and disposable browser recordings in CI. To inspect publisher code see `scripts/upload-reviewed-training-vercel.mjs`; private routing is in `server/routes/trainingMediaRoutes.ts`. All recording and publishing functionality remains on draft PR #2763 until verified.
