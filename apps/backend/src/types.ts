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

export type VehicleFeed = {
  fetchPositions(): Promise<VehiclePosition[]>;
};

export type StopPoint = {
  stop_id: string;
  stop_name: string;
  latitude: number;
  longitude: number;
};

export type RouteShape = {
  route_id: string;
  direction_id: string;
  shape_id: string;
  coordinates: Array<[number, number]>;
};
