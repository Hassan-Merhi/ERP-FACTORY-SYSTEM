# Automated nightly ERP & Factory training

**Status:** A guarded implementation on the `feature/embedded-training-library-recorder` branch. It cannot run nightly until merged into `main`; it cannot publish privately until storage and approval settings are provisioned. No laptop or user-side agent is required.

## Design and operation

1. GitHub Actions workflow `.github/workflows/nightly-training-audit.yml` runs every night at **02:15 UTC** (04:15 Beirut winter / 05:15 summer) and can also be manually dispatched.
2. `scripts/plan-nightly-training.mjs` compares `main` against the previous **successful nightly run**, not against an arbitrary failed or one-topic manual run. On the first successful run, it records all 16 configured real-UI tours. Subsequent runs classify changed ERP / Factory source files and choose the affected tours; shared code changes conservatively trigger all tours. Unrecognized module files are flagged for human review.
3. If no relevant source changed, the recorder is skipped. A JSON plan remains attached to the run.
4. Otherwise GitHub reuses the `training-videos.yml` workflow. It builds the **actual application**, boots an isolated localhost Postgres test database, seeds disposable ERP and Factory companies, and launches a headless browser with disposable users. The browser records real rendered UI into WebM, captures PNG, VTT captions and a Markdown guide. Only same-origin read requests are allowed during recording; approved UI tab navigation is permitted. **No production company, secrets, balances, stock, payroll, invoices or vouchers are touched.**
5. The workflow uploads a **30-day GitHub Actions artifact** and creates a GitHub issue linking to the review run. A failed recording is reported as a failure, not silently treated as an approved tutorial.
6. A human watches the clip, checks for sensitive information, checks the guide against the current real UI and verifies the functionality shown. Review is explicit; the AI cannot self-approve.
7. The separate manual `publish-training-video.yml` workflow is gated behind the `training-publication` GitHub Environment. Once an approved run ID and individual topic ID are supplied, it validates that the recording came from a successful main-branch training run, uploads WebM, captions and an approved screenshot to **private S3-compatible object storage**, and opens a PR updating `shared/publishedTrainingMedia.json` with the reviewed guide steps. **A maintainer must review and merge that PR and deploy** before the app serves the video, captions, screenshot and approved guide.
8. Inside the ERP and Factory Help & Training pages, authenticated users see only their authorized topics. The video stream resolves through `/api/training/media/:topic`, checks active-company page access server-side, signs a private S3 GET request on the server, supports byte-range seeking, and does not expose object store credentials or public video URLs.

## Mandatory one-time setup (not performed by code)

- Merge the reviewed training-center PR and make sure the Actions workflows are enabled on `main`.
- Provision private S3-compatible durable media storage (Cloudflare R2, AWS S3 or another SigV4-compatible bucket). Keep bucket **private**, with public ACL/access disabled. Use an account limited to the training/video prefix, not business-data buckets.
- In GitHub Settings > Environments, create **`training-publication`**. Add required reviewers and restrict deployment branches to `main`; the workflow will not run successfully without the deliberate environment variable described next. Reviewers must verify the actual video in the recording run **before** approving.
- In that protected environment set **`TRAINING_PUBLICATION_APPROVAL_ENABLED=true`** only after required reviewer rules are configured.
- In protected environment secrets set **`TRAINING_MEDIA_S3_ENDPOINT`**, **`TRAINING_MEDIA_S3_BUCKET`**, **`TRAINING_MEDIA_S3_ACCESS_KEY`**, **`TRAINING_MEDIA_S3_SECRET_KEY`**. Set optional environment variable `TRAINING_MEDIA_S3_REGION` (e.g. `auto` for R2, `us-east-1` for S3).
- On **Render** (for runtime playback), configure the *same* `TRAINING_MEDIA_S3_ENDPOINT`, `TRAINING_MEDIA_S3_BUCKET`, `TRAINING_MEDIA_S3_ACCESS_KEY`, `TRAINING_MEDIA_S3_SECRET_KEY` and `TRAINING_MEDIA_S3_REGION` in protected environment settings. Give the Render credentials **read-only access**, separate from the uploader. No keys should be committed to GitHub or passed to the browser.
- Confirm the published media route can stream a reviewed WebM and VTT with normal employee permissions. Then check unauthorized topic and unauthenticated requests return 403/401.
- Retain the original Markdown guides and reviewed media files in private permanent storage; a GitHub Actions artifact expires and cannot be the permanent library.
- Optionally set GitHub Issues notifications or subscriptions for administrators responsible for training reviews.

## Scope boundaries

- The current recorder is deterministic browser automation, **not** unrestricted generative-AI exploration. It navigates genuine pages and can click an approved read-only tab but it does not autonomously fill complex production forms.
- Only the 16 registered modules have recording tours. Newly added routes that do not match a known tour are flagged for review rather than hallucinating instructions.
- No AI voiceover, speech generation, durable in-app admin approval console, automatic production writes, or publishing without human approval exists yet.
- If GitHub Actions, the test fixture, or private storage are misconfigured, the correct behavior is to stop and report the error rather than touch a real company.
- Site updates require a new deployment; published manifest changes are merged through the normal protected PR process. Video objects are content-addressed by their source SHA.

## Manual operations

Run `Nightly ERP Training Audit` manually for a complete source-based audit, or run `Record Real ERP Training Videos (Disposable Data)` to capture a single approved topic (or `all`). After reviewing the resulting artifact, run `Approve & Publish ERP Training Video` with the completed run ID and individual topic ID. Only the publication workflow has object storage write credentials.

## Tests

The change detector includes `node --test scripts/plan-nightly-training.test.mjs`. The Help & Training catalog includes role filtering tests; the Factory guard has a restricted-user direct-route test. Run the repository type-check, frontend tests and disposable browser recording job before merging. If GitHub CI fails before jobs execute, do **not** treat recording or runtime deployment as verified.
