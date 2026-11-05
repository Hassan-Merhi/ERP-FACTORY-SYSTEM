/**
 * Phase 1 ticket authorization and lifecycle policy. All decisions must be
 * repeated on the server after loading the ticket in the active company.
 * Being a participant NEVER grants permission to view a linked source record.
 */
export type TicketStatus = "open" | "seen" | "working" | "finalized" | "reopened";
export type TicketAction = "view" | "comment" | "start" | "seen" | "finalize" | "reopen" | "assign" | "manage" | "export";
export type TicketActor = {
  userId: string;
  companyId: number;
  role: string;
  canAccessPage: boolean;
  canCreate?: boolean;
  canFinalize?: boolean;
  canReopen?: boolean;
  canManageAll?: boolean;
  canExport?: boolean;
};
export type TicketResource = {
  companyId: number;
  createdBy: string;
  assignedTo: string;
  participantIds: readonly string[];
  status: TicketStatus;
};

export function isTicketAdministrator(actor: TicketActor): boolean {
  return actor.canManageAll === true && ["Developer", "Admin", "Owner", "Manager"].includes(actor.role);
}

export function canAccessTicket(actor: TicketActor, ticket: TicketResource): boolean {
  if (!actor.canAccessPage || actor.companyId !== ticket.companyId) return false;
  return isTicketAdministrator(actor) || ticket.createdBy === actor.userId ||
    ticket.assignedTo === actor.userId || ticket.participantIds.includes(actor.userId);
}

export function canPerformTicketAction(actor: TicketActor, ticket: TicketResource, action: TicketAction): boolean {
  if (!canAccessTicket(actor, ticket)) return false;
  const admin = isTicketAdministrator(actor);
  const assignee = ticket.assignedTo === actor.userId;
  switch (action) {
    case "view":
    case "comment": return true;
    case "seen": return assignee && ticket.status === "open";
    case "start": return assignee && ["open", "seen", "reopened"].includes(ticket.status);
    case "finalize": return assignee && actor.canFinalize !== false &&
      ["open", "seen", "working", "reopened"].includes(ticket.status);
    case "reopen": return (admin || ticket.createdBy === actor.userId) &&
      actor.canReopen !== false && ticket.status === "finalized";
    case "assign":
    case "manage": return admin;
    case "export": return admin && actor.canExport === true;
  }
}

export function transitionTicket(
  actor: TicketActor, ticket: TicketResource, action: "seen" | "start" | "finalize" | "reopen",
  details: { resolutionNote?: string; reason?: string } = {},
): TicketStatus {
  if (!canPerformTicketAction(actor, ticket, action)) throw new Error("TICKET_ACTION_DENIED");
  if (action === "finalize" && !details.resolutionNote?.trim()) throw new Error("TICKET_RESOLUTION_REQUIRED");
  if (action === "reopen" && !details.reason?.trim()) throw new Error("TICKET_REOPEN_REASON_REQUIRED");
  switch (action) {
    case "seen": return "seen";
    case "start": return "working";
    case "finalize": return "finalized";
    case "reopen": return "reopened";
  }
}

export const TICKET_DEFAULT_OVERDUE_HOURS = 24;
