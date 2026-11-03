# ERP & Factory Training — private storage and gateway deployment

Status: **Vercel private storage exists; gateway NOT deployed; ERP integration NOT merged**. No tutorial has been uploaded or published. Training recordings use disposable local companies, never real accounting, inventory or payroll.

## Verified storage (November 3, 2026)
- Vercel store: `erp-factory-training-media`, ID `store_TXyFGTsySrCeQhOj`, private, region `pdx1`, 0 objects.
- Connected Vercel project: `erp-training-storage-access`, ID `prj_Ev2ficF3T5o43OciPNkIRmyg10lN`, production and preview access. The project has **no deployment**.
- The project has `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY`. New Vercel functions use automatically rotated OIDC tokens instead of a persistent `BLOB_READ_WRITE_TOKEN`. Do not copy expiring tokens into Render.
- The legacy training PR currently expects a long-lived Vercel token: **do not deploy that integration** until it has been replaced and tested.

## Selected gateway design — not yet implemented
1. **Read:** a logged-in ERP employee requests one approved tutorial. The Render backend checks company, role and page access. Render authenticates the request to a dedicated Vercel gateway, including the exact immutable object key. Vercel uses its own OIDC identity to mint a short-lived, object-specific read-only signed Blob URL. Render immediately fetches the media using that URL and streams it back to the authenticated ERP session, including video byte-range requests. No Blob token reaches the browser.
2. **Write:** only the manually approved GitHub `training-publication` job may request an upload grant. Verify its GitHub Actions OIDC JWT signature and the exact repository ID, main branch, approved workflow and protected environment. Use Vercel Blob client uploads for large WebM files, with strict pathname, content-type and size limits. Do not route raw videos through Vercel Functions: they have a 4.5 MB request-size limit.
3. **Gateway identity:** Use a dedicated strong shared secret stored only in Render and Vercel for server-to-server signing requests. Validate timestamps and signatures; avoid open upload endpoints. Do not enable publication before the gateway's public endpoints reject unauthenticated requests.
4. **Publishing:** write only immutable `training/videos/{topic}/{sourceSha}.webm|vtt|png` keys. Human review of the actual recorded video precedes any upload and a second PR review precedes ERP publication. No automatic self-approval.

Vercel reference documentation:
- https://vercel.com/changelog/vercel-blob-now-supports-oidc-authentication
- https://vercel.com/changelog/signed-urls-are-now-available-for-vercel-blob
- https://vercel.com/docs/vercel-blob/client-upload
- https://vercel.com/docs/functions/limitations

## Outstanding blockers
- **Gateway implementation/deployment:** The connected repository code-writing operation was blocked during the attempted guarded gateway implementation. No gateway code was published, no API route deployed, and no shared secret configured. This must be completed and security-reviewed before changing production env vars.
- **GitHub Actions:** #2764 reports jobs failing before runner assignment. Full CI, read-only browser recording, and publishing are still unverified.
- **GitHub protected environment:** must require human reviewers and restrict deployment to main. Pending.
- **ERP:** draft PR #2763 is not merged. Live accounting and Factory data are unchanged.

## Acceptance checks before launch
- Vercel deployment is READY and its public API returns 401 without valid server/workflow identity.
- Signing API validates immutable allowed key patterns and an expiry less than five minutes; no open signing proxy or public bucket.
- Approved upload runs only from GitHub main protected environment and cannot overwrite an existing object.
- Video range seeking and captions work from Render, with only authorized role access, while unauthorized and unauthenticated requests fail.
- Nightly fixture recording works with GitHub Actions; no production URL, database, supplier balance, inventory or journal change is permitted.
