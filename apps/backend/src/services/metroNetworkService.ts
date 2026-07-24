import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_text_color: string;
};

type StopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  zone_id: string;
};

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

export class MetroNetworkService {
  private network: unknown | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async getNetwork() {
    if (this.network && Date.now() - this.loadedAt < this.ttlMs) {
      return this.network;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`Metro GTFS feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const routes = parseCsv<RouteRow>(zip, "routes.txt");
    const stops = parseCsv<StopRow>(zip, "stops.txt");
    const trips = parseCsv<TripRow>(zip, "trips.txt");
    const shapes = parseCsv<ShapeRow>(zip, "shapes.txt");

    const routeById = new Map(routes.map((route) => [route.route_id, route]));
    const selectedShapeKeys = selectShapesByRouteDirection(trips);
    const selectedShapeIds = new Set(selectedShapeKeys.values());
    const shapeRouteDirectionByShapeId = invertShapeSelection(selectedShapeKeys);

    const pointsByShape = new Map<
      string,
      Array<{ sequence: number; coordinate: [number, number] }>
    >();

    for (const row of shapes) {
      if (!selectedShapeIds.has(row.shape_id)) continue;

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

    const lineFeatures = [...pointsByShape.entries()].map(([shapeId, points]) => {
      const routeDirection = shapeRouteDirectionByShapeId.get(shapeId);
      const [routeId, directionId] = routeDirection?.split(":") ?? ["", ""];
      const route = routeById.get(routeId);

      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: points
            .sort((a, b) => a.sequence - b.sequence)
            .map((point) => point.coordinate)
        },
        properties: {
          route_id: routeId,
          direction_id: directionId,
          line: route?.route_short_name || routeId,
          color: normalizeColor(route?.route_color),
          text_color: normalizeColor(route?.route_text_color, "FFFFFF")
        }
      };
    });

    this.network = {
      stations: {
        type: "FeatureCollection",
        features: stops.map((stop) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [Number(stop.stop_lon), Number(stop.stop_lat)]
          },
          properties: {
            id: stop.stop_id,
            name: stop.stop_name,
            zone: stop.zone_id
          }
        }))
      },
      lines: {
        type: "FeatureCollection",
        features: lineFeatures
      },
      routes: routes.map((route) => ({
        id: route.route_id,
        short_name: route.route_short_name,
        long_name: route.route_long_name,
        color: normalizeColor(route.route_color),
        text_color: normalizeColor(route.route_text_color, "FFFFFF")
      }))
    };

    this.loadedAt = Date.now();
    return this.network;
  }
}

function parseCsv<T>(zip: AdmZip, entryName: string) {
  const entry = zip.getEntry(entryName);
  if (!entry) {
    throw new Error(`Metro GTFS feed does not contain ${entryName}`);
  }

  return parse(entry.getData().toString("utf8"), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  }) as T[];
}

function selectShapesByRouteDirection(trips: TripRow[]) {
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

function invertShapeSelection(shapeByRouteDirection: Map<string, string>) {
  const routeDirectionByShapeId = new Map<string, string>();

  for (const [routeDirection, shapeId] of shapeByRouteDirection) {
    routeDirectionByShapeId.set(shapeId, routeDirection);
  }

  return routeDirectionByShapeId;
}

function normalizeColor(value: string | undefined, fallback = "777777") {
  const color = value?.replace("#", "").trim();
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : `#${fallback}`;
}
