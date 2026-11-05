/**
 * Ticket notification runner. Runs only from the existing scheduler and only when enabled.
 * Delivery contract: in-app inserts are transactional/idempotent. External provider sends
 * are at-most-once; ambiguous results are flagged for review, never blindly resent.
 */
import nodemailer from "nodemailer";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { sendWhatsAppTextToChatId } from "./whatsappService";

import { ticketEventRecipients, ticketEventCopy, ticketDestinationUrl } from "./ticketNotificationPolicy";
const MAX_EVENTS_PER_TICK = 40;
const MAX_DELIVERIES_PER_TICK = 80;
/** Create one overdue event per ticket per 24-hour elapsed period, not per cron tick. */
export async function enqueueTicketOverdueReminders(now:Date=new Date()):Promise<number> {
  const result=await pool.query(
    `WITH eligible AS (
      SELECT t.id, t.company_id,
       floor(extract(epoch FROM ($1::timestamptz - t.due_at)) / 86400)::bigint AS period
      FROM support_tickets t
      WHERE t.status <> 'finalized' AND t.due_at <= $1::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM support_ticket_outbox o
         WHERE o.event_key = 'ticket:' || t.id || ':overdue:' ||
          floor(extract(epoch FROM ($1::timestamptz - t.due_at)) / 86400)::bigint
       )
      ORDER BY t.due_at DESC
      LIMIT 100
    )
    INSERT INTO support_ticket_outbox(company_id,ticket_id,event_key,event_type,payload)
    SELECT e.company_id,e.id,
      'ticket:' || e.id || ':overdue:' || e.period,'ticket_overdue',
      jsonb_build_object('period',e.period)
    FROM eligible e ON CONFLICT(event_key) DO NOTHING RETURNING id`,[now]
  );
  return result.rowCount??0;
}

type ClaimedEvent={id:number;company_id:number;ticket_id:number;event_type:string;payload:Record<string,unknown>};
async function materializeOneEvent():Promise<boolean> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const result=await client.query<ClaimedEvent>(
      `SELECT id,company_id,ticket_id,event_type,payload
        FROM support_ticket_outbox
        WHERE processed_at IS NULL AND available_at<=now()
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    const event=result.rows[0];
    if(!event) {await client.query("COMMIT");return false;}
    const ticketResult=await client.query<{
      ticket_number:string;status:string;created_by:string;assigned_to:string;
    }>(`SELECT ticket_number,status,created_by,assigned_to
        FROM support_tickets WHERE id=$1 AND company_id=$2`,[event.ticket_id,event.company_id]);
    const ticket=ticketResult.rows[0];
    if(!ticket || (event.event_type==="ticket_overdue" && ticket.status==="finalized")) {
      await client.query("UPDATE support_ticket_outbox SET processed_at=now() WHERE id=$1",[event.id]);
      await client.query("COMMIT");return true;
    }
    const participants=await client.query<{user_id:string}>(
      "SELECT user_id FROM support_ticket_participants WHERE company_id=$1 AND ticket_id=$2",
      [event.company_id,event.ticket_id]
    );
    const actor=typeof event.payload?.actorId==="string"?event.payload.actorId:null;
    // Supervisors are included for overdue tickets only if their existing company-role
    // permissions allow viewing all tickets and the Ticket Management page.
    const supervisors=event.event_type==="ticket_overdue" ? await client.query<{user_id:string}>(`
      SELECT DISTINCT r.user_id FROM user_company_roles r
      JOIN users u ON u.id=r.user_id AND u.active=true
      WHERE r.company_id=$1 AND r.role IN ('Admin','Developer','Owner','Manager')
       AND (r.role IN ('Admin','Developer') OR NOT EXISTS(
         SELECT 1 FROM role_feature_permissions p WHERE p.company_id=r.company_id
          AND p.role=r.role AND p.feature_key IN ('act_ticket_manage_all','page_ticket_management')
          AND p.enabled=false
       ))`,[event.company_id]) : {rows:[] as {user_id:string}[]};
    const supervisorIds=supervisors.rows.map(x=>x.user_id);
    const candidates=[...new Set([...ticketEventRecipients({
      eventType:event.event_type,createdBy:ticket.created_by,assignedTo:ticket.assigned_to,
      actorId:actor,participantIds:participants.rows.map(p=>p.user_id),
    }),...supervisorIds].filter(id=>id!==actor))];
    const eligibleSet=new Set([ticket.created_by,ticket.assigned_to,...participants.rows.map(p=>p.user_id),...supervisorIds]);
    const recipients=candidates.filter(id=>eligibleSet.has(id));
    if(recipients.length) {
      const active=await client.query<{id:string;email:string|null;email_enabled:boolean|null;
        whatsapp_chat_id:string|null;whatsapp_enabled:boolean|null}>(
        `SELECT DISTINCT u.id,c.email,c.email_enabled,c.whatsapp_chat_id,c.whatsapp_enabled
           FROM users u JOIN user_company_roles r ON r.user_id=u.id AND r.company_id=$1
           LEFT JOIN support_ticket_notification_contacts c ON c.company_id=r.company_id AND c.user_id=u.id
          WHERE u.active=true AND u.id=ANY($2::varchar[])`,[event.company_id,recipients]
      );
      for(const recipient of active.rows) {
        const channels=["in_app"];
        if(recipient.email_enabled && recipient.email)channels.push("email");
        if(recipient.whatsapp_enabled && recipient.whatsapp_chat_id)channels.push("whatsapp");
        for(const channel of channels){
          await client.query(
            `INSERT INTO support_ticket_notifications(company_id,ticket_id,outbox_id,recipient_user_id,channel)
              VALUES($1,$2,$3,$4,$5) ON CONFLICT(outbox_id,recipient_user_id,channel) DO NOTHING`,
            [event.company_id,event.ticket_id,event.id,recipient.id,channel]
          );
        }
      }
    }
    await client.query("UPDATE support_ticket_outbox SET processed_at=now(),last_error=NULL WHERE id=$1",[event.id]);
    await client.query("COMMIT");
    return true;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}

type Delivery={
 id:number;company_id:number;ticket_id:number;recipient_user_id:string;
 channel:"in_app"|"email"|"whatsapp";event_type:string;ticket_number:string;
 created_by:string;assigned_to:string;status:string;email:string|null;
 email_enabled:boolean|null;whatsapp_chat_id:string|null;whatsapp_enabled:boolean|null;
 actor_id:string|null;source_mode:string;
};
async function claimDelivery(channel:"email"|"whatsapp"):Promise<Delivery|{skipped:true}|null>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const result=await client.query<Delivery>(`
      SELECT n.id,n.company_id,n.ticket_id,n.recipient_user_id,n.channel,
       o.event_type,t.ticket_number,t.created_by,t.assigned_to,t.status,t.source_mode,
       c.email,c.email_enabled,c.whatsapp_chat_id,c.whatsapp_enabled,
       o.payload->>'actorId' AS actor_id
      FROM support_ticket_notifications n
      JOIN support_ticket_outbox o ON o.id=n.outbox_id AND o.company_id=n.company_id
      JOIN support_tickets t ON t.id=n.ticket_id AND t.company_id=n.company_id
      JOIN users u ON u.id=n.recipient_user_id AND u.active=true
      JOIN user_company_roles r ON r.user_id=u.id AND r.company_id=n.company_id
      LEFT JOIN support_ticket_notification_contacts c ON c.company_id=n.company_id AND c.user_id=n.recipient_user_id
      WHERE n.delivery_status='pending' AND n.next_attempt_at<=now() AND n.channel=$1
      ORDER BY n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED
    `,[channel]);
    const d=result.rows[0];
    if(!d){await client.query("COMMIT");return null;}
    // Recheck access at send time so reassigned/removed participants cannot receive stale notifications.
    const allowed=await client.query(
      `SELECT 1 WHERE $1=$2 OR $1=$3 OR EXISTS(
        SELECT 1 FROM support_ticket_participants
        WHERE company_id=$4 AND ticket_id=$5 AND user_id=$1
       ) OR EXISTS(
        SELECT 1 FROM user_company_roles r
        WHERE r.user_id=$1 AND r.company_id=$4
         AND r.role IN ('Admin','Developer','Owner','Manager')
         AND (r.role IN ('Admin','Developer') OR NOT EXISTS(
           SELECT 1 FROM role_feature_permissions p WHERE p.company_id=r.company_id
            AND p.role=r.role AND p.feature_key IN ('act_ticket_manage_all','page_ticket_management')
            AND p.enabled=false
         ))
       )`,[d.recipient_user_id,d.created_by,d.assigned_to,d.company_id,d.ticket_id]
    );
    if(!allowed.rowCount || (d.event_type==="ticket_overdue"&&d.status==="finalized") ||
      (channel==="email"&&(!d.email_enabled||!d.email)) ||
      (channel==="whatsapp"&&(!d.whatsapp_enabled||!d.whatsapp_chat_id))) {
      await client.query("UPDATE support_ticket_notifications SET delivery_status='suppressed',error='Not eligible or no consent' WHERE id=$1",[d.id]);
      await client.query("COMMIT");return {skipped:true};
    }
    if(channel==="email" && !emailConfigured() || channel==="whatsapp" && !(await whatsappConfigured())) {
      await client.query(
        `UPDATE support_ticket_notifications SET next_attempt_at=now()+interval '15 minutes',error='Channel not configured'
         WHERE id=$1`,[d.id]);
      await client.query("COMMIT");return {skipped:true};
    }
    // Commit 'sending' BEFORE the external call. If the process crashes, the send is uncertain
    // and cannot be automatically repeated, avoiding duplicate WhatsApp/email messages.
    await client.query(
      `UPDATE support_ticket_notifications SET delivery_status='sending',attempt_count=attempt_count+1,
        last_attempt_at=now(),error=NULL WHERE id=$1`,[d.id]
    );
    await client.query("COMMIT");
    return d;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}

function emailConfigured():boolean {
  return !!(process.env.TICKET_SMTP_HOST && process.env.TICKET_SMTP_USER &&
    process.env.TICKET_SMTP_PASS && process.env.TICKET_SMTP_FROM);
}
async function whatsappConfigured():Promise<boolean> {
  try{
    const r=await pool.query<{enabled:boolean;instance_id:string|null;api_token:string|null}>(
      "SELECT enabled,instance_id,api_token FROM whatsapp_settings WHERE id=1"
    );
    return Boolean(r.rows[0]?.enabled && r.rows[0]?.instance_id && r.rows[0]?.api_token);
  }catch{return false;}
}

async function sendTicketEmail(address:string,title:string,message:string):Promise<void>{
  const transport=nodemailer.createTransport({
    host:process.env.TICKET_SMTP_HOST,
    port:Number(process.env.TICKET_SMTP_PORT||587),
    secure:process.env.TICKET_SMTP_SECURE==="true",
    auth:{user:process.env.TICKET_SMTP_USER!,pass:process.env.TICKET_SMTP_PASS!},
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
    requireTLS:process.env.TICKET_SMTP_SECURE!=="true",
    tls:{rejectUnauthorized:true},
  });
  try{
    await transport.sendMail({
      from:process.env.TICKET_SMTP_FROM!,to:address,subject:title,
      text:message,
    });
  }finally{transport.close();}
}

async function deliverInApp():Promise<boolean>{
  // Inbox insertion and completion are one transaction; SKIP LOCKED prevents duplicates.
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const result=await client.query<Delivery>(`
      SELECT n.id,n.company_id,n.ticket_id,n.recipient_user_id,n.channel,
       o.event_type,t.ticket_number,t.created_by,t.assigned_to,t.status,t.source_mode,
       o.payload->>'actorId' AS actor_id
       FROM support_ticket_notifications n
       JOIN support_ticket_outbox o ON o.id=n.outbox_id AND o.company_id=n.company_id
       JOIN support_tickets t ON t.id=n.ticket_id AND t.company_id=n.company_id
       JOIN users u ON u.id=n.recipient_user_id AND u.active=true
       JOIN user_company_roles r ON r.user_id=u.id AND r.company_id=n.company_id
      WHERE n.delivery_status='pending' AND n.channel='in_app'
       AND n.next_attempt_at<=now()
      ORDER BY n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`
    );
    const d=result.rows[0];
    if(!d){await client.query("COMMIT");return false;}
    const access=await client.query(
      `SELECT 1 WHERE $1=$2 OR $1=$3 OR EXISTS(
       SELECT 1 FROM support_ticket_participants
       WHERE company_id=$4 AND ticket_id=$5 AND user_id=$1) OR EXISTS(
       SELECT 1 FROM user_company_roles r WHERE r.user_id=$1 AND r.company_id=$4
        AND r.role IN ('Admin','Developer','Owner','Manager')
        AND (r.role IN ('Admin','Developer') OR NOT EXISTS(
         SELECT 1 FROM role_feature_permissions p WHERE p.company_id=r.company_id
          AND p.role=r.role AND p.feature_key IN ('act_ticket_manage_all','page_ticket_management')
          AND p.enabled=false
        )))`,
      [d.recipient_user_id,d.created_by,d.assigned_to,d.company_id,d.ticket_id]
    );
    if(!access.rowCount || d.event_type==="ticket_overdue"&&d.status==="finalized"){
      await client.query("UPDATE support_ticket_notifications SET delivery_status='suppressed' WHERE id=$1",[d.id]);
    }else{
      const copy=ticketEventCopy(d.event_type,d.ticket_number);
      await client.query(
        `INSERT INTO notifications(recipient_user_id,event_type,title,message,entity_type,entity_id,triggered_by_user_id,company_id,is_read)
         VALUES($1,$2,$3,$4,'support_ticket',$5,$6,$7,false)`,
        [d.recipient_user_id,copy.eventCode,copy.title,copy.message,d.ticket_id,d.actor_id,d.company_id]
      );
      await client.query(
        `UPDATE support_ticket_notifications SET delivery_status='delivered',sent_at=now(),delivered_at=now()
         WHERE id=$1`,[d.id]
      );
    }
    await client.query("COMMIT");
    return true;
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}
  finally{client.release();}
}

async function deliverExternal(channel:"email"|"whatsapp"):Promise<boolean>{
  const d=await claimDelivery(channel);
  if(!d)return false;
  if("skipped" in d)return true;
  const copy=ticketEventCopy(d.event_type,d.ticket_number);
  const deepLink=ticketDestinationUrl(process.env.TICKET_APP_BASE_URL,d.source_mode,d.ticket_id);
  const message=deepLink?`${copy.message}\n${deepLink}`:copy.message;
  try{
    if(channel==="email")await sendTicketEmail(d.email!,copy.title,message);
    else{
      const {success,error}=await sendWhatsAppTextToChatId(d.whatsapp_chat_id!,message);
      if(!success)throw new Error(error||"WhatsApp provider rejected the message");
    }
    await pool.query(
      `UPDATE support_ticket_notifications SET delivery_status='sent',sent_at=now(),error=NULL WHERE id=$1 AND delivery_status='sending'`,
      [d.id]
    );
  }catch(error){
    // It may have been accepted by the provider before a timeout/disconnect.
    // Mark uncertain instead of risking duplicate send through an automatic retry.
    logger.warn("[TicketNotifications] External send uncertain",{deliveryId:d.id,channel,
      message:error instanceof Error?error.message:"Delivery failed"});
    await pool.query(
      `UPDATE support_ticket_notifications SET delivery_status='uncertain',error=$2 WHERE id=$1 AND delivery_status='sending'`,
      [d.id,"Provider did not confirm acceptance; manual review required"]
    );
  }
  return true;
}

/** A background tick; does not access app requests, and never changes vouchers. */
export async function runTicketNotificationTick():Promise<void>{
  if(process.env.TICKET_NOTIFICATIONS_ENABLED!=="true")return;
  try{
    await enqueueTicketOverdueReminders();
    for(let i=0;i<MAX_EVENTS_PER_TICK;i++)if(!await materializeOneEvent())break;
    // After a restart, a provider call left in 'sending' is ambiguous, not retryable.
    await pool.query(
      `UPDATE support_ticket_notifications
         SET delivery_status='uncertain',error='Worker restarted before provider confirmation'
       WHERE delivery_status='sending' AND last_attempt_at<now()-interval '5 minutes'`
    );
    for(let i=0;i<MAX_DELIVERIES_PER_TICK;i++){
      if(!await deliverInApp())break;
    }
    for(const channel of ["email","whatsapp"] as const){
      for(let i=0;i<20;i++)if(!await deliverExternal(channel))break;
    }
  }catch(error){
    logger.error("[TicketNotifications] Worker tick failed",{error});
    throw error;
  }
}
