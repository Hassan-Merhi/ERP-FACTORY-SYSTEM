/**
 * Published training recordings, read from the authenticated ERP at runtime.
 *
 * The nightly audit records changed tours against disposable data, validates
 * the narrated MP4s and publishes them to private storage together with a
 * manifest. The server reads that manifest and exposes the non-sensitive
 * listing at /api/training/media; playback goes through the same authenticated
 * route family, so no storage URL or credential ever reaches the browser.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

export interface PublishedTrainingTopic {
  guideSteps: string[];
  captions: boolean;
  screenshot: boolean;
  sourceSha: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}

export interface PublishedTrainingLibrary {
  provider: "vercel" | "static";
  topics: Record<string, PublishedTrainingTopic>;
}

export interface PublishedTrainingMaps {
  videos: Readonly<Record<string, string>>;
  captions: Readonly<Record<string, string>>;
  guides: Readonly<Record<string, readonly string[]>>;
  screenshots: Readonly<Record<string, string>>;
}

const EMPTY: PublishedTrainingMaps = { videos: {}, captions: {}, guides: {}, screenshots: {} };
const TOPIC_ID = /^[a-z0-9-]{1,80}$/;

/** Turns the server listing into the per-topic playback URLs the page renders. */
export function buildPublishedTrainingMaps(library?: PublishedTrainingLibrary | null): PublishedTrainingMaps {
  if (!library || typeof library !== "object" || !library.topics || typeof library.topics !== "object") return EMPTY;
  const videos: Record<string, string> = {};
  const captions: Record<string, string> = {};
  const guides: Record<string, readonly string[]> = {};
  const screenshots: Record<string, string> = {};
  for (const [topic, entry] of Object.entries(library.topics)) {
    if (!TOPIC_ID.test(topic) || !entry || typeof entry !== "object") continue;
    videos[topic] = "/api/training/media/" + topic;
    if (entry.captions) captions[topic] = "/api/training/media/" + topic + "/captions";
    if (entry.screenshot) screenshots[topic] = "/api/training/media/" + topic + "/screenshot";
    if (Array.isArray(entry.guideSteps) && entry.guideSteps.length > 0) {
      guides[topic] = entry.guideSteps.filter((step) => typeof step === "string" && step.length > 0);
    }
  }
  return { videos, captions, guides, screenshots };
}

export function usePublishedTrainingMedia(): PublishedTrainingMaps & { loading: boolean } {
  const { selectedCompany } = useCompany();
  const { data, isLoading } = useQuery<PublishedTrainingLibrary>({
    // The server filters the listing by the active company's page access.
    queryKey: companyQueryKey("/api/training/media", selectedCompany?.id),
    staleTime: 60_000,
    retry: 1,
  });
  const maps = useMemo(() => buildPublishedTrainingMaps(data), [data]);
  return { ...maps, loading: isLoading };
}
