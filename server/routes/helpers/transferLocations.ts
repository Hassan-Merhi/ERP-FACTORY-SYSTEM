/**
 * Source and destination locations of a stock transfer request, resolved only
 * when they belong to the company. Every id comes from the request body, which
 * the path-based company scope does not see.
 */
import { storage } from "../../storage";
import { ownLocationIds } from "./companyOwnership";

export async function resolveTransferLocations(
  companyId: number,
  sourceLocationId: unknown,
  destinationLocationId: unknown,
  items: readonly { sourceLocationId?: unknown }[]
) {
  const owned = await ownLocationIds(companyId, [
    sourceLocationId,
    destinationLocationId,
    ...items.map((item) => item?.sourceLocationId),
  ]);
  const sourceLocation = owned.has(Number(sourceLocationId))
    ? await storage.getLocationById(Number(sourceLocationId))
    : undefined;
  const destLocation = owned.has(Number(destinationLocationId))
    ? await storage.getLocationById(Number(destinationLocationId))
    : undefined;
  const foreignItemSource = items.some(
    (item) => Boolean(item?.sourceLocationId) && !owned.has(Number(item.sourceLocationId))
  );
  return { sourceLocation, destLocation, foreignItemSource };
}
