/**
 * The GIT report tabs (Detail, Truck/Location) render
 * fleet-wide counts and totals. /api/git/containers paginates at 50 rows, so a
 * request without all=true silently truncated those views — 58 containers on
 * the road showed up as 50.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { gitContainersUrl } from "@/pages/git-mockup/helpers";
import { parseGitPagination } from "../../server/routes/git/gitListingProfiles";

const REPORT_TABS = ["TabDetail", "TabTruckLocation"];

describe("git report listing URLs", () => {
  it("always requests the full listing", () => {
    expect(gitContainersUrl()).toBe("/api/git/containers?all=true");
  });

  it("keeps company scope and offloaded flags alongside all=true", () => {
    const url = new URL(gitContainersUrl({ allCompanies: true, includeOffloaded: true }), "http://x");
    expect(url.pathname).toBe("/api/git/containers");
    expect(url.searchParams.get("all")).toBe("true");
    expect(url.searchParams.get("allCompanies")).toBe("true");
    expect(url.searchParams.get("includeOffloaded")).toBe("true");
  });

  it("omits scope flags that were not asked for", () => {
    const url = new URL(gitContainersUrl({ includeOffloaded: true }), "http://x");
    expect(url.searchParams.get("allCompanies")).toBeNull();
    expect(url.searchParams.get("includeOffloaded")).toBe("true");
  });

  it("paginates at 50 rows when all=true is missing — why the tabs must pass it", () => {
    expect(parseGitPagination({}).pageSize).toBe(50);
  });

  it.each(REPORT_TABS)("%s builds its query through gitContainersUrl", (tab) => {
    const source = readFileSync(path.resolve(__dirname, `../../client/src/pages/git-mockup/${tab}.tsx`), "utf8");
    expect(source).toContain("gitContainersUrl(");
    expect(source).not.toMatch(/queryUrl\s*=\s*[\s\S]{0,120}"\/api\/git\/containers(\?[^"]*)?"/);
  });
});
