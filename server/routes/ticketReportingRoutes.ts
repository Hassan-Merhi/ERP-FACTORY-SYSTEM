import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { requirePageAccess, requireActionAccess, requireExportAccess } from "../lib/permissionMiddleware";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { pool } from "../db";
import { serializeTicketCsv, ticketReportFiltersSchema, ticketReportWhere, type TicketReportFilters } from "../lib/ticketReportingPolicy";

const managementRoles=new Set(["Admin","Developer","Owner","Manager"]);
const page=[requireAuth,requirePageAccess("page_ticket_management"),requireActionAccess("act_ticket_manage_all")];
const exports=[...page,requireExportAccess("exp_ticket_export")];
type Scalar = { total:string; open:string; seen:string; working:string; reopened:string; finalized:string; overdue:string; urgent:string; avg_resolution_hours:string|null; resolved_within_24_hours:string };
type GroupRow = { label:string; count:string; overdue:string };
type EmployeeRow = {user_id:string;username:string|null;count:string;finalized:string;overdue:string;avg_resolution_hours:string|null};
type TrendRow={day:string;created:string;finalized:string};
type OverdueCase={id:number;ticket_number:string;title:string;assigned_to:string;username:string|null;status:string;priority:string;due_at:string;overdue_hours:string};

function parseFilters(req:Request,res:Response):TicketReportFilters|null {
  const raw=Object.fromEntries(Object.entries(req.query).map(([key,val])=>[key,typeof val==="string"?val:undefined]).filter(([,val])=>val!==undefined));
  const parsed=ticketReportFiltersSchema.safeParse(raw);
  if(!parsed.success){res.status(400).json({message:"Invalid reporting filters",errors:parsed.error.flatten()});return null;}
  return parsed.data;
}

async function scope(req:Request,res:Response):Promise<number|null> {
  const ctx=await getActiveCompanyPermissionContext(req);
  if(!managementRoles.has(ctx.role)){res.status(403).json({message:"Administrator ticket reporting access required"});return null;}
  return ctx.companyId;
}

export function registerTicketReportingRoutes(app:Express):void {
  app.get("/api/tickets/dashboard",...page,async(req:Request,res:Response)=>{
    try{
      const companyId=await scope(req,res);if(!companyId)return;
      const filters=parseFilters(req,res);if(!filters)return;
      const {where,params,now}=ticketReportWhere(companyId,filters);
      const [stats,statuses,categories,employees,trends,overdueCases]=await Promise.all([
        pool.query<Scalar>(`
          SELECT count(*)::text AS total,
           count(*) FILTER(WHERE t.status='open')::text AS open,
           count(*) FILTER(WHERE t.status='seen')::text AS seen,
           count(*) FILTER(WHERE t.status='working')::text AS working,
           count(*) FILTER(WHERE t.status='reopened')::text AS reopened,
           count(*) FILTER(WHERE t.status='finalized')::text AS finalized,
           count(*) FILTER(WHERE t.status<>'finalized' AND t.due_at<$${params.length+1}::timestamptz)::text AS overdue,
           count(*) FILTER(WHERE t.priority='urgent' AND t.status<>'finalized')::text AS urgent,
           round((avg(extract(epoch FROM (t.finalized_at-t.created_at))/3600) FILTER(WHERE t.finalized_at IS NOT NULL))::numeric,2)::text AS avg_resolution_hours,
           count(*) FILTER(WHERE t.finalized_at IS NOT NULL AND t.finalized_at<=t.due_at)::text AS resolved_within_24_hours
          FROM support_tickets t WHERE ${where}`,[...params,now]),
        pool.query<GroupRow>(`SELECT t.status AS label,count(*)::text AS count,
          count(*) FILTER(WHERE t.status<>'finalized' AND t.due_at<$${params.length+1}::timestamptz)::text AS overdue
          FROM support_tickets t WHERE ${where} GROUP BY t.status ORDER BY count(*) DESC`,[...params,now]),
        pool.query<GroupRow>(`SELECT t.category AS label,count(*)::text AS count,
          count(*) FILTER(WHERE t.status<>'finalized' AND t.due_at<$${params.length+1}::timestamptz)::text AS overdue
          FROM support_tickets t WHERE ${where} GROUP BY t.category ORDER BY count(*) DESC,t.category ASC LIMIT 20`,[...params,now]),
        pool.query<EmployeeRow>(`SELECT t.assigned_to AS user_id,u.username,count(*)::text AS count,
          count(*) FILTER(WHERE t.status='finalized')::text AS finalized,
          count(*) FILTER(WHERE t.status<>'finalized' AND t.due_at<$${params.length+1}::timestamptz)::text AS overdue,
          round((avg(extract(epoch FROM (t.finalized_at-t.created_at))/3600) FILTER(WHERE t.finalized_at IS NOT NULL))::numeric,2)::text AS avg_resolution_hours
          FROM support_tickets t LEFT JOIN users u ON u.id=t.assigned_to
          WHERE ${where} GROUP BY t.assigned_to,u.username ORDER BY count(*) DESC,t.assigned_to LIMIT 50`,[...params,now]),
        pool.query<TrendRow>(`SELECT to_char(date_trunc('day',t.created_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS day,
          count(*)::text AS created,
          count(*) FILTER(WHERE t.status='finalized')::text AS finalized
          FROM support_tickets t WHERE ${where}
          GROUP BY date_trunc('day',t.created_at AT TIME ZONE 'UTC')
          ORDER BY day DESC LIMIT 31`,params]),
        pool.query<OverdueCase>(`SELECT t.id,t.ticket_number,t.title,t.assigned_to,u.username,t.status,t.priority,t.due_at,
          floor(extract(epoch FROM ($${params.length+1}::timestamptz-t.due_at))/3600)::text AS overdue_hours
          FROM support_tickets t LEFT JOIN users u ON u.id=t.assigned_to
          WHERE ${where} AND t.status<>'finalized' AND t.due_at<$${params.length+1}::timestamptz
          ORDER BY t.due_at ASC,t.id ASC LIMIT 30`,[...params,now]),
      ]);
      res.setHeader("Cache-Control","private, no-store");
      return res.json({
        generatedAt:now.toISOString(),filters,
        summary:stats.rows[0]??null,
        byStatus:statuses.rows,byCategory:categories.rows,byEmployee:employees.rows,byCreatedDay:trends.rows.reverse(),
        overdueCases:overdueCases.rows,
      });
    }catch(error){console.error("[TicketReporting] dashboard failure",error);return res.status(500).json({message:"Ticket reporting unavailable"});}
  });

  app.get("/api/tickets/export",...exports,async(req:Request,res:Response)=>{
    try{
      const companyId=await scope(req,res);if(!companyId)return;
      const filters=parseFilters(req,res);if(!filters)return;
      const {where,params}=ticketReportWhere(companyId,filters);
      // Hard cap avoids unbounded memory/response work. Never export record snapshots or private attachments.
      const result=await pool.query<{
        ticket_number:string;title:string;category:string;status:string;priority:string;source_mode:string;
        created_by:string;assigned_to:string;created_at:string;first_seen_at:string|null;
        finalized_at:string|null;due_at:string;resolution_note:string|null;
      }>(`SELECT t.ticket_number,t.title,t.category,t.status,t.priority,t.source_mode,
        t.created_by,t.assigned_to,t.created_at,t.first_seen_at,t.finalized_at,t.due_at,t.resolution_note
        FROM support_tickets t WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT 10001`,params);
      if(result.rows.length>10000)return res.status(413).json({message:"Export contains more than 10,000 tickets. Narrow your filters."});
      const columns=["Ticket","Title","Category","Status","Priority","Source","Created by","Assigned to","Created UTC","Seen UTC","Finalized UTC","Due UTC","Resolution"];
      const fields:(keyof (typeof result.rows)[number])[]=["ticket_number","title","category","status","priority","source_mode","created_by","assigned_to","created_at","first_seen_at","finalized_at","due_at","resolution_note"];
      const csv=serializeTicketCsv([columns,...result.rows.map(r=>fields.map(field=>{const value:unknown=r[field];return value instanceof Date?value.toISOString():value;}))]);
      res.setHeader("Content-Type","text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",'attachment; filename="ticket-report.csv"');
      res.setHeader("Cache-Control","private, no-store");
      res.setHeader("X-Content-Type-Options","nosniff");
      return res.send("\uFEFF"+csv);
    }catch(error){console.error("[TicketReporting] export failure",error);return res.status(500).json({message:"Ticket export unavailable"});}
  });
}
