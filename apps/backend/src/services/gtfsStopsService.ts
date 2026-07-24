import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import type { StopPoint } from "../types.js";

type GtfsStopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  location_type?: string;
};

export class GtfsStopsService {
  private stops: StopPoint[] | null = null;
  private loadedAt = 0;

  constructor(
    private readonly gtfsStaticUrl: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000
  ) {}

  async getStops() {
    if (this.stops && Date.now() - this.loadedAt < this.ttlMs) {
      return this.stops;
    }

    const response = await fetch(this.gtfsStaticUrl);
    if (!response.ok) {
      throw new Error(`GTFS static feed returned ${response.status}`);
    }

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const stopsEntry = zip.getEntry("stops.txt");
    if (!stopsEntry) {
      throw new Error("GTFS static feed does not contain stops.txt");
    }

    const rows = parse(stopsEntry.getData().toString("utf8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true
    }) as GtfsStopRow[];

    this.stops = rows
      .filter((row) => !row.location_type || row.location_type === "0")
      .map((row) => ({
        stop_id: row.stop_id,
        stop_name: row.stop_name,
        latitude: Number(row.stop_lat),
        longitude: Number(row.stop_lon)
      }))
      .filter(
        (stop) =>
          Number.isFinite(stop.latitude) &&
          Number.isFinite(stop.longitude)
      );

    this.loadedAt = Date.now();
    return this.stops;
  }
}
