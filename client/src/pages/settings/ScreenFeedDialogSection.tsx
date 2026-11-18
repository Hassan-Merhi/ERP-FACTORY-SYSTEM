// Extracted from ./RemoteSupportWatchDialog.tsx to keep that module under the source-size cap.
import { CheckCircle2, Clock3, History, Maximize2, Monitor, RefreshCw, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportScreenFeedFrameRendered } from "@/lib/screen-feed-binary-transport";
import { getPageLabel } from "./WatchUserDialog";
import { useScreenFeedDialogState } from "./useScreenFeedDialogState";

export function ScreenFeedDialogSection({
  bindViewer,
  connected,
  displayMode,
  fmtTime,
  frame,
  groupedActivity,
  openNativeFullscreen,
  refetchTabs,
  selectedTab,
  selectedTabId,
  setDisplayMode,
  t,
  username,
  viewerSurfaceRef,
}: Pick<
  ReturnType<typeof useScreenFeedDialogState>,
  | "bindViewer"
  | "connected"
  | "displayMode"
  | "fmtTime"
  | "frame"
  | "groupedActivity"
  | "openNativeFullscreen"
  | "refetchTabs"
  | "selectedTab"
  | "selectedTabId"
  | "setDisplayMode"
  | "t"
  | "username"
  | "viewerSurfaceRef"
>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 lg:flex-row lg:gap-4 lg:p-4">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-[#091523] shadow-[0_8px_32px_rgba(0,0,0,0.24)]">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 lg:px-4">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className={`h-2 w-2 rounded-full ${frame ? "bg-emerald-400" : "bg-amber-400"}`} />
            <span>{t("Live screen")}</span>
            <span className="hidden text-xs font-medium text-emerald-300 sm:inline">
              {frame ? t("Streaming") : connected ? t("Preparing frame…") : t("Connecting…")}
            </span>
            {frame?.capturedAt ? (
              <span className="hidden items-center gap-1 text-[11px] font-normal text-slate-400 md:inline-flex">
                <Clock3 className="h-3 w-3" /> {fmtTime(frame.capturedAt)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => {
                void refetchTabs();
                bindViewer();
              }}
              title={t("Refresh")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="ml-1.5 hidden sm:inline">{t("Refresh")}</span>
            </Button>
            <Button
              size="sm"
              variant={displayMode === "fit" ? "default" : "outline"}
              className="h-8 px-2.5"
              onClick={() => setDisplayMode("fit")}
              data-testid="button-feed-fit"
            >
              <Monitor className="mr-1.5 h-3.5 w-3.5" />
              {t("Fit")}
            </Button>
            <Button
              size="sm"
              variant={displayMode === "actual" ? "default" : "outline"}
              className="h-8 px-2.5"
              onClick={() => setDisplayMode("actual")}
              data-testid="button-feed-actual"
            >
              <ZoomIn className="mr-1.5 h-3.5 w-3.5" />
              100%
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-slate-700 bg-slate-900 px-2.5 text-slate-100"
              onClick={openNativeFullscreen}
              data-testid="button-fullscreen-feed"
              disabled={!frame?.imageUrl}
              aria-label={t("Full Screen")}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div
          ref={viewerSurfaceRef}
          className={`relative flex min-h-[38vh] min-w-0 flex-1 bg-black ${displayMode === "fit" ? "items-center justify-center overflow-hidden" : "items-start justify-start overflow-auto"}`}
          data-testid="screen-feed-viewport"
        >
          {frame?.imageUrl ? (
            <img
              src={frame.imageUrl}
              alt={`${t("Live screen for")} ${username}`}
              className={displayMode === "fit" ? "h-full w-full object-contain" : "max-h-none max-w-none object-none"}
              draggable={false}
              onLoad={() => reportScreenFeedFrameRendered(frame.capturedAt, selectedTabId)}
              data-testid="img-screen-feed"
              data-frame-viewport-width={frame.viewport?.width ?? ""}
              data-frame-viewport-height={frame.viewport?.height ?? ""}
              data-frame-viewport-scroll-x={frame.viewport?.scrollX ?? ""}
              data-frame-viewport-scroll-y={frame.viewport?.scrollY ?? ""}
              data-frame-viewport-visual-scale={frame.viewport?.visualScale ?? ""}
              data-frame-captured-at={frame.capturedAt}
            />
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900 text-slate-400">
                <Monitor className="h-8 w-8" />
              </div>
              <p className="text-sm font-semibold text-slate-200">
                {selectedTabId ? t("Preparing live screen…") : t("Waiting for an active ERP tab…")}
              </p>
              <p className="text-xs text-slate-500">
                {selectedTabId ? t("Waiting for the first binary frame from this ERP tab…") : t("No active tabs")}
              </p>
              <RefreshCw className="h-4 w-4 animate-spin text-blue-400" aria-hidden="true" />
            </div>
          )}
        </div>
      </section>

      <aside
        className="flex max-h-[30vh] min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto lg:max-h-none lg:w-[330px] lg:overflow-hidden xl:w-[352px]"
        data-testid="screen-feed-activity-panel"
      >
        <div className="shrink-0 rounded-xl border border-slate-700/80 bg-[#112139] p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-blue-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold">{t("Mouse & keyboard control")}</h3>
          </div>
          <div data-screen-feed-control-slot className="mt-2" data-screenfeed-ignore="true" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-[#0d1b30]">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700/60 px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4 text-blue-300" />
              {t("Recent activity")}
            </h3>
            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
              {t("Live")}
            </span>
          </div>
          {selectedTab ? (
            <div className="shrink-0 border-b border-slate-700/60 bg-blue-700/15 px-4 py-2.5">
              <p className="text-[11px] text-slate-400">{t("Selected tab")}</p>
              <p className="truncate text-sm font-semibold text-blue-100">{getPageLabel(selectedTab.route)}</p>
            </div>
          ) : null}
          <div
            className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-sm"
            data-testid="screen-feed-activity-list"
          >
            {groupedActivity.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-400">{t("No history yet.")}</p>
            ) : (
              groupedActivity.map((event, index) => (
                <div
                  key={`${event.id}-${event.route}`}
                  className={`relative flex items-center gap-2.5 rounded-lg px-2 py-2 ${index === 0 ? "bg-blue-700/30 text-white" : "text-slate-300"}`}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${index === 0 ? "bg-blue-400 ring-4 ring-blue-500/15" : "bg-slate-600"}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{getPageLabel(event.route)}</span>
                  {event.count > 1 ? (
                    <span className="shrink-0 rounded bg-slate-700/80 px-1.5 py-0.5 text-[10px]">×{event.count}</span>
                  ) : null}
                  <time className="shrink-0 text-[11px] text-slate-400" dateTime={event.occurredAt}>
                    {fmtTime(event.occurredAt)}
                  </time>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
