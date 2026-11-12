/**
 * Whether the app currently knows the cloud is unreachable. ConnectivityContext
 * sets it from browser events and its health polls; capture reads it outside
 * React. A write is saved on the device only when the app already knows it is
 * offline before sending it, never after a request was cut off mid-flight (the
 * cloud may have committed it, and a second copy would post twice).
 */
let knownOffline = typeof navigator !== "undefined" ? navigator.onLine === false : false;

export function setKnownOffline(offline: boolean): void {
  knownOffline = offline;
}

export function isKnownOffline(): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return knownOffline;
}
