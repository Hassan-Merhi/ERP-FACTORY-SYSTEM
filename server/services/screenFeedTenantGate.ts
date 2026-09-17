/**
 * Tenant gate for passive screen-feed frame routes.
 *
 * Interactive control already binds sessions to the controller company and the
 * target tab's company. Passive frame routes historically only checked the view
 * permission + controller role, so a Manager in company A could request frames
 * for a userId that was only active in company B.
 *
 * Developer remains the cross-company support role (same rule as control-tab
 * selection). Every other controller must share an active company with the
 * target — either via live presence or a heartbeating ERP browser tab.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { userPresence } from "@shared/schema";
import { db } from "../db";
import { listRemoteControlTabs } from "./remoteControlSessionService";

const PRESENCE_TTL_MS = 3 * 60 * 1000;

export interface ScreenFeedTenantGateInput {
  controllerRole: string;
  controllerCompanyId: number | null | undefined;
  watchedUserId: string;
}

export type ScreenFeedTenantGateResult =
  | { allowed: true; companyId: number; source: "developer" | "tab" | "presence" }
  | { allowed: false; status: 400 | 403 | 404; message: string };

type PresenceCompanyLookup = (watchedUserId: string) => Promise<number | null>;

async function defaultPresenceCompanyLookup(watchedUserId: string): Promise<number | null> {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS);
  const rows = await db
    .select({ companyId: userPresence.companyId })
    .from(userPresence)
    .where(and(eq(userPresence.userId, watchedUserId), gt(userPresence.lastSeen, cutoff)))
    .orderBy(desc(userPresence.lastSeen))
    .limit(1);
  const companyId = rows[0]?.companyId;
  return typeof companyId === "number" && companyId > 0 ? companyId : null;
}

let presenceCompanyLookup: PresenceCompanyLookup = defaultPresenceCompanyLookup;

export function setScreenFeedPresenceLookupForTests(next: PresenceCompanyLookup | null): void {
  presenceCompanyLookup = next ?? defaultPresenceCompanyLookup;
}

function positiveCompanyId(value: unknown): number | null {
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function tabCompanyForTarget(watchedUserId: string, controllerCompanyId: number | null): number | null {
  const tabs = listRemoteControlTabs(watchedUserId);
  if (tabs.length === 0) return null;
  if (controllerCompanyId) {
    const match = tabs.find((tab) => tab.companyId === controllerCompanyId);
    if (match) return match.companyId;
  }
  return tabs[0]?.companyId ?? null;
}

export async function assertScreenFeedTenantAccess(
  input: ScreenFeedTenantGateInput
): Promise<ScreenFeedTenantGateResult> {
  const watchedUserId = String(input.watchedUserId ?? "").trim();
  if (!watchedUserId) {
    return { allowed: false, status: 400, message: "A watched user is required." };
  }

  const controllerCompanyId = positiveCompanyId(input.controllerCompanyId);
  const role = String(input.controllerRole ?? "");

  if (role === "Developer") {
    const tabCompany = tabCompanyForTarget(watchedUserId, controllerCompanyId);
    const presenceCompany = tabCompany ?? (await presenceCompanyLookup(watchedUserId));
    const companyId = controllerCompanyId ?? presenceCompany;
    if (!companyId) {
      return {
        allowed: false,
        status: 400,
        message: "No company selected.",
      };
    }
    return { allowed: true, companyId, source: "developer" };
  }

  if (!controllerCompanyId) {
    return { allowed: false, status: 400, message: "No company selected." };
  }

  const matchingTab = listRemoteControlTabs(watchedUserId).find((tab) => tab.companyId === controllerCompanyId);
  if (matchingTab) {
    return { allowed: true, companyId: controllerCompanyId, source: "tab" };
  }

  const presenceCompany = await presenceCompanyLookup(watchedUserId);
  if (presenceCompany === controllerCompanyId) {
    return { allowed: true, companyId: controllerCompanyId, source: "presence" };
  }

  // Same 404 wording for "no presence" and "wrong company" so the probe cannot
  // be used to map user IDs across tenants.
  return {
    allowed: false,
    status: 404,
    message: "No active screen feed is available for this user in the selected company.",
  };
}
