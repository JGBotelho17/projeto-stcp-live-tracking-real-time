export type VehiclePosition = {
  vehicle_id: string;
  line_number: string;
  latitude: number;
  longitude: number;
  bearing: number;
  speed: number | null;
  direction_id: string | null;
  next_stop_id: string | null;
  next_stop_name: string | null;
  next_stop_eta_min: number | null;
  next_stop_distance_meters: number | null;
  updated_at: string;
};

export type VehicleDelta = {
  upserted: VehiclePosition[];
  removed: string[];
  serverTime: string;
};

export type VehicleSnapshot = {
  vehicles: VehiclePosition[];
  serverTime: string;
};

export type AnimatedVehicle = {
  current: VehiclePosition;
  previous: VehiclePosition;
  animationStartedAt: number;
  animationDurationMs: number;
  routeMotion?: {
    shapeKey: string;
    fromMeters: number;
    toMeters: number;
    direction: 1 | -1;
  };
};

export type StopsGeoJson = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: {
      type: "Point";
      coordinates: [number, number];
    };
    properties: {
      id: string;
      name: string;
    };
  }>;
};

export type RouteShapePayload = {
  shapes: Array<{
    route_id: string;
    direction_id: string;
    shape_id: string;
    coordinates: Array<[number, number]>;
  }>;
};

export type LinesPayload = {
  lines: TransitLine[];
};

export type TransitLine = {
  id: string;
  number: string;
  name: string;
  color: string;
  text_color: string;
  directions: Array<{
    direction_id: string;
    headsign: string;
    stops: Array<{
      stop_id: string;
      stop_name: string;
      latitude: number;
      longitude: number;
    }>;
  }>;
};

export type TransitMode = "bus" | "metro";

export type MetroNetworkPayload = {
  stations: StopsGeoJson;
  lines: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: {
        type: "LineString";
        coordinates: Array<[number, number]>;
      };
      properties: {
        route_id: string;
        direction_id: string;
        line: string;
        color: string;
        text_color: string;
      };
    }>;
  };
  routes: Array<{
    id: string;
    short_name: string;
    long_name: string;
    color: string;
    text_color: string;
  }>;
};

export type MetroEstimatedVehiclesPayload = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: {
      type: "Point";
      coordinates: [number, number];
    };
    properties: {
      id: string;
      line: string;
      route_id: string;
      headsign: string;
      direction_id: string;
      color: string;
      bearing: number;
      next_station: string;
      eta_min: number;
      estimated: true;
    };
  }>;
  meta: {
    generated_at: string;
    mode: "timetable_estimate";
    schedule_source: "calendar" | "weekday_template";
    realtime: false;
  };
};
