import { createClient, type RedisClientType } from "redis";
import type { VehiclePosition } from "../types.js";

const VEHICLE_HASH_KEY = "stcp:vehicles:latest";

export class RedisVehicleStore {
  private readonly client: RedisClientType;
  private readonly memory = new Map<string, VehiclePosition>();
  private useMemoryFallback = false;

  constructor(redisUrl: string) {
    this.client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 1_500,
        reconnectStrategy: false
      }
    });
    this.client.on("error", (error) => {
      if (!this.useMemoryFallback) {
        console.error("[redis] connection error", error);
      }
    });
  }

  async connect() {
    if (this.client.isOpen || this.useMemoryFallback) return;

    try {
      await this.client.connect();
    } catch (error) {
      this.useMemoryFallback = true;
      console.warn("[redis] unavailable, using in-memory vehicle cache");
      if (this.client.isOpen) {
        await this.client.quit();
      }
    }
  }

  async disconnect() {
    if (!this.useMemoryFallback && this.client.isOpen) {
      await this.client.quit();
    }
  }

  async getAll(): Promise<Map<string, VehiclePosition>> {
    if (this.useMemoryFallback) {
      return new Map(this.memory);
    }

    const raw = await this.client.hGetAll(VEHICLE_HASH_KEY);
    return new Map(
      Object.entries(raw).map(([vehicleId, value]) => [
        vehicleId,
        JSON.parse(value) as VehiclePosition
      ])
    );
  }

  async upsertMany(vehicles: VehiclePosition[]) {
    if (vehicles.length === 0) return;

    if (this.useMemoryFallback) {
      for (const vehicle of vehicles) {
        this.memory.set(vehicle.vehicle_id, vehicle);
      }
      return;
    }

    const entries = vehicles.flatMap((vehicle) => [
      vehicle.vehicle_id,
      JSON.stringify(vehicle)
    ]);

    await this.client.hSet(VEHICLE_HASH_KEY, entries);
  }

  async removeMany(vehicleIds: string[]) {
    if (vehicleIds.length === 0) return;

    if (this.useMemoryFallback) {
      for (const vehicleId of vehicleIds) {
        this.memory.delete(vehicleId);
      }
      return;
    }

    await this.client.hDel(VEHICLE_HASH_KEY, vehicleIds);
  }
}
