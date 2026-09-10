import { describe, expect, it } from "vitest";

import { auditToolchainCoherence } from "../scripts/audit-toolchain-coherence.mjs";

describe("toolchain coherence contract", () => {
  it("pins every Node-using runtime and CI job to the canonical toolchain", () => {
    const report = auditToolchainCoherence();

    expect(report.canonical).toBe("24.21.0");
    expect(report.failures).toEqual([]);
    expect(report.summary.disagreeing).toBe(0);
    expect(report.summary.workflowJobsChecked).toBeGreaterThan(0);

    const render = report.sources.find((source: { file: string }) => source.file === "render.yaml (NODE_VERSION)");
    expect(render).toMatchObject({ states: "24.21.0", ok: true });

    const nodeJobs = report.workflowJobs.filter((job: { usesNode: boolean }) => job.usesNode);
    expect(nodeJobs.length).toBeGreaterThan(0);
    expect(nodeJobs.every((job: { states: string; ok: boolean }) => job.states === "24.21.0" && job.ok)).toBe(true);
  });
});
