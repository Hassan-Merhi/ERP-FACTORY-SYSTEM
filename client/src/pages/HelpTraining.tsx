import { useMemo, useState } from "react";
import { Link } from "wouter";
import { BookOpen, ChevronRight, CirclePlay, Clapperboard, FileText, Search, ShieldCheck, Video } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import type { TrainingMode, TrainingTopic } from "@/training/trainingCatalog";
import { usePublishedTrainingMedia } from "@/training/publishedVideos";

interface Props {
  mode: TrainingMode;
  /** Guides for the pages this user can open, built from their own navigation. */
  topics: readonly TrainingTopic[];
}

const WORKSPACE: Record<TrainingMode, { label: string; home: string }> = {
  erp: { label: "ERP", home: "/tracking" },
  factory: { label: "Factory", home: "/factory/production-report" },
  properties: { label: "Properties", home: "/properties/rentals" },
  pos: { label: "POS", home: "/pos" },
};

export default function HelpTraining({ mode, topics }: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All topics");
  const {
    videos: publishedTrainingVideos,
    captions: publishedTrainingCaptions,
    guides: publishedTrainingGuides,
    screenshots: publishedTrainingScreenshots,
  } = usePublishedTrainingMedia();
  const visible = topics;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return visible.filter((topic) => {
      const text = [topic.title, topic.description, topic.category, ...(topic.keywords ?? []), ...(topic.tabs ?? [])]
        .join(" ")
        .toLowerCase();
      return (category === "All topics" || category === topic.category) && (!term || text.includes(term));
    });
  }, [visible, search, category]);
  const [selectedId, setSelectedId] = useState("welcome");
  const active = filtered.find((topic) => topic.id === selectedId) ?? filtered[0];
  const categories = ["All topics", ...new Set(visible.map((topic) => topic.category))];
  const home = WORKSPACE[mode].home;
  const videoUrl = active ? publishedTrainingVideos[active.id] : undefined;
  const supportedVideo = videoUrl && videoUrl.startsWith("/api/training/media/");
  const [failedVideo, setFailedVideo] = useState<string | null>(null);
  const videoFailed = Boolean(videoUrl) && failedVideo === videoUrl;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-5 sm:px-7" data-testid="help-training">
      <PageHeader
        title="Help & Training"
        subtitle={
          <>
            Step-by-step guides for the {WORKSPACE[mode].label} pages you have access to. Narrated recordings of each
            screen appear alongside the guide once the nightly recorder has captured it.
          </>
        }
      >
        <Link href={home} className="rounded-lg border px-3 py-2 text-sm hover:bg-muted">
          Return to {WORKSPACE[mode].label}
        </Link>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <BookOpen className="mb-2 h-5 w-5 text-primary" />
          <div className="text-2xl font-bold">{visible.length}</div>
          <p className="text-xs text-muted-foreground">Available guides</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <Video className="mb-2 h-5 w-5 text-primary" />
          <div className="text-2xl font-bold">
            {visible.filter((t) => Boolean(publishedTrainingVideos[t.id])).length}
          </div>
          <p className="text-xs text-muted-foreground">Published real-screen videos</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <ShieldCheck className="mb-2 h-5 w-5 text-primary" />
          <div className="text-sm font-semibold">Safe demonstrations</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Recordings use disposable training data, not live transactions.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setCategory(value)}
            className={
              "rounded-full border px-3 py-1.5 text-xs font-medium transition " +
              (category === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")
            }
            aria-pressed={category === value}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <input
          aria-label="Search training guides"
          data-testid="training-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search pages, workflows, stock, payroll, vouchers..."
          className="h-10 w-full rounded-lg border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <nav
          aria-label="Training topics"
          className="max-h-[620px] space-y-2 overflow-y-auto rounded-xl border bg-card p-3"
        >
          {filtered.length === 0 && <p className="p-4 text-sm text-muted-foreground">No guides match this search.</p>}
          {filtered.map((topic) => (
            <button
              type="button"
              key={topic.id}
              onClick={() => setSelectedId(topic.id)}
              data-testid={"training-topic-" + topic.id}
              className={
                "w-full rounded-lg border p-3 text-left transition hover:bg-muted " +
                (active?.id === topic.id ? "border-primary bg-primary/5" : "border-transparent")
              }
            >
              <div className="flex items-start gap-2">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{topic.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{topic.category}</span>
                </div>
                <ChevronRight className="mt-1 h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </button>
          ))}
        </nav>

        {active ? (
          <article className="min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-6" data-testid="training-article">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-primary">{active.category}</div>
              <h2 className="mt-2 text-xl font-bold">{active.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{active.description}</p>
            </div>
            <div className="overflow-hidden rounded-xl border bg-muted/30">
              {supportedVideo && videoFailed ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center">
                  <Clapperboard className="h-10 w-10 text-muted-foreground" />
                  <p className="font-semibold">This video could not be played here</p>
                  <a
                    className="text-sm font-medium text-primary underline"
                    href={videoUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the video in a new tab
                  </a>
                </div>
              ) : supportedVideo ? (
                <video
                  key={videoUrl}
                  className="aspect-video w-full bg-black"
                  controls
                  playsInline
                  preload="metadata"
                  poster={publishedTrainingScreenshots[active.id]}
                  aria-label={"Training video: " + active.title}
                  data-testid="training-video"
                  onError={() => setFailedVideo(videoUrl ?? null)}
                >
                  <source src={videoUrl} type="video/mp4" onError={() => setFailedVideo(videoUrl ?? null)} />
                  {publishedTrainingCaptions[active.id] && (
                    <track
                      kind="captions"
                      src={publishedTrainingCaptions[active.id]}
                      srcLang="en"
                      label="English"
                      default
                    />
                  )}
                </video>
              ) : (
                <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center">
                  <Clapperboard className="h-10 w-10 text-muted-foreground" />
                  <p className="font-semibold">Real-system video not yet published</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    The written guide is available now. The nightly recorder adds a narrated video of this screen the
                    next time it records this page.
                  </p>
                </div>
              )}
            </div>
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <CirclePlay className="h-4 w-4 text-primary" />
                Step-by-step instructions
              </h3>
              <ol className="mt-3 space-y-3">
                {(publishedTrainingGuides[active.id] ?? active.steps).map((step, i) => (
                  <li className="flex items-start gap-3 text-sm" key={i}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {i + 1}
                    </span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
            {active.tabs && active.tabs.length > 0 && (
              <div className="space-y-2" data-testid="training-tabs">
                <h3 className="text-base font-semibold">Tabs on this page you can open</h3>
                <div className="flex flex-wrap gap-2">
                  {active.tabs.map((tab) => (
                    <span key={tab} className="rounded-full border bg-muted/40 px-3 py-1 text-xs">
                      {tab}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {publishedTrainingScreenshots[active.id] && (
              <div className="space-y-2">
                <h3 className="text-base font-semibold">Actual training-system screenshot</h3>
                <img
                  src={publishedTrainingScreenshots[active.id]}
                  alt={"Verified training screenshot: " + active.title}
                  loading="lazy"
                  className="max-h-[480px] w-full rounded-lg border object-contain"
                />
              </div>
            )}
            {active.route && (
              <Link
                href={active.route}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold hover:bg-muted"
              >
                Open this page <ChevronRight className="h-4 w-4" />
              </Link>
            )}
            <p className="text-xs text-muted-foreground">
              Guides describe current navigation; verify your permissions and actual screen before entering data.
            </p>
          </article>
        ) : (
          <div className="rounded-xl border p-8 text-sm text-muted-foreground">Select a guide to begin.</div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Training videos are recorded automatically from a disposable training company, never from live data. No screen
        recording is running from this page.
      </p>
    </main>
  );
}
