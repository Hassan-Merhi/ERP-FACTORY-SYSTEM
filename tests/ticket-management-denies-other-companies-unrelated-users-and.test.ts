import { describe, expect, it } from "vitest";
import { canAccessTicket, canPerformTicketAction, transitionTicket, TICKET_DEFAULT_OVERDUE_HOURS } from "../server/lib/ticketPolicy";

const ticket = { companyId: 12, createdBy: "creator", assignedTo: "worker", participantIds: ["observer"], status: "open" as const };
const actor = (userId: string, companyId = 12, role = "Normal User") => ({ userId, companyId, role, canAccessPage: true });

describe("support ticket Phase 1 isolation and lifecycle", () => {
  it("denies other companies, unrelated users and page-denied users", () => {
    expect(canAccessTicket(actor("worker", 13), ticket)).toBe(false);
    expect(canAccessTicket(actor("stranger"), ticket)).toBe(false);
    expect(canAccessTicket({ ...actor("worker"), canAccessPage: false }, ticket)).toBe(false);
  });
  it("allows only creator, assigned user, explicit participants and authorized admins to view", () => {
    for (const id of ["creator", "worker", "observer"]) expect(canAccessTicket(actor(id), ticket)).toBe(true);
    expect(canAccessTicket({ ...actor("admin", 12, "Admin"), canManageAll: true }, ticket)).toBe(true);
    expect(canAccessTicket({ ...actor("admin", 13, "Admin"), canManageAll: true }, ticket)).toBe(false);
    expect(canAccessTicket({ ...actor("admin", 12, "Admin"), canManageAll: false }, ticket)).toBe(false);
  });
  it("lets only assigned user progress and finalize with a resolution", () => {
    expect(transitionTicket(actor("worker"), ticket, "seen")).toBe("seen");
    expect(transitionTicket(actor("worker"), ticket, "start")).toBe("working");
    expect(() => transitionTicket(actor("worker"), ticket, "finalize")).toThrow("TICKET_RESOLUTION_REQUIRED");
    expect(transitionTicket(actor("worker"), ticket, "finalize", { resolutionNote: "Corrected entry" })).toBe("finalized");
    expect(() => transitionTicket(actor("creator"), ticket, "finalize", { resolutionNote: "done" })).toThrow("TICKET_ACTION_DENIED");
    expect(canPerformTicketAction(actor("observer"), ticket, "assign")).toBe(false);
  });
  it("permits creator or admin to reopen only finalized tickets with reason", () => {
    const finalized = { ...ticket, status: "finalized" as const };
    expect(() => transitionTicket(actor("creator"), finalized, "reopen")).toThrow("TICKET_REOPEN_REASON_REQUIRED");
    expect(transitionTicket(actor("creator"), finalized, "reopen", { reason: "Wrong amount persists" })).toBe("reopened");
    expect(transitionTicket({ ...actor("admin", 12, "Admin"), canManageAll: true }, finalized, "reopen", { reason: "Invalid evidence" })).toBe("reopened");
    expect(() => transitionTicket(actor("worker"), finalized, "reopen", { reason: "no" })).toThrow("TICKET_ACTION_DENIED");
  });
  it("limits exports to authorized administrators and sets 24-hour default", () => {
    expect(canPerformTicketAction({ ...actor("admin", 12, "Admin"), canManageAll: true, canExport: true }, ticket, "export")).toBe(true);
    expect(canPerformTicketAction({ ...actor("worker"), canExport: true }, ticket, "export")).toBe(false);
    expect(TICKET_DEFAULT_OVERDUE_HOURS).toBe(24);
  });
});
