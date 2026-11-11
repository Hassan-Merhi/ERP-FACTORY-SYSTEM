# Stock Transfer Order — GREEN API inbound approval (Phase 3)

## Scope and behavior

This phase processes **Stock Transfer Order only**. Normal Stock Transfers,
Factory, POS and Properties approval paths are unchanged.

From the existing Stock Transfer Order → Send to WhatsApp → Request Approval
tab, an operator selects saved orders belonging to the same destination.
ERP sends one consolidated request to the company's saved approval group and
stores the exact GREEN API `idMessage` on the immutable batch.

An authorized user replies **directly to that approval message** with
`DONE` or `DECLINE`. The new inbound webhook:

1. Authenticates GREEN API with a dedicated, strong Bearer secret.
2. Accepts only `incomingMessageReceived` containing directly quoted text
   (`messageData.quotedMessage.stanzaId` or legacy
   `extendedTextMessageData.stanzaId`).
3. Matches the currently enabled **main GREEN API instance**, exact group
   `@g.us`, saved authorized sender phone `@c.us`, and the exact
   outbound `request_message_id` that was quoted.
4. Confirms the snapshot is still current: all included orders still exist
   in the same company/destination and remain order-origin records, stock
   lines are unchanged, no revisions were added/removed/superseded and the
   original approval group/phone remain configured.
5. Records the **first valid DONE or DECLINE only**, as immutable
   `done_received` or `decline_received` evidence. Unique partial index
   `sto_wa_batch_decision_once_uk`, plus batch row locks, prevents duplicate
   or contradictory decisions even across concurrent Render instances.
6. Marks outdated requests `stale`, releases their order reservations,
   and records `request_stale` instead of accepting the reply.
7. Responds 200 to duplicates and unrelated webhook notifications, 401 to
   unauthorized callbacks, and retryable 503 to transient database failures.

**Phase 3 only stages the decision.** A DONE/DECLINE does **not** approve
or reject revisions, alter vouchers or inventory, or send either Excel file.
Phase 4 will atomically execute the verified batch decision. Phase 5 will
send the approved cost-free Excel to the approval group and destination group.

## Render / GREEN API setup needed after deployment

1. Generate a fresh cryptographically random token, for example
   `openssl rand -hex 32`. Do not commit, paste into messages, or log it.
2. Add a Render environment variable named
   `STO_WA_GREEN_API_WEBHOOK_TOKEN`, with the **raw random token** as its
   value. The app refuses inbound callbacks if the variable is absent or
   shorter than 32 characters.
3. In the **main** GREEN API instance's Settings, enable incoming-message
   notifications (`incomingWebhook`) and configure:
   - `webhookUrl`: `https://<your ERP host>/api/stock-transfer-order/wa-approval/webhook`
   - `webhookUrlToken`: `Bearer <the same secret>`
4. Confirm the group selected in ERP's Stock Transfer Order approval settings
   is a group visible to the **same main GREEN API instance**.
5. Configure the single authorized WhatsApp phone in international E.164
   format (`+countrycode... `). It must resolve from GREEN API
   `senderData.sender` in numeric `@c.us` format. Unknown `@lid`
   senders are deliberately refused until a separately verified identity
   mapping is implemented.
6. In ERP Settings → Export Center, check that the approval settings display
   **Protected inbound webhook configured**, then submit a test request
   containing a test order and reply directly to its exact group message.

**Do not replace an existing webhook URL blindly.** A GREEN API instance may
have only one webhook destination. If a production receiver is already in use,
route incoming webhook notifications through that existing receiver with a
trusted fan-out to this endpoint rather than breaking the existing integration.
No GREEN API instance settings or Render credentials have been changed here.

## Files

- `server/routes/stockTransferOrderWaApprovalWebhookRoutes.ts`
- `server/services/security/stockTransferOrderWaWebhookAuthentication.ts`
- `server/services/stockTransferOrderWhatsAppReplyParser.ts`
- `server/services/stockTransferOrderWhatsAppInbound.ts`
- `server/startup-schema/040-stock-transfer-order-wa-webhook.ts`
- `migrations/20261111_002_stock_transfer_order_whatsapp_webhook_phase3.sql`
- `tests/stock-transfer-order-wa-phase3-incoming.test.ts`
- `tests/stock-transfer-order-wa-phase3-contract.test.ts`

The stage 040 decision index is registered in the normal startup migration
list and the production-compatible schema ensure, both idempotently.
The new public webhook is registered **before** ERP human-session tenant
authorization middleware, and the exact path is exempted from
Origin/CSRF checks only because it has independent strong Bearer protection.

## Verification

Source/manifest consistency and contract tests have been added. Pure parser
and token verification Vitest tests have been added, including valid modern
and legacy group quotes, unauthorized or non-phone senders, wrong webhook
type, unquoted commands, and missing credentials. These tests have not been
executed with the full private ERP build or a real configured GREEN API
instance in this conversation; a deployed integration test is still
required before enabling real approvals in Phase 4.
