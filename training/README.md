# ERP & Factory Help and Training Center

## What is included

- The authenticated ERP route is `/help-training`.
- The authenticated Factory route is `/factory/help-training`.
- Both sidebars link to the Help & Training center.
- Guides cover existing navigation and workflows; the same page never modifies business data.
- Generic help content is filtered by the current user page permissions.
- Video players only appear for explicitly published, reviewed media; empty slots explain that no video has been published.

## Recording real software, not a generated mock-up

For the scheduled change detector, review gates and private media setup, see [automation.md](automation.md).\n\nThe supported recording runner is `scripts/record-training-guides.mjs`. It signs into **the actual application built from the repository** and opens registered read-only UI tours, records the browser with Puppeteer, captures a screenshot, and creates a Markdown guide plus WebVTT captions.

The recorder **requires the existing Phase 7 disposable Postgres fixture** on 127.0.0.1:5000, `NODE_ENV=test`, `ERP_E2E_DISPOSABLE_DB=1`, `TRAINING_SANDBOX_VERIFIED=1`, and ephemeral fixture credentials. It refuses public or production URLs. It restricts network traffic during each tour to same-origin GET/HEAD/OPTIONS. No AI agent may click arbitrary controls or perform writes.

### Run recordings

After merging the implementation, GitHub Actions > **Record Real ERP Training Videos (Disposable Data)** > Run workflow > select a topic or all. The workflow installs Chrome/ffmpeg, builds the app, prepares disposable ERP and Factory companies, records real UI clips, and produces a review artifact. The generated artifact expires after 14 days and is **not** a publishing destination.

Each completed topic output includes:
- `screen.webm`: actual rendered UI video with instructional on-screen captions.
- `screenshot.png`: screenshot from the training session.
- `captions.vtt`: captions and timing.
- `guide.md`: workflow documentation.
- `report.json`: recording status for all selected topics.

### Review and publish permanently

1. Check recording success and confirm the video contains only disposable sample data, no private business details, login screens or credentials.
2. Check the instructions against the actual current UI and confirm the recorded page is correct.
3. Upload approved WebM files to authenticated durable training-media storage. Do not serve them from temporary GitHub Action artifacts or an ephemeral Render filesystem.
4. Use the protected **Approve & Publish ERP Training Video** workflow to upload approved video, captions and screenshot to private S3-compatible storage and open a PR updating `shared/publishedTrainingMedia.json` with reviewed guide steps. The app resolves video and caption streams through its authenticated backend, so no direct storage URL is exposed.
5. Verify streaming playback and role access before publishing the change. Add transcripts/captions alongside the media via your storage integration.
6. Rerecord videos when relevant workflows or screenshots change.

This is the **initial foundation**. Nightly detection and automated recording have now been added, while private streaming is available only after storage credentials and an approved published manifest are configured. AI-discovered multi-step write simulations, voice narration and an in-app admin approval console are **not implemented**. Until a reviewed publication PR is merged and deployed, the library marks videos as unpublished.

## Security and reliability

- Never automate real stock movements, invoices, vouchers, bonuses or payroll in production.
- Do not put login details, tokens, live financial records, personally identifiable information or restricted business details in a guide or video artifact.
- Access filtering in the client is for navigation only; private playback also checks active-company page permission on the server. Do not store secret documentation in the static frontend bundle.
- The destination page retains its original server and page permissions.
- Real action tutorials must be recorded against isolated throwaway test data with explicit assertions of expected outcomes and reviewed before release.
