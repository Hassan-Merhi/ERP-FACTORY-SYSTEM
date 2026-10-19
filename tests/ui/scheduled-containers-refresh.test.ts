import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = new URL(
  "../../client/src/pages/factory/factoryshippingcontainers/components/ScheduledContainersTable.tsx",
  import.meta.url
);
const source = readFileSync(file, "utf8");

describe("scheduled containers request policy", () => {
  it("does not poll or refetch the editor on focus or reconnect", () => {
    expect(source).toContain("refetchInterval: false");
    expect(source).toContain("refetchOnWindowFocus: false");
    expect(source).toContain("refetchOnReconnect: false");
    expect(source).not.toContain("refetchInterval: 5000");
    expect(source).toContain("staleTime: 5 * 60 * 1000");
  });

  it("still refreshes after successful mutations and permits user-triggered retry", () => {
    expect(source.match(/invalidateQueries\(\{ queryKey: \[SCHEDULED_KEY\] \}\)/g)).toHaveLength(4);
    expect(source).toContain("onClick={() => void refetch()}");
    expect(source).toContain("Could not load scheduled containers.");
  });
});
