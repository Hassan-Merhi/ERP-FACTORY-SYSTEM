import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubSeededFetch, stubFetchRoutes } from "./pageMocks";
import { writeFileSync, readFileSync } from "fs";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

const SKIP = new Set(["application-language-announcement","text-page-title","text-page-subtitle","page-header","loading-state","empty-state","button-cursor-up","button-cursor-down","button-back","button-back-settings","text-not-found","text-no-data","text-empty"]);
const list = readFileSync("/tmp/claude-0/more-pages.txt", "utf8").trim().split("\n");
const out: Record<string, any> = {};
afterAll(() => writeFileSync("/tmp/claude-0/discover-more.json", JSON.stringify(out, null, 1)));
const errors: string[] = [];
beforeAll(() => {
  process.on("unhandledRejection", (e: any) => errors.push("rej:" + String(e?.message ?? e)));
  (URL as any).createObjectURL = () => "blob:x"; (URL as any).revokeObjectURL = () => {};
  window.print = () => {}; window.open = (() => null) as any;
  HTMLAnchorElement.prototype.click = function () {};
});
async function mountOnce(p: string, rich: boolean) {
  resetPageState();
  if (rich) stubSeededFetch(); else stubFetchRoutes();
  if (p.includes("/factory/")) { pageState.companyType = "factory"; pageState.appMode = "factory"; }
  const mod = await import(/* @vite-ignore */ "/home/user/ERP-FACTORY-SYSTEM/client/src/" + p);
  const name = p.split("/").pop()!.replace(/\.tsx$/, "");
  const C = mod.default ?? mod[name];
  const r = renderWithProviders(React.createElement(C as any));
  await act(async () => { await new Promise((res) => setTimeout(res, 200)); });
  const ids = Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")!).filter((i) => !SKIP.has(i) && !/undefined|^text-no-/.test(i));
  return { r, ids };
}
for (const p of list) {
  it(p, async () => {
    writeFileSync("/tmp/claude-0/discover-current.txt", p);
    errors.length = 0;
    const onErr = (e: any) => { errors.push("win:" + String(e?.error?.message ?? e?.message)); e.preventDefault?.(); };
    window.addEventListener("error", onErr);
    const res: any = { name: p.split("/").pop()!.replace(/\.tsx$/, "") };
    try {
      const empty = await mountOnce(p, false); res.emptyIds = empty.ids.slice(0, 5); empty.r.unmount();
      const rich = await mountOnce(p, true);
      res.richIds = rich.ids.slice(0, 5);
      res.hasRows = /Name 1|Item 1|Cust 1|Supp 1|CONT1|Desc 1/.test(document.body.textContent || "");
      const buttons = Array.from(document.querySelectorAll("button[data-testid]")).map((b) => b.getAttribute("data-testid")!).slice(0, 30);
      let clicks = 0;
      for (const id of buttons) {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
        if (!el || el.disabled) continue;
        try { await act(async () => { fireEvent.click(el); await new Promise((r2) => setTimeout(r2, 20)); }); clicks++; } catch (e: any) { errors.push("click:" + id + ":" + String(e?.message)); }
        fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
      }
      rich.r.unmount();
      res.clicks = clicks; res.ok = true;
    } catch (e: any) { res.ok = false; res.err = String(e?.message ?? e).slice(0, 200); }
    res.errors = errors.slice(0, 3);
    window.removeEventListener("error", onErr);
    out[p] = res;
    writeFileSync("/tmp/claude-0/discover-more.json", JSON.stringify(out, null, 1));
  });
}
