/**
 * Kinds a PC delivers as a finished envelope (the live route wrote it in its
 * own transaction), and their stream. Only the PC route accepts them.
 */
import { PHASE9_PAYMENT_DELETE_KIND, PHASE9_PAYMENT_EDIT_KIND } from "../../edge/phase9PaymentEnvelope.mjs";
import { PHASE9_STOCK_ITEM_EDIT_KIND } from "../../edge/phase9StockItemEditEnvelope.mjs";
import { PHASE9_POS_SALE_CANCEL_KIND, PHASE9_POS_SALE_EDIT_KIND } from "../../edge/phase9PosSaleEnvelope.mjs";
import { PHASE9_RECEIVING_KIND } from "../../edge/phase9ReceivingEnvelope.mjs";
import { PHASE9_ATTACHMENT_KIND, PHASE9_ATTACHMENT_UPDATE_KIND } from "../../edge/phase9AttachmentEnvelope.mjs";
import { PHASE9_STOCK_ITEM_DELETE_KIND } from "../../edge/phase9StockItemLifecycleEnvelope.mjs";
import {
  PHASE9_STOCK_TRANSFER_EDIT_KIND,
  PHASE9_STOCK_TRANSFER_FINALIZE_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_KIND,
  PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND,
} from "../../edge/phase9StockTransferWorkflowEnvelope.mjs";
import { PHASE9_CUSTOMER_CREATE_KIND } from "../../edge/phase9CustomerCreateEnvelope.mjs";

export const PC_ENVELOPE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  [PHASE9_PAYMENT_EDIT_KIND]: "payments",
  [PHASE9_PAYMENT_DELETE_KIND]: "payments",
  [PHASE9_STOCK_ITEM_EDIT_KIND]: "stock",
  [PHASE9_STOCK_ITEM_DELETE_KIND]: "stock",
  [PHASE9_STOCK_TRANSFER_EDIT_KIND]: "stock",
  [PHASE9_STOCK_TRANSFER_FINALIZE_KIND]: "stock",
  [PHASE9_STOCK_TRANSFER_REVISION_KIND]: "stock",
  [PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND]: "stock",
  [PHASE9_RECEIVING_KIND]: "receiving",
  [PHASE9_POS_SALE_EDIT_KIND]: "pos",
  [PHASE9_POS_SALE_CANCEL_KIND]: "pos",
  [PHASE9_ATTACHMENT_KIND]: "attachments",
  [PHASE9_ATTACHMENT_UPDATE_KIND]: "attachments",
  // Phase C1: on the voucher stream, so it applies before the vouchers naming it.
  [PHASE9_CUSTOMER_CREATE_KIND]: "payments",
});
