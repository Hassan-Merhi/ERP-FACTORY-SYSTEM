import { offlineError } from "./offlineError";
import { getErrorDetails } from "@shared/errorUtils";
import { buildPacks, type OfflineReadiness, type PrepProgress } from "../offlinePrep";
import {
  getOfflineReadGrant,
  getVerifiedOfflineReadScope,
  saveVerifiedOfflineReadBatch,
  verifyOfflineReadScope,
  type OfflineReadActor,
} from "./offlineReadCache";
import { mergeOfflinePages, normalizeOfflineReadUrl, readPaginationPlan } from "./offlineReadPolicy";

const activePreparations = new Set<number>();

/** Download every page, or refuse to promote an incomplete snapshot. */
export async function downloadCompleteOfflineDataset(url: string, transport: typeof fetch = fetch): Promise<string> {
  if (normalizeOfflineReadUrl(url) !== url) throw offlineError("OFFLINE_PREP_URL_UNSUPPORTED");
  const getPage = async (pageUrl: string): Promise<{ payload: unknown; headers: Headers }> => {
    const result = await transport(pageUrl, { credentials: "include", cache: "no-store" });
    if (!result.ok) throw offlineError(`OFFLINE_PREP_HTTP_${result.status}`);
    if (!(result.headers.get("content-type") ?? "").includes("json")) {
      throw offlineError("OFFLINE_PREP_EXPECTED_JSON");
    }
    const payload: unknown = await result.json();
    if (payload && typeof payload === "object" && "offline" in payload && payload.offline === true) {
      throw offlineError("OFFLINE_PREP_NOT_CONNECTED");
    }
    return { payload, headers: result.headers };
  };

  const first = await getPage(url);
  const plan = readPaginationPlan(first.payload, first.headers);
  const pages: unknown[] = [first.payload];
  for (let page = 2; page <= plan.totalPages; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const paging =
      plan.field === "data" ? `page=${page}&pageSize=${plan.pageSize}` : `page=${page}&limit=${plan.pageSize}`;
    const next = await getPage(`${url}${separator}${paging}`);
    const nextPlan = readPaginationPlan(next.payload, next.headers);
    if (nextPlan.totalPages !== plan.totalPages || nextPlan.total !== plan.total || nextPlan.field !== plan.field)
      throw offlineError("OFFLINE_PAGINATION_CHANGED");
    pages.push(next.payload);
  }
  const complete = mergeOfflinePages(pages, plan);
  return JSON.stringify(complete);
}

function emptyReadiness(): OfflineReadiness {
  return {
    ready: false,
    partial: false,
    preparedAt: null,
    completedDatasets: 0,
    totalDatasets: 0,
    errors: [],
    packSummary: {},
  };
}

export async function getScopedOfflineReadiness(actor: OfflineReadActor): Promise<OfflineReadiness> {
  try {
    const grant = await getOfflineReadGrant(actor);
    if (!grant || grant.expiresAt <= Date.now()) return emptyReadiness();
    return {
      ready: grant.status === "ready",
      partial: grant.status === "partial",
      preparedAt: grant.preparedAt,
      completedDatasets: grant.completed,
      totalDatasets: grant.total,
      errors: JSON.parse(grant.errors) as string[],
      packSummary: grant.packSummary ? JSON.parse(grant.packSummary) : {},
    };
  } catch {
    return emptyReadiness();
  }
}

/**
 * Promotes only a complete generation; a failed download cannot overwrite a
 * previously verified, still-valid snapshot. No cached auth/session responses.
 */
export async function runScopedOfflinePrep(
  companyId: number,
  onProgress: (value: PrepProgress) => void
): Promise<PrepProgress> {
  if (activePreparations.has(companyId)) throw offlineError("OFFLINE_PREP_ALREADY_RUNNING");
  activePreparations.add(companyId);
  const results: PrepProgress["results"] = [];
  const errors: string[] = [];
  const datasets = buildPacks().flatMap((pack) =>
    pack.datasets
      .filter((dataset) => dataset.id !== "user" && dataset.id !== "companies")
      .map((dataset) => ({ ...dataset, packId: pack.id }))
  );
  const total = datasets.length;
  const emit = (phase: PrepProgress["phase"], label: string): PrepProgress => {
    const complete = results.filter((entry) => entry.success).length;
    const failed = results.length - complete;
    const current: PrepProgress = {
      phase,
      currentLabel: label,
      totalDatasets: total,
      completedDatasets: complete,
      failedDatasets: failed,
      percent: Math.round((100 * results.length) / Math.max(1, total)),
      results: [...results],
      errors: [...errors],
    };
    onProgress(current);
    return current;
  };

  try {
    emit("preparing", "OFFLINE_PREP_AUTH_CHECK");
    const actor = await verifyOfflineReadScope(companyId);
    if (!actor) throw offlineError("OFFLINE_PREP_AUTH_REQUIRED");
    const generation: Array<{ url: string; body: string }> = [];
    const packSummary: Record<string, { label: string; count: number; completedAt: number }> = {};
    for (const dataset of datasets) {
      const url = dataset.endpoint;
      emit("preparing", dataset.label);
      try {
        const body = await downloadCompleteOfflineDataset(url);
        // The response must have the expected business wrapper. The offline
        // GET path replays this exact response, not legacy CachedEntity tables.
        const parsed: unknown = JSON.parse(body);
        const record =
          parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        const count = Array.isArray(parsed) ? parsed.length : Array.isArray(record?.data) ? record.data.length : 1;
        generation.push({ url, body });
        const pack = packSummary[dataset.packId] ?? { label: dataset.packId, count: 0, completedAt: Date.now() };
        pack.count += count;
        packSummary[dataset.packId] = pack;
        results.push({
          datasetId: dataset.id,
          label: dataset.label,
          packId: dataset.packId,
          success: true,
          count,
        });
      } catch (error) {
        const reason = getErrorDetails(error).optionalMessage ?? "OFFLINE_PREP_FAILED";
        errors.push(`${dataset.id}: ${reason}`);
        results.push({
          datasetId: dataset.id,
          label: dataset.label,
          packId: dataset.packId,
          success: false,
          count: 0,
          error: reason,
        });
      }
    }

    // A different tab can change the shared server session mid-download.
    // Revalidate the server-owned identity before promoting any cached pages.
    const finalActor = await verifyOfflineReadScope(companyId);
    if (!finalActor || finalActor.userId !== actor.userId) {
      throw offlineError("OFFLINE_PREP_SCOPE_CHANGED");
    }
    const verified = getVerifiedOfflineReadScope();
    if (!verified || verified.companyId !== companyId || verified.userId !== actor.userId) {
      throw offlineError("OFFLINE_PREP_SCOPE_CHANGED");
    }
    if (errors.length || generation.length !== total) {
      return emit("error", "OFFLINE_PREP_INCOMPLETE");
    }

    emit("verifying", "OFFLINE_PREP_VERIFYING");
    await saveVerifiedOfflineReadBatch({ ...actor, snapshots: generation, total, packSummary });
    return emit("done", "OFFLINE_PREP_READY");
  } catch (error) {
    errors.push(getErrorDetails(error).optionalMessage ?? "OFFLINE_PREP_FAILED");
    return emit("error", "OFFLINE_PREP_FAILED");
  } finally {
    activePreparations.delete(companyId);
  }
}
