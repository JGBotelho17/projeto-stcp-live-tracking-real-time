import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import type { VehiclePosition } from "../types.js";

const MIN_URBAN_SPEED_METERS_PER_SECOND = 4.2;

type TripRow = {
  route_id: string;
  direction_id: string;
  trip_id: string;
  shape_id: string;
};

type StopTimeRow = {
  trip_id: string;
  stop_id: string;
  stop_sequence: string;
};

type StopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
};

type ShapeRow = {
  shape_id: string;
  shape_pt_lat: string;
  shape_pt_lon: string;
  shape_pt_sequence: string;
};

type RouteShapeIndex = {
  route_id: string;
  direction_id: string;
  shape_id: string;
  coordinates: Array<[number, number]>;
  cumulativeMeters: number[];
  totalMeters: number;
};

type RouteStop = {
  stop_id: string;
  stop_name: string;
  distanceAlongShapeMeters: number;
};

type NextStopIndex = {
  shapesByRouteDirection: Map<string, RouteShapeIndex>;
  stopsByRouteDirection: Map<string, RouteStop[]>;
};

export class GtfsNextStopsService {
  private index: NextStopIndex | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async enrichVehicles(vehicles: VehiclePosition[]) {
    const index = await this.getIndex();

    return vehicles.map((vehicle) => {
      const nextStop = this.findNextStop(vehicle, index);
      if (!nextStop) return vehicle;

      return {
        ...vehicle,
        next_stop_id: nextStop.stop_id,
        next_stop_name: nextStop.stop_name,
        next_stop_eta_min: nextStop.etaMin,
        next_stop_distance_meters: Math.round(nextStop.distanceToStopMeters)
      };
    });
  }

  private findNextStop(vehicle: VehiclePosition, index: NextStopIndex) {
    const directionId = vehicle.direction_id;
    if (!directionId) return null;

    const key = routeDirectionKey(vehicle.line_number, directionId);
    const shape = index.shapesByRouteDirection.get(key);
    const stops = index.stopsByRouteDirection.get(key);
    if (!shape || !stops || stops.length === 0) return null;

    const projection = projectPointToShape([vehicle.longitude, vehicle.latitude], shape);
    if (projection.distanceFromShapeMeters > 140) return null;

    const lookAheadMeters = Math.max(20, (vehicle.speed ?? 0) * 4);
    const nextStop = stops.find(
      (stop) =>
        stop.distanceAlongShapeMeters >
        projection.distanceAlongShapeMeters + lookAheadMeters
    );

    const stop = nextStop ?? stops[0] ?? null;
    if (!stop) return null;

    const distanceToStopMeters =
      stop.distanceAlongShapeMeters >= projection.distanceAlongShapeMeters
        ? stop.distanceAlongShapeMeters - projection.distanceAlongShapeMeters
        : shape.totalMeters - projection.distanceAlongShapeMeters + stop.distanceAlongShapeMeters;
    const speed = Math.max(vehicle.speed ?? 0, MIN_URBAN_SPEED_METERS_PER_SECOND);

    return {
      ...stop,
      distanceToStopMeters,
      etaMin: Math.max(1, Math.ceil(distanceToStopMeters / speed / 60))
    };
  }

  private async getIndex() {
    if (this.index && Date.now() - this.loadedAt < this.ttlMs) {
      return this.index;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`GTFS static feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const tripsEntry = zip.getEntry("trips.txt");
    const stopTimesEntry = zip.getEntry("stop_times.txt");
    const stopsEntry = zip.getEntry("stops.txt");
    const shapesEntry = zip.getEntry("shapes.txt");

    if (!tripsEntry || !stopTimesEntry || !stopsEntry || !shapesEntry) {
      throw new Error("GTFS static feed must contain trips, stop_times, stops and shapes");
    }

    const trips = parseCsv<TripRow>(tripsEntry.getData().toString("utf8"));
    const selectedShapeByRouteDirection = selectMostCommonShapes(trips);
    const selectedTripByRouteDirection = selectRepresentativeTrips(
      trips,
      selectedShapeByRouteDirection
    );

    const shapeIds = new Set(selectedShapeByRouteDirection.values());
    const routeDirectionByShape = invertShapeSelection(selectedShapeByRouteDirection);
    const shapesByRouteDirection = buildShapeIndex(
      parseCsv<ShapeRow>(shapesEntry.getData().toString("utf8")),
      shapeIds,
      routeDirectionByShape
    );

    const stopsById = buildStopsById(parseCsv<StopRow>(stopsEntry.getData().toString("utf8")));
    const routeDirectionByTripId = invertTripSelection(selectedTripByRouteDirection);
    const stopsByRouteDirection = buildRouteStops(
      parseCsv<StopTimeRow>(stopTimesEntry.getData().toString("utf8")),
      routeDirectionByTripId,
      stopsById,
      shapesByRouteDirection
    );

    this.index = {
      shapesByRouteDirection,
      stopsByRouteDirection
    };
    this.loadedAt = Date.now();
    return this.index;
  }
}

function parseCsv<T>(content: string) {
  return parse(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  }) as T[];
}

function selectMostCommonShapes(trips: TripRow[]) {
  const counts = new Map<string, Map<string, number>>();

  for (const trip of trips) {
    if (!trip.route_id || !trip.direction_id || !trip.shape_id) continue;

    const key = routeDirectionKey(trip.route_id, trip.direction_id);
    const shapeCounts = counts.get(key) ?? new Map<string, number>();
    shapeCounts.set(trip.shape_id, (shapeCounts.get(trip.shape_id) ?? 0) + 1);
    counts.set(key, shapeCounts);
  }

  const selected = new Map<string, string>();
  for (const [key, shapeCounts] of counts) {
    const [shapeId] = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    selected.set(key, shapeId);
  }

  return selected;
}

function selectRepresentativeTrips(
  trips: TripRow[],
  selectedShapeByRouteDirection: Map<string, string>
) {
  const selected = new Map<string, string>();

  for (const trip of trips) {
    const key = routeDirectionKey(trip.route_id, trip.direction_id);
    if (selected.has(key)) continue;
    if (selectedShapeByRouteDirection.get(key) !== trip.shape_id) continue;
    selected.set(key, trip.trip_id);
  }

  return selected;
}

function invertShapeSelection(selectedShapeByRouteDirection: Map<string, string>) {
  const routeDirectionByShape = new Map<string, string>();

  for (const [routeDirection, shapeId] of selectedShapeByRouteDirection) {
    routeDirectionByShape.set(shapeId, routeDirection);
  }

  return routeDirectionByShape;
}

function invertTripSelection(selectedTripByRouteDirection: Map<string, string>) {
  const routeDirectionByTripId = new Map<string, string>();

  for (const [routeDirection, tripId] of selectedTripByRouteDirection) {
    routeDirectionByTripId.set(tripId, routeDirection);
  }

  return routeDirectionByTripId;
}

function buildShapeIndex(
  rows: ShapeRow[],
  shapeIds: Set<string>,
  routeDirectionByShape: Map<string, string>
) {
  const pointsByShape = new Map<
    string,
    Array<{ sequence: number; coordinate: [number, number] }>
  >();

  for (const row of rows) {
    if (!shapeIds.has(row.shape_id)) continue;

    const latitude = Number(row.shape_pt_lat);
    const longitude = Number(row.shape_pt_lon);
    const sequence = Number(row.shape_pt_sequence);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(sequence)) {
      continue;
    }

    const points = pointsByShape.get(row.shape_id) ?? [];
    points.push({ sequence, coordinate: [longitude, latitude] });
    pointsByShape.set(row.shape_id, points);
  }

  const shapesByRouteDirection = new Map<string, RouteShapeIndex>();

  for (const [shapeId, points] of pointsByShape) {
    const routeDirection = routeDirectionByShape.get(shapeId);
    if (!routeDirection) continue;

    const [routeId, directionId] = routeDirection.split(":");
    const coordinates = points
      .sort((a, b) => a.sequence - b.sequence)
      .map((point) => point.coordinate);
    const cumulativeMeters = buildCumulativeMeters(coordinates);

    shapesByRouteDirection.set(routeDirection, {
      route_id: routeId,
      direction_id: directionId,
      shape_id: shapeId,
      coordinates,
      cumulativeMeters,
      totalMeters: cumulativeMeters[cumulativeMeters.length - 1] ?? 0
    });
  }

  return shapesByRouteDirection;
}

function buildStopsById(rows: StopRow[]) {
  const stopsById = new Map<string, { stop_name: string; coordinate: [number, number] }>();

  for (const row of rows) {
    const latitude = Number(row.stop_lat);
    const longitude = Number(row.stop_lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    stopsById.set(row.stop_id, {
      stop_name: row.stop_name,
      coordinate: [longitude, latitude]
    });
  }

  return stopsById;
}

function buildRouteStops(
  rows: StopTimeRow[],
  routeDirectionByTripId: Map<string, string>,
  stopsById: Map<string, { stop_name: string; coordinate: [number, number] }>,
  shapesByRouteDirection: Map<string, RouteShapeIndex>
) {
  const rowsByRouteDirection = new Map<
    string,
    Array<{ sequence: number; stop_id: string }>
  >();

  for (const row of rows) {
    const routeDirection = routeDirectionByTripId.get(row.trip_id);
    if (!routeDirection) continue;

    const sequence = Number(row.stop_sequence);
    if (!Number.isFinite(sequence)) continue;

    const stopRows = rowsByRouteDirection.get(routeDirection) ?? [];
    stopRows.push({ sequence, stop_id: row.stop_id });
    rowsByRouteDirection.set(routeDirection, stopRows);
  }

  const stopsByRouteDirection = new Map<string, RouteStop[]>();

  for (const [routeDirection, stopRows] of rowsByRouteDirection) {
    const shape = shapesByRouteDirection.get(routeDirection);
    if (!shape) continue;

    const routeStops = stopRows
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => {
        const stop = stopsById.get(row.stop_id);
        if (!stop) return null;

        const projection = projectPointToShape(stop.coordinate, shape);
        return {
          stop_id: row.stop_id,
          stop_name: stop.stop_name,
          distanceAlongShapeMeters: projection.distanceAlongShapeMeters
        };
      })
      .filter((stop): stop is RouteStop => stop !== null)
      .sort((a, b) => a.distanceAlongShapeMeters - b.distanceAlongShapeMeters);

    stopsByRouteDirection.set(routeDirection, routeStops);
  }

  return stopsByRouteDirection;
}

function buildCumulativeMeters(coordinates: Array<[number, number]>) {
  const cumulativeMeters = [0];

  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeMeters[index] =
      cumulativeMeters[index - 1] +
      distanceMeters(coordinates[index - 1], coordinates[index]);
  }

  return cumulativeMeters;
}

function projectPointToShape(point: [number, number], shape: RouteShapeIndex) {
  let bestDistanceFromShapeMeters = Number.POSITIVE_INFINITY;
  let bestDistanceAlongShapeMeters = 0;

  for (let index = 1; index < shape.coordinates.length; index += 1) {
    const start = shape.coordinates[index - 1];
    const end = shape.coordinates[index];
    const segmentProjection = projectPointToSegment(point, start, end);
    const distanceFromShapeMeters = distanceMeters(point, segmentProjection.coordinate);

    if (distanceFromShapeMeters < bestDistanceFromShapeMeters) {
      bestDistanceFromShapeMeters = distanceFromShapeMeters;
      bestDistanceAlongShapeMeters =
        shape.cumulativeMeters[index - 1] +
        distanceMeters(start, segmentProjection.coordinate);
    }
  }

  return {
    distanceAlongShapeMeters: bestDistanceAlongShapeMeters,
    distanceFromShapeMeters: bestDistanceFromShapeMeters
  };
}

function projectPointToSegment(
  point: [number, number],
  start: [number, number],
  end: [number, number]
) {
  const origin = point;
  const p = toLocalMeters(point, origin);
  const a = toLocalMeters(start, origin);
  const b = toLocalMeters(end, origin);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));

  return {
    coordinate: [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t
    ] as [number, number]
  };
}

function toLocalMeters(coordinate: [number, number], origin: [number, number]) {
  const metersPerDegreeLongitude = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
  return {
    x: (coordinate[0] - origin[0]) * metersPerDegreeLongitude,
    y: (coordinate[1] - origin[1]) * 110_540
  };
}

function distanceMeters(from: [number, number], to: [number, number]) {
  const origin = from;
  const a = toLocalMeters(from, origin);
  const b = toLocalMeters(to, origin);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function routeDirectionKey(routeId: string, directionId: string) {
  return `${routeId}:${directionId}`;
}
