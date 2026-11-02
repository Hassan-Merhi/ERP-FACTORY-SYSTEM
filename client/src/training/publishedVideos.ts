/**
 * Reviewed, permanently hosted training screencasts only.
 * Do not link expiring CI artifacts, user sessions, or unreviewed recordings.
 * After sandbox recording, upload approved videos to durable private media
 * storage and add their authenticated playback URLs through the publishing flow.
 */
import media from "@shared/publishedTrainingMedia.json";
type MediaEntry = { videoKey: string; captionsKey?: string; screenshotKey?: string; guideSteps?: string[] };
export const publishedTrainingVideos: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(media as Record<string, MediaEntry>).map(([topic]) => [topic, "/api/training/media/" + topic])
);
export const publishedTrainingGuides: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(media as Record<string, MediaEntry>)
    .filter(([, item]) => Array.isArray(item.guideSteps) && item.guideSteps.length > 0)
    .map(([topic, item]) => [topic, item.guideSteps])
);
export const publishedTrainingScreenshots: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(media as Record<string, MediaEntry>)
    .filter(([, item]) => Boolean(item.screenshotKey))
    .map(([topic]) => [topic, "/api/training/media/" + topic + "/screenshot"])
);
export const publishedTrainingCaptions: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(media as Record<string, MediaEntry>)
    .filter(([, item]) => Boolean(item.captionsKey))
    .map(([topic]) => [topic, "/api/training/media/" + topic + "/captions"])
);
