import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  Clock,
  Eye,
  History,
  Maximize2,
  Monitor,
  MousePointer2,
  RefreshCw,
  Wifi,
  WifiOff,
  ZoomIn,
} from "lucide-react";
import { formatScreenFeedDelay } from "./screen-feed-viewer-layout";
import { useWatchUserDialogModel } from "./WatchUserDialogModel";

export function getPageLabel(route: string): string {
  if (!route || route === "/") return "Dashboard";
  const routeLabels: Record<string, string> = {
    "/": "Dashboard",
    "/dashboard": "Dashboard",
    "/locations": "Locations",
    "/locations/inventory": "Location Inventory",
    "/stock-items": "Stock Items",
    "/stock-groups": "Stock Groups",
    "/ledger-accounts": "Ledger Accounts",
    "/vouchers": "Vouchers",
    "/vouchers/payment": "Payment Vouchers",
    "/vouchers/receipt": "Receipt Vouchers",
    "/vouchers/journal": "Journal Vouchers",
    "/vouchers/sales": "Sales Vouchers",
    "/purchase-orders": "Purchase Orders",
    "/containers": "Containers",
    "/containers/otw": "Containers OTW",
    "/employees": "Employees",
    "/customers": "Customers",
    "/suppliers": "Suppliers",
    "/bank-accounts": "Bank Accounts",
    "/reports": "Reports",
    "/reports/profit-loss": "Profit & Loss",
    "/reports/balance-sheet": "Balance Sheet",
    "/settings": "Settings",
    "/pos": "Point of Sale",
    "/pos/sales": "POS Sales",
    "/pos-transfer-orders": "POS Transfer Orders",
    "/chatbot": "AI Chatbot",
    "/deleted-items": "Deleted Items",
  };
  if (routeLabels[route]) return routeLabels[route];
  return route
    .replace(/^\//, "")
    .replace(/-/g, " ")
    .replace(/\//g, " > ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface ScreenFeedCursor {
  x: number;
  y: number;
  ts: number;
  visible: boolean;
}

interface ScreenFeedViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
  devicePixelRatio: number;
  visualScale: number;
}

interface ScreenFeedCapture {
  width: number;
  height: number;
  source: "dom" | "retry" | "fallback";
  quality: number;
  encodedBytes: number;
  durationMs: number;
  failureReason?: string | null;
}

export interface ScreenFrame {
  dataUrl: string;
  capturedAt: string;
  receivedAt?: string;
  clientCapturedAt?: string | null;
  username: string;
  clicks: Array<{ x: number; y: number; label: string; ts: number }>;
  cursor?: ScreenFeedCursor | null;
  viewport?: ScreenFeedViewport | null;
  capture?: ScreenFeedCapture | null;
}

export interface ActivityEvent {
  id: string | number;
  route: string;
  occurredAt: string;
}

interface GroupedActivityEvent extends ActivityEvent {
  count: number;
  firstOccurredAt: string;
}

export type DisplayMode = "fit" | "actual";
export type RecoveryState = "live" | "delayed" | "recovering" | "fallback" | "waiting";

const qualityLabels = {
  excellent: "Excellent",
  good: "Good",
  delayed: "Delayed",
  stale: "Stale",
  waiting: "Waiting",
} as const;

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function groupConsecutiveActivity(activity: ActivityEvent[]): GroupedActivityEvent[] {
  const grouped: GroupedActivityEvent[] = [];
  for (const event of activity) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.route === event.route) {
      previous.count += 1;
      previous.firstOccurredAt = event.occurredAt;
      continue;
    }
    grouped.push({ ...event, count: 1, firstOccurredAt: event.occurredAt });
  }
  return grouped;
}

export function WatchUserDialog({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const m = useWatchUserDialogModel({ userId });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="fixed! inset-0! left-0! top-0! translate-x-0! translate-y-0! max-w-none! w-screen! h-screen! rounded-none! p-0 overflow-hidden flex flex-col"
        data-testid="dialog-watch-user"
        data-watched-user-id={String(userId)}
        data-screenfeed-ignore="true"
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0 flex-wrap gap-y-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${m.recoveryState === "live" ? "bg-green-500" : m.recoveryState === "delayed" ? "bg-amber-500" : m.recoveryState === "fallback" ? "bg-red-500" : "bg-muted-foreground/50"}`}
            />
            <span className="text-xs font-semibold uppercase tracking-wide">{m.stateLabel}</span>
          </span>
          <span className="font-semibold text-sm">Watching: {username}</span>
          {m.presence && (
            <span className="text-sm text-muted-foreground">
              · {m.presence.companyName || "Company unavailable"} · {m.presence.role || "—"} · last seen{" "}
              {m.timeAgo(m.presence.lastSeen)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <span
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium"
              data-testid="screen-feed-quality"
            >
              {m.liveConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {qualityLabels[m.quality]}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void m.requestFreshFrame()}
              disabled={m.refreshing || m.isFetchingFrame}
              data-testid="button-request-fresh-frame"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${m.refreshing || m.isFetchingFrame ? "animate-spin" : ""}`} />
              Request fresh frame
            </Button>
            <Button
              size="sm"
              variant={m.displayMode === "fit" ? "default" : "outline"}
              onClick={() => m.setDisplayMode("fit")}
              data-testid="button-feed-fit"
            >
              <Monitor className="h-3.5 w-3.5 mr-1.5" /> Fit
            </Button>
            <Button
              size="sm"
              variant={m.displayMode === "actual" ? "default" : "outline"}
              onClick={() => m.setDisplayMode("actual")}
              data-testid="button-feed-actual"
            >
              <ZoomIn className="h-3.5 w-3.5 mr-1.5" /> 100%
            </Button>
            {m.hasScreen && (
              <Button size="sm" variant="outline" onClick={m.openNativeFullscreen} data-testid="button-fullscreen-feed">
                <Maximize2 className="h-3.5 w-3.5 mr-1.5" /> Full Screen
              </Button>
            )}
          </div>
        </div>

        {(m.streamError || m.frameMetadata.failureReason || m.isFallback) && (
          <div
            className={`px-4 py-2 border-b text-xs flex items-start gap-2 ${m.isFallback ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                {m.isFallback
                  ? "Full page capture failed; a simplified fallback is shown."
                  : "The viewer is recovering the live connection."}
              </p>
              <p className="opacity-90 wrap-break-word">
                {m.frameMetadata.failureReason || m.streamError || "Waiting for the next full frame."}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div ref={m.viewerSurfaceRef} className="flex-1 min-w-0 flex flex-col overflow-hidden bg-black">
            <div
              ref={m.frameViewportRef}
              className={`flex-1 min-h-0 ${m.displayMode === "fit" ? "overflow-hidden flex items-center justify-center" : "overflow-auto flex items-start justify-start"}`}
              data-testid="screen-feed-viewport"
            >
              {m.hasScreen ? (
                <div
                  className="relative shrink-0"
                  style={{ width: m.displaySize.width, height: m.displaySize.height }}
                  data-testid="screen-feed-frame-wrapper"
                >
                  <img
                    src={m.screenFrame.dataUrl}
                    alt="Live screen of user"
                    className="block w-full h-full object-contain select-none"
                    draggable={false}
                    data-testid="img-screen-feed"
                    data-frame-viewport-width={m.screenFrame.viewport?.width ?? ""}
                    data-frame-viewport-height={m.screenFrame.viewport?.height ?? ""}
                    data-frame-viewport-scroll-x={m.screenFrame.viewport?.scrollX ?? ""}
                    data-frame-viewport-scroll-y={m.screenFrame.viewport?.scrollY ?? ""}
                    data-frame-viewport-visual-scale={m.screenFrame.viewport?.visualScale ?? ""}
                    data-frame-captured-at={m.screenFrame.capturedAt}
                  />
                  {m.cursorVisible && m.cursor && (
                    <div
                      className="absolute pointer-events-none drop-shadow-md"
                      style={{
                        left: `${m.cursor.x * 100}%`,
                        top: `${m.cursor.y * 100}%`,
                        transform: "translate(-2px, -2px)",
                      }}
                      data-testid="screen-feed-cursor"
                    >
                      <MousePointer2 className="h-5 w-5 fill-white text-black" />
                    </div>
                  )}
                  {m.recentClicks.map((click, index) => {
                    const opacity = Math.max(0, 1 - (m.tick - click.ts) / 4000);
                    return (
                      <div
                        key={`${click.ts}-${index}`}
                        title={click.label}
                        style={{
                          position: "absolute",
                          left: `${click.x * 100}%`,
                          top: `${click.y * 100}%`,
                          transform: "translate(-50%, -50%)",
                          opacity,
                          pointerEvents: "none",
                        }}
                      >
                        <span className="relative flex h-5 w-5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-5 w-5 bg-orange-500 border-2 border-white" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground m-auto">
                  <Clock className="h-10 w-10 opacity-30" />
                  <p className="text-sm">Waiting for first frame…</p>
                  <p className="text-xs">Live delivery starts as soon as the employee browser responds.</p>
                  {m.tick - m.watchStartRef.current > 10000 && (
                    <Button size="sm" variant="outline" onClick={() => void m.requestFreshFrame()}>
                      Reconnect viewer
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="border-t px-3 py-1.5 shrink-0 bg-background/95 text-xs text-muted-foreground">
              <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
                <span className="font-medium text-foreground">{m.stateLabel}</span>
                <span>Frame age: {Number.isFinite(m.frameAgeMs) ? formatScreenFeedDelay(m.frameAgeMs) : "—"}</span>
                <span>Delivery: {formatScreenFeedDelay(m.transportDelayMs)}</span>
                <span>Capture: {m.frameMetadata.resolution}</span>
                <span>Viewport: {m.frameMetadata.viewport}</span>
                <span>Zoom: {m.frameMetadata.zoom}</span>
                <span>DPR: {m.frameMetadata.dpr}</span>
                <span>Scroll: {m.frameMetadata.scroll}</span>
                <span>Frame: {m.frameMetadata.size}</span>
                <span>Render: {m.frameMetadata.captureTime}</span>
                <span>Source: {m.frameMetadata.source}</span>
              </div>
            </div>

            {m.clicks.length > 0 && (
              <div className="border-t px-3 py-1.5 shrink-0 bg-background/80 backdrop-blur-xs">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide flex items-center gap-1 shrink-0">
                    <Eye className="h-3 w-3" /> Clicks
                  </span>
                  {[...m.clicks]
                    .reverse()
                    .slice(0, 6)
                    .map((click, index) => (
                      <div
                        key={`${click.ts}-${index}`}
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                      >
                        <span className="truncate max-w-[160px]">{click.label || "—"}</span>
                        <span className="text-muted-foreground/50 shrink-0">
                          {new Date(click.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          <div className="w-72 shrink-0 border-l flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b shrink-0">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide flex items-center gap-1">
                <History className="h-3.5 w-3.5" /> Page history
              </p>
            </div>
            {m.isOnline && m.presence?.currentRoute && (
              <div className="px-3 py-2 border-b shrink-0 bg-muted/40">
                <p className="text-xs text-muted-foreground mb-0.5">Currently on</p>
                <p className="text-sm font-semibold truncate">{getPageLabel(m.presence.currentRoute)}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{m.presence.currentRoute}</p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto divide-y text-sm min-h-0">
              {m.groupedActivity.length === 0 ? (
                <p className="text-xs text-muted-foreground px-3 py-3">
                  No history yet — pages appear here as the user navigates.
                </p>
              ) : (
                m.groupedActivity.map((event) => (
                  <div key={`${event.id}-${event.route}`} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="font-medium leading-tight truncate">{getPageLabel(event.route)}</p>
                      {event.count > 1 && (
                        <span className="text-[11px] rounded-full bg-muted px-1.5 py-0.5 shrink-0">×{event.count}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground font-mono truncate">{event.route}</p>
                      <p className="text-xs text-muted-foreground shrink-0">{m.fmtTime(event.occurredAt)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
