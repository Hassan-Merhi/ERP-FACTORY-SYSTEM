export type VerificationStatus = "PASS" | "WARN" | "FAIL";
export type VerificationArea = {
  area: string;
  status: VerificationStatus;
  detail: string;
  mismatches: string[];
};

export function summarizeVerification(areas: VerificationArea[]): VerificationStatus {
  if (areas.some((area) => area.status === "FAIL")) return "FAIL";
  if (areas.some((area) => area.status === "WARN")) return "WARN";
  return "PASS";
}
