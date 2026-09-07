export const GOLDEN_COAST_HADI_CASH_CONFIGURATION_CODE = "GC_POS_HADI_CASH_TARGET_REQUIRED";

export interface GoldenCoastPosConfigurationErrorResponse {
  status: 422;
  body: {
    code: typeof GOLDEN_COAST_HADI_CASH_CONFIGURATION_CODE;
    message: string;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/**
 * Golden Coast cash settlement requires an active HADI Cash/Bank account with
 * the same name as the selected Golden Coast payment account. Missing master
 * data is a configuration problem, not an internal server failure. Classify it
 * as 422 so the whole POS transaction still rolls back atomically while the UI
 * receives the existing detailed setup message and a stable machine code.
 */
export function classifyGoldenCoastPosConfigurationError(
  error: unknown
): GoldenCoastPosConfigurationErrorResponse | null {
  const message = errorMessage(error);
  if (!message.startsWith("HADI has no active Cash/Bank account named ")) return null;

  return {
    status: 422,
    body: {
      code: GOLDEN_COAST_HADI_CASH_CONFIGURATION_CODE,
      message,
    },
  };
}
