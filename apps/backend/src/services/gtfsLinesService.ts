import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color?: string;
  route_text_color?: string;
};

type TripRow = {
  route_id: string;
  trip_id: string;
  direction_id: string;
  trip_headsign?: string;
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

type LineDirection = {
  direction_id: string;
  headsign: string;
  stops: Array<{
    stop_id: string;
    stop_name: string;
    latitude: number;
    longitude: number;
  }>;
};

type TransitLine = {
  id: string;
  number: string;
  name: string;
  color: string;
  text_color: string;
  directions: LineDirection[];
};

export class GtfsLinesService {
  private lines: TransitLine[] | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async getLines() {
    if (this.lines && Date.now() - this.loadedAt < this.ttlMs) {
      return this.lines;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`GTFS static feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const routesEntry = zip.getEntry("routes.txt");
    const tripsEntry = zip.getEntry("trips.txt");
    const stopTimesEntry = zip.getEntry("stop_times.txt");
    const stopsEntry = zip.getEntry("stops.txt");

    if (!routesEntry || !tripsEntry || !stopTimesEntry || !stopsEntry) {
      throw new Error("GTFS static feed must contain routes, trips, stop_times and stops");
    }

    const routes = parseCsv<RouteRow>(routesEntry.getData().toString("utf8"));
    const trips = parseCsv<TripRow>(tripsEntry.getData().toString("utf8"));
    const stopTimes = parseCsv<StopTimeRow>(stopTimesEntry.getData().toString("utf8"));
    const stopsById = buildStopsById(parseCsv<StopRow>(stopsEntry.getData().toString("utf8")));
    const representativeTrips = selectRepresentativeTrips(trips, stopTimes);
    const stopTimesByTripId = groupStopTimesByTripId(stopTimes);

    this.lines = routes
      .map((route) => {
        const routeTrips = representativeTrips.get(route.route_id) ?? [];
        const directions = routeTrips
          .map((trip) => {
            const stops = (stopTimesByTripId.get(trip.trip_id) ?? [])
              .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence))
              .map((stopTime) => stopsById.get(stopTime.stop_id))
              .filter((stop): stop is LineDirection["stops"][number] => stop !== undefined);

            if (stops.length === 0) return null;

            return {
              direction_id: trip.direction_id || "0",
              headsign: trip.trip_headsign || stops[stops.length - 1]?.stop_name || `Sentido ${trip.direction_id || "0"}`,
              stops
            };
          })
          .filter((direction): direction is LineDirection => direction !== null)
          .sort((a, b) => a.direction_id.localeCompare(b.direction_id, "pt-PT", { numeric: true }));

        return {
          id: route.route_id,
          number: route.route_short_name || route.route_id,
          name: route.route_long_name || route.route_short_name || route.route_id,
          color: normalizeColor(route.route_color, "#187ec2"),
          text_color: normalizeColor(route.route_text_color, "#ffffff"),
          directions
        };
      })
      .filter((line) => line.directions.length > 0)
      .sort((a, b) => a.number.localeCompare(b.number, "pt-PT", { numeric: true }));

    this.loadedAt = Date.now();
    return this.lines;
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

function buildStopsById(rows: StopRow[]) {
  const stopsById = new Map<string, LineDirection["stops"][number]>();

  for (const row of rows) {
    const latitude = Number(row.stop_lat);
    const longitude = Number(row.stop_lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    stopsById.set(row.stop_id, {
      stop_id: row.stop_id,
      stop_name: row.stop_name,
      latitude,
      longitude
    });
  }

  return stopsById;
}

function selectRepresentativeTrips(trips: TripRow[], stopTimes: StopTimeRow[]) {
  const stopCountByTripId = new Map<string, number>();
  for (const stopTime of stopTimes) {
    stopCountByTripId.set(stopTime.trip_id, (stopCountByTripId.get(stopTime.trip_id) ?? 0) + 1);
  }

  const selected = new Map<string, TripRow[]>();

  for (const trip of trips) {
    if (!trip.route_id || !trip.trip_id) continue;

    const directionId = trip.direction_id || "0";
    const routeTrips = selected.get(trip.route_id) ?? [];
    const existingIndex = routeTrips.findIndex((selectedTrip) => (selectedTrip.direction_id || "0") === directionId);
    const existing = existingIndex >= 0 ? routeTrips[existingIndex] : null;
    const tripStopCount = stopCountByTripId.get(trip.trip_id) ?? 0;
    const existingStopCount = existing ? stopCountByTripId.get(existing.trip_id) ?? 0 : -1;

    if (!existing || tripStopCount > existingStopCount) {
      const nextTrip = { ...trip, direction_id: directionId };
      if (existingIndex >= 0) {
        routeTrips[existingIndex] = nextTrip;
      } else {
        routeTrips.push(nextTrip);
      }
      selected.set(trip.route_id, routeTrips);
    }
  }

  return selected;
}

function groupStopTimesByTripId(rows: StopTimeRow[]) {
  const stopTimesByTripId = new Map<string, StopTimeRow[]>();

  for (const row of rows) {
    const rowsForTrip = stopTimesByTripId.get(row.trip_id) ?? [];
    rowsForTrip.push(row);
    stopTimesByTripId.set(row.trip_id, rowsForTrip);
  }

  return stopTimesByTripId;
}

function normalizeColor(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const color = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}
