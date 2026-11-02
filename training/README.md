# ERP & Factory Help and Training Center

## What is included

- The authenticated ERP route is `/help-training`.
- The authenticated Factory route is `/factory/help-training`.
- Both sidebars link to the Help & Training center.
- Guides cover existing navigation and workflows; the same page never modifies business data.
- Generic help content is filtered by the current user page permissions.
- Video players only appear for explicitly published, reviewed media; empty slots explain that no video has been published.

## Recording real software, not a generated mock-up

The supported recording runner is `scripts/record-training-guides.mjs`. It signs into **the actual application built from the repository** and opens registered read-only UI tours, records the browser with Puppeteer, captures a screenshot, and creates a Markdown guide plus WebVTT captions.

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
4. Add the reviewed URL under the matching topic ID in `client/src/training/publishedVideos.ts` via code review. Signed, expiring media URLs should be resolved by an authenticated backend in a later integration, not hard-coded into the frontend.
5. Verify streaming playback and role access before publishing the change. Add transcripts/captions alongside the media via your storage integration.
6. Rerecord videos when relevant workflows or screenshots change.

This is the **initial foundation**. Full AI-discovered multi-step write simulations, voice narration, an admin uploader and durable private streaming storage are **not implemented** by this change. Add those only after credentials, a persistent media store and a reviewed sample company are provisioned. Until then the library honestly marks videos as unpublished.

## Security and reliability

- Never automate real stock movements, invoices, vouchers, bonuses or payroll in production.
- Do not put login details, tokens, live financial records, personally identifiable information or restricted business details in a guide or video artifact.
- Access filtering in the client is for navigation only; do not store secret documentation in the static frontend bundle.
- The destination page retains its original server and page permissions.
- Real action tutorials must be recorded against isolated throwaway test data with explicit assertions of expected outcomes and reviewed before release.
