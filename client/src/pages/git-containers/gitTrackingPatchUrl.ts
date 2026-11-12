/** SP tracking rows use negative synthetic ids, avoiding ERP primary-key collisions. */
export function gitTrackingPatchUrl(id: number): string {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error("Invalid tracking container id");
  return id < 0
    ? `/api/git/sp-containers/${-id}/tracking`
    : `/api/containers/${id}/tracking`;
}

export function gitContainerDetailPath(id: number, propertiesMode = false): string {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error("Invalid tracking container id");
  return `${propertiesMode ? "/properties" : ""}/containers/${Math.abs(id)}`;
}
