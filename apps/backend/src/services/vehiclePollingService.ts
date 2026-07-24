import type { RedisVehicleStore } from "../cache/redisStore.js";
import type { SocketHub } from "../realtime/socketHub.js";
import type { GtfsNextStopsService } from "./gtfsNextStopsService.js";
import type { VehicleDelta, VehicleFeed, VehiclePosition } from "../types.js";

type VehiclePollingServiceOptions = {
  feed: VehicleFeed;
  store: RedisVehicleStore;
  socketHub: SocketHub;
  nextStopsService?: GtfsNextStopsService;
  pollIntervalMs: number;
  staleAfterSeconds: number;
};

export class VehiclePollingService {
  private timer: NodeJS.Timeout | null = null;
  private readonly missingSince = new Map<string, number>();

  constructor(private readonly options: VehiclePollingServiceOptions) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    try {
      const fetchedVehicles = await this.options.feed.fetchPositions();
      const nextVehicles = this.options.nextStopsService
        ? await this.options.nextStopsService.enrichVehicles(fetchedVehicles)
        : fetchedVehicles;
      const previous = await this.options.store.getAll();
      const delta = computeDelta(
        previous,
        nextVehicles,
        this.options.staleAfterSeconds,
        this.missingSince
      );

      await this.options.store.upsertMany(delta.upserted);
      await this.options.store.removeMany(delta.removed);

      if (delta.upserted.length > 0 || delta.removed.length > 0) {
        this.options.socketHub.broadcastDelta(delta);
      }

      console.info(
        `[poller] ${nextVehicles.length} vehicles, ${delta.upserted.length} updated, ${delta.removed.length} removed`
      );
    } catch (error) {
      console.error("[poller] failed to refresh vehicle positions", error);
    }
  }
}

function computeDelta(
  previous: Map<string, VehiclePosition>,
  nextVehicles: VehiclePosition[],
  staleAfterSeconds: number,
  missingSince: Map<string, number>
): VehicleDelta {
  const nextById = new Map(nextVehicles.map((vehicle) => [vehicle.vehicle_id, vehicle]));
  const now = Date.now();

  for (const vehicleId of nextById.keys()) {
    missingSince.delete(vehicleId);
  }

  const upserted = nextVehicles.filter((vehicle) => {
    const old = previous.get(vehicle.vehicle_id);
    return !old || hasMeaningfulChange(old, vehicle);
  });

  const removed = [...previous.values()]
    .filter((vehicle) => !nextById.has(vehicle.vehicle_id))
    .filter((vehicle) => {
      const firstMissingAt = missingSince.get(vehicle.vehicle_id) ?? now;
      missingSince.set(vehicle.vehicle_id, firstMissingAt);
      return now - firstMissingAt > staleAfterSeconds * 1000;
    })
    .map((vehicle) => vehicle.vehicle_id);

  return {
    upserted,
    removed,
    serverTime: new Date().toISOString()
  };
}

function hasMeaningfulChange(old: VehiclePosition, next: VehiclePosition) {
  return (
    old.line_number !== next.line_number ||
    old.direction_id !== next.direction_id ||
    old.next_stop_id !== next.next_stop_id ||
    old.next_stop_name !== next.next_stop_name ||
    old.next_stop_eta_min !== next.next_stop_eta_min ||
    old.next_stop_distance_meters !== next.next_stop_distance_meters ||
    old.speed !== next.speed ||
    old.bearing !== next.bearing ||
    Math.abs(old.latitude - next.latitude) > 0.00001 ||
    Math.abs(old.longitude - next.longitude) > 0.00001 ||
    old.updated_at !== next.updated_at
  );
}
