/**
 * Physical barcode verification for a single truck dispatch (Option A).
 * Camera and USB scanners feed the same queued, server-validated endpoint.
 * No writes to the original order or inventory occur on this page.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Package,
  ScanLine,
  Search,
  ShieldCheck,
  Trash2,
  Weight,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MobileBarcodeScanner, type CameraScanFeedback } from "@/components/MobileBarcodeScanner";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

type DispatchStatus = "OPEN" | "CLOSED" | "CANCELLED";

interface DispatchScan {
  id: number | string;
  dispatchId: number | string;
  orderId: number;
  baleId: number;
  baleReference: string;
  articleCode?: string | null;
  productName?: string | null;
  weightKg: string | number;
  scannedByUsername: string;
  scannedAt: string;
  removedAt?: string | null;
  removedByUserId?: string | null;
  removalReason?: string | null;
  stillInLoading: boolean;
}

interface ScanHistoryResponse {
  orderId: number;
  dispatchId: number;
  status: DispatchStatus;
  activeCount: number;
  activeWeightKg: number;
  scans: DispatchScan[];
}
interface DispatchScanError extends Error {
  code?: string;
  previous?: {
    baleReference?: string;
    scannedByUsername?: string;
    dispatchNumber?: number;
    scannedAt?: string;
  } | null;
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: DispatchStatus;
  role: string;
  onChanged: () => void;
}

const PAGE_CHUNK = 100;
const MAX_PENDING = 50;

function scanError(error: unknown): { type: CameraScanFeedback["type"]; message: string } {
  const problem = error as DispatchScanError | null;
  const type: CameraScanFeedback["type"] =
    problem?.code === "DISPATCH_DUPLICATE"
      ? "duplicate"
      : problem?.code === "DISPATCH_NOT_IN_LOADING" || problem?.code === "DISPATCH_AMBIGUOUS_BARCODE"
        ? "warn"
        : "error";
  const prior = problem?.previous;
  const detail =
    type === "duplicate" && prior
      ? "Trip #" + prior.dispatchNumber + " · " + (prior.scannedByUsername || "Previous scanner")
      : null;
  return { type, message: detail || problem?.message || "Could not verify this bale" };
}

function fmtCount(n: number): string {
  return n.toLocaleString();
}
function fmtKg(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function FactoryLoadingDispatchScanner({
  orderId,
  dispatchId,
  companyId,
  status,
  role,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const { formatDisplayDateTime } = useDateFormat();
  const baseUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const scansUrl = baseUrl + "/scans";
  const scanKey = companyQueryKey(scansUrl, companyId);
  const loadingListKey = companyQueryKey("/api/factory/customer-orders/" + orderId + "/loading-dispatches", companyId);
  const writable = status === "OPEN" && !["view only", "create only"].includes(role.toLowerCase());
  const canCorrect = status === "OPEN" && ["admin", "owner", "developer"].includes(role.toLowerCase());

  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<string[]>([]);
  const processingRef = useRef(false);
  const [scanText, setScanText] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [feedback, setFeedback] = useState<CameraScanFeedback | null>(null);
  const [filterText, setFilterText] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_CHUNK);
  const [removedVisible, setRemovedVisible] = useState(false);
  const [correction, setCorrection] = useState<DispatchScan | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correcting, setCorrecting] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery<ScanHistoryResponse>({
    queryKey: scanKey,
    queryFn: async () => {
      const res = await fetch(scansUrl, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Unable to load dispatch scan history");
      }
      return res.json() as Promise<ScanHistoryResponse>;
    },
    enabled: Boolean(companyId) && orderId > 0 && dispatchId > 0,
    refetchInterval: 5000,
  });

  const scans = useMemo(() => data?.scans ?? [], [data?.scans]);
  const active = useMemo(() => scans.filter((item) => !item.removedAt), [scans]);
  const corrected = useMemo(() => scans.filter((item) => Boolean(item.removedAt)), [scans]);
  const filtered = useMemo(() => {
    const term = filterText.trim().toLocaleLowerCase();
    if (!term) return active;
    return active.filter((item) =>
      [item.baleReference, item.articleCode ?? "", item.productName ?? "", item.scannedByUsername].some((text) =>
        text.toLocaleLowerCase().includes(term)
      )
    );
  }, [active, filterText]);
  const visibleScans = filtered.slice(0, visibleCount);

  const flushQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (pendingRef.current.length) {
        const code = pendingRef.current.shift()!;
        setPendingCount(pendingRef.current.length + 1);
        try {
          const response = await apiRequest("POST", scansUrl, { scanCode: code });
          const item: {
            baleReference?: string;
            articleCode?: string;
            weightKg?: string | number;
            status?: string;
            warningMessage?: string;
          } = await response.json();
          setFeedback({
            type: item.status === "REVIEW_REQUIRED" ? "warn" : "success",
            referenceNumber: item.baleReference || code,
            message:
              item.warningMessage ||
              "Verified for this truck · " +
                (item.articleCode || "Bale") +
                " · " +
                fmtKg(Number(item.weightKg ?? 0)) +
                " kg",
          });
          // Refetch the saved facts; we never count an unconfirmed scan.
          void queryClient.invalidateQueries({ queryKey: scanKey });
          void queryClient.invalidateQueries({ queryKey: loadingListKey });
          onChanged();
        } catch (error) {
          const resolved = scanError(error);
          setFeedback({ type: resolved.type, referenceNumber: code, message: resolved.message });
          if (resolved.type !== "duplicate") {
            toast({ title: "Bale not verified", description: resolved.message, variant: "destructive" });
          }
          if ((error as DispatchScanError)?.code === "DISPATCH_NOT_OPEN") {
            pendingRef.current = [];
            onChanged();
          }
        } finally {
          setPendingCount(pendingRef.current.length);
        }
      }
    } finally {
      processingRef.current = false;
      setPendingCount(0);
    }
  }, [scansUrl, scanKey, loadingListKey, onChanged, toast]);

  const submitBarcode = useCallback(
    (code: string) => {
      if (!writable) return;
      const value = code.trim();
      if (!value) return;
      if (value.length > 120) {
        setFeedback({
          type: "error",
          referenceNumber: value.slice(0, 120),
          message: "Bale barcode exceeds 120 characters",
        });
        return;
      }
      if (pendingRef.current.length >= MAX_PENDING) {
        setFeedback({
          type: "warn",
          referenceNumber: value,
          message: "Scanner queue full. Check network connectivity.",
        });
        return;
      }
      pendingRef.current.push(value);
      setPendingCount(pendingRef.current.length + (processingRef.current ? 1 : 0));
      void flushQueue();
    },
    [writable, flushQueue]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = scanText;
    setScanText("");
    submitBarcode(value);
    inputRef.current?.focus();
  };

  const removeScan = async () => {
    if (!correction || !canCorrect || correcting) return;
    const reason = correctionReason.trim();
    if (reason.length < 3 || reason.length > 500) return;
    setCorrecting(true);
    try {
      await apiRequest("POST", scansUrl + "/" + correction.id + "/remove", { reason });
      setCorrection(null);
      setCorrectionReason("");
      void queryClient.invalidateQueries({ queryKey: scanKey });
      void queryClient.invalidateQueries({ queryKey: loadingListKey });
      onChanged();
      toast({ title: "Dispatch scan corrected", description: "The previous scan stays in permanent history." });
    } catch (error) {
      toast({
        title: "Unable to correct scan",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCorrecting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="dispatch-verification-scanner">
      <Card className="border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[#101c34]">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold">
                <ScanLine className="h-5 w-5 text-blue-500" /> Truck barcode verification
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Scan the exact reference of each bale entering this truck. This does not change main loading.
              </p>
            </div>
            <Badge
              variant="outline"
              className={writable ? "border-emerald-400 text-emerald-700 dark:text-emerald-300" : ""}
            >
              {status === "OPEN" ? "Trip open" : "Trip read-only"}
            </Badge>
          </div>
          {writable && (
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <ScanLine className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={scanText}
                  onChange={(event) => setScanText(event.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Scan bale reference and press Enter"
                  className="h-12 bg-white pl-10 font-mono dark:bg-[#0a1629]"
                  data-testid="input-dispatch-scan"
                />
              </div>
              <MobileBarcodeScanner onScan={submitBarcode} feedback={feedback} className="h-12 w-12 shrink-0" />
              <Button
                type="button"
                size="sm"
                className="h-12 shrink-0"
                disabled={!scanText.trim()}
                onClick={() => {
                  const value = scanText;
                  setScanText("");
                  submitBarcode(value);
                  inputRef.current?.focus();
                }}
                data-testid="button-submit-dispatch-scan"
              >
                Verify
              </Button>
            </div>
          )}
          {!writable && (
            <p className="text-sm text-muted-foreground">
              This trip cannot accept further scans. The permanent verification record remains available below.
            </p>
          )}
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-sky-300" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {pendingCount} barcode(s) being processed or queued
            </div>
          )}
          {feedback && (
            <div
              role="status"
              aria-live="polite"
              data-testid="dispatch-scan-feedback"
              className={
                "flex items-start gap-2 rounded-xl border p-3 text-sm " +
                (feedback.type === "success"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200"
                  : feedback.type === "warn"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200"
                    : "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200")
              }
            >
              {feedback.type === "success" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0" />
              ) : feedback.type === "warn" ? (
                <AlertTriangle className="h-5 w-5 shrink-0" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="break-all font-mono font-semibold">{feedback.referenceNumber}</p>
                <p className="mt-1">{feedback.message}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-200 bg-white dark:border-blue-500/20 dark:bg-[#101c34]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold">Verified truck bales</h3>
              <p className="text-xs text-muted-foreground">Server-confirmed scans · newest first</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" data-testid="badge-dispatch-scanned-count">
                {fmtCount(data?.activeCount ?? active.length)} bales
              </Badge>
              <Badge variant="outline">
                <Weight className="mr-1 h-3 w-3" /> {fmtKg(data?.activeWeightKg ?? 0)} kg
              </Badge>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                Refresh
              </Button>
            </div>
          </div>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 pl-9"
              placeholder="Search reference, article, operator"
              value={filterText}
              onChange={(event) => {
                setFilterText(event.target.value);
                setVisibleCount(PAGE_CHUNK);
              }}
              data-testid="input-search-dispatch-scans"
            />
          </div>
          {isLoading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading verified bales…
            </div>
          )}
          {isError && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error instanceof Error ? error.message : "Unable to fetch scans"}
            </div>
          )}
          {!isLoading && !isError && filtered.length === 0 && (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              <Package className="mx-auto mb-2 h-6 w-6" />
              {filterText
                ? "No scans match your search."
                : "No verified bales yet. Start scanning as each bale enters the truck."}
            </div>
          )}
          {visibleScans.length > 0 && (
            <div className="overflow-x-auto rounded-xl border dark:border-slate-700">
              <table className="w-full min-w-[600px] border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-muted-foreground dark:bg-[#0b162a]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Reference / Article</th>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Kg</th>
                    <th className="px-3 py-2 font-medium">Scanned by / Time</th>
                    <th className="px-3 py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleScans.map((scan) => (
                    <tr
                      key={String(scan.id)}
                      className="border-t dark:border-slate-700"
                      data-testid={"dispatch-scan-" + scan.id}
                    >
                      <td className="px-3 py-2">
                        <p className="font-mono font-semibold">{scan.baleReference}</p>
                        <p className="text-[11px] text-muted-foreground">{scan.articleCode || "—"}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p className="max-w-[280px] truncate">{scan.productName || "—"}</p>
                        {!scan.stillInLoading && (
                          <span className="text-[11px] font-semibold text-amber-600">
                            Removed from main loading since scan
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmtKg(Number(scan.weightKg))}</td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{scan.scannedByUsername}</p>
                        <p className="text-muted-foreground">{formatDisplayDateTime(scan.scannedAt)}</p>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canCorrect ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-red-600 hover:text-red-700"
                            onClick={() => {
                              setCorrection(scan);
                              setCorrectionReason("");
                            }}
                            title="Remove verification (audit reason required)"
                            aria-label={"Correct scan " + scan.baleReference}
                            data-testid={"button-remove-dispatch-scan-" + scan.id}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : (
                          <ShieldCheck className="ml-auto h-4 w-4 text-emerald-600" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {filtered.length > visibleCount && (
            <Button size="sm" variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_CHUNK)}>
              Show next {Math.min(PAGE_CHUNK, filtered.length - visibleCount)} scans ({filtered.length - visibleCount}{" "}
              remaining)
            </Button>
          )}
          {corrected.length > 0 && (
            <div className="rounded-xl border dark:border-slate-700">
              <button
                type="button"
                className="flex w-full items-center justify-between p-3 text-left text-sm font-medium"
                onClick={() => setRemovedVisible((value) => !value)}
                data-testid="button-dispatch-correction-history"
              >
                <span className="flex items-center gap-2">
                  <History className="h-4 w-4" /> Correction history ({corrected.length})
                </span>
                <span className="text-xs text-muted-foreground">{removedVisible ? "Hide" : "Show"}</span>
              </button>
              {removedVisible && (
                <div className="max-h-[420px] space-y-2 overflow-y-auto border-t p-3 dark:border-slate-700">
                  {corrected.map((scan) => (
                    <div
                      key={String(scan.id)}
                      className="flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 p-2.5 text-xs dark:bg-[#0b162a]"
                    >
                      <div>
                        <p className="font-mono font-semibold">{scan.baleReference}</p>
                        <p className="text-muted-foreground">
                          Originally scanned by {scan.scannedByUsername} · {formatDisplayDateTime(scan.scannedAt)}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium text-red-600">
                          Corrected {scan.removedAt && formatDisplayDateTime(scan.removedAt)}
                        </p>
                        <p className="text-muted-foreground">{scan.removalReason || "No reason"}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(correction)}
        onOpenChange={(open) => {
          if (!open && !correcting) setCorrection(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Correct dispatch verification</DialogTitle>
            <DialogDescription>
              Remove {correction?.baleReference || "this bale"} from active truck verification? The original scan
              remains in the permanent audit history. This never removes the bale from main loading.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={correctionReason}
            rows={3}
            maxLength={500}
            placeholder="Required reason for correction"
            onChange={(event) => setCorrectionReason(event.target.value)}
            data-testid="input-dispatch-correction-reason"
          />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={correcting} onClick={() => setCorrection(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={correcting || correctionReason.trim().length < 3}
              onClick={() => void removeScan()}
              data-testid="button-confirm-dispatch-correction"
            >
              {correcting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Remove verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
