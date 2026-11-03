export class Phase9PressingRefusal extends Error {
  constructor(code: string);
}
export interface Phase9PressingEvidence {
  companyId: number;
  localConfirmationId: number;
  baleId: number;
  machineId: number;
  assignmentId: number;
  actorUserId: string;
  requestId: string;
  referenceNumber: string;
  confirmedAt: string;
  deviceCapturedAt: string | null;
  productionDate: string;
  timezoneName: string;
}
export interface Phase9PressingEnvelope extends Phase9PressingEvidence {
  kind: "pressing.confirmation.v1";
  inventoryFinalized: false;
}
export function phase9PressingEnvelope(evidence: Phase9PressingEvidence): Phase9PressingEnvelope;
