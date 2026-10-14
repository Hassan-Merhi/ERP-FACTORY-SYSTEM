import { db } from "../../db";
import { factoryContainers } from "../../../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { isScraperAvailable } from "../../lib/parcelsAppScraper";
import { isHttpScraperAvailable } from "../../lib/httpTrackingScraper";
import { isMaerskDirectScraperAvailable } from "../../lib/maerskDirectScraper";
import * as seventeenTrack from "../../lib/trackingProviders/seventeenTrackProvider";

// ── Status helpers ────────────────────────────────────────────────────────────

const INACTIVE_LOWER = ["offloaded", "closed", "completed"] as const;

export function isInactiveStatus(status: string): boolean {
  return INACTIVE_LOWER.includes(status.toLowerCase() as "closed" | "offloaded" | "completed");
}

export const activeStatusFilter = sql`LOWER(${factoryContainers.status}) NOT IN ('offloaded','closed','completed')`;

export function isValidContainerNumber(containerNumber: string | null | undefined): boolean {
  if (!containerNumber) return false;
  return /^[A-Z]{4}\d{7}$/.test(containerNumber.trim().toUpperCase());
}

// ── Progress tracking ─────────────────────────────────────────────────────────

interface ProgressStep {
  provider: string;
  status: "running" | "success" | "fail" | "skip" | "blocked";
  detail?: string;
  ts: number;
}

const _progressStore = new Map<number, ProgressStep[]>();

export function getFactoryTrackingProgress(containerId: number): ProgressStep[] {
  return _progressStore.get(containerId) ?? [];
}

export function initProgress(containerId: number): void {
  _progressStore.set(containerId, []);
  setTimeout(() => _progressStore.delete(containerId), 10 * 60 * 1000);
}

export function ep(containerId: number, provider: string, status: ProgressStep["status"], detail?: string): void {
  let steps = _progressStore.get(containerId);
  if (!steps) {
    steps = [];
    _progressStore.set(containerId, steps);
  }
  const existing = steps.find((s) => s.provider === provider);
  if (existing) {
    existing.status = status;
    existing.detail = detail;
    existing.ts = Date.now();
  } else {
    steps.push({ provider, status, detail, ts: Date.now() });
  }
}

// ── Quota helpers (shared with ERP — reads from ERP's checks table for quota) ─

export async function check17trackQuota(): Promise<boolean> {
  const limit = seventeenTrack.getMonthlyLimit();
  try {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const { containerTrackingChecks } = await import("../../../shared/schema");
    const result = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(containerTrackingChecks)
      .where(
        and(eq(containerTrackingChecks.provider, "17track"), gte(containerTrackingChecks.checkedAt, startOfMonth))
      );
    const used = result[0]?.count ?? 0;
    return used < limit;
  } catch {
    return true;
  }
}

export function anyProviderConfigured(): boolean {
  return (
    !!process.env.PARCELSAPP_API_KEY ||
    seventeenTrack.isConfigured() ||
    isScraperAvailable() ||
    isHttpScraperAvailable() ||
    isMaerskDirectScraperAvailable()
  );
}

// ── DB helpers ────────────────────────────────────────────────────────────────
