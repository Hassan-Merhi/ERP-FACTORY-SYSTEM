import { describe, expect, it } from "vitest";
import { canAccessTicket, canPerformTicketAction, transitionTicket, type TicketActor, type TicketResource } from "../server/lib/ticketPolicy";
import { sanitizeTicketCsvCell, serializeTicketCsv, ticketReportFiltersSchema, ticketReportWhere } from "../server/lib/ticketReportingPolicy";
import { sniffTicketEvidence, safeTicketFileName, MAX_TICKET_ATTACHMENT_BYTES } from "../server/lib/ticketEvidenceValidation";
import { ticketDestinationUrl, ticketEventCopy, ticketEventRecipients } from "../server/services/ticketNotificationPolicy";

const ticket: TicketResource = {
  companyId: 7, createdBy: "reporter", assignedTo: "assignee",
  participantIds: ["watcher"], status: "working",
};
function actor(userId: string, overrides: Partial<TicketActor> = {}): TicketActor {
  return { userId, companyId: 7, role: "Normal User", canAccessPage: true, ...overrides };
}

describe("Ticket Management Phase 6 security acceptance contracts", () => {
  it("fails closed across company and role matrix, including a user with a page but no ticket relationship", () => {
    const candidates = [
      { a: actor("reporter"), allowed: true },
      { a: actor("assignee"), allowed: true },
      { a: actor("watcher"), allowed: true },
      { a: actor("unrelated"), allowed: false },
      { a: actor("admin", { role: "Admin" }), allowed: false },
      { a: actor("admin", { role: "Admin", canManageAll: true }), allowed: true },
      { a: actor("manager", { role: "Manager", canManageAll: true }), allowed: true },
      { a: actor("manager", { role: "Manager", canManageAll: false }), allowed: false },
      { a: actor("assignee", { companyId: 8 }), allowed: false },
      { a: actor("admin", { role: "Admin", canManageAll: true, companyId: 8 }), allowed: false },
      { a: actor("assignee", { canAccessPage: false }), allowed: false },
    ];
    for (const { a, allowed } of candidates) {
      expect(canAccessTicket(a, ticket), JSON.stringify(a)).toBe(allowed);
    }
  });

  it("requires the assignee for final approval even for privileged administrators", () => {
    const note = { resolutionNote: "Confirmed correction in the ERP." };
    expect(transitionTicket(actor("assignee"), ticket, "finalize", note)).toBe("finalized");
    for (const a of [
      actor("reporter"), actor("watcher"),
      actor("administrator", { role: "Admin", canManageAll: true }),
      actor("assignee", { canFinalize: false }),
    ]) {
      expect(() => transitionTicket(a, ticket, "finalize", note)).toThrow("TICKET_ACTION_DENIED");
    }
    expect(() => transitionTicket(actor("assignee"), ticket, "finalize", { resolutionNote: "  " }))
      .toThrow("TICKET_RESOLUTION_REQUIRED");
  });

  it("does not authorize participants to manage or export unrelated company tickets", () => {
    for (const id of ["reporter", "assignee", "watcher"]) {
      expect(canPerformTicketAction(actor(id, { canExport: true }), ticket, "export")).toBe(false);
      expect(canPerformTicketAction(actor(id), ticket, "manage")).toBe(false);
    }
    expect(canPerformTicketAction(actor("admin", { role: "Admin", canManageAll: true, canExport: false }), ticket, "export")).toBe(false);
    expect(canPerformTicketAction(actor("admin", { role: "Admin", canManageAll: true, canExport: true }), ticket, "export")).toBe(true);
  });

  it("rejects tenant injection, invalid dates, and unsupported report filters", () => {
    for (const unsafe of [
      { companyId: "8" }, { from: "2026-02-29" }, { to: "2026-12-32" },
      { from: "2026-11-05", to: "2026-11-04" },
      { from: "2025-01-01", to: "2026-11-05" },
      { assignedTo: "a".repeat(101) }, { status: "open' OR 1=1--" },
    ]) {
      expect(ticketReportFiltersSchema.safeParse(unsafe).success, JSON.stringify(unsafe)).toBe(false);
    }
    const filters = ticketReportFiltersSchema.parse({
      from: "2026-11-01", to: "2026-11-05", status: "working",
      priority: "urgent", sourceMode: "factory", category: "Voucher Error", assignedTo: "assignee",
    });
    const scoped = ticketReportWhere(7, filters);
    expect(scoped.where.startsWith("t.company_id=$1")).toBe(true);
    expect(scoped.params).toEqual([7, "2026-11-01", "2026-11-05", "working", "urgent", "factory", "Voucher Error", "assignee"]);
    expect(scoped.where).toContain("t.created_at < (($3::date + interval '1 day') AT TIME ZONE 'UTC')");
    expect(() => ticketReportWhere(0, filters)).toThrow("COMPANY_REQUIRED");
  });

  it("keeps CSV values inert with formulas, embedded control characters and quotes", () => {
    for (const dangerous of ["=1+1", "+cmd", "-12", "@SUM(A:A)", "  =HYPERLINK(x)"]) {
      expect(sanitizeTicketCsvCell(dangerous)).toMatch(/^"'/);
    }
    expect(sanitizeTicketCsvCell('one,"two"')).toBe('"one,""two"""');
    expect(sanitizeTicketCsvCell("x\r\ny\t")).toBe('"x  y "');
    expect(serializeTicketCsv([["Number", "Title"], ["TKT-1", "عطل في الفاتورة"]]))
      .toContain('"TKT-1","عطل في الفاتورة"\r\n');
  });

  it("accepts only known evidence signatures and strips path/control characters", () => {
    expect(sniffTicketEvidence(Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(sniffTicketEvidence(Buffer.alloc(MAX_TICKET_ATTACHMENT_BYTES + 1))).toBeNull();
    expect(sniffTicketEvidence(Buffer.from("%PDF-1.7\nvalid-looking header"))).toBe("application/pdf");
    expect(safeTicketFileName("../folder/receipt\\secret\u0000.pdf")).toBe("secret_.pdf");
  });

  it("excludes the event author from recipient selection and external messages omit private details", () => {
    expect(ticketEventRecipients({
      eventType: "ticket_comment", createdBy: "reporter", assignedTo: "assignee",
      participantIds: ["reporter", "watcher"], actorId: "watcher",
    })).toEqual(["reporter", "assignee"]);
    const copy = ticketEventCopy("ticket_overdue", "TKT-123");
    expect(copy.message).not.toMatch(/voucher|bank|amount|photo|employee mistake/i);
    expect(ticketDestinationUrl("http://bad.example", "factory", 10)).toBeNull();
    expect(ticketDestinationUrl("https://host.example", "factory", 10))
      .toBe("https://host.example/factory/tickets?ticketId=10");
  });
});
