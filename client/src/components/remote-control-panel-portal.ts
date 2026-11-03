export const REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR =
  "[data-testid='dialog-watch-user'], [data-testid='dialog-watch-user-fast']";
const HOST_SELECTOR = "[data-remote-control-panel-host='true']";
const DIALOG_RESERVE_CLASSES = ["pb-[46vh]!", "lg:pb-0!", "lg:pr-[376px]!"] as const;

interface HostLease {
  dialog: HTMLElement;
  users: number;
}

const hostLeases = new WeakMap<HTMLElement, HostLease>();

export function findRemoteSupportWatchDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(REMOTE_SUPPORT_WATCH_DIALOG_SELECTOR);
}

function configureDialog(dialog: HTMLElement): void {
  dialog.classList.add(...DIALOG_RESERVE_CLASSES);
}

function restoreDialog(dialog: HTMLElement): void {
  dialog.classList.remove(...DIALOG_RESERVE_CLASSES);
}

function createHost(dialog: HTMLElement): HTMLElement {
  const host = document.createElement("aside");
  host.setAttribute("data-remote-control-panel-host", "true");
  host.setAttribute("data-screenfeed-ignore", "true");
  host.setAttribute("aria-label", "Remote controls");
  // The modern Watch User layout provides a dedicated sidebar slot.
  // Legacy viewers still use the existing floating control panel.
  const slot = dialog.querySelector<HTMLElement>("[data-screen-feed-control-slot]");
  if (slot) {
    host.dataset.remoteControlPanelMode = "unified";
    host.className = "flex w-full flex-col gap-2";
    slot.appendChild(host);
  } else {
    host.className =
      "absolute inset-x-0 bottom-0 z-2147483645 flex h-[46vh] flex-col gap-2 overflow-y-auto border-t bg-background/95 p-3 shadow-2xl backdrop-blur-sm lg:inset-x-auto lg:bottom-0 lg:right-0 lg:top-14 lg:h-auto lg:w-[376px] lg:border-l lg:border-t-0";
    dialog.appendChild(host);
  }
  host.style.setProperty("pointer-events", "auto", "important");
  host.style.setProperty("touch-action", "auto", "important");
  return host;
}

export function acquireRemoteControlPanelHost(dialog: HTMLElement): HTMLElement {
  if (!dialog.querySelector("[data-screen-feed-control-slot]")) configureDialog(dialog);
  const existing = dialog.querySelector<HTMLElement>(HOST_SELECTOR);
  const host = existing ?? createHost(dialog);
  const lease = hostLeases.get(host);
  if (lease) {
    lease.users += 1;
  } else {
    hostLeases.set(host, { dialog, users: 1 });
  }
  return host;
}

export function releaseRemoteControlPanelHost(host: HTMLElement): void {
  const lease = hostLeases.get(host);
  if (!lease) return;
  lease.users -= 1;
  if (lease.users > 0) return;
  hostLeases.delete(host);
  restoreDialog(lease.dialog);
  host.remove();
}
