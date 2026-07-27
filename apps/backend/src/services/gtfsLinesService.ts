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

    const parsedLines = routes
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
      .filter((line) => line.directions.length > 0);

    const fallbackLines: TransitLine[] = [
      {
        id: "22",
        number: "22",
        name: "Carmo - Batalha",
        color: "#d1a84f",
        text_color: "#ffffff",
        directions: [
          {
            direction_id: "0",
            headsign: "Carmo - Batalha (Circular)",
            stops: [
              { stop_id: "CAR2", stop_name: "Carmo", latitude: 41.1472, longitude: -8.6164 },
              { stop_id: "CLER1", stop_name: "Clérigos", latitude: 41.1458, longitude: -8.6143 },
              { stop_id: "PLIB1", stop_name: "Praça da Liberdade", latitude: 41.1468, longitude: -8.6111 },
              { stop_id: "BAT1", stop_name: "Praça da Batalha", latitude: 41.1437, longitude: -8.6068 },
              { stop_id: "BAT2", stop_name: "Batalha-Guindais", latitude: 41.1444, longitude: -8.6074 },
              { stop_id: "PDJ1", stop_name: "Praça D. João I", latitude: 41.1477, longitude: -8.6094 },
              { stop_id: "GGF1", stop_name: "Guilherme Gomes Fernandes", latitude: 41.1480, longitude: -8.6145 }
            ]
          }
        ]
      },
      {
        id: "106",
        number: "ZF",
        name: "Valadares (Estação) - Francelos",
        color: "#ff7900",
        text_color: "#000000",
        directions: [
          {
            direction_id: "0",
            headsign: "Francelos",
            stops: [
              { stop_id: "VAL", stop_name: "VALADARES (EST)", latitude: 41.0985018209741, longitude: -8.63180623040246 },
              { stop_id: "VAL2", stop_name: "VALADARES", latitude: 41.0982559098731, longitude: -8.6290886659795 },
              { stop_id: "E1092", stop_name: "ESTR.NACIONAL 109", latitude: 41.0948958564137, longitude: -8.6293994364137 },
              { stop_id: "CPNH2", stop_name: "CAMPOLINHO", latitude: 41.0954848375936, longitude: -8.6309878235284 },
              { stop_id: "JP2", stop_name: "JOSÉ PORTUGAL", latitude: 41.0953046252936, longitude: -8.6339785532098 },
              { stop_id: "CDFT1", stop_name: "CEDOFEITA", latitude: 41.0936300100553, longitude: -8.63889541045537 },
              { stop_id: "BCH1", stop_name: "BICHEIROS", latitude: 41.0933758564137, longitude: -8.64273872831716 },
              { stop_id: "BELA1", stop_name: "BELA", latitude: 41.0935100100553, longitude: -8.64789541045537 },
              { stop_id: "RCD1", stop_name: "ROÇADAS", latitude: 41.0939433662261, longitude: -8.65262558463741 },
              { stop_id: "PMEL1", stop_name: "PEREIRA MELO", latitude: 41.0945100100553, longitude: -8.65397872831716 },
              { stop_id: "NTRT1", stop_name: "NUNO TRISTÃO", latitude: 41.091862408842, longitude: -8.65361225392604 },
              { stop_id: "ISNT1", stop_name: "INFANTE SANTO", latitude: 41.0886354566788, longitude: -8.65362552738907 },
              { stop_id: "VGM1", stop_name: "VASCO GAMA", latitude: 41.0862826477931, longitude: -8.65282252378652 },
              { stop_id: "ACBL1", stop_name: "ÁLVARES CABRAL", latitude: 41.0856289896898, longitude: -8.65588778642169 },
              { stop_id: "ISG1", stop_name: "INFANTE SAGRES", latitude: 41.0839170908252, longitude: -8.65568723092258 },
              { stop_id: "FRCL1", stop_name: "FRANCELOS-PRAIA", latitude: 41.0805855077891, longitude: -8.65571932863599 },
              { stop_id: "FRC", stop_name: "FRANCELOS", latitude: 41.0809272122479, longitude: -8.65236349832313 }
            ]
          },
          {
            direction_id: "1",
            headsign: "Valadares (Estação)",
            stops: [
              { stop_id: "FRC", stop_name: "FRANCELOS", latitude: 41.0809272122479, longitude: -8.65236349832313 },
              { stop_id: "FRCL2", stop_name: "FRANCELOS-PRAIA", latitude: 41.0806620071157, longitude: -8.6555295364137 },
              { stop_id: "ISG2", stop_name: "INFANTE SAGRES", latitude: 41.0837132601426, longitude: -8.65546307273667 },
              { stop_id: "ACBL2", stop_name: "ÁLVARES CABRAL", latitude: 41.085718202561, longitude: -8.65571402808569 },
              { stop_id: "VGM2", stop_name: "VASCO GAMA", latitude: 41.0861754429868, longitude: -8.6528142985811 },
              { stop_id: "ISNT2", stop_name: "INFANTE SANTO", latitude: 41.0886276914949, longitude: -8.65343135394299 },
              { stop_id: "NTRT2", stop_name: "NUNO TRISTÃO", latitude: 41.0918645743537, longitude: -8.65337256486093 },
              { stop_id: "PMEL2", stop_name: "PEREIRA MELO", latitude: 41.0946115852211, longitude: -8.65377861842542 },
              { stop_id: "RCD2", stop_name: "ROÇADAS", latitude: 41.0936003334668, longitude: -8.65265810682441 },
              { stop_id: "BELA2", stop_name: "BELA", latitude: 41.09354378444, longitude: -8.64799541045537 },
              { stop_id: "BCH2", stop_name: "BICHEIROS", latitude: 41.0934019599585, longitude: -8.64276336953826 },
              { stop_id: "CDFT2", stop_name: "CEDOFEITA", latitude: 41.0936802085853, longitude: -8.6389276197478 },
              { stop_id: "JP1", stop_name: "JOSÉ PORTUGAL", latitude: 41.0953315642249, longitude: -8.63404369534622 },
              { stop_id: "CPNH1", stop_name: "CAMPOLINHO", latitude: 41.0954978714338, longitude: -8.6309978815653 },
              { stop_id: "E109", stop_name: "ESTR.NACIONAL 109", latitude: 41.0948563734331, longitude: -8.62942189083632 },
              { stop_id: "VAL1", stop_name: "VALADARES", latitude: 41.0982434928268, longitude: -8.62907844976317 },
              { stop_id: "VAL", stop_name: "VALADARES (EST)", latitude: 41.0985018209741, longitude: -8.63180623040246 }
            ]
          }
        ]
      }
    ];

    this.lines = [...parsedLines, ...fallbackLines].sort((a, b) =>
      a.number.localeCompare(b.number, "pt-PT", { numeric: true })
    );

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
