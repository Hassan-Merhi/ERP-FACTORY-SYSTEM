import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = resolve(
  process.cwd(),
  "client/src/pages/factory/factoryshippingcontainers/components/ScheduledContainersTable.tsx"
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

  it("still refreshes after successful add, edit and delete, with manual retry", () => {
    expect(source.match(/invalidateQueries\(\{ queryKey: \[SCHEDULED_KEY\] \}\)/g)).toHaveLength(3);
    expect(source).toContain("onClick={() => void refetch()}");
    expect(source).toContain("Could not load scheduled containers.");
  });

  it("shows only active scheduled containers without orphaned archive controls", () => {
    expect(source).toContain("const activeRows = rows.filter((row) => !row.isArchived)");
    expect(source).toContain('data-testid="button-add-scheduled"');
    expect(source).toContain("button-scheduled-delete-");
    expect(source).not.toContain("Archived Scheduled Containers");
    expect(source).not.toContain("button-toggle-archived-scheduled");
    expect(source).not.toContain("button-scheduled-archive-");
    expect(source).not.toContain("archiveMutation");
    expect(source).not.toContain("archivedExpanded");
    expect(source).not.toContain("RotateCcw");
  });
});
