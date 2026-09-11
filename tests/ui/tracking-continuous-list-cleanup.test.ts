import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("tracking continuous-list cleanup", () => {
  it("has no user-facing page controls or obsolete page state", () => {
    const page = source("client/src/pages/GITContainers.tsx");

    expect(page).not.toContain("PaginationBar");
    expect(page).not.toContain("setPage(");
    expect(page).not.toContain("const [page,");
    expect(page).toContain("CONTAINER_CHUNK_SIZE");
  });

  it("keeps batching internal to the continuous loader", () => {
    const hook = source("client/src/pages/git-containers/usePaginatedGITContainers.ts");

    expect(hook).not.toContain("page: number;");
    expect(hook).toContain("withContinuousCursor");
    expect(hook).toContain("fetchNextPage");
    expect(hook).toContain("AbortSignal");
  });

  it("keeps cursor invariant failures as internal technical identifiers", () => {
    const route = source("server/routes/accountTransactionPaginationRoutes.ts");

    expect(route).toContain("account-statement-cursor-row-invalid");
    expect(route).toContain("customer-statement-cursor-row-invalid");
    expect(route).toContain("factory-customer-cursor-row-invalid");
    expect(route).not.toContain("Unable to build account statement cursor");
  });
});
