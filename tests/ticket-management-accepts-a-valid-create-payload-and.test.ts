import { describe, expect, it } from "vitest";
import { ticketCreateSchema } from "../server/lib/ticketInputs";
import { canAccessTicket, canPerformTicketAction } from "../server/lib/ticketPolicy";

const valid = { title:"Incorrect journal voucher", description:"Amount needs correction", category:"Voucher Error", priority:"high", sourceMode:"erp", assignedTo:"worker-id", voucherId:25 };

describe("Ticket Management Phase 2 input security", () => {
  it("accepts a valid create payload and applies normal priority by default", () => {
    expect(ticketCreateSchema.parse(valid).voucherId).toBe(25);
    const { priority, ...withoutPriority }=valid;
    expect(ticketCreateSchema.parse(withoutPriority).priority).toBe("normal");
  });
  it("blocks forged company, creator, status or financial fields", () => {
    for (const extra of [{companyId:99},{createdBy:"admin"},{status:"finalized"},{totalAmount:99999}])
      expect(ticketCreateSchema.safeParse({...valid,...extra}).success).toBe(false);
  });
  it("rejects invalid voucher ids and category/status inputs", () => {
    for (const invalid of [{voucherId:-1},{voucherId:0},{voucherId:1.2},{sourceMode:"properties"},{title:" "},{priority:"superurgent"}])
      expect(ticketCreateSchema.safeParse({...valid,...invalid}).success).toBe(false);
  });
  it("keeps ticket visibility scoped to company, author, assignee and participants", () => {
    const ticket = {companyId:12,createdBy:"creator",assignedTo:"worker-id",participantIds:["participant"],status:"open" as const};
    const actor=(userId:string,companyId=12)=>({userId,companyId,role:"Normal User",canAccessPage:true});
    expect(canAccessTicket(actor("participant"),ticket)).toBe(true);
    expect(canAccessTicket(actor("unrelated"),ticket)).toBe(false);
    expect(canAccessTicket(actor("worker-id",13),ticket)).toBe(false);
    expect(canPerformTicketAction(actor("participant"),ticket,"finalize")).toBe(false);
  });
});
