import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure Paddle signature verifier, no HTTP registrations or state mutations.
 * See https://developer.paddle.com/webhooks/about/signature-verification
 * Call only with the ORIGINAL raw request bytes, never reserialized JSON.
 * The caller must deduplicate event IDs and atomically persist status changes.
 */
export function verifyPaddleSignature({ rawBody, signature, secret, nowMs=Date.now(), toleranceMs=5000 }) {
  if(typeof secret!=="string"||secret.length<16) return false;
  if(!(Buffer.isBuffer(rawBody)||typeof rawBody==="string"))return false;
  if(typeof signature!=="string"||signature.length>500||!Number.isFinite(nowMs))return false;
  const parts=signature.split(";").map(part=>part.trim());
  const tsFields=parts.filter(part=>part.startsWith("ts="));
  const h1Fields=parts.filter(part=>part.startsWith("h1="));
  if(tsFields.length!==1||h1Fields.length===0)return false;
  const timestamp=tsFields[0].slice(3);
  if(!/^\d{10,12}$/.test(timestamp))return false;
  const tsMs=Number(timestamp)*1000;
  if(!Number.isSafeInteger(tsMs)||Math.abs(nowMs-tsMs)>toleranceMs)return false;
  const body=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(rawBody,"utf8");
  const expected=createHmac("sha256",secret)
    .update(Buffer.from(timestamp+":","utf8")).update(body).digest();
  for(const part of h1Fields){
    const hex=part.slice(3);
    if(!/^[a-f0-9]{64}$/i.test(hex))continue;
    const supplied=Buffer.from(hex,"hex");
    if(supplied.length===expected.length&&timingSafeEqual(supplied,expected))return true;
  }
  return false;
}
export function parseVerifiedPaddleSubscription({rawBody,signature,secret,nowMs=Date.now()}) {
  if(!verifyPaddleSignature({rawBody,signature,secret,nowMs}))throw new Error("Unauthenticated Paddle notification");
  let event;
  try {event=JSON.parse(Buffer.isBuffer(rawBody)?rawBody.toString("utf8"):rawBody);} catch {throw new Error("Invalid notification JSON");}
  if(!event||typeof event!=="object"||!/^evt_[a-zA-Z0-9]+$/.test(String(event.event_id||"")))
    throw new Error("Invalid event identifier");
  if(!String(event.event_type||"").startsWith("subscription."))throw new Error("Not a subscription notification");
  const subscription=event.data;
  if(!subscription||typeof subscription!=="object"||!/^sub_[a-zA-Z0-9]+$/.test(String(subscription.id||"")))
    throw new Error("Invalid subscription identifier");
  const occurred=Date.parse(event.occurred_at);
  if(!Number.isFinite(occurred))throw new Error("Invalid occurrence timestamp");
  const accepted=new Set(["trialing","active","past_due","paused","canceled"]);
  if(!accepted.has(subscription.status))throw new Error("Unsupported subscription state");
  return Object.freeze({
    provider:"paddle",
    eventId:event.event_id,
    eventType:event.event_type,
    providerSubscriptionId:subscription.id,
    occurredAtMs:occurred,
    status:subscription.status,
    // Do NOT trust custom_data as an account identifier by itself.
    // Resolve this provider subscription ID to a pre-verified account
    // association from the database, never bind by email or client input.
  });
}
