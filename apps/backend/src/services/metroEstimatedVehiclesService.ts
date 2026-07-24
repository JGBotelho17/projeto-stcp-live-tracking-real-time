import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";

const TIME_ZONE = "Europe/Lisbon";

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_color: string;
  route_text_color: string;
};

type StopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
};

type TripRow = {
  route_id: string;
  service_id: string;
  trip_id: string;
  trip_headsign: string;
  direction_id: string;
  shape_id: string;
};

type StopTimeRow = {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: string;
};

type ShapeRow = {
  shape_id: string;
  shape_pt_lat: string;
  shape_pt_lon: string;
  shape_pt_sequence: string;
};

type CalendarRow = {
  service_id: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  start_date: string;
  end_date: string;
};

type CalendarDateRow = {
  service_id: string;
  date: string;
  exception_type: string;
};

type ShapeIndex = {
  shape_id: string;
  coordinates: Array<[number, number]>;
  cumulativeMeters: number[];
  totalMeters: number;
};

type TripStop = {
  stop_id: string;
  stop_name: string;
  arrivalSeconds: number;
  departureSeconds: number;
  distanceAlongShapeMeters: number;
};

type TripIndex = {
  route_id: string;
  route_short_name: string;
  route_color: string;
  service_id: string;
  trip_id: string;
  trip_headsign: string;
  direction_id: string;
  shape: ShapeIndex;
  stops: TripStop[];
};

type MetroScheduleIndex = {
  calendars: CalendarRow[];
  calendarDates: CalendarDateRow[];
  trips: TripIndex[];
};

export class MetroEstimatedVehiclesService {
  private index: MetroScheduleIndex | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async getEstimatedVehicles() {
    const index = await this.getIndex();
    const localNow = getLisbonDateParts(new Date());
    const active = getActiveServiceIds(index, localNow.date, localNow.weekday);
    const activeServiceIds = active.serviceIds;
    const features = [];

    for (const trip of index.trips) {
      if (!activeServiceIds.has(trip.service_id)) continue;

      const firstStop = trip.stops[0];
      const lastStop = trip.stops[trip.stops.length - 1];
      if (!firstStop || !lastStop) continue;
      if (
        localNow.secondsSinceMidnight < firstStop.departureSeconds ||
        localNow.secondsSinceMidnight > lastStop.arrivalSeconds
      ) {
        continue;
      }

      const position = estimateTripPosition(trip, localNow.secondsSinceMidnight);
      if (!position) continue;

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [position.longitude, position.latitude]
        },
        properties: {
          id: trip.trip_id,
          line: trip.route_short_name,
          route_id: trip.route_id,
          headsign: trip.trip_headsign,
          direction_id: trip.direction_id,
          color: trip.route_color,
          bearing: position.bearing,
          next_station: position.nextStationName,
          eta_min: position.etaMin,
          estimated: true
        }
      });
    }

    return {
      type: "FeatureCollection",
      features,
      meta: {
        generated_at: new Date().toISOString(),
        mode: "timetable_estimate",
        schedule_source: active.fallbackTemplate ? "weekday_template" : "calendar",
        realtime: false
      }
    };
  }

  private async getIndex() {
    if (this.index && Date.now() - this.loadedAt < this.ttlMs) {
      return this.index;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`Metro GTFS feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const routes = parseCsv<RouteRow>(zip, "routes.txt");
    const stops = parseCsv<StopRow>(zip, "stops.txt");
    const trips = parseCsv<TripRow>(zip, "trips.txt");
    const stopTimes = parseCsv<StopTimeRow>(zip, "stop_times.txt");
    const shapes = parseCsv<ShapeRow>(zip, "shapes.txt");
    const calendars = parseCsv<CalendarRow>(zip, "calendar.txt");
    const calendarDates = parseCsv<CalendarDateRow>(zip, "calendar_dates.txt");

    const routeById = new Map(routes.map((route) => [route.route_id, route]));
    const stopById = buildStopsById(stops);
    const shapeById = buildShapesById(shapes);
    const stopTimesByTripId = groupStopTimes(stopTimes);

    const indexedTrips = trips
      .map((trip) => {
        const shape = shapeById.get(trip.shape_id);
        const route = routeById.get(trip.route_id);
        const tripStopTimes = stopTimesByTripId.get(trip.trip_id);
        if (!shape || !route || !tripStopTimes) return null;

        const tripStops = tripStopTimes
          .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence))
          .map((row) => {
            const stop = stopById.get(row.stop_id);
            if (!stop) return null;

            return {
              stop_id: row.stop_id,
              stop_name: stop.stop_name,
              arrivalSeconds: parseGtfsTime(row.arrival_time),
              departureSeconds: parseGtfsTime(row.departure_time),
              distanceAlongShapeMeters: projectPointToShape(stop.coordinate, shape)
                .distanceAlongShapeMeters
            };
          })
          .filter((stop): stop is TripStop => stop !== null);

        return {
          route_id: trip.route_id,
          route_short_name: route.route_short_name,
          route_color: normalizeColor(route.route_color),
          service_id: trip.service_id,
          trip_id: trip.trip_id,
          trip_headsign: trip.trip_headsign,
          direction_id: trip.direction_id,
          shape,
          stops: tripStops
        };
      })
      .filter((trip): trip is TripIndex => trip !== null && trip.stops.length >= 2);

    this.index = {
      calendars,
      calendarDates,
      trips: indexedTrips
    };
    this.loadedAt = Date.now();
    return this.index;
  }
}

function estimateTripPosition(trip: TripIndex, nowSeconds: number) {
  const nextStopIndex = trip.stops.findIndex(
    (stop) => stop.arrivalSeconds >= nowSeconds
  );
  const toStop = trip.stops[Math.max(0, nextStopIndex)];
  const fromStop = trip.stops[Math.max(0, nextStopIndex - 1)] ?? toStop;
  if (!toStop || !fromStop) return null;

  const interval = Math.max(1, toStop.arrivalSeconds - fromStop.departureSeconds);
  const progress = Math.min(
    1,
    Math.max(0, (nowSeconds - fromStop.departureSeconds) / interval)
  );
  const distanceAlongShapeMeters =
    fromStop.distanceAlongShapeMeters +
    (toStop.distanceAlongShapeMeters - fromStop.distanceAlongShapeMeters) * progress;
  const point = getPointAtDistance(trip.shape, distanceAlongShapeMeters);

  return {
    ...point,
    nextStationName: toStop.stop_name,
    etaMin: Math.max(0, Math.ceil((toStop.arrivalSeconds - nowSeconds) / 60))
  };
}

function getActiveServiceIds(
  index: MetroScheduleIndex,
  date: string,
  weekday: keyof CalendarRow
) {
  const inDateRange = new Set(
    index.calendars
      .filter(
        (calendar) =>
          calendar.start_date <= date &&
          calendar.end_date >= date &&
          calendar[weekday] === "1"
      )
      .map((calendar) => calendar.service_id)
  );
  applyCalendarExceptions(inDateRange, index.calendarDates, date);

  if (inDateRange.size > 0) {
    return { serviceIds: inDateRange, fallbackTemplate: false };
  }

  const weekdayTemplate = new Set(
    index.calendars
      .filter((calendar) => calendar[weekday] === "1")
      .map((calendar) => calendar.service_id)
  );

  return { serviceIds: weekdayTemplate, fallbackTemplate: true };
}

function applyCalendarExceptions(
  serviceIds: Set<string>,
  calendarDates: CalendarDateRow[],
  date: string
) {
  for (const exception of calendarDates) {
    if (exception.date !== date) continue;

    if (exception.exception_type === "1") {
      serviceIds.add(exception.service_id);
    }

    if (exception.exception_type === "2") {
      serviceIds.delete(exception.service_id);
    }
  }
}

function getLisbonDateParts(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  const weekday = String(parts.weekday).toLowerCase() as keyof CalendarRow;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);

  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    weekday,
    secondsSinceMidnight: hour * 3600 + minute * 60 + second
  };
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

function buildShapesById(rows: ShapeRow[]) {
  const pointsByShape = new Map<
    string,
    Array<{ sequence: number; coordinate: [number, number] }>
  >();

  for (const row of rows) {
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

  const shapesById = new Map<string, ShapeIndex>();

  for (const [shapeId, points] of pointsByShape) {
    const coordinates = points
      .sort((a, b) => a.sequence - b.sequence)
      .map((point) => point.coordinate);
    const cumulativeMeters = buildCumulativeMeters(coordinates);

    shapesById.set(shapeId, {
      shape_id: shapeId,
      coordinates,
      cumulativeMeters,
      totalMeters: cumulativeMeters[cumulativeMeters.length - 1] ?? 0
    });
  }

  return shapesById;
}

function groupStopTimes(rows: StopTimeRow[]) {
  const stopTimesByTripId = new Map<string, StopTimeRow[]>();

  for (const row of rows) {
    const stopTimes = stopTimesByTripId.get(row.trip_id) ?? [];
    stopTimes.push(row);
    stopTimesByTripId.set(row.trip_id, stopTimes);
  }

  return stopTimesByTripId;
}

function parseGtfsTime(value: string) {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
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

function getPointAtDistance(shape: ShapeIndex, distance: number) {
  const targetDistance = Math.min(shape.totalMeters, Math.max(0, distance));

  for (let index = 1; index < shape.cumulativeMeters.length; index += 1) {
    const previousDistance = shape.cumulativeMeters[index - 1];
    const nextDistance = shape.cumulativeMeters[index];
    if (targetDistance > nextDistance) continue;

    const progress =
      nextDistance === previousDistance
        ? 0
        : (targetDistance - previousDistance) / (nextDistance - previousDistance);
    const start = shape.coordinates[index - 1];
    const end = shape.coordinates[index];

    return {
      longitude: start[0] + (end[0] - start[0]) * progress,
      latitude: start[1] + (end[1] - start[1]) * progress,
      bearing: bearingBetween(start, end)
    };
  }

  const last = shape.coordinates[shape.coordinates.length - 1];
  const previous = shape.coordinates[shape.coordinates.length - 2] ?? last;
  return {
    longitude: last[0],
    latitude: last[1],
    bearing: bearingBetween(previous, last)
  };
}

function projectPointToShape(point: [number, number], shape: ShapeIndex) {
  let bestDistanceFromShapeMeters = Number.POSITIVE_INFINITY;
  let bestDistanceAlongShapeMeters = 0;

  for (let index = 1; index < shape.coordinates.length; index += 1) {
    const start = shape.coordinates[index - 1];
    const end = shape.coordinates[index];
    const projection = projectPointToSegment(point, start, end);
    const distanceFromShapeMeters = distanceMeters(point, projection.coordinate);

    if (distanceFromShapeMeters < bestDistanceFromShapeMeters) {
      bestDistanceFromShapeMeters = distanceFromShapeMeters;
      bestDistanceAlongShapeMeters =
        shape.cumulativeMeters[index - 1] + distanceMeters(start, projection.coordinate);
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
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));

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

function bearingBetween(from: [number, number], to: [number, number]) {
  const startLat = (from[1] * Math.PI) / 180;
  const endLat = (to[1] * Math.PI) / 180;
  const deltaLon = ((to[0] - from[0]) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLon);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function normalizeColor(value: string | undefined, fallback = "777777") {
  const color = value?.replace("#", "").trim();
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : `#${fallback}`;
}
