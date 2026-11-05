import { describe, expect, it } from "vitest";
import { serializeTicketCsv, sanitizeTicketCsvCell, ticketReportFiltersSchema, ticketReportWhere } from "../server/lib/ticketReportingPolicy";

describe("Ticket Management Phase 5 reporting security",()=>{
  it("enforces company scope and never accepts companyId from query parameters",()=>{
    const filters=ticketReportFiltersSchema.parse({status:"open",sourceMode:"factory"});
    const query=ticketReportWhere(12,filters);
    expect(query.where).toContain("t.company_id=$1");
    expect(query.params).toEqual([12,"open","factory"]);
    expect(ticketReportFiltersSchema.safeParse({companyId:"13"}).success).toBe(false);
    expect(()=>ticketReportWhere(-1,{})).toThrow("COMPANY_REQUIRED");
  });
  it("rejects SQL-style values, unknown keys, and overly long date ranges",()=>{
    for(const invalid of [
      {status:"finalized' OR true --"},{priority:"critical"},{sourceMode:"everything"},
      {from:"2026-02-30"},{to:"2026-13-10"},
      {from:"2026-11-10",to:"2026-11-05"},
      {from:"2024-01-01",to:"2026-11-05"},
      {assignedTo:"x".repeat(101)},{arbitrary:"untrusted"},
    ])expect(ticketReportFiltersSchema.safeParse(invalid).success).toBe(false);
  });
  it("uses indexed, parameterized filters and bounded date handling",()=>{
    const parsed=ticketReportFiltersSchema.parse({
      from:"2026-11-01",to:"2026-11-05",category:"Voucher Error",assignedTo:"employee-a",
    });
    const query=ticketReportWhere(12,parsed);
    expect(query.params).toEqual([12,"2026-11-01","2026-11-05","Voucher Error","employee-a"]);
    expect(query.where).toContain("t.created_at < (($3::date + interval '1 day') AT TIME ZONE 'UTC')");
    expect(query.where).toContain("t.assigned_to=$5");
  });
  it("neutralizes formula injection and escapes CSV special characters",()=>{
    for(const formula of ["=2+2","+cmd","-4","@SUM(A1)"," =IMPORTXML(A1)"])
      expect(sanitizeTicketCsvCell(formula)).toMatch(/^"'/);
    expect(sanitizeTicketCsvCell('a"b')).toBe('"a""b"');
    expect(serializeTicketCsv([["Ticket","Title"],["TKT-1","row\nline"]]))
      .toBe('"Ticket","Title"\r\n"TKT-1","row line"\r\n');
  });
});
