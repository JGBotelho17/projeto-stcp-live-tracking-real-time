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

    const parsedShapes = [...selectedShapeByRouteDirection.entries()]
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

    const fallbackShapes: RouteShape[] = [
      {
        route_id: "22",
        direction_id: "0",
        shape_id: "22_shp",
        coordinates: [
          [-8.6164, 41.1472],
          [-8.6143, 41.1458],
          [-8.6111, 41.1468],
          [-8.6068, 41.1437],
          [-8.6074, 41.1444],
          [-8.6094, 41.1477],
          [-8.6145, 41.1480],
          [-8.6164, 41.1472]
        ]
      },
      {
        route_id: "106",
        direction_id: "0",
        shape_id: "ZF_dir0_shp",
        coordinates: [[-8.631745,41.098488],[-8.632028,41.097301],[-8.631698,41.096056],[-8.631477,41.095767],[-8.631543,41.095729],[-8.632421,41.095418],[-8.63257,41.095385],[-8.633736,41.095357],[-8.633736,41.095357],[-8.634475,41.09544],[-8.634794,41.095458],[-8.635834,41.095064],[-8.636167,41.095022],[-8.636914,41.09485],[-8.637079,41.094745],[-8.637492,41.094327],[-8.637723,41.094123],[-8.638327,41.093964],[-8.638734,41.09378],[-8.639263,41.093685],[-8.639263,41.093685],[-8.63946,41.093649],[-8.639568,41.093565],[-8.639643,41.09344],[-8.639651,41.093223],[-8.641273,41.093327],[-8.641798,41.093339],[-8.642319,41.093381],[-8.642619,41.093446],[-8.643179,41.093493],[-8.643435,41.093515],[-8.643679,41.093472],[-8.644022,41.093458],[-8.644443,41.09347],[-8.645455,41.093634],[-8.645455,41.093634],[-8.645999,41.093722],[-8.646208,41.093727],[-8.646563,41.093703],[-8.647703,41.093581],[-8.648493,41.093543],[-8.649099,41.093624],[-8.651056,41.093553],[-8.651056,41.093553],[-8.652298,41.09353],[-8.652419,41.093557],[-8.652677,41.094205],[-8.652676,41.094205],[-8.652973,41.094952],[-8.653179,41.09498],[-8.653899,41.094881],[-8.653685,41.093242],[-8.653685,41.093242],[-8.653443,41.091549],[-8.653506,41.091531],[-8.653551,41.091493],[-8.653565,41.091444],[-8.653522,41.087189],[-8.652897,41.08676],[-8.652897,41.08676],[-8.652293,41.086347],[-8.652325,41.086321],[-8.652355,41.086253],[-8.653466,41.086164],[-8.655154,41.086083],[-8.655154,41.086083],[-8.655768,41.08605],[-8.655416,41.083561],[-8.655377,41.083176],[-8.655378,41.082871],[-8.655694,41.080243],[-8.655583,41.080138],[-8.655411,41.080076],[-8.655098,41.080153],[-8.655098,41.080153],[-8.652106,41.080899],[-8.652071,41.080853],[-8.652014,41.08082],[-8.651945,41.080806],[-8.651874,41.080813],[-8.651812,41.08084],[-8.651769,41.080882],[-8.65175,41.080934],[-8.651759,41.080987],[-8.651821,41.081049]]
      },
      {
        route_id: "106",
        direction_id: "1",
        shape_id: "ZF_dir1_shp",
        coordinates: [[-8.651833,41.081056],[-8.651833,41.081056],[-8.65192,41.081081],[-8.65199,41.081074],[-8.652053,41.081047],[-8.652096,41.081005],[-8.652115,41.080954],[-8.652106,41.080899],[-8.655411,41.080076],[-8.655583,41.080138],[-8.655694,41.080243],[-8.655537,41.081535],[-8.655537,41.081535],[-8.655378,41.082871],[-8.655377,41.083176],[-8.655416,41.083561],[-8.655768,41.08605],[-8.655176,41.086082],[-8.655176,41.086082],[-8.653546,41.086164],[-8.652663,41.08623],[-8.652663,41.08623],[-8.652355,41.086253],[-8.652329,41.086174],[-8.65225,41.086134],[-8.652146,41.086133],[-8.652071,41.086177],[-8.652049,41.08621],[-8.652041,41.086246],[-8.652069,41.086316],[-8.652146,41.086362],[-8.652194,41.086369],[-8.652293,41.086347],[-8.653165,41.086944],[-8.653165,41.086944],[-8.653522,41.087189],[-8.6535,41.089611],[-8.6535,41.089611],[-8.653462,41.0896],[-8.653416,41.091345],[-8.653331,41.091376],[-8.653293,41.091441],[-8.653302,41.091485],[-8.653335,41.091521],[-8.653385,41.091544],[-8.653443,41.091549],[-8.653465,41.091628],[-8.653754,41.093747],[-8.653754,41.093747],[-8.653899,41.094881],[-8.653179,41.09498],[-8.652973,41.094952],[-8.652612,41.094044],[-8.652612,41.094044],[-8.652419,41.093557],[-8.652298,41.09353],[-8.651213,41.093547],[-8.649867,41.093598],[-8.649867,41.093598],[-8.649099,41.093624],[-8.648493,41.093543],[-8.647703,41.093581],[-8.647086,41.093647],[-8.647086,41.093647],[-8.646563,41.093703],[-8.646208,41.093727],[-8.645999,41.093722],[-8.644443,41.09347],[-8.644022,41.093458],[-8.643679,41.093472],[-8.643435,41.093515],[-8.643281,41.093509],[-8.643203,41.093501],[-8.642619,41.093446],[-8.642319,41.093381],[-8.641604,41.093335],[-8.641604,41.093335],[-8.641273,41.093327],[-8.639651,41.093223],[-8.639643,41.09344],[-8.639568,41.093565],[-8.63946,41.093649],[-8.638734,41.09378],[-8.638327,41.093964],[-8.637723,41.094123],[-8.637492,41.094327],[-8.637079,41.094745],[-8.636914,41.09485],[-8.636167,41.095022],[-8.635834,41.095064],[-8.635396,41.095233],[-8.635396,41.095233],[-8.634794,41.095458],[-8.634475,41.09544],[-8.63371,41.095354],[-8.63257,41.095385],[-8.632421,41.095418],[-8.632174,41.095502],[-8.632174,41.095502],[-8.631737,41.095652],[-8.631477,41.095767],[-8.630737,41.095417],[-8.629942,41.0951],[-8.629942,41.0951],[-8.629261,41.094847],[-8.629209,41.094936],[-8.629189,41.095012],[-8.629215,41.095094],[-8.629341,41.095327],[-8.629341,41.095327],[-8.629552,41.095714],[-8.62964,41.096123],[-8.629432,41.096522],[-8.629782,41.096781],[-8.629782,41.096781],[-8.629962,41.096919],[-8.629086,41.098333],[-8.628911,41.098652],[-8.629946,41.098764],[-8.629946,41.098764],[-8.631633,41.098961],[-8.631728,41.098562]]
      }
    ];

    this.shapes = [...parsedShapes, ...fallbackShapes];

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
