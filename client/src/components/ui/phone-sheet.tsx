import * as React from "react";

import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";

import "@/mobile-shell-dialogs.css";

/**
 * Phone dialogs open as bottom sheets: full width, anchored to the bottom edge above the
 * keyboard and the home indicator, rounded on top, with the title and the action row pinned
 * while the form scrolls. A shell opts in by rendering `PhoneSheetDialogs` around its tree
 * (ERP, Factory and Properties do; POS and the login screen keep centred dialogs). Dialogs are
 * portalled outside the shell, but React context reaches them, so no document-level marker is
 * needed. Tablet and desktop always keep the centred modal.
 */
const PhoneSheetDialogsContext = React.createContext(false);

export function PhoneSheetDialogs({ children }: { children: React.ReactNode }) {
  return <PhoneSheetDialogsContext.Provider value={true}>{children}</PhoneSheetDialogsContext.Provider>;
}

/** True while dialogs in this tree should open as phone bottom sheets. */
export function usePhoneSheet(): boolean {
  const enabled = React.useContext(PhoneSheetDialogsContext);
  const phone = useErpPhoneLayout();
  return enabled && phone;
}

type DialogFrame = {
  /** The dialog is a phone bottom sheet. */
  sheet: boolean;
  /** The dialog keeps its default padding (frames with `p-0` lay out their own header and body). */
  padded: boolean;
};

/** Set by DialogContent/AlertDialogContent so the header, footer and close control can follow. */
export const DialogFrameContext = React.createContext<DialogFrame>({ sheet: false, padded: true });

export function useDialogFrame(): DialogFrame {
  return React.useContext(DialogFrameContext);
}

/** Does a caller's className drop the frame's padding? */
export function isUnpadded(className: string | undefined): boolean {
  return /(^|\s)p-0(\s|$)/.test(className ?? "");
}

/** How many rendered children an action row holds (conditional `false`/`null` entries ignored). */
export function countActions(children: React.ReactNode): number {
  return React.Children.toArray(children).filter(React.isValidElement).length;
}

const BACKGROUND_SIDE_BLEED = "shadow-[-1rem_0_0_hsl(var(--background)),1rem_0_0_hsl(var(--background))]";

/** Class fragments shared by DialogContent and AlertDialogContent. */
export const dialogFrameClasses = {
  base: "fixed z-50 grid gap-4 overflow-y-auto overscroll-contain border bg-background p-4 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:p-6 motion-reduce:animate-none motion-reduce:transition-none",
  centred:
    "left-1/2 top-1/2 max-h-[calc(var(--app-viewport-height)-1rem)] w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-h-[calc(var(--app-viewport-height)-2rem)] sm:w-[calc(100vw-2rem)] sm:rounded-lg",
  // Lifted above the on-screen keyboard and capped to what the user can see
  // (useVisualViewportMetrics), so the pinned actions stay reachable while typing. The `sm:`
  // twins cover landscape phones, which cross Tailwind's sm width but are still phones.
  sheet:
    "inset-x-0 top-auto bottom-[var(--erp-keyboard-inset,0px)] w-full max-w-full max-h-[calc(var(--erp-visual-viewport-height,var(--app-viewport-height,100dvh))-0.75rem)] translate-x-0 translate-y-0 rounded-t-2xl rounded-b-none border-x-0 border-b-0 border-t pb-[max(1rem,var(--safe-area-bottom,0px))] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:w-full sm:max-w-full sm:max-h-[calc(var(--erp-visual-viewport-height,var(--app-viewport-height,100dvh))-0.75rem)] sm:rounded-t-2xl sm:rounded-b-none sm:pb-[max(1rem,var(--safe-area-bottom,0px))]",
  // The title row sticks to the top of the sheet's scroll area; the side bleed paints the
  // frame's padding so scrolled content never shows beside it.
  sheetHeader: `sticky -top-4 z-30 -mt-4 bg-background pb-2 pt-4 ${BACKGROUND_SIDE_BLEED}`,
  // The close control (normally absolute) becomes a sticky first grid item that overlaps the
  // header row, so it stays in view however long the dialog is.
  sheetClose:
    "sticky inset-auto top-0 z-40 order-first min-h-11 min-w-11 self-end justify-self-end -mb-[3.75rem] bg-background sm:inset-auto sm:top-0",
  // The action row stays pinned above the home indicator while the form scrolls.
  sheetFooter: `sticky bottom-[calc(-1*max(1rem,var(--safe-area-bottom,0px)))] z-20 bg-background pb-[max(0.75rem,var(--safe-area-bottom,0px))] ${BACKGROUND_SIDE_BLEED}`,
  // Two actions (Cancel + primary) share one row, primary on the trailing side.
  sheetFooterPair: "grid grid-cols-2",
};
