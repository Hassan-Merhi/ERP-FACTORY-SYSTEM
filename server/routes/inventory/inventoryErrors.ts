export class InventoryRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "InventoryRouteError";
  }
}

export function inventoryErrorStatus(error: unknown, fallbackStatus = 500): number {
  return error instanceof InventoryRouteError ? error.statusCode : fallbackStatus;
}
