/**
 * Shape of the published training-media manifest that the nightly audit
 * uploads to private storage and the ERP reads at runtime. Every entry points
 * at immutable objects named after the recording's source commit, so a
 * re-recorded tour replaces the entry while the previous files stay available
 * for rollback. Errors carry machine codes, never user-facing text: callers
 * fall back to the last good manifest instead of surfacing them.
 */
export const TRAINING_MANIFEST_KEY = "training/manifest/current.json";
export const TRAINING_TOPIC_ID = /^[a-z0-9-]{1,80}$/;
export const TRAINING_OBJECT_KEY = /^training\/videos\/[a-z0-9-]{1,80}\/[a-f0-9]{40}\.(?:webm|mp4|vtt|png)$/;
export const MAX_TRAINING_MANIFEST_BYTES = 256 * 1024;
export const TRAINING_ROUTE = /^\/[a-z0-9][a-z0-9/_-]{0,119}$/;

export interface PublishedTrainingMedia {
  videoKey: string;
  captionsKey?: string;
  screenshotKey?: string;
  guideSteps?: string[];
  sourceSha?: string;
  publishedAt?: string;
  publishedBy?: string;
  durationSeconds?: number;
  /** Page the recording teaches; playback access follows that page's permission. */
  route?: string;
}

export type PublishedTrainingManifest = Record<string, PublishedTrainingMedia>;

function optionalKey(value: unknown, suffix: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !TRAINING_OBJECT_KEY.test(value) || !value.endsWith(suffix))
    throw new Error("training_manifest.invalid_object_key");
  return value;
}

/**
 * Accepts only well-formed entries and drops nothing silently: a malformed
 * manifest is rejected as a whole so a partial upload never hides topics.
 */
export function parsePublishedTrainingManifest(input: unknown): PublishedTrainingManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("training_manifest.not_an_object");
  const result: PublishedTrainingManifest = {};
  for (const [topic, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!TRAINING_TOPIC_ID.test(topic)) throw new Error("training_manifest.invalid_topic_id");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("training_manifest.invalid_entry");
    const entry = raw as Record<string, unknown>;
    const videoKey = entry.videoKey;
    if (typeof videoKey !== "string" || !TRAINING_OBJECT_KEY.test(videoKey) || !/\.(?:mp4|webm)$/.test(videoKey)) {
      throw new Error("training_manifest.invalid_video_key");
    }
    if (!videoKey.startsWith("training/videos/" + topic + "/"))
      throw new Error("training_manifest.video_key_topic_mismatch");
    const guideSteps = entry.guideSteps;
    if (
      guideSteps !== undefined &&
      (!Array.isArray(guideSteps) ||
        guideSteps.length > 20 ||
        guideSteps.some((step) => typeof step !== "string" || step.length === 0 || step.length > 400))
    ) {
      throw new Error("training_manifest.invalid_guide_steps");
    }
    const sourceSha = entry.sourceSha;
    if (sourceSha !== undefined && (typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceSha)))
      throw new Error("training_manifest.invalid_source_sha");
    const publishedAt = entry.publishedAt;
    if (publishedAt !== undefined && (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))))
      throw new Error("training_manifest.invalid_published_at");
    const publishedBy = entry.publishedBy;
    if (publishedBy !== undefined && (typeof publishedBy !== "string" || !/^[\w.-]{1,80}$/.test(publishedBy)))
      throw new Error("training_manifest.invalid_publisher");
    const durationSeconds = entry.durationSeconds;
    if (
      durationSeconds !== undefined &&
      (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
    ) {
      throw new Error("training_manifest.invalid_duration");
    }
    const route = entry.route;
    if (route !== undefined && (typeof route !== "string" || !TRAINING_ROUTE.test(route)))
      throw new Error("training_manifest.invalid_route");
    result[topic] = {
      videoKey,
      route: route as string | undefined,
      captionsKey: optionalKey(entry.captionsKey, ".vtt"),
      screenshotKey: optionalKey(entry.screenshotKey, ".png"),
      guideSteps: guideSteps as string[] | undefined,
      sourceSha: sourceSha as string | undefined,
      publishedAt: publishedAt as string | undefined,
      publishedBy: publishedBy as string | undefined,
      durationSeconds: durationSeconds as number | undefined,
    };
  }
  return result;
}
