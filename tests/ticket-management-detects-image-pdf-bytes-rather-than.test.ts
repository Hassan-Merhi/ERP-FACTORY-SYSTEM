import { describe, expect, it } from "vitest";
import { MAX_TICKET_ATTACHMENT_BYTES, safeTicketFileName, sniffTicketEvidence } from "../server/lib/ticketEvidenceValidation";
import { canAccessTicket, canPerformTicketAction, transitionTicket } from "../server/lib/ticketPolicy";

describe("Ticket Phase 3 private evidence validation",()=>{
  it("detects image/PDF bytes rather than trusting user-provided extension",()=>{
    expect(sniffTicketEvidence(Buffer.from([0xff,0xd8,0xff,1,1,1,1,1,1,1,0xff,0xd9]))).toBe("image/jpeg");
    expect(sniffTicketEvidence(Buffer.from([137,80,78,71,13,10,26,10,1,1,1,1]))).toBe("image/png");
    expect(sniffTicketEvidence(Buffer.from("RIFF1234WEBP"))).toBe("image/webp");
    expect(sniffTicketEvidence(Buffer.from("%PDF-1.7abcdefghijklmnop"))).toBe("application/pdf");
    expect(sniffTicketEvidence(Buffer.from("MZapplication-not-photo.exe"))).toBe(null);
  });
  it("denies empty/oversized evidence and normalizes filenames",()=>{
    expect(sniffTicketEvidence(Buffer.alloc(0))).toBe(null);
    expect(sniffTicketEvidence(Buffer.alloc(MAX_TICKET_ATTACHMENT_BYTES+1))).toBe(null);
    expect(safeTicketFileName("../hello.pdf")).toBe("hello.pdf");
    expect(safeTicketFileName("bad\r\nname.png")).toBe("bad__name.png");
    expect(safeTicketFileName("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });
  it("does not allow other-company or unrelated users into the ticket",()=>{
    const resource={companyId:2,createdBy:"creator",assignedTo:"worker",participantIds:["collaborator"],status:"working" as const};
    const actor=(userId:string,companyId=2)=>({userId,companyId,role:"Normal User",canAccessPage:true,canFinalize:true});
    expect(canAccessTicket(actor("stranger"),resource)).toBe(false);
    expect(canAccessTicket(actor("worker",3),resource)).toBe(false);
    expect(canPerformTicketAction(actor("collaborator"),resource,"comment")).toBe(true);
    expect(canPerformTicketAction(actor("collaborator"),resource,"finalize")).toBe(false);
    expect(transitionTicket(actor("worker"),resource,"finalize",{resolutionNote:"Corrected and checked"})).toBe("finalized");
    expect(()=>transitionTicket(actor("worker"),resource,"finalize")).toThrow("TICKET_RESOLUTION_REQUIRED");
  });
  it("limits reopen to the ticket creator or an explicitly authorized administrator",()=>{
    const resource={companyId:2,createdBy:"creator",assignedTo:"worker",participantIds:[],status:"finalized" as const};
    const creator={userId:"creator",companyId:2,role:"Normal User",canAccessPage:true,canReopen:true};
    expect(transitionTicket(creator,resource,"reopen",{reason:"Unresolved"})).toBe("reopened");
    expect(()=>transitionTicket({...creator,userId:"worker"},resource,"reopen",{reason:"Unresolved"})).toThrow("TICKET_ACTION_DENIED");
  });
});
