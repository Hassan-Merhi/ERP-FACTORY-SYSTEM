import { z } from "zod";

/**
 * Company and privileges are NEVER accepted from client filters.
 * Date input uses UTC calendar days; end day is inclusive.
 */
export const ticketReportFiltersSchema = z.object({
  from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status:z.enum(["open","seen","working","finalized","reopened"]).optional(),
  priority:z.enum(["low","normal","high","urgent"]).optional(),
  sourceMode:z.enum(["erp","factory"]).optional(),
  category:z.string().trim().min(1).max(80).optional(),
  assignedTo:z.string().trim().min(1).max(100).optional(),
}).strict().superRefine((value,ctx)=>{
  const exact=(date:string)=>{
    const d=new Date(date+"T00:00:00.000Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===date;
  };
  if(value.from&&!exact(value.from))ctx.addIssue({code:"custom",message:"Invalid from date"});
  if(value.to&&!exact(value.to))ctx.addIssue({code:"custom",message:"Invalid to date"});
  if(value.from&&value.to&&value.from>value.to)ctx.addIssue({code:"custom",message:"Date range is reversed"});
  if(value.from&&value.to){
    const diff=Date.parse(value.to+"T00:00:00Z")-Date.parse(value.from+"T00:00:00Z");
    if(diff>366*86400000)ctx.addIssue({code:"custom",message:"Maximum range is 366 days"});
  }
});
export type TicketReportFilters = z.infer<typeof ticketReportFiltersSchema>;

export function ticketReportWhere(companyId:number,filters:TicketReportFilters,now=new Date()){
  if(!Number.isSafeInteger(companyId)||companyId<=0)throw new Error("COMPANY_REQUIRED");
  const clauses=["t.company_id=$1"];
  const params:unknown[]=[companyId];
  const add=(sql:string,v:unknown)=>{params.push(v);clauses.push(sql.replace("?", "$"+params.length));};
  if(filters.from)add("t.created_at>=?::date",filters.from);
  if(filters.to)add("t.created_at<(?::date + interval '1 day')",filters.to);
  if(filters.status)add("t.status=?",filters.status);
  if(filters.priority)add("t.priority=?",filters.priority);
  if(filters.sourceMode)add("t.source_mode=?",filters.sourceMode);
  if(filters.category)add("t.category=?",filters.category);
  if(filters.assignedTo)add("t.assigned_to=?",filters.assignedTo);
  return {where:clauses.join(" AND "),params,now};
}

export function sanitizeTicketCsvCell(value:unknown):string{
  let cell=String(value??"").replace(/[\u0000-\u001f\u007f]/g," ");
  // Spreadsheet programs interpret leading +, -, =, @ as a formula; prefix a safe apostrophe.
  if(/^[\s]*[=+@\-]/.test(cell))cell="'"+cell;
  return '"'+cell.replace(/"/g,'""')+'"';
}
export function serializeTicketCsv(rows:readonly (readonly unknown[])[]):string{
  return rows.map(row=>row.map(sanitizeTicketCsvCell).join(",")).join("\r\n")+"\r\n";
}
