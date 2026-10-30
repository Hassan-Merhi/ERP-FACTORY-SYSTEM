import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (file: string) => readFileSync(file, "utf8");
const queue = source("client/src/pages/factory/pressing-scanner/pressingOfflineQueue.ts");
const hook = source("client/src/pages/factory/pressing-scanner/usePressingOfflineSync.ts");
const transport = source("client/src/pages/factory/pressing-scanner/pressingConfirmClient.ts");
const manager = source("client/src/pages/factory/PressingMachineManagement.tsx");
const panel = source("client/src/pages/factory/PressingOfflineQueueStatus.tsx");
const scanner = source("client/src/pages/factory/ContinuousPressingScanner.tsx");
const auth = source("server/routes/factory/factoryPressingMachineManagementRoutes.ts");
const generic = source("client/src/lib/offlineQueue.ts");

describe("Phase 5 pressing offline resilience contract", () => {
  it("persists a request ID and payload in IndexedDB before HTTP", () => {
    expect(queue).toContain('indexedDB.open(DB_NAME, DB_VERSION)');
    expect(queue).toContain('db.createObjectStore(STORE, { keyPath: "requestId" })');
    expect(queue).toContain('store.createIndex("actor", ["companyId", "userId"]');
    expect(queue).toContain("await savePressingScan(record)");
    expect(hook.indexOf("await enqueuePressingScan(identity, payload)"))
      .toBeLessThan(hook.indexOf("return deliver(identity, current)"));
    expect(transport).toContain('"/api/factory/pressing-machines/confirm", row.payload');
    expect(queue).toContain("requestId: record.requestId, payload: record.payload");
  });
  it("avoids the general-purpose ERP offline queue entirely", () => {
    expect(generic).toContain("pressing-machines(?:");
    expect(generic).toContain("NEVER_QUEUE_PATTERNS");
    expect(transport).toContain("row.payload");
  });
  it("locks offline rows to authenticated company and operator", () => {
    expect(auth).toContain("companyId: ctx.companyId, userId: ctx.userId");
    expect(hook).toContain('fetch("/api/factory/pressing-machines/me"');
    expect(hook).toContain("session.companyId === actor.companyId && session.userId === actor.userId");
    expect(queue).toContain("IDBKeyRange.only([actor.companyId, actor.userId])");
    expect(queue).toContain("row.companyId !== actor.companyId || row.userId !== actor.userId");
  });
  it("marks scans confirmed only when server returns a matching authoritative receipt", () => {
    expect(transport).toContain('item.status === "PRESSING_COMPLETED"');
    expect(transport).toContain("receipt.requestId !== row.requestId");
    expect(transport).toContain("receipt.operatorUserId !== row.userId");
    expect(hook).toContain('transitionPressingScan(actorValue, row.requestId, "confirmed"');
    expect(hook).toContain('transitionPressingScan(actorValue, row.requestId, "rejected"');
    expect(hook).toContain('transitionPressingScan(actorValue, row.requestId, "pending"');
  });
  it("automatically retries safe requests on reconnect, page visibility and interval", () => {
    expect(hook).toContain('window.addEventListener("online", onOnline)');
    expect(hook).toContain('document.addEventListener("visibilitychange", onVisibility)');
    expect(hook).toContain('window.setInterval(run, 12_000)');
    expect(hook).toContain('r.state === "syncing"');
    expect(hook).toContain("pressingRetryDelay(changed.attempts)");
    expect(hook).toContain("requestId: crypto.randomUUID()");
  });
  it("shows queued scans in amber and never increases accounting/stock", () => {
    expect(manager).toContain("onBarcode={cameraRead}");
    expect(manager).toContain("scanner.submit({");
    expect(manager).toContain("<PressingOfflineQueueStatus");
    expect(panel).toContain("Pending scans are not counted");
    expect(panel).toContain("Retry pending");
    expect(scanner).toContain('last?.outcome === "confirmed"');
    expect(scanner).toContain("inFlightRef.current += 1");
    expect(scanner).not.toContain("!submittingRef.current");
    expect(hook).not.toMatch(/(?:update|insert|delete)\(factoryBales\)/);
    expect(transport).not.toContain("/api/factory/finalize");
  });
});
