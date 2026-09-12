import { LanguageOnboardingDialog } from "@/components/LanguageOnboardingDialog";
import { RemoteSupportRuntime } from "@/components/RemoteSupportRuntime";

/**
 * Global overlays rendered above every workspace shell. Extracted from
 * AuthenticatedApp so the shell router stays under the 150-line boundary;
 * rendering is identical, only the location moved.
 */
export function AuthenticatedAppOverlays({ userId }: { userId: number | string | undefined }) {
  return (
    <>
      {userId === undefined ? null : <LanguageOnboardingDialog userId={userId} />}
      <RemoteSupportRuntime />
    </>
  );
}
