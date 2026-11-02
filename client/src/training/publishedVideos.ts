/**
 * Reviewed, permanently hosted training screencasts only.
 * Do not link expiring CI artifacts, user sessions, or unreviewed recordings.
 * After sandbox recording, upload approved videos to durable private media
 * storage and add their authenticated playback URLs through the publishing flow.
 */
export const publishedTrainingVideos: Readonly<Record<string, string>> = {};
