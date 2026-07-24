import type { VehicleFeed, VehiclePosition } from "../types.js";

const center = { latitude: 41.1579, longitude: -8.6291 };

const seedVehicles = [
  { vehicle_id: "stcp-200-01", line_number: "200", offset: 0 },
  { vehicle_id: "stcp-207-03", line_number: "207", offset: 0.9 },
  { vehicle_id: "stcp-208-02", line_number: "208", offset: 1.8 },
  { vehicle_id: "stcp-500-05", line_number: "500", offset: 2.7 },
  { vehicle_id: "stcp-600-04", line_number: "600", offset: 3.6 },
  { vehicle_id: "stcp-701-02", line_number: "701", offset: 4.5 }
];

export class MockVehicleFeed implements VehicleFeed {
  async fetchPositions(): Promise<VehiclePosition[]> {
    const elapsed = Date.now() / 1000;

    return seedVehicles.map((vehicle, index) => {
      const t = elapsed / (46 + index * 4) + vehicle.offset;
      const latitude = center.latitude + Math.sin(t) * (0.012 + index * 0.001);
      const longitude = center.longitude + Math.cos(t * 0.86) * (0.018 + index * 0.001);
      const bearing = angleFromVelocity(t, index);

      return {
        vehicle_id: vehicle.vehicle_id,
        line_number: vehicle.line_number,
        latitude,
        longitude,
        bearing,
        speed: 7 + index * 1.4,
        direction_id: index % 2 === 0 ? "0" : "1",
        next_stop_id: `P${2100 + index}`,
        next_stop_name: `Paragem ${2100 + index}`,
        next_stop_eta_min: 2 + index,
        next_stop_distance_meters: 260 + index * 140,
        updated_at: new Date().toISOString()
      };
    });
  }
}

function angleFromVelocity(t: number, index: number) {
  const dy = Math.cos(t) * (0.012 + index * 0.001);
  const dx = -Math.sin(t * 0.86) * (0.018 + index * 0.001);
  const radians = Math.atan2(dx, dy);
  return ((radians * 180) / Math.PI + 360) % 360;
}
