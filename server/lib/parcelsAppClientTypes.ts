// Extracted from ./parcelsAppClient.ts

export interface ParcelsAppEvent {
  date: string | null;
  status: string | null;
  location: string | null;
  description: string | null;
}

export interface ParcelsAppShipment {
  trackingId: string;
  /** Alternate id some ParcelsApp payloads use instead of trackingId */
  id?: string;
  done: boolean;
  fromCache?: boolean;
  // ParcelsApp normally returns attributes as an array of {l, val} objects,
  // but malformed/partial entries are possible and must be tolerated.
  attributes?:
    | Array<{ l?: unknown; val?: unknown; [k: string]: unknown }>
    | {
        status?: string;
        location?: string;
        description?: string;
        weight?: string;
        origin?: string;
        destination?: string;
        estimatedDeliveryDate?: string;
        estimatedDelivery?: string;
        deliveryDate?: string;
        expectedDelivery?: string;
        estimatedArrival?: string;
        arrivalDate?: string;
        eta?: string;
        [key: string]: string | undefined;
      };
  // Top-level ETA / delivery fields ParcelsApp may return directly on the shipment
  estimatedArrival?: string;
  estimatedDeliveryDate?: string;
  estimatedDelivery?: string;
  eta?: string;
  delivered_by?: string;
  states?: Array<{
    date: string;
    status: string;
    location?: string;
    description?: string;
  }>;
  status?: string;
  error?: string;
}

export interface ParcelsAppTrackResult {
  success: boolean;
  shipment: ParcelsAppShipment | null;
  rawResponse: unknown;
  error?: string;
  timedOut?: boolean;
}
