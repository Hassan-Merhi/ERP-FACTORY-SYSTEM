import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(),p),"utf8");
const service = read("server/services/whatsappService.ts");
const api = read("server/routes/stockTransferOrderWaApprovalRoutes.ts");
const stateRoute = read("server/routes/whatsappRoutes.ts");
const settings = read("client/src/pages/settings/StockTransferOrderApprovalSettings.tsx");
const panel = read("client/src/pages/stock-transfer-order/StockTransferOrderApprovalRequestPanel.tsx");

describe("Stock Transfer Order main WhatsApp authorization preflight",()=>{
  it("cannot use the POS fallback for the main account or its groups",()=>{
    const start = service.indexOf("export async function getStrictGreenMainInstanceState(");
    const end = service.indexOf("export async function fetchGreenApiChats(",start);
    const strict = service.slice(start,end);
    expect(strict).toContain('fetchGreenApiReadOnly({ instanceId, apiToken }, "getStateInstance"');
    expect(strict).toContain('fetchGreenApiReadOnly({ instanceId, apiToken }, "getChats"');
    expect(strict).toContain('response.status === 401 || response.status === 403');
    expect(strict).not.toContain("fetchGreenApiWithAuthFallback(");
    expect(strict).not.toContain("getGreenApiAuthFallback(");
    expect(api).toContain("getStrictGreenMainInstanceState(wa.instanceId,wa.apiToken)");
    expect(api).toContain("fetchStrictGreenMainChats(wa.instanceId,wa.apiToken)");
  });

  it("distinguishes credentials saved from provider authorization",()=>{
    expect(settings).toContain("Main credentials saved");
    expect(settings).toContain("Main credentials rejected (401/403)");
    expect(settings).toContain('mainConnection.data?.state === "authorized"');
    expect(settings).toContain("Check main WhatsApp");
    expect(stateRoute).toContain("getStrictGreenMainInstanceState(s.instanceId, s.apiToken)");
    expect(panel).toContain('mainConnection.data?.state !== "authorized"');
    expect(panel).toContain("POS authorization does not count");
  });

  it("fails closed with actionable 409 and never dispatches from a backup account",()=>{
    expect(api).toContain('code:"STO_WA_MAIN_NOT_AUTHORIZED"');
    expect(api).toContain('mainState==="invalidCredentials"');
    expect(api).toContain("The POS connection is separate.");
    expect(api).toContain('mainState==="unknown"?503:409');
    expect(api).not.toContain('message:"Connect the main WhatsApp account first."');
    expect(service).toContain("export async function sendStockTransferOrderApprovalRequest(");
    const sender = service.slice(service.indexOf("export async function sendStockTransferOrderApprovalRequest("),service.indexOf("/**\n * Phase 5:"));
    expect(sender).not.toContain("fetchGreenApiWithAuthFallback(");
  });
});
