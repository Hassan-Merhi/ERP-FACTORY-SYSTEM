import { describe, expect, it } from "vitest";
import { gitContainerDetailPath, gitTrackingPatchUrl } from "../client/src/pages/git-containers/gitTrackingPatchUrl";

describe("shared ERP and Supplier Partner GIT row identity", () => {
  it("routes negative SP synthetic ids to SP logistics only", () => {
    expect(gitTrackingPatchUrl(-1)).toBe("/api/git/sp-containers/1/tracking");
    expect(gitTrackingPatchUrl(-123)).toBe("/api/git/sp-containers/123/tracking");
    expect(gitContainerDetailPath(-1)).toBe("/containers/1");
  });

  it("leaves ERP tracking and container navigation unchanged", () => {
    expect(gitTrackingPatchUrl(1)).toBe("/api/containers/1/tracking");
    expect(gitContainerDetailPath(123)).toBe("/containers/123");
  });

  it("rejects non-container identifiers", () => {
    for (const id of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => gitTrackingPatchUrl(id)).toThrow("Invalid tracking container id");
    }
  });
});
