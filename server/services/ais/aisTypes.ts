export type AisConnectionState = "disabled" | "connecting" | "connected" | "reconnecting" | "stopped";

export interface AisPositionUpdate {
  kind: "position";
  mmsi: string;
  vesselName: string | null;
  latitude: number;
  longitude: number;
  speedKnots: number | null;
  course: number | null;
  heading: number | null;
  navigationStatus: string | null;
  observedAt: Date;
}

export interface AisStaticUpdate {
  kind: "static";
  mmsi: string;
  vesselName: string | null;
  imo: string | null;
  destination: string | null;
  eta: Date | null;
  observedAt: Date;
}

export type AisUpdate = AisPositionUpdate | AisStaticUpdate;

export interface AisHealthSnapshot {
  state: AisConnectionState;
  configured: boolean;
  connectedAt: Date | null;
  lastMessageAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  messagesReceived: number;
  messagesRejected: number;
  reconnects: number;
}
