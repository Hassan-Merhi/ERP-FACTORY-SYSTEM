/**
 * The evidence ratchet holds, and holds against the ways ratchets usually fail.
 *
 * The repository already gates whether a sensitive write route is *tested*
 * (audit-write-route-coverage.mjs, at zero). This audit asks whether a write
 * leaves the trail the rest of the system reconciles against. Stock evidence
 * remains a reviewed backlog; voucher request identity is now closed except for
 * the exact compatibility set whose replay/source guards were reviewed.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { auditWriteEvidence, compareBacklog } from "../scripts/audit-write-evidence.mjs";

const baseline = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config/write-evidence-baseline.json"), "utf8")
) as {
  stockWritesWithoutJournalEvidence: {
    ceiling: number;
    files: string[];
    rationale: string;
    reviewed: Record<string, { reason: string; files: string[] }>;
    unreviewed: string[];
  };
  voucherWritesWithoutRequestIdentity: {
    ceiling: number;
    files: string[];
    rationale: string;
  };
};

const voucherReview = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config/voucher-write-evidence-review.json"), "utf8")
) as {
  reviewState: string;
  summary: {
    initialReviewed: number;
    activeReviewed: number;
    explicitReplayGuard: number;
    migrationImportRepair: number;
    operationalWithoutRequestIdentity: number;
    phase3InfrastructureCompleted: number;
    phase4OperationalCompleted: number;
    phase5OperationalCompleted: number;
    phase6SpecialPurposeCompleted: number;
    phase7PostReviewSafeWriters: number;
    phase8RequestIdentityCompleted: number;
    unreviewed: number;
  };
  reviewed: Record<string, { verdict: string; reason: string; files: string[] }>;
  completed: Record<string, { verdict: string; reason: string; files: string[] }>;
  unreviewed: string[];
};

const measured = auditWriteEvidence() as {
  scannedFiles: number;
  unjournalledStockWrites: string[];
  voucherWritesWithoutRequestIdentity: string[];
  unapprovedDirectVoucherCreation: string[];
  journalledStockWrites: number;
  voucherWritesWithRequestIdentity: number;
};

describe("write evidence ratchet", () => {
  it("holds both backlogs at or below their pinned ceilings", () => {
    expect(measured.unjournalledStockWrites.length).toBeLessThanOrEqual(
      baseline.stockWritesWithoutJournalEvidence.ceiling
    );
    expect(measured.voucherWritesWithoutRequestIdentity.length).toBeLessThanOrEqual(
      baseline.voucherWritesWithoutRequestIdentity.ceiling
    );
  });

  it("names no file that the baseline has not reviewed", () => {
    const pinnedStock = new Set(baseline.stockWritesWithoutJournalEvidence.files);
    const pinnedVouchers = new Set(baseline.voucherWritesWithoutRequestIdentity.files);

    expect(measured.unjournalledStockWrites.filter((file) => !pinnedStock.has(file))).toEqual([]);
    expect(measured.voucherWritesWithoutRequestIdentity.filter((file) => !pinnedVouchers.has(file))).toEqual([]);
  });

  it("fails a swap that keeps the count steady", () => {
    const pinned = { ceiling: 2, files: ["first-writer", "second-writer"] };
    const { errors } = compareBacklog("probe", ["first-writer", "replacement-writer"], pinned);

    expect(errors).toHaveLength(1);
    expect(errors[0].includes("replacement-writer")).toBe(true);
  });

  it("treats a shrinking backlog as an improvement to re-pin, not a failure", () => {
    const pinned = { ceiling: 2, files: ["first-writer", "second-writer"] };
    const { errors, notes } = compareBacklog("probe", ["first-writer"], pinned);

    expect(errors).toEqual([]);
    expect(notes.join(" ").includes("second-writer")).toBe(true);
  });

  it("is measuring something, so an empty detector cannot pass as success", () => {
    expect(measured.scannedFiles).toBeGreaterThan(500);
    expect(measured.unjournalledStockWrites.length).toBeGreaterThan(0);
    expect(measured.voucherWritesWithoutRequestIdentity.length).toBeGreaterThan(0);
  });

  it("records why each backlog exists so a reviewer can judge a new entry", () => {
    expect(baseline.stockWritesWithoutJournalEvidence.rationale.includes("postStockMovementTx")).toBe(true);
    expect(baseline.voucherWritesWithoutRequestIdentity.rationale.includes("stable posting identity")).toBe(true);
  });

  it("accounts for every file in the stock backlog", () => {
    const stock = baseline.stockWritesWithoutJournalEvidence;
    const classified = Object.values(stock.reviewed).flatMap((group) => group.files);

    expect([...classified, ...stock.unreviewed].sort()).toEqual([...stock.files].sort());
    expect(new Set(classified).size, "a file is classified twice").toBe(classified.length);
  });

  it("keeps the stock unreviewed remainder empty", () => {
    expect(baseline.stockWritesWithoutJournalEvidence.unreviewed).toEqual([]);
  });

  it("says why each stock category is not a defect, or that it is", () => {
    for (const [category, group] of Object.entries(baseline.stockWritesWithoutJournalEvidence.reviewed)) {
      if (category !== "unjournalled") {
        expect(group.files.length, `${category} classifies no files`).toBeGreaterThan(0);
      }
      expect(group.reason.length, `${category} has no stated reason`).toBeGreaterThan(120);
    }

    expect(Object.keys(baseline.stockWritesWithoutJournalEvidence.reviewed)).toContain("unjournalled");
    expect(baseline.stockWritesWithoutJournalEvidence.reviewed.unjournalled.files).toEqual([]);
  });

  it("keeps only the exact 14 reviewed compatibility writers in the active voucher backlog", () => {
    const classified = Object.values(voucherReview.reviewed).flatMap((group) => group.files);

    expect(voucherReview.reviewState).toBe("REVIEWED FILE BY FILE");
    expect(voucherReview.summary.activeReviewed).toBe(14);
    expect(voucherReview.summary.explicitReplayGuard).toBe(14);
    expect(voucherReview.summary.migrationImportRepair).toBe(0);
    expect(voucherReview.summary.operationalWithoutRequestIdentity).toBe(0);
    expect(baseline.voucherWritesWithoutRequestIdentity.ceiling).toBe(14);
    expect([...classified, ...voucherReview.unreviewed].sort()).toEqual(
      [...baseline.voucherWritesWithoutRequestIdentity.files].sort()
    );
    expect(measured.voucherWritesWithoutRequestIdentity.sort()).toEqual(
      [...baseline.voucherWritesWithoutRequestIdentity.files].sort()
    );
    expect(new Set(classified).size, "a voucher file is classified twice").toBe(classified.length);
  });

  it("keeps the voucher unreviewed remainder empty", () => {
    expect(voucherReview.unreviewed).toEqual([]);
    expect(voucherReview.summary.unreviewed).toBe(0);
  });

  it("keeps every active compatibility classification explicit and documented", () => {
    expect(Object.keys(voucherReview.reviewed)).toEqual(["explicit-replay-guard"]);
    for (const [category, group] of Object.entries(voucherReview.reviewed)) {
      expect(group.files.length, `${category} classifies no files`).toBeGreaterThan(0);
      expect(group.reason.length, `${category} has no stated reason`).toBeGreaterThan(120);
      expect(group.verdict.length, `${category} has no verdict`).toBeGreaterThan(10);
    }
  });

  it("locks all completed voucher cohorts out of the active and measured backlog", () => {
    const active = new Set(baseline.voucherWritesWithoutRequestIdentity.files);
    const measuredBacklog = new Set(measured.voucherWritesWithoutRequestIdentity);
    const expectedCounts: Record<string, number> = {
      "phase-3-infrastructure-writers": 11,
      "phase-4-operational-writers": 22,
      "phase-5-operational-writers": 22,
      "phase-6-deterministic-source-writers": 6,
      "phase-6-intrinsic-replay-safe-writers": 5,
      "phase-7-post-review-safe-writers": 1,
      "phase-8-request-identity-writers": 1,
    };

    for (const [groupName, expectedCount] of Object.entries(expectedCounts)) {
      const completed = voucherReview.completed[groupName];
      expect(completed, `${groupName} missing`).toBeTruthy();
      expect(completed.reason.length, `${groupName} reason`).toBeGreaterThan(120);
      expect(completed.files).toHaveLength(expectedCount);
      expect(completed.files.filter((file) => active.has(file))).toEqual([]);
      expect(completed.files.filter((file) => measuredBacklog.has(file))).toEqual([]);
      expect(new Set(completed.files).size).toBe(completed.files.length);
    }

    expect(voucherReview.summary.phase3InfrastructureCompleted).toBe(11);
    expect(voucherReview.summary.phase4OperationalCompleted).toBe(22);
    expect(voucherReview.summary.phase5OperationalCompleted).toBe(22);
    expect(voucherReview.summary.phase6SpecialPurposeCompleted).toBe(11);
    expect(voucherReview.summary.phase7PostReviewSafeWriters).toBe(1);
    expect(voucherReview.summary.phase8RequestIdentityCompleted).toBe(1);
  });

  it("keeps the original 81-path review accounting honest", () => {
    expect(voucherReview.summary.initialReviewed).toBe(81);
    // Phase 8 is part of the original 81: those files were reviewed as active
    // compatibility writers and later earned a request identity, so they leave the
    // measured backlog without leaving the accounting.
    expect(
      voucherReview.summary.activeReviewed +
        voucherReview.summary.phase3InfrastructureCompleted +
        voucherReview.summary.phase4OperationalCompleted +
        voucherReview.summary.phase5OperationalCompleted +
        voucherReview.summary.phase6SpecialPurposeCompleted +
        voucherReview.summary.phase8RequestIdentityCompleted
    ).toBe(voucherReview.summary.initialReviewed);
  });

  it("rejects any new unreviewed direct voucher creator", () => {
    expect(measured.unapprovedDirectVoucherCreation).toEqual([]);
  });

  it("credits the write paths that do carry evidence", () => {
    expect(measured.journalledStockWrites).toBeGreaterThan(0);
    expect(measured.voucherWritesWithRequestIdentity).toBeGreaterThan(0);
  });
});
