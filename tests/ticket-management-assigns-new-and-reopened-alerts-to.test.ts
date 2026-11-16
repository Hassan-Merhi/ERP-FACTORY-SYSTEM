import { describe, expect, it } from "vitest";
import { ticketDestinationUrl, ticketEventCopy, ticketEventRecipients, TICKET_REMINDER_HOURS } from "../server/services/ticketNotificationPolicy";

const base={createdBy:"creator",assignedTo:"assignee",participantIds:["watcher","creator"],actorId:null};

describe("Ticket notification Phase 4 policy",()=>{
  it("assigns new and reopened ticket alerts to the current assignee",()=>{
    expect(ticketEventRecipients({...base,eventType:"ticket_created"})).toEqual(["assignee"]);
    expect(ticketEventRecipients({...base,eventType:"ticket_reopen"})).toEqual(["assignee"]);
    expect(ticketEventRecipients({...base,eventType:"ticket_overdue"})).toEqual(["assignee"]);
  });
  it("sends Seen/Started/Finalized alerts to the creator",()=>{
    for(const eventType of ["ticket_seen","ticket_start","ticket_finalize"])
      expect(ticketEventRecipients({...base,eventType,actorId:"assignee"})).toEqual(["creator"]);
  });
  it("de-duplicates watchers and never notifies the actor about their own comment",()=>{
    expect(ticketEventRecipients({...base,eventType:"ticket_comment",actorId:"creator"})).toEqual(["assignee","watcher"]);
    expect(ticketEventRecipients({...base,eventType:"ticket_attachment",actorId:"watcher"})).toEqual(["creator","assignee"]);
    expect(ticketEventRecipients({...base,eventType:"unexpected"})).toEqual([]);
  });
  it("sends safe external copy without descriptions, voucher data, or employee accusation",()=>{
    const copy=ticketEventCopy("ticket_created","TKT-2026-000125");
    expect(copy.eventCode).toBe("TICKET_CREATED");
    expect(copy.title).toBe("Ticket TKT-2026-000125");
    expect(copy.message).toContain("Open the ERP/Factory Ticket Management");
    expect(copy.message).not.toMatch(/amount|photo|voucher|error committed by/i);
  });
  it("uses HTTPS-only authenticated ticket deep links",()=>{
    expect(ticketDestinationUrl("https://erp.example.test","factory",125)).toBe("https://erp.example.test/factory/tickets?ticketId=125");
    expect(ticketDestinationUrl("https://erp.example.test","erp",125)).toBe("https://erp.example.test/tickets?ticketId=125");
    expect(ticketDestinationUrl("http://untrusted.test","erp",125)).toBe(null);
    expect(ticketDestinationUrl("https://erp.example.test","erp",-1)).toBe(null);
  });
  it("configures the first overdue alert at 24 hours",()=>{
    expect(TICKET_REMINDER_HOURS).toBe(24);
  });
});
