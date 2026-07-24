import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { VehicleFeed, VehiclePosition } from "../types.js";

type GtfsRealtimeFeedOptions = {
  url: string;
  authHeader?: string;
};

export class GtfsRealtimeVehicleFeed implements VehicleFeed {
  constructor(private readonly options: GtfsRealtimeFeedOptions) {}

  async fetchPositions(): Promise<VehiclePosition[]> {
    const headers: Record<string, string> = {};
    if (this.options.authHeader) {
      headers.Authorization = this.options.authHeader;
    }

    const response = await fetch(this.options.url, { headers });
    if (!response.ok) {
      throw new Error(`GTFS-RT feed returned ${response.status}`);
    }

    const body = new Uint8Array(await response.arrayBuffer());
    const decoded =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body);

    const now = new Date().toISOString();

    return decoded.entity
      .filter((entity) => Boolean(entity.vehicle?.position))
      .map((entity) => {
        const vehicle = entity.vehicle;
        const position = vehicle?.position;
        const timestamp = vehicle?.timestamp
          ? new Date(Number(vehicle.timestamp) * 1000).toISOString()
          : now;

        return {
          vehicle_id:
            vehicle?.vehicle?.id ||
            vehicle?.vehicle?.label ||
            entity.id,
          line_number:
            vehicle?.trip?.routeId ||
            vehicle?.vehicle?.label ||
            "STCP",
          latitude: Number(position?.latitude),
          longitude: Number(position?.longitude),
          bearing: normalizeBearing(Number(position?.bearing ?? 0)),
          speed:
            position?.speed === null || position?.speed === undefined
              ? null
              : Number(position.speed),
          direction_id: null,
          next_stop_id: vehicle?.stopId || null,
          next_stop_name: null,
          next_stop_eta_min: null,
          next_stop_distance_meters: null,
          updated_at: timestamp
        };
      })
      .filter(
        (vehicle) =>
          Number.isFinite(vehicle.latitude) &&
          Number.isFinite(vehicle.longitude)
      );
  }
}

function normalizeBearing(value: number) {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}
