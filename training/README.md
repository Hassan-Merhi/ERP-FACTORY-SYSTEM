# ERP & Factory Help and Training Center

## What is included

- The authenticated ERP route is `/help-training`.
- The authenticated Factory route is `/factory/help-training`.
- Both sidebars link to the Help & Training center.
- Guides cover existing navigation and workflows; the same page never modifies business data.
- Generic help content is filtered by the current user page permissions.
- Video players appear for every topic the nightly recorder has published; empty slots explain that no video has been recorded yet. The page reads the published list from the authenticated route `/api/training/media`, which the server refreshes from private storage about once a minute, so a new recording needs no deploy.

## Recording real software, not a generated mock-up

For the scheduled change detector, review gates and private media setup, see [automation.md](automation.md).

The supported recording runner is `scripts/record-training-guides.mjs`. It signs into **the actual application built from the repository** and opens registered read-only UI tours, records the browser with Puppeteer, captures a screenshot, and creates a Markdown guide plus WebVTT captions.

The recorder **requires the existing Phase 7 disposable Postgres fixture** on 127.0.0.1:5000, `NODE_ENV=test`, `ERP_E2E_DISPOSABLE_DB=1`, `TRAINING_SANDBOX_VERIFIED=1`, and ephemeral fixture credentials. It refuses public or production URLs. It restricts network traffic during each tour to same-origin GET/HEAD/OPTIONS. No AI agent may click arbitrary controls or perform writes.

### Run recordings

After merging the implementation, GitHub Actions > **Record Real ERP Training Videos (Disposable Data)** > Run workflow > select a topic or all. The workflow installs Chrome, ffmpeg and the offline Piper narration voice (`en_US-lessac-medium`, verified by SHA-256 pins), builds the app, prepares disposable ERP and Factory companies, and records one narrated tour per topic. Each tour walks through **every control** on the page: every tab in the main area (including nested tab strips), every button, dropdown, field and section heading each tab reveals, and the **hidden controls** inside the menus, dropdown lists and dialogs those buttons open, which the recorder opens one by one. The shared top bar and sidebar are explained once, in the overview video of each mode (`factory-overview`, `erp-tracking`), so the other videos do not repeat them. A pointer composited at the full frame rate glides to the control being explained, which is outlined on screen, while a spoken sentence (generated deterministically from the control's real label, role and state by `scripts/training-narration.mjs`, then voiced locally by `scripts/training-narration-tts.py`) explains what it does. Safe demonstrations show what a control does: typing a sample value into a search box, opening a menu or list, and choosing one entry from an opened list (for example an account in a voucher line or a record in an import dialog); every demonstration is undone by clearing the text, closing the layer or reloading the untouched page. Buttons that would print, export, download, delete, save or post are explained but never pressed. Videos are Windows-friendly H.264 + AAC MP4 files between 1 and 20 minutes long, with matching WebVTT captions and a Markdown transcript. The workflow validates their full decode and the duration ceiling, and produces a review artifact. The generated artifact expires after 30 days and is **not** a publishing destination.

Each completed topic output includes:
- `screen.mp4`: validated H.264/yuv420p video (35–60 seconds) with five on-screen instructional steps, playable in standard Windows players.
- `screenshot.png`: screenshot from the training session.
- `captions.vtt`: captions and timing.
- `guide.md`: workflow documentation.
- `report.json`: recording status for all selected topics.

### Automatic nightly publication

The **Nightly ERP Training Audit** publishes by itself. After the `record` job uploads its artifact, the `publish` job in the same run:

1. Downloads that run's own artifact and re-validates every topic captured from the audited `main` commit with `scripts/validate-training-recording.mjs`: report status, source commit, the four files, WebVTT captions, numbered guide steps, and a full decode of the MP4 as H.264/yuv420p with an AAC narration track between 1 and 20 minutes.
2. Obtains a GitHub OIDC identity in the `training-publication` environment and asks the Vercel gateway for one signed PUT per immutable object (`training/videos/{topic}/{commit}.mp4|.vtt|.png`). No storage token exists in GitHub.
3. Reads the current manifest (`training/manifest/current.json`) back through the gateway, replaces each re-recorded topic with tonight's recording, keeps every other topic, and overwrites the manifest. Earlier files stay in private storage for rollback.
4. Opens a GitHub issue listing what was recorded and whether publication succeeded.

The ERP picks the new manifest up within about a minute; no pull request, merge or deploy is involved. Playback still goes through the authenticated `/api/training/media/:topic` routes, which check the active company and page permission before signing a short-lived read.

**Rolling back or publishing one topic by hand:** run **Approve & Publish ERP Training Video** with the recording run ID and one topic. It validates the same way, then uploads that topic and updates the manifest. The `training-publication` environment must have `TRAINING_PUBLICATION_APPROVAL_ENABLED=true`, a `main` branch restriction, and **no required reviewers**, otherwise the nightly publish job waits for a click that never comes.

The build-time file `shared/publishedTrainingMedia.json` is only the fallback used when `TRAINING_MEDIA_PROVIDER` is not `vercel`.

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

## Expanded nightly ERP / Factory system regression (PR #2811)

The nightly audit also invokes `.github/workflows/nightly-system-regression.yml` with **four independent test areas** plus a separate coverage comparison:

1. **Backend and database:** runs every test file selected by the repository's backend Vitest configuration, including real PostgreSQL integration scenarios for ERP, Factory and connected business modules, with existing coverage thresholds.
2. **Frontend:** runs all registered frontend Vitest suites and browser offline/IndexedDB isolation checks, including UI and mobile component tests.
3. **Rendered pages:** logs in to separate synthetic ERP and Factory companies and visits registered ERP and Factory pages on phone and desktop; runs language smoke checks, seeded Factory detail routes, and layout checks. These are view/navigation checks, not automatic page writes.
4. **Security and data-contract audits:** runs company-scope, write-route, write-evidence, inventory-contract and migration audits. It saves a module-by-module test file inventory at `artifacts/nightly-system-coverage/inventory.json`.
5. **Measured coverage comparison:** fetches both Vitest coverage summaries and runs the existing coverage ratchet. Missing, failed or unregistered tests are not treated as passing.

The scheduled parent workflow also retains the **separate synthetic transaction and reconciliation job** described above. Any failed transaction or whole-system job opens a GitHub issue with links to the test artifacts. All records remain in temporary PostgreSQL services; no real customer, supplier, employee, stock or financial data is imported.

**Limits / further implementation needed:** A full existing test-suite run is not equivalent to having automated create/edit/delete/reversal scenarios for every individual action. The disposable transaction scenarios explicitly verified today cover POS, stock transfers, journal vouchers, Supplier Partner sales, and raw-container offload/reversal. Payroll, production bonuses, invoicing, rentals, scanner workflows, deposits and other specialized write paths depend on whatever regression tests already exist; adding new cross-module posted-transaction tests for each of them remains separate engineering work. The inventory calls these gaps out instead of asserting 100% coverage.

The existing `trainingCatalog` and 16 readonly capture tours are not automatically extended to every new application page. Recordings continue to require human approval before publication; the nightly system regression job **never publishes**, edits production, or changes business balances.
