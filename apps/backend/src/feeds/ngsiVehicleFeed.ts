import type { VehicleFeed, VehiclePosition } from "../types.js";

type NgsiAttribute<T> = {
  value?: T;
};

type NgsiVehicleEntity = {
  id: string;
  fleetVehicleId?: NgsiAttribute<string>;
  name?: NgsiAttribute<string>;
  annotations?: NgsiAttribute<string[]>;
  location?: NgsiAttribute<{
    type: "Point";
    coordinates: [number, number];
  }>;
  bearing?: NgsiAttribute<number>;
  heading?: NgsiAttribute<number>;
  speed?: NgsiAttribute<number>;
  observationDateTime?: NgsiAttribute<string>;
};

export class NgsiVehicleFeed implements VehicleFeed {
  constructor(private readonly url: string) {}

  async fetchPositions(): Promise<VehiclePosition[]> {
    const response = await fetch(this.url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`NGSI feed returned ${response.status}`);
    }

    const entities = (await response.json()) as NgsiVehicleEntity[];

    return entities
      .map((entity) => toVehiclePosition(entity))
      .filter((vehicle): vehicle is VehiclePosition => vehicle !== null);
  }
}

function toVehiclePosition(entity: NgsiVehicleEntity): VehiclePosition | null {
  const coordinates = entity.location?.value?.coordinates;
  if (!coordinates || coordinates.length < 2) return null;

  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const fleetVehicleId = entity.fleetVehicleId?.value;
  const routeId = extractRouteId(entity.annotations?.value, entity.name?.value);
  const directionId = extractDirectionId(entity.annotations?.value);
  const bearing = entity.bearing?.value ?? entity.heading?.value ?? 0;

  return {
    vehicle_id: fleetVehicleId ? `stcp-${fleetVehicleId}` : entity.id,
    line_number: routeId,
    latitude,
    longitude,
    bearing: normalizeBearing(Number(bearing)),
    speed:
      entity.speed?.value === undefined || entity.speed?.value === null
        ? null
        : Number(entity.speed.value),
    direction_id: directionId,
    next_stop_id: null,
    next_stop_name: null,
    next_stop_eta_min: null,
    next_stop_distance_meters: null,
    updated_at: entity.observationDateTime?.value ?? new Date().toISOString()
  };
}

function extractRouteId(annotations: string[] | undefined, name: string | undefined) {
  const routeAnnotation = annotations?.find((entry) => entry.startsWith("stcp:route:"));
  if (routeAnnotation) {
    return routeAnnotation.replace("stcp:route:", "");
  }

  const nameRoute = name?.match(/^STCP\s+([A-Z0-9]+)\s+/i)?.[1];
  return nameRoute ?? "STCP";
}

function extractDirectionId(annotations: string[] | undefined) {
  const directionAnnotation = annotations?.find((entry) => entry.startsWith("stcp:sentido:"));
  return directionAnnotation?.replace("stcp:sentido:", "") ?? null;
}

function normalizeBearing(value: number) {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}
