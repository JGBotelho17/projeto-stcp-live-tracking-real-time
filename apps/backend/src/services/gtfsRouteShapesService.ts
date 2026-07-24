import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import type { RouteShape } from "../types.js";

type TripRow = {
  route_id: string;
  direction_id: string;
  shape_id: string;
};

type ShapeRow = {
  shape_id: string;
  shape_pt_lat: string;
  shape_pt_lon: string;
  shape_pt_sequence: string;
};

export class GtfsRouteShapesService {
  private shapes: RouteShape[] | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async getRouteShapes() {
    if (this.shapes && Date.now() - this.loadedAt < this.ttlMs) {
      return this.shapes;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`GTFS static feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const tripsEntry = zip.getEntry("trips.txt");
    const shapesEntry = zip.getEntry("shapes.txt");
    if (!tripsEntry || !shapesEntry) {
      throw new Error("GTFS static feed must contain trips.txt and shapes.txt");
    }

    const trips = parse(tripsEntry.getData().toString("utf8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true
    }) as TripRow[];

    const selectedShapeByRouteDirection = selectMostCommonShapes(trips);
    const selectedShapeIds = new Set(selectedShapeByRouteDirection.values());

    const shapeRows = parse(shapesEntry.getData().toString("utf8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true
    }) as ShapeRow[];

    const coordinatesByShape = new Map<
      string,
      Array<{ sequence: number; coordinate: [number, number] }>
    >();

    for (const row of shapeRows) {
      if (!selectedShapeIds.has(row.shape_id)) continue;

      const longitude = Number(row.shape_pt_lon);
      const latitude = Number(row.shape_pt_lat);
      const sequence = Number(row.shape_pt_sequence);
      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(sequence)
      ) {
        continue;
      }

      const points = coordinatesByShape.get(row.shape_id) ?? [];
      points.push({ sequence, coordinate: [longitude, latitude] });
      coordinatesByShape.set(row.shape_id, points);
    }

    this.shapes = [...selectedShapeByRouteDirection.entries()]
      .map(([routeDirectionKey, shapeId]) => {
        const [routeId, directionId] = routeDirectionKey.split(":");
        const points = coordinatesByShape.get(shapeId) ?? [];

        return {
          route_id: routeId,
          direction_id: directionId,
          shape_id: shapeId,
          coordinates: points
            .sort((a, b) => a.sequence - b.sequence)
            .map((point) => point.coordinate)
        };
      })
      .filter((shape) => shape.coordinates.length >= 2);

    this.loadedAt = Date.now();
    return this.shapes;
  }
}

function selectMostCommonShapes(trips: TripRow[]) {
  const counts = new Map<string, Map<string, number>>();

  for (const trip of trips) {
    if (!trip.route_id || !trip.direction_id || !trip.shape_id) continue;

    const key = `${trip.route_id}:${trip.direction_id}`;
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
