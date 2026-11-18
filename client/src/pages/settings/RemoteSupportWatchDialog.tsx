import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Monitor,
  RefreshCw,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translateRemoteSupportPhase5Text } from "@/i18n/remoteSupportPhase5Translations";
import { apiRequest } from "@/lib/queryClient";
import { getPageLabel } from "./WatchUserDialog";
import { useScreenFeedDialogState } from "./useScreenFeedDialogState";
import { ScreenFeedDialogSection } from "./ScreenFeedDialogSection";

interface RemoteSupportRuntime {
  flags?: { screenFeedEnabled?: boolean; fastScreenFeed?: boolean };
}

function ScreenFeedDialog(props: { userId: string; username: string; onClose: () => void; fastMode?: boolean }) {
  const {
    bindViewer,
    captureFailure,
    connected,
    displayMode,
    error,
    fastMode,
    fmtTime,
    frame,
    groupedActivity,
    onClose,
    openNativeFullscreen,
    presence,
    refetchTabs,
    selectedTab,
    selectedTabId,
    setDisplayMode,
    setSelectedTabId,
    t,
    tabListRef,
    tabs,
    userId,
    username,
    viewerSurfaceRef,
  } = useScreenFeedDialogState(props);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="dark fixed! inset-0! left-0! top-0! flex h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! flex-col gap-0! overflow-hidden rounded-none! border-0! bg-[#07111f] p-0! text-slate-100 [&>button.absolute]:hidden"
        data-testid="dialog-watch-user"
        data-watched-user-id={userId}
        data-watched-tab-id={selectedTabId}
        data-screenfeed-ignore="true"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0a1628] px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600/20 text-blue-300">
              <Monitor className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-base font-bold tracking-tight lg:text-lg" data-watch-username={username}>
                  {t("Watching")} {username}
                </h2>
                <span
                  className={`hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:inline-flex ${frame ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/70 text-slate-300"}`}
                  data-testid="screen-feed-connection-badge"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${frame ? "bg-emerald-400" : "bg-amber-400"}`} />
                  {frame ? t("Live") : connected ? t("Connected") : t("Connecting…")}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
                <span>{connected ? t("Binary live feed") : t("Connecting…")}</span>
                {presence?.lastSeen ? (
                  <span>
                    · {t("last seen")} {fmtTime(presence.lastSeen)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {fastMode !== false ? (
              <span className="hidden items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-emerald-300 md:inline-flex">
                <Zap className="h-4 w-4" /> {t("Fast mode")}
              </span>
            ) : null}
            {frame?.viewport ? (
              <span className="hidden items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-300 xl:inline-flex">
                <Monitor className="h-4 w-4 text-blue-300" />
                {frame.viewport.width} × {frame.viewport.height}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label={t("Close viewer")}
              onClick={onClose}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </header>

        <nav
          className="flex min-w-0 shrink-0 items-center gap-2 border-b border-slate-800/80 bg-[#081525] px-3 py-2.5 lg:px-5"
          aria-label={t("ERP tab")}
        >
          <div className="hidden shrink-0 items-center gap-2 pr-2 text-sm font-semibold text-slate-200 sm:flex">
            <Layers3 className="h-4 w-4 text-blue-400" />
            {t("ERP tab")}
          </div>
          <button
            type="button"
            className="hidden h-9 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white sm:flex"
            onClick={() => tabListRef.current?.scrollBy({ left: -320, behavior: "smooth" })}
            aria-label={t("Previous tabs")}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div
            ref={tabListRef}
            className="hidden min-w-0 flex-1 gap-2 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex"
            data-testid="screen-feed-tab-strip"
          >
            {tabs.length === 0 ? <span className="px-3 py-2 text-xs text-slate-400">{t("No active tabs")}</span> : null}
            {tabs.map((tab, index) => (
              <button
                key={tab.tabId}
                type="button"
                onClick={() => setSelectedTabId(tab.tabId)}
                aria-pressed={selectedTabId === tab.tabId}
                data-testid="button-select-remote-tab"
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300 ${selectedTabId === tab.tabId ? "border-blue-400 bg-blue-600/90 text-white shadow-[0_0_0_1px_rgba(96,165,250,0.4)]" : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500 hover:bg-slate-800"}`}
                title={getPageLabel(tab.route)}
              >
                <Monitor className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="max-w-44 truncate">{getPageLabel(tab.route)}</span>
                {tabs.filter((candidate) => candidate.route === tab.route).length > 1 ? (
                  <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px]">#{index + 1}</span>
                ) : null}
              </button>
            ))}
          </div>
          <label className="flex min-w-0 flex-1 items-center sm:hidden">
            <span className="sr-only">{t("ERP tab")}</span>
            <select
              value={selectedTabId}
              onChange={(event) => setSelectedTabId(event.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-blue-600/50 bg-slate-900 px-2 text-sm text-white"
              data-testid="select-remote-support-tab"
            >
              {tabs.length === 0 ? <option value="">{t("No active tabs")}</option> : null}
              {tabs.map((tab, index) => (
                <option value={tab.tabId} key={tab.tabId}>
                  {getPageLabel(tab.route)} #{index + 1}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="hidden h-9 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white sm:flex"
            onClick={() => tabListRef.current?.scrollBy({ left: 320, behavior: "smooth" })}
            aria-label={t("Next tabs")}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </nav>

        {error || captureFailure ? (
          <div
            className="shrink-0 space-y-1 border-b border-amber-500/30 bg-amber-950/40 px-4 py-2 text-xs text-amber-100"
            role="alert"
          >
            {error ? (
              <p className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </p>
            ) : null}
            {captureFailure ? (
              <p className="flex items-center gap-2" data-testid="screen-feed-capture-failure">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t("Screen capture issue")}: {captureFailure.reason}
                {captureFailure.stage ? ` · ${captureFailure.stage}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        <ScreenFeedDialogSection
          bindViewer={bindViewer}
          connected={connected}
          displayMode={displayMode}
          fmtTime={fmtTime}
          frame={frame}
          groupedActivity={groupedActivity}
          openNativeFullscreen={openNativeFullscreen}
          refetchTabs={refetchTabs}
          selectedTab={selectedTab}
          selectedTabId={selectedTabId}
          setDisplayMode={setDisplayMode}
          t={t}
          username={username}
          viewerSurfaceRef={viewerSurfaceRef}
        />
      </DialogContent>
    </Dialog>
  );
}

function RuntimeLoadingDialog({ onClose }: { onClose: () => void }) {
  const { language } = useApplicationLanguage();
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="fixed! inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! p-0 overflow-hidden flex items-center justify-center bg-background"
        data-screenfeed-ignore="true"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> {t("Preparing remote viewer…")}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeDisabledDialog({ onClose }: { onClose: () => void }) {
  const { language } = useApplicationLanguage();
  const t = useCallback((value: string) => translateRemoteSupportPhase5Text(value, language), [language]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="fixed! inset-0! left-0! top-0! h-screen! w-screen! max-w-none! translate-x-0! translate-y-0! rounded-none! p-0 overflow-hidden flex items-center justify-center bg-background"
        data-screenfeed-ignore="true"
      >
        <div className="max-w-md space-y-3 p-6 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
          <p className="font-semibold">{t("Remote screen feed is disabled.")}</p>
          <p className="text-sm text-muted-foreground">
            {t("Enable screen feed in Remote Support settings before opening a viewer.")}
          </p>
          <Button onClick={onClose}>{t("Close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteSupportWatchDialog(props: { userId: string; username: string; onClose: () => void }) {
  const {
    data: runtime,
    isLoading,
    isError,
  } = useQuery<RemoteSupportRuntime>({
    queryKey: ["/api/screen-feed/capabilities"],
    queryFn: () => apiRequest("GET", "/api/screen-feed/capabilities").then((response) => response.json()),
    staleTime: 15000,
    retry: 1,
  });

  if (isLoading) return <RuntimeLoadingDialog onClose={props.onClose} />;
  if (!isError && runtime?.flags?.screenFeedEnabled === false) return <RuntimeDisabledDialog onClose={props.onClose} />;
  return <ScreenFeedDialog {...props} fastMode={runtime?.flags?.fastScreenFeed} />;
}
