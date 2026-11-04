import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return readFileSync(new URL("../.github/workflows/" + name + ".yml", import.meta.url), "utf8");
}

function job(source: string, name: string): string {
  const marker = "\n  " + name + ":\n";
  const index = source.indexOf(marker);
  if (index < 0) throw new Error("Missing workflow job: " + name);
  const remaining = source.slice(index + marker.length);
  const next = remaining.search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? remaining : remaining.slice(0, next);
}

describe("GitHub token permission boundaries", () => {
  it("validates training recordings without exposing publication credentials", () => {
    const source = workflow("publish-training-video");
    const validator = job(source, "verify-recording");
    const publisher = job(source, "publish");
    expect(source).toContain("permissions: {}");
    expect(validator).toContain("actions: read");
    expect(validator).toContain("contents: read");
    expect(validator).not.toContain("contents: write");
    expect(validator).not.toContain("id-token: write");
    expect(validator).toContain("gh run download");
    expect(validator).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(publisher).toContain("needs: verify-recording");
    expect(publisher).toContain("environment: training-publication");
    expect(publisher).toContain("TRAINING_PUBLICATION_APPROVAL_ENABLED");
    expect(publisher).toContain("contents: write");
    expect(publisher).toContain("pull-requests: write");
    expect(publisher).toContain("id-token: write");
  });

  it("keeps certification status writes separate from application tests", () => {
    const source = workflow("main-certification");
    const tester = job(source, "certify");
    const publisher = job(source, "publish");
    expect(tester).toContain("contents: read");
    expect(tester).not.toContain("statuses: write");
    expect(publisher).toContain("statuses: write");
    expect(publisher).toContain("needs: certify");
  });

  it("does not grant branch-mutation permission to the obsolete edge validator", () => {
    const source = workflow("edge-phase3-validate-once");
    expect(source).toContain("contents: read");
    expect(source).not.toContain("contents: write");
    expect(source).toContain("persist-credentials: false");
    expect(source).not.toContain("git push origin");
  });

  it("isolates branch deletion and Dependabot merge from read-only jobs", () => {
    const janitor = workflow("repository-janitor");
    expect(job(janitor, "report")).not.toContain("contents: write");
    expect(job(janitor, "cleanup")).toContain("contents: write");
    expect(job(janitor, "cleanup")).toContain("current_sha");
    const dependabot = workflow("dependabot-automerge");
    expect(job(dependabot, "inspect")).not.toContain("contents: write");
    expect(job(dependabot, "inspect")).toContain("dependabot/fetch-metadata");
    expect(job(dependabot, "enable-automerge")).toContain("pull-requests: write");
    expect(job(dependabot, "enable-automerge")).toContain("EXPECTED_HEAD_SHA");
  });

  it("limits CI repair and Scorecard token privileges to their required operations", () => {
    const repair = workflow("ci-repair-bot");
    expect(job(repair, "retry-failed")).toContain("actions: write");
    expect(job(repair, "retry-failed")).not.toContain("contents: read");
    const sweep = job(workflow("ci-repair-sweep"), "sweep");
    expect(sweep).toContain("actions: write");
    expect(sweep).not.toContain("contents: write");
    const scorecard = workflow("scorecards");
    expect(scorecard).toContain("permissions: {}");
    expect(job(scorecard, "analysis")).toContain("security-events: write");
    expect(job(scorecard, "analysis")).toContain("id-token: write");
    expect(job(scorecard, "analysis")).toContain("contents: read");
  });
});
