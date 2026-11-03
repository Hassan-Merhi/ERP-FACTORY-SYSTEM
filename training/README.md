# ERP & Factory Help and Training Center

## What is included

- The authenticated ERP route is `/help-training`.
- The authenticated Factory route is `/factory/help-training`.
- Both sidebars link to the Help & Training center.
- Guides cover existing navigation and workflows; the same page never modifies business data.
- Generic help content is filtered by the current user page permissions.
- Video players only appear for explicitly published, reviewed media; empty slots explain that no video has been published.

## Recording real software, not a generated mock-up

For the scheduled change detector, review gates and private media setup, see [automation.md](automation.md).

The supported recording runner is `scripts/record-training-guides.mjs`. It signs into **the actual application built from the repository** and opens registered read-only UI tours, records the browser with Puppeteer, captures a screenshot, and creates a Markdown guide plus WebVTT captions.

The recorder **requires the existing Phase 7 disposable Postgres fixture** on 127.0.0.1:5000, `NODE_ENV=test`, `ERP_E2E_DISPOSABLE_DB=1`, `TRAINING_SANDBOX_VERIFIED=1`, and ephemeral fixture credentials. It refuses public or production URLs. It restricts network traffic during each tour to same-origin GET/HEAD/OPTIONS. No AI agent may click arbitrary controls or perform writes.

### Run recordings

After merging the implementation, GitHub Actions > **Record Real ERP Training Videos (Disposable Data)** > Run workflow > select a topic or all. The workflow installs Chrome/ffmpeg, builds the app, prepares disposable ERP and Factory companies, records real UI clips, and produces a review artifact. The generated artifact expires after 30 days and is **not** a publishing destination.

Each completed topic output includes:
- `screen.webm`: actual rendered UI video with instructional on-screen captions.
- `screenshot.png`: screenshot from the training session.
- `captions.vtt`: captions and timing.
- `guide.md`: workflow documentation.
- `report.json`: recording status for all selected topics.

### Review and publish permanently

1. Check recording success and confirm the video contains only disposable sample data, no private business details, login screens or credentials.
2. Check the instructions against the actual current UI and confirm the recorded page is correct.
3. Approve the selected topic through the protected GitHub `training-publication` environment after reviewing all evidence.
4. Use **Approve & Publish ERP Training Video** to upload approved WebM, captions and screenshot to the dedicated **private Vercel Blob store** and create a PR updating `shared/publishedTrainingMedia.json` with approved guide steps. GitHub Actions temporary artifacts and ephemeral Render filesystems are not used as permanent storage.
5. Review/merge that PR, deploy the change, and verify playback and active-company role access; the app routes video, captions and screenshots through its authenticated backend.
6. Rerecord videos when relevant workflows or screenshots change.

This is the **initial foundation**. Nightly detection and automated recording have now been added, while private streaming is available only after storage credentials and an approved published manifest are configured. AI-discovered multi-step write simulations, voice narration and an in-app admin approval console are **not implemented**. Until a reviewed publication PR is merged and deployed, the library marks videos as unpublished.

## Security and reliability

- Never automate real stock movements, invoices, vouchers, bonuses or payroll in production.
- Do not put login details, tokens, live financial records, personally identifiable information or restricted business details in a guide or video artifact.
- Access filtering in the client is for navigation only; private playback also checks active-company page permission on the server. Do not store secret documentation in the static frontend bundle.
- The destination page retains its original server and page permissions.
- Real action tutorials must be recorded against isolated throwaway test data with explicit assertions of expected outcomes and reviewed before release.


## Nightly disposable transactions and reconciliation

The **Nightly ERP Training Audit** workflow now runs a separate `transactions` job **every night**, even when no application pages changed. This job is independent of video recording and performs the existing actual application transaction tests, not mocked calculations. A temporary PostgreSQL 18 service is initialized with a fabricated dataset and unique test credentials; it is not connected to Render or a production company.

The fixture generator is `scripts/prepare-phase7-browser-e2e-fixture.mjs`. It creates three fake companies (ERP, Factory, Supplier Partner), synthetic inventory, accounts, a supplier and a container. **You do not need to supply any real records.** Developers can change or expand the fake-only fixture and expected assertions through reviewed code changes; the current workflow does **not** accept user-uploaded datasets or import live company data.

The transaction runner `scripts/run-phase7-browser-e2e.mjs` executes actual local server and browser actions including:

- ERP POS sales and phone checkout, with inventory deduction
- stock transfer between ERP locations
- a journal voucher through the API and another through the UI
- Factory container offload and reverse-offload
- Supplier Partner stock sale, posting and role isolation

The nightly follow-up `scripts/verify-nightly-transaction-reconciliation.mjs` **fails the workflow** if the required transaction cases did not pass, if any voucher with accounting entries is unbalanced, if fake ERP stock quantity/value does not reconcile, if the fake ERP cash/sales or Supplier Partner payable postings do not match the example amounts, or if Factory offload reversal leaves raw stock behind. It uses company-scoped queries on the isolated test database.

GitHub Actions uploads `nightly-fake-company-reconciliation`, containing the browser case report, screenshots, reconciliation JSON, and disposable server log. A failed audit opens an investigation issue; no failed recording is automatically published.

**Scope warning:** this reconciles the explicitly implemented scenarios, **not every possible financial/stock transaction in the ERP**. Payroll, bonus calculation, invoicing, POS reversal and other workflows require their own seeded integration scenarios and independent assertions before they can be claimed covered. Publishing training videos continues to require protected human approval, a separate publication PR and deployment.

### Run manually

GitHub → Actions → **Nightly ERP Training Audit** → **Run workflow**, choose the implementation branch for an initial test or `main` after merging the PR. The schedule runs from `main` at 02:15 UTC (04:15 Beirut standard time / 05:15 daylight time).

Safety conditions enforced by the reconciler: `NODE_ENV=test`, `ERP_E2E_DISPOSABLE_DB=1`, `TRAINING_SANDBOX_VERIFIED=1`, a loopback PostgreSQL host and the exact dedicated `/heliumdb` fixture database. Never connect this job to live databases, real company data or user credentials.
