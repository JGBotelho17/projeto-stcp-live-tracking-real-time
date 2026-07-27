import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import { clamp, lerp, lerpAngle } from "../geo/lerp";
import { apiBaseUrl, socket } from "../realtime/socket";
import { HARDCODED_STCP_LINES } from "../data/stcp_lines";
import type {
  AnimatedVehicle,
  LinesPayload,
  MetroEstimatedVehiclesPayload,
  MetroNetworkPayload,
  RouteShapePayload,
  StopsGeoJson,
  TransitLine,
  TransitMode,
  VehicleDelta,
  VehiclePosition,
  VehicleSnapshot
} from "../types";

const PORTO_CENTER: [number, number] = [-8.6291, 41.1579];
const UPDATE_INTERVAL_MS = 12_000;
const DEFAULT_GPS_INTERVAL_MS = 60_000;
const SNAPSHOT_BOOTSTRAP_MS = 1;
const MAX_ANIMATION_INTERVAL_MS = 75_000;
const MAX_PREDICTION_MS = 22_000;
const MAX_SNAP_DISTANCE_METERS = 90;
const MAX_REASONABLE_CITY_SPEED_MPS = 15;
const MIN_ETA_SPEED_MPS = 4.2;
const STALE_GPS_AFTER_MS = 90_000;
const VERY_STALE_GPS_AFTER_MS = 150_000;
const FILTERED_RENDER_INTERVAL_MS = 16;
const ALL_VEHICLES_RENDER_INTERVAL_MS = 33;
const WALKING_SPEED_METERS_PER_MINUTE = 75;
const USER_LOCATION_ORIGIN_LABEL = "A minha localização";
const FAVORITE_LINES_STORAGE_KEY = "stcp-live:favourite-lines";
const STOPS_SOURCE_ID = "stcp-stops";
const STOPS_HIT_LAYER_ID = "stcp-stop-hit";
const BUS_SOURCE_ID = "stcp-buses";
const BUS_LAYER_ID = "stcp-bus-icons";
const BUS_SELECTED_LAYER_ID = "stcp-bus-selected";
const SELECTED_ROUTE_SOURCE_ID = "selected-route";
const SELECTED_ROUTE_CASING_LAYER_ID = "selected-route-casing";
const SELECTED_ROUTE_LAYER_ID = "selected-route-line";
const SELECTED_ROUTE_STOPS_SOURCE_ID = "selected-route-stops";
const SELECTED_ROUTE_STOP_HALO_LAYER_ID = "selected-route-stop-halo";
const SELECTED_ROUTE_STOP_DOT_LAYER_ID = "selected-route-stop-dot";
const SELECTED_ROUTE_STOP_LABEL_LAYER_ID = "selected-route-stop-label";
const SELECTED_ROUTE_STOP_HIT_LAYER_ID = "selected-route-stop-hit";
const USER_LOCATION_SOURCE_ID = "user-location";
const USER_LOCATION_LAYER_ID = "user-location-dot";
const JOURNEY_ROUTE_SOURCE_ID = "journey-route";
const JOURNEY_ROUTE_CASING_LAYER_ID = "journey-route-casing";
const JOURNEY_ROUTE_LAYER_ID = "journey-route-line";
const JOURNEY_WALK_LAYER_ID = "journey-walk-line";
const JOURNEY_POINTS_SOURCE_ID = "journey-points";
const JOURNEY_POINTS_LAYER_ID = "journey-points";
const JOURNEY_LABELS_LAYER_ID = "journey-point-labels";
const BUS_ICON_PREFIX = "stcp-small-bus";
const BUS_LINE_FAMILIES = [
  { key: "100", color: "#ee3b35", text: "#ffffff" },
  { key: "200", color: "#f28c28", text: "#06100f" },
  { key: "300", color: "#f7d154", text: "#06100f" },
  { key: "400", color: "#35b779", text: "#06100f" },
  { key: "500", color: "#2bb7d6", text: "#06100f" },
  { key: "600", color: "#16a34a", text: "#ffffff" },
  { key: "700", color: "#8b5cf6", text: "#ffffff" },
  { key: "800", color: "#e255a1", text: "#ffffff" },
  { key: "900", color: "#9ad84f", text: "#06100f" },
  { key: "eletrico", color: "#d84315", text: "#ffffff" },
  { key: "madrugada", color: "#1e3a8a", text: "#ffffff" },
  { key: "other", color: "#7de0d4", text: "#06100f" }
] as const;

export function getLineFamilyKey(lineNumber: string) {
  if (["1", "18", "22"].includes(lineNumber)) return "eletrico";
  if (lineNumber.endsWith("M")) return "madrugada";
  const match = lineNumber.match(/\d+/);
  if (!match) return "other";

  const family = Math.floor(Number(match[0]) / 100) * 100;
  return family >= 100 && family <= 900 ? String(family) : "other";
}

export function getGroupLabel(lineNumber: string) {
  const family = getLineFamilyKey(lineNumber);
  switch (family) {
    case "200": return "Porto (Ocidental)";
    case "300": return "Porto (Circular)";
    case "400": return "Porto (Oriental)";
    case "500": return "Matosinhos";
    case "600": return "Maia";
    case "700": return "Valongo";
    case "800": return "Gondomar";
    case "900": return "Vila Nova de Gaia";
    case "madrugada": return "Rede da Madrugada";
    case "eletrico": return "Elétricos";
    default: return "Zonas Locais";
  }
}
const METRO_LINES_SOURCE_ID = "metro-lines";
const METRO_STATIONS_SOURCE_ID = "metro-stations";
const METRO_TRAINS_SOURCE_ID = "metro-estimated-trains";
const METRO_TRAIN_LAYER_ID = "metro-estimated-trains";
const METRO_TRAIN_SELECTED_LAYER_ID = "metro-estimated-train-halo";
const METRO_TRAIN_ICON_ID = "metro-estimated-train";
const METRO_LAYER_IDS = [
  "metro-line-casing",
  "metro-lines",
  "metro-station-halo",
  "metro-stations",
  "metro-station-labels",
  METRO_TRAIN_SELECTED_LAYER_ID,
  METRO_TRAIN_LAYER_ID
];
const STCP_LAYER_IDS = [
  "stcp-stop-halo",
  "stcp-stop-dot",
  "stcp-stop-label",
  STOPS_HIT_LAYER_ID,
  SELECTED_ROUTE_CASING_LAYER_ID,
  SELECTED_ROUTE_LAYER_ID,
  SELECTED_ROUTE_STOP_HALO_LAYER_ID,
  SELECTED_ROUTE_STOP_DOT_LAYER_ID,
  SELECTED_ROUTE_STOP_LABEL_LAYER_ID,
  SELECTED_ROUTE_STOP_HIT_LAYER_ID,
  USER_LOCATION_LAYER_ID,
  JOURNEY_ROUTE_CASING_LAYER_ID,
  JOURNEY_ROUTE_LAYER_ID,
  JOURNEY_WALK_LAYER_ID,
  JOURNEY_POINTS_LAYER_ID,
  JOURNEY_LABELS_LAYER_ID,
  BUS_SELECTED_LAYER_ID,
  BUS_LAYER_ID
];

type RouteShape = {
  route_id: string;
  direction_id: string;
  shape_id: string;
  coordinates: Array<[number, number]>;
  cumulativeMeters: number[];
  totalMeters: number;
};

type TransitStop = TransitLine["directions"][number]["stops"][number];

type UserLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

type DestinationCandidate = {
  name: string;
  latitude: number;
  longitude: number;
};

type JourneyPlan = {
  mode: "stcp" | "walk";
  optionLabel: string;
  destinationName: string;
  totalMin: number;
  walkingMin: number;
  transfers: number;
  lineNumber: string | null;
  lineName: string | null;
  headsign: string | null;
  originStopName: string | null;
  destinationStopName: string | null;
  walkToStopMin: number;
  waitMin: number;
  rideMin: number;
  walkFromStopMin: number;
  distanceMeters: number;
  originCoordinate: [number, number];
  originStopCoordinate: [number, number] | null;
  destinationStopCoordinate: [number, number] | null;
  destinationCoordinate: [number, number];
  coordinates: Array<[number, number]>;
  segments: JourneySegment[];
  legs: JourneyRideLeg[];
};

type JourneySegment = {
  kind: "walk" | "ride";
  coordinates: Array<[number, number]>;
  lineNumber?: string;
  color?: string;
  durationMin?: number;
  distanceMeters?: number;
};

type JourneyRideLeg = {
  lineNumber: string;
  lineName: string;
  headsign: string;
  fromStopName: string;
  toStopName: string;
  fromCoordinate: [number, number];
  toCoordinate: [number, number];
  waitMin: number;
  rideMin: number;
  coordinates: Array<[number, number]>;
};

type WalkingRoute = {
  coordinates: Array<[number, number]>;
  durationMin: number;
  distanceMeters: number;
};

type SelectedRouteStopClickTarget = {
  coordinates: [number, number];
  properties: Record<string, string | number | null>;
};

type StopArrival = {
  lineNumber: string;
  lineName: string;
  directionId: string;
  headsign: string;
  vehicleId: string | null;
  etaLabel: string;
  distanceLabel: string;
  color: string;
  textColor: string;
};

type MobilePanel = "navigation" | "journey" | "stops" | "settings" | null;

type FavoriteResult = {
  lineNumber: string;
  headsign: string;
  vehicleId: string;
  stopName: string;
  etaLabel: string;
  distanceLabel: string;
};

function loadFavoriteLineNumbers() {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(FAVORITE_LINES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((lineNumber): lineNumber is string => typeof lineNumber === "string")
      : [];
  } catch {
    return [];
  }
}

function toDatetimeLocalValue(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function normalizeLineReference(lineNumber: string) {
  return lineNumber.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function StcpLogo() {
  return (
    <img className="transport-logo stcp-wordmark" src="/brand-logos/stcp-logo.svg" alt="" aria-hidden="true" />
  );
}

function MetroLogo() {
  return (
    <img className="transport-logo metro-wordmark" src="/brand-logos/metro-porto-logo.svg" alt="" aria-hidden="true" />
  );
}

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="16" height="16" 
      viewBox="0 0 24 24" fill="none" 
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
    >
      <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
  );
}

function SendIcon() {
  return <span className="icon-send" aria-hidden="true" />;
}


function NavInfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7h.01" />
    </svg>
  );
}

function NavRouteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 18c3 0 3-12 6-12s3 12 6 12 3-12 4-12" />
      <circle cx="4" cy="18" r="2" />
      <circle cx="10" cy="6" r="2" />
      <circle cx="16" cy="18" r="2" />
      <circle cx="20" cy="6" r="2" />
    </svg>
  );
}

function NavStopsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function NavSettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.3 3a8 8 0 0 0-1.7 1L5.1 6l-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 1.7 1l.3 3h5l.3-3a8 8 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.7.1-1Z" />
    </svg>
  );
}
function TrashIcon() {
  return <span className="icon-trash" aria-hidden="true" />;
}

export default function BusMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const vehiclesRef = useRef<globalThis.Map<string, AnimatedVehicle>>(new globalThis.Map());
  const routeShapesRef = useRef<globalThis.Map<string, RouteShape>>(new globalThis.Map());
  const routeShapeFallbackRef = useRef<globalThis.Map<string, RouteShape>>(new globalThis.Map());
  const routeShapeCandidatesRef = useRef<globalThis.Map<string, RouteShape[]>>(new globalThis.Map());
  const selectedIdRef = useRef<string | null>(null);
  const routeOverlayOwnerRef = useRef<"vehicle" | "stop" | "journey" | "line" | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupHtmlRef = useRef("");
  const stopPopupRef = useRef<maplibregl.Popup | null>(null);
  const replacingStopPopupRef = useRef(false);
  const stopOverviewHandlersReadyRef = useRef(false);
  const selectedRouteStopHandlersReadyRef = useRef(false);
  const selectedRouteStopClickTargetsRef = useRef<SelectedRouteStopClickTarget[]>([]);
  const locationRequestedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastRenderRef = useRef(0);

  const [selectedLineFilters, setSelectedLineFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [activeMobilePanel, setActiveMobilePanel] = useState<MobilePanel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<TransitMode>("bus");
  const [connected, setConnected] = useState(socket.connected);
  const [isJourneyExpanded, setIsJourneyExpanded] = useState(true);
  const [isLinesFilterExpanded, setIsLinesFilterExpanded] = useState(true);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [stopCount, setStopCount] = useState(0);
  const [metroStationCount, setMetroStationCount] = useState(0);
  const [metroLineCount, setMetroLineCount] = useState(0);
  const [estimatedTrainCount, setEstimatedTrainCount] = useState(0);
  const [metroScheduleSource, setMetroScheduleSource] = useState<string | null>(null);
  const [lastVehicleUpdate, setLastVehicleUpdate] = useState<string | null>(null);
  const [linesOpen, setLinesOpen] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [linesError, setLinesError] = useState<string | null>(null);
  const [linesPayload, setLinesPayloadState] = useState<LinesPayload | null>(null);
  const linesPayloadRef = useRef<LinesPayload | null>(null);

  const setLinesPayload = useCallback((payload: LinesPayload | null) => {
    linesPayloadRef.current = payload;
    setLinesPayloadState(payload);
  }, []);

  const lineSearchIndex = useMemo(() => {
    const liveLines = linesPayload?.lines ?? [];
    const liveByNumber = new globalThis.Map<string, typeof liveLines[number]>();
    for (const line of liveLines) {
      liveByNumber.set(line.number.toUpperCase(), line);
    }

    const merged: TransitLine[] = Object.entries(HARDCODED_STCP_LINES).map(([number, name]) => {
      const live = liveByNumber.get(number.toUpperCase());
      if (live) return live;
      return {
        id: `stub-${number}`,
        number,
        name,
        color: "",
        text_color: "",
        directions: []
      };
    });

    return merged.map((line) => {
      const numberNorm = normalizeSearchText(line.number);
      const nameNorm = normalizeSearchText(line.name);
      const headsigns: string[] = [];
      const stopNames: string[] = [];
      for (const direction of line.directions) {
        headsigns.push(normalizeSearchText(direction.headsign));
        for (const stop of direction.stops) {
          stopNames.push(normalizeSearchText(stop.stop_name));
        }
      }
      return {
        line,
        numberNorm,
        nameNorm,
        headsigns,
        stopNames
      };
    });
  }, [linesPayload]);

  const allUniqueStops = useMemo(() => {
    const lines = linesPayload?.lines ?? [];
    const uniqueStops = new Map<string, { id: string; name: string; nameNorm: string; idNorm: string; lat: number; lon: number }>();
    
    for (const line of lines) {
      for (const direction of line.directions) {
        for (const stop of direction.stops) {
          if (!uniqueStops.has(stop.stop_id)) {
            uniqueStops.set(stop.stop_id, {
              id: stop.stop_id,
              name: stop.stop_name,
              nameNorm: normalizeSearchText(stop.stop_name),
              idNorm: normalizeSearchText(stop.stop_id),
              lat: stop.latitude,
              lon: stop.longitude
            });
          }
        }
      }
    }
    return Array.from(uniqueStops.values());
  }, [linesPayload]);

  const allLinesSearchIndex = useMemo(() => {
    const lines = linesPayload?.lines ?? [];
    return lines.map((line) => ({
      line,
      numberNorm: normalizeSearchText(line.number),
      nameNorm: normalizeSearchText(line.name),
      headsignsNorm: line.directions.map((d) => normalizeSearchText(d.headsign))
    }));
  }, [linesPayload]);
  const [lineSearch, setLineSearch] = useState("");
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoriteLineNumbers, setFavoriteLineNumbers] = useState<string[]>(() => loadFavoriteLineNumbers());
  const [selectedFavoriteLine, setSelectedFavoriteLine] = useState<string | null>(null);
  const [favoriteDirectionId, setFavoriteDirectionId] = useState<string | null>(null);
  const [favoriteResult, setFavoriteResult] = useState<FavoriteResult | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationStatus, setLocationStatus] = useState<"idle" | "pending" | "ready" | "denied" | "unsupported">("idle");
  const [journeyOpen, setJourneyOpen] = useState(true);
  const [journeyTimeMode, setJourneyTimeMode] = useState<"depart" | "arrive">("depart");
  const [journeyDateTime, setJourneyDateTime] = useState(() => toDatetimeLocalValue(new Date()));
  const [originQuery, setOriginQuery] = useState(USER_LOCATION_ORIGIN_LABEL);
  const [originCandidate, setOriginCandidate] = useState<DestinationCandidate | null>(null);
  const [destinationQuery, setDestinationQuery] = useState("");
  const [destinationCandidate, setDestinationCandidate] = useState<DestinationCandidate | null>(null);
  const [originSuggestions, setOriginSuggestions] = useState<DestinationCandidate[]>([]);
  const [destinationSuggestions, setDestinationSuggestions] = useState<DestinationCandidate[]>([]);
  const [activeSuggestionField, setActiveSuggestionField] = useState<"origin" | "destination" | null>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [journeyPlan, setJourneyPlan] = useState<JourneyPlan | null>(null);
  const [journeyOptions, setJourneyOptions] = useState<JourneyPlan[]>([]);
  const [journeyDetailsOpen, setJourneyDetailsOpen] = useState(true);
  const [infoDialog, setInfoDialog] = useState<"about" | "donate" | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  const linesById = useMemo(() => {
    const map = new globalThis.Map<string, TransitLine>();
    if (!linesPayload) return map;
    for (const line of linesPayload.lines) {
      if (!map.has(line.id)) map.set(line.id, line);
      if (!map.has(line.number)) map.set(line.number, line);
      if (!map.has(line.id.toUpperCase())) map.set(line.id.toUpperCase(), line);
      if (!map.has(line.number.toUpperCase())) map.set(line.number.toUpperCase(), line);
    }
    return map;
  }, [linesPayload]);

  const canonicalLineCache = useMemo(() => new globalThis.Map<string, string>(), [linesPayload]);
  const searchMatchCache = useMemo(() => new globalThis.Map<string, boolean>(), [linesPayload]);

  const availableLines = useMemo(() => {
    const seen = new Set<string>();

    return [...vehiclesRef.current.values()]
      .map((vehicle) => getCanonicalLineNumber(vehicle.current.line_number))
      .filter((line) => {
        if (!HARDCODED_STCP_LINES[line]) return false;
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      })
      .sort((a, b) => a.localeCompare(b, "pt-PT", { numeric: true }));
  }, [dataVersion, linesPayload]);



  const favoriteLines = useMemo(() => {
    const lines = linesPayload?.lines ?? [];
    return favoriteLineNumbers
      .map((lineNumber) => lines.find((line) => line.number === lineNumber))
      .filter((line): line is TransitLine => Boolean(line));
  }, [favoriteLineNumbers, linesPayload]);

  const selectedFavoriteLineData = useMemo(() => {
    return linesPayload?.lines.find((line) => line.number === selectedFavoriteLine) ?? null;
  }, [linesPayload, selectedFavoriteLine]);

  const linesAvailableForFavorite = useMemo(() => {
    const seen = new Set<string>();

    return (linesPayload?.lines ?? [])
      .filter((line) => {
        const normalized = normalizeLineReference(line.number);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .sort((a, b) => a.number.localeCompare(b.number, "pt-PT", { numeric: true }));
  }, [linesPayload]);

  const railLines = useMemo(() => {
    const orderedLineNumbers: string[] = [];
    const seen = new Set<string>();

    for (const lineNumber of favoriteLineNumbers) {
      if (!lineNumber?.trim()) continue;
      const normalized = normalizeLineReference(lineNumber);
      if (!seen.has(normalized)) {
        orderedLineNumbers.push(lineNumber);
        seen.add(normalized);
      }
    }

    const others: string[] = [];
    const addOther = (lineNumber: string) => {
      if (!lineNumber?.trim()) return;
      const upper = lineNumber.trim().toUpperCase();
      if (!HARDCODED_STCP_LINES[upper]) return; // Only allow valid STCP lines
      const normalized = normalizeLineReference(lineNumber);
      if (!seen.has(normalized)) {
        others.push(upper);
        seen.add(normalized);
      }
    };

    for (const lineNumber of availableLines) {
      addOther(lineNumber);
    }

    const canonicalLineNumbers = Object.keys(HARDCODED_STCP_LINES);
    for (const lineNumber of canonicalLineNumbers) {
      addOther(lineNumber);
    }

    others.sort((a, b) => {
      const getSortGroup = (line: string) => {
        if (["1", "18", "22"].includes(line)) return 2;
        if (line.endsWith("M")) return 1;
        return 0;
      };
      
      const groupA = getSortGroup(a);
      const groupB = getSortGroup(b);
      
      if (groupA !== groupB) return groupA - groupB;
      return a.localeCompare(b, "pt-PT", { numeric: true });
    });

    return [...orderedLineNumbers, ...others];
  }, [availableLines, favoriteLineNumbers, linesPayload]);

  const filteredTransitLines = useMemo(() => {
    const query = normalizeSearchText(lineSearch);
    
    const getSortGroup = (line: string) => {
      if (["1", "18", "22"].includes(line)) return 2;
      if (line.endsWith("M")) return 1;
      return 0;
    };

    if (!query) {
      return lineSearchIndex.map((item) => item.line).sort((a, b) => {
        const groupA = getSortGroup(a.number);
        const groupB = getSortGroup(b.number);
        if (groupA !== groupB) return groupA - groupB;
        return a.number.localeCompare(b.number, "pt-PT", { numeric: true });
      });
    }

    const filtered = lineSearchIndex.filter((item) => {
      return (
        item.numberNorm.includes(query) ||
        item.nameNorm.includes(query) ||
        item.headsigns.some((h) => h.includes(query)) ||
        item.stopNames.some((s) => s.includes(query))
      );
    }).map((item) => item.line);

    return filtered.sort((a, b) => {
      const groupA = getSortGroup(a.number);
      const groupB = getSortGroup(b.number);
      if (groupA !== groupB) return groupA - groupB;
      return a.number.localeCompare(b.number, "pt-PT", { numeric: true });
    });
  }, [lineSearch, lineSearchIndex]);

  const visibleRailLines = isLinesFilterExpanded ? railLines : favoriteLineNumbers;

  function toggleSelectedLineFilter(lineNumber: string) {
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedLineFilters((current) =>
      current.includes(lineNumber) ? current.filter((entry) => entry !== lineNumber) : [...current, lineNumber]
    );
  }

  function selectSingleLineFilter(lineNumber: string) {
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedLineFilters([lineNumber]);
  }

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: PORTO_CENTER,
      zoom: 12.5,
      pitch: 0,
      bearing: 0,
      maxPitch: 0,
      attributionControl: false
    });

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    map.on("load", () => {
      void setupMapLayers(map);
    });

    mapRef.current = map;

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      stopPopupRef.current?.remove();
      stopPopupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    requestUserLocation();
  }, []);

  useEffect(() => {
    renderUserLocation();
  }, [userLocation]);

  useEffect(() => {
    renderJourneyPlan(journeyPlan);
  }, [journeyPlan]);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onSnapshot = (payload: VehicleSnapshot) => {
      setLastVehicleUpdate(payload.serverTime);
      replaceVehicles(payload.vehicles);
    };
    const onDelta = (payload: VehicleDelta) => {
      setLastVehicleUpdate(payload.serverTime);
      applyDelta(payload);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("vehicle:snapshot", onSnapshot);
    socket.on("vehicle:delta", onDelta);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("vehicle:snapshot", onSnapshot);
      socket.off("vehicle:delta", onDelta);
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      if (mode === "bus") {
        const now = performance.now();
        const renderInterval = selectedLineFilters.length > 0 ? FILTERED_RENDER_INTERVAL_MS : ALL_VEHICLES_RENDER_INTERVAL_MS;

        if (now - lastRenderRef.current >= renderInterval) {
          renderVehicles(selectedLineFilters, now);
          lastRenderRef.current = now;
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [mode, linesPayload, selectedLineFilters]);

  useEffect(() => {
    updateLayerVisibility();
    setSelectedId(null);
    if (mode === "bus") {
      renderVehicles(selectedLineFilters);
      if (journeyPlan) {
        focusJourneyPlan(journeyPlan);
      } else {
        mapRef.current?.easeTo({ center: PORTO_CENTER, zoom: 12.5, duration: 500 });
      }
    } else {
      clearVehicleLayer();
      mapRef.current?.easeTo({ center: [-8.6059, 41.1498], zoom: 11.7, duration: 500 });
    }
  }, [mode, selectedLineFilters]);

  async function refreshVehicleSnapshot() {
    const response = await fetch(`${apiBaseUrl}/vehicles`);
    if (!response.ok) return;

    const payload = (await response.json()) as VehicleSnapshot;
    setLastVehicleUpdate(payload.serverTime);
    replaceVehicles(payload.vehicles);
  }

  useEffect(() => {
    if (mode !== "metro") return;

    void loadMetroEstimatedVehicles();
    const timer = window.setInterval(() => {
      void loadMetroEstimatedVehicles();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if ((!linesOpen && !selectedId) || linesPayload || linesLoading) return;
    void loadLines();
  }, [linesOpen, selectedId, linesPayload, linesLoading]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !linesPayload) return;
    
    for (const line of linesPayload.lines) {
      if (!line.color) continue;
      const iconId = `${BUS_ICON_PREFIX}-${line.number}`;
      if (!map.hasImage(iconId)) {
        map.addImage(iconId, createBusIconImageData(line.color), { pixelRatio: 2 });
      }
    }
  }, [linesPayload]);

  useEffect(() => {
    if (searchQuery.trim().length < 2 || linesPayload || linesLoading) return;
    void loadLines();
  }, [searchQuery, linesPayload, linesLoading]);

  useEffect(() => {
    window.localStorage.setItem(FAVORITE_LINES_STORAGE_KEY, JSON.stringify(favoriteLineNumbers));
  }, [favoriteLineNumbers]);

  useEffect(() => {
    if (!favoritesOpen) return;
    requestUserLocation();
    if (!linesPayload && !linesLoading) void loadLines();
  }, [favoritesOpen, linesPayload, linesLoading]);

  useEffect(() => {
    if (!selectedId) return;
    renderVehicles(selectedLineFilters);
  }, [linesPayload, selectedId, selectedLineFilters]);

  useEffect(() => {
    if (!selectedId) {
      syncSelectedLineOverlay(selectedLineFilters);
    }
  }, [selectedLineFilters, linesPayload, selectedId]);

  useEffect(() => {
    const query = originQuery.trim();
    if (!journeyOpen || isUserLocationOrigin(query) || query.length < 3) {
      setOriginSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchLocationCandidates(query, 5)
        .then((suggestions) => {
          if (!cancelled) setOriginSuggestions(suggestions);
        })
        .catch(() => {
          if (!cancelled) setOriginSuggestions([]);
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [originQuery, journeyOpen]);

  useEffect(() => {
    const query = destinationQuery.trim();
    if (!journeyOpen || query.length < 3) {
      setDestinationSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchLocationCandidates(query, 5)
        .then((suggestions) => {
          if (!cancelled) setDestinationSuggestions(suggestions);
        })
        .catch(() => {
          if (!cancelled) setDestinationSuggestions([]);
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [destinationQuery, journeyOpen]);

  async function loadLines() {
    setLinesLoading(true);
    setLinesError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/lines`);
      if (!response.ok) {
        throw new Error("Não foi possível carregar as linhas.");
      }

      const payload = (await response.json()) as LinesPayload;

      // Force specific line colors
      for (const line of payload.lines) {
        if (["1", "18", "22"].includes(line.number) || ["1", "18", "22"].includes(line.id)) {
          line.color = "#d84315";
          line.text_color = "#ffffff";
        }
        if (["605"].includes(line.number) || ["605"].includes(line.id)) {
          line.color = "#16a34a"; // Force Maia green
          line.text_color = "#ffffff";
        }
      }

      setLinesPayload(payload);
      setExpandedLineId(payload.lines[0]?.id ?? null);
      return payload;
    } catch (error) {
      setLinesError(error instanceof Error ? error.message : "Erro ao carregar as linhas.");
      return null;
    } finally {
      setLinesLoading(false);
    }
  }

  function openFavorites() {
    setFavoritesOpen(true);
    setFavoriteError(null);
    requestUserLocation();
    if (!linesPayload && !linesLoading) void loadLines();
  }

  function toggleFavoriteLine(lineNumber: string) {
    setFavoriteError(null);
    setFavoriteLineNumbers((current) => {
      if (current.includes(lineNumber)) {
        const next = current.filter((entry) => entry !== lineNumber);
        if (selectedFavoriteLine === lineNumber) {
          setSelectedFavoriteLine(null);
          setFavoriteDirectionId(null);
        }
        return next;
      }

      return [...current, lineNumber].sort((a, b) => a.localeCompare(b, "pt-PT", { numeric: true }));
    });
    setSelectedLineFilters((current) => current.filter((entry) => entry !== lineNumber));
  }

  function selectFavoriteLine(lineNumber: string) {
    setSelectedFavoriteLine(lineNumber);
    setFavoriteDirectionId(null);
    setFavoriteResult(null);
    setFavoriteError(null);
  }

  function handleFavoriteDirection(line: TransitLine, direction: TransitLine["directions"][number]) {
    setSelectedFavoriteLine(line.number);
    setFavoriteDirectionId(direction.direction_id);
    setFavoriteResult(null);
    setFavoriteError(null);

    if (!userLocation) {
      requestUserLocation(true);
      setFavoriteError("Ativa a localização para eu encontrar a paragem mais próxima de ti.");
      return;
    }

    const nearestStop = getNearestStopToUser(direction, userLocation);
    const shape = getShapeForLineDirection(line.number, direction.direction_id);

    if (!nearestStop || !shape) {
      setFavoriteError("Não consegui encontrar a geometria deste sentido.");
      return;
    }

    const bestArrival = getBestVehicleArrivalForStop(line.number, direction.direction_id, nearestStop, shape);
    if (!bestArrival) {
      setFavoriteError("Neste momento não encontrei autocarros ativos para esse sentido.");
      return;
    }

    const result: FavoriteResult = {
      lineNumber: line.number,
      headsign: direction.headsign,
      vehicleId: bestArrival.vehicleId.replace(/^stcp-/, ""),
      stopName: nearestStop.stop_name,
      etaLabel: bestArrival.estimate.label,
      distanceLabel: formatDistanceMeters(bestArrival.estimate.distanceMeters)
    };

    setFavoriteResult(result);
    setFavoritesOpen(false);
    setMode("bus");
    selectSingleLineFilter(line.number);

    const focusVehicle = () => {
      const now = performance.now();
      const vehicle = getInterpolatedVehicle(bestArrival.vehicleId, now) ?? bestArrival.vehicle;
      selectedIdRef.current = bestArrival.vehicleId;
      setSelectedId(bestArrival.vehicleId);
      renderVehicles([line.number], now);
      mapRef.current?.easeTo({
        center: [vehicle.longitude, vehicle.latitude],
        zoom: 15.6,
        duration: 850
      });
    };

    if (mode === "bus") {
      focusVehicle();
    } else {
      window.setTimeout(focusVehicle, 160);
    }
  }

  function getNearestStopToUser(direction: TransitLine["directions"][number], location: UserLocation) {
    const userCoordinate: [number, number] = [location.longitude, location.latitude];
    let nearestStop: TransitStop | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const stop of direction.stops) {
      const distance = distanceMeters(userCoordinate, stopCoordinate(stop));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestStop = stop;
      }
    }

    return nearestStop;
  }

  function getShapeForLineDirection(lineNumber: string, directionId: string) {
    const exactShape = routeShapesRef.current.get(routeShapeKey(lineNumber, directionId));
    if (exactShape) return exactShape;

    return routeShapeCandidatesRef.current
      .get(lineNumber)
      ?.find((shape) => shape.direction_id === directionId) ?? null;
  }

  function getBestVehicleArrivalForStop(
    lineNumber: string,
    directionId: string,
    stop: TransitStop,
    shape: RouteShape
  ) {
    const now = performance.now();
    let bestArrival: {
      vehicleId: string;
      vehicle: VehiclePosition;
      estimate: ReturnType<typeof getStopArrivalEstimate>;
    } | null = null;

    for (const [vehicleId, animated] of vehiclesRef.current) {
      const currentVehicle = animated.current;
      if (currentVehicle.line_number !== lineNumber) continue;
      if (currentVehicle.direction_id && currentVehicle.direction_id !== directionId) continue;
      if (isGpsVeryStale(currentVehicle)) continue;

      const candidateShape = animated.routeMotion
        ? routeShapesRef.current.get(animated.routeMotion.shapeKey)
        : getShapeForVehicle(currentVehicle);
      if (!candidateShape) continue;
      if (candidateShape.route_id !== shape.route_id || candidateShape.direction_id !== directionId) continue;

      const vehicle = getInterpolatedVehicle(vehicleId, now) ?? currentVehicle;
      const estimate = getStopArrivalEstimate(vehicle, stop, candidateShape, animated.routeMotion?.direction);

      if (
        !bestArrival ||
        estimate.etaMin < bestArrival.estimate.etaMin ||
        (estimate.etaMin === bestArrival.estimate.etaMin &&
          estimate.distanceMeters < bestArrival.estimate.distanceMeters)
      ) {
        bestArrival = {
          vehicleId,
          vehicle,
          estimate
        };
      }
    }

    return bestArrival;
  }

  async function showStopOverviewPopup(
    coordinates: [number, number],
    stop: { id: string; name: string }
  ) {
    const map = mapRef.current;
    if (!map) return;

    const payload = linesPayloadRef.current ?? linesPayload ?? (await loadLines());
    const arrivals = payload ? getStopArrivals(stop.id, payload.lines) : [];

    replaceStopPopup();
    routeOverlayOwnerRef.current = "stop";
    selectedIdRef.current = null;
    setSelectedId(null);
    popupRef.current?.remove();
    popupRef.current = null;
    popupHtmlRef.current = "";
    syncStopLinesOverlay(stop.id, arrivals, payload?.lines ?? []);

    stopPopupRef.current = new maplibregl.Popup({
      anchor: "bottom",
      closeButton: true,
      closeOnClick: false,
      className: "stop-eta-popup stop-overview-popup",
      offset: [0, -12],
      maxWidth: "460px"
    }).on("close", () => {
      stopPopupRef.current = null;
      if (replacingStopPopupRef.current) return;
      if (routeOverlayOwnerRef.current === "stop") {
        clearSelectedRouteOverlay(false);
      }
    })
      .setLngLat(coordinates)
      .setHTML(createStopOverviewPopupHtml(stop.name, arrivals))
      .addTo(map);
  }

  function getStopArrivals(stopId: string, lines: TransitLine[]) {
    const arrivals: StopArrival[] = [];

    for (const line of lines) {
      for (const direction of line.directions) {
        const stop = direction.stops.find((entry) => entry.stop_id === stopId);
        if (!stop) continue;

        const shape = getShapeForLineDirection(line.number, direction.direction_id);
        const bestArrival = shape
          ? getBestVehicleArrivalForStop(line.number, direction.direction_id, stop, shape)
          : null;

        arrivals.push({
          lineNumber: line.number,
          lineName: line.name,
          directionId: direction.direction_id,
          headsign: direction.headsign,
          vehicleId: bestArrival?.vehicleId.replace(/^stcp-/, "") ?? null,
          etaLabel: bestArrival?.estimate.label ?? "sem veículo ativo",
          distanceLabel: bestArrival ? formatDistanceMeters(bestArrival.estimate.distanceMeters) : "sem previsão",
          color: line.color || getLineTheme(line.number).color,
          textColor: line.text_color || getLineTheme(line.number).text
        });
      }
    }

    return arrivals.sort((a, b) => {
      const aEta = Number.parseInt(a.etaLabel, 10);
      const bEta = Number.parseInt(b.etaLabel, 10);
      if (Number.isFinite(aEta) && Number.isFinite(bEta)) return aEta - bEta;
      if (Number.isFinite(aEta)) return -1;
      if (Number.isFinite(bEta)) return 1;
      return a.lineNumber.localeCompare(b.lineNumber, "pt-PT", { numeric: true });
    });
  }

  function syncStopLinesOverlay(stopId: string, arrivals: StopArrival[], lines: TransitLine[]) {
    const map = mapRef.current;
    const routeSource = map?.getSource(SELECTED_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    const stopsSource = map?.getSource(SELECTED_ROUTE_STOPS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!routeSource || !stopsSource) return;

    const routeFeatures: Array<{
      type: "Feature";
      geometry: {
        type: "LineString";
        coordinates: Array<[number, number]>;
      };
      properties: {
        color: string;
        line_number: string;
      };
    }> = [];
    const stopFeatures: Array<{
      type: "Feature";
      geometry: {
        type: "Point";
        coordinates: [number, number];
      };
      properties: Record<string, string | number | null>;
    }> = [];
    const clickTargets: SelectedRouteStopClickTarget[] = [];
    const seenStops = new Set<string>();

    for (const arrival of arrivals) {
      const line = lines.find((entry) => entry.number === arrival.lineNumber);
      const direction = line?.directions.find((entry) => entry.direction_id === arrival.directionId);
      const shape = line && direction ? getShapeForLineDirection(line.number, direction.direction_id) : null;
      if (!line || !direction || !shape) continue;

      routeFeatures.push({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: shape.coordinates
        },
        properties: {
          color: line.color || getLineTheme(line.number).color,
          line_number: line.number
        }
      });

      direction.stops.forEach((routeStop, index) => {
        const featureKey = `${line.number}:${direction.direction_id}:${routeStop.stop_id}`;
        if (seenStops.has(featureKey)) return;
        seenStops.add(featureKey);

        const bestArrival = getBestVehicleArrivalForStop(line.number, direction.direction_id, routeStop, shape);
        const properties = {
          color: line.color || getLineTheme(line.number).color,
          id: routeStop.stop_id,
          name: routeStop.stop_name,
          sequence: index + 1,
          line_number: line.number,
          direction_id: direction.direction_id,
          vehicle_id: bestArrival?.vehicleId ?? null,
          next_vehicle_id: bestArrival?.vehicleId?.replace(/^stcp-/, "") ?? null,
          eta_label: bestArrival?.estimate.label ?? "Sem estimativa",
          eta_min: bestArrival?.estimate.etaMin ?? null,
          distance_meters: bestArrival?.estimate.distanceMeters ?? null,
          is_clicked_stop: routeStop.stop_id === stopId ? 1 : 0
        };
        const coordinates = stopCoordinate(routeStop);

        stopFeatures.push({
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates
          },
          properties
        });
        clickTargets.push({ coordinates, properties });
      });
    }

    selectedRouteStopClickTargetsRef.current = clickTargets;
    routeSource.setData({
      type: "FeatureCollection",
      features: routeFeatures
    });
    stopsSource.setData({
      type: "FeatureCollection",
      features: stopFeatures
    });
  }

  function createStopOverviewPopupHtml(stopName: string, arrivals: StopArrival[]) {
    const arrivalsHtml = arrivals.length
      ? arrivals
          .slice(0, 10)
          .map(
            (arrival) => `
              <li>
                <span class="line-pill" style="background:${arrival.color};color:${arrival.textColor}">
                  ${escapeHtml(arrival.lineNumber)}
                </span>
                <div>
                  <b>${escapeHtml(arrival.headsign)}</b>
                  <small>${arrival.vehicleId ? `Autocarro n.º ${escapeHtml(arrival.vehicleId)} · ` : ""}${escapeHtml(arrival.distanceLabel)}</small>
                </div>
                <strong>${escapeHtml(arrival.etaLabel)}</strong>
              </li>
            `
          )
          .join("")
      : `<li class="empty-arrival">Ainda não há linhas carregadas para esta paragem.</li>`;

    return `
      <article class="stop-overview-card">
        <p class="eyebrow">Paragem</p>
        <h3>${escapeHtml(stopName)}</h3>
        <ul>${arrivalsHtml}</ul>
      </article>
    `;
  }

  function formatDistanceMeters(distanceMetersValue: number) {
    return distanceMetersValue >= 1000
      ? `${(distanceMetersValue / 1000).toFixed(1)} km`
      : `${Math.round(distanceMetersValue)} m`;
  }

  function requestUserLocation(force = false) {
    if (locationRequestedRef.current && !force) return;
    locationRequestedRef.current = true;

    if (!navigator.geolocation) {
      setLocationStatus("unsupported");
      return;
    }

    setLocationStatus("pending");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null
        });
        setLocationStatus("ready");
      },
      () => {
        setLocationStatus("denied");
      },
      {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 30_000
      }
    );
  }

  function renderUserLocation() {
    const source = mapRef.current?.getSource(USER_LOCATION_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    if (!userLocation) {
      source.setData(emptyFeatureCollection());
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [userLocation.longitude, userLocation.latitude]
          },
          properties: {
            accuracy: userLocation.accuracy ?? 0
          }
        }
      ]
    });
  }

  function renderJourneyPlan(plan: JourneyPlan | null) {
    const routeSource = mapRef.current?.getSource(JOURNEY_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    const pointsSource = mapRef.current?.getSource(JOURNEY_POINTS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!routeSource || !pointsSource) return;

    if (!plan) {
      routeSource.setData(emptyFeatureCollection());
      pointsSource.setData(emptyFeatureCollection());
      return;
    }

    const lineColor = plan.lineNumber ? getLineTheme(plan.lineNumber).color : "#7de0d4";
    const routeFeatures = plan.segments
      .filter((segment) => segment.coordinates.length >= 2)
      .map((segment) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: segment.coordinates
        },
        properties: {
          color: segment.color ?? lineColor,
          kind: segment.kind
        }
      }));

    routeSource.setData({
      type: "FeatureCollection",
      features: routeFeatures
    });

    const pointFeatures = [];

    pointFeatures.push({
      type: "Feature" as const,
      geometry: {
        type: "Point" as const,
        coordinates: plan.originCoordinate
      },
      properties: {
        label: "Origem",
        color: "#1f8ff2"
      }
    });

    if (plan.originStopCoordinate && plan.originStopName) {
      pointFeatures.push({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: plan.originStopCoordinate
        },
        properties: {
          label: "Entrada",
          color: lineColor
        }
      });
    }

    if (plan.destinationStopCoordinate && plan.destinationStopName) {
      pointFeatures.push({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: plan.destinationStopCoordinate
        },
        properties: {
          label: "Saída",
          color: "#f7d154"
        }
      });
    }

    pointFeatures.push({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: plan.destinationCoordinate
        },
        properties: {
          label: "Destino",
          color: "#eb6f92"
        }
      });

    pointsSource.setData({
      type: "FeatureCollection",
      features: pointFeatures
    });
  }

  async function calculateJourney(event: { preventDefault: () => void }) {
    event.preventDefault();
    const destinationText = destinationQuery.trim();

    if (!destinationText) {
      setJourneyError("Escreve um destino para eu calcular o caminho.");
      return;
    }

    setJourneyLoading(true);
    setJourneyError(null);

    try {
      const lines = linesPayload ?? (await loadLines());
      if (!lines) {
        throw new Error("Não consegui carregar as linhas da STCP.");
      }

      const origin = await resolveJourneyOrigin();
      const destination = destinationCandidate?.name === destinationText
        ? destinationCandidate
        : await resolveDestination(destinationText);
      const roughOptions = createJourneyPlanOptions(origin, destination, lines);
      const enrichedShortlist = await Promise.all(roughOptions.map((option) => enrichJourneyPlanWithWalkingRoutes(option)));
      const options = selectDisplayJourneyOptions(enrichedShortlist);
      const plan = options[0];
      if (!plan) {
        throw new Error("Não encontrei uma rota útil para esse destino.");
      }
      setJourneyOptions(options);
      setJourneyPlan(plan);
      setJourneyDetailsOpen(true);
      setMode("bus");
      focusJourneyPlan(plan);
    } catch (error) {
      setJourneyError(error instanceof Error ? error.message : "Não consegui calcular esse caminho.");
      setJourneyPlan(null);
      setJourneyOptions([]);
    } finally {
      setJourneyLoading(false);
    }
  }

  function clearJourneyPlanner() {
    setDestinationQuery("");
    setDestinationCandidate(null);
    setDestinationSuggestions([]);
    setJourneyError(null);
    setJourneyPlan(null);
    setJourneyOptions([]);
    setJourneyDetailsOpen(true);
    renderJourneyPlan(null);
  }

  async function resolveDestination(query: string): Promise<DestinationCandidate> {
    const results = await searchLocationCandidates(query, 1);
    const result = results[0];

    if (!result) {
      throw new Error("Não encontrei esse destino no Porto.");
    }

    return result;
  }

  async function resolveJourneyOrigin(): Promise<UserLocation> {
    const query = originQuery.trim();

    if (!query || isUserLocationOrigin(query)) {
      if (!userLocation) {
        requestUserLocation(true);
        throw new Error("Preciso da tua localização ou de uma origem escrita para calcular o percurso.");
      }

      return userLocation;
    }

    const chosenOrigin = originCandidate?.name === query ? originCandidate : await resolveLocation(query, "origem");
    return {
      latitude: chosenOrigin.latitude,
      longitude: chosenOrigin.longitude,
      accuracy: null
    };
  }

  async function resolveLocation(query: string, label: "origem" | "destino") {
    const results = await searchLocationCandidates(query, 1);
    const result = results[0];

    if (!result) {
      throw new Error(`Não encontrei essa ${label} no Porto.`);
    }

    return result;
  }

  async function searchLocationCandidates(query: string, limit: number): Promise<DestinationCandidate[]> {
    const coordinateMatch = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordinateMatch) {
      return [{
        name: "Destino escolhido",
        latitude: Number(coordinateMatch[1]),
        longitude: Number(coordinateMatch[2])
      }];
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("countrycodes", "pt");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("viewbox", "-8.75,41.31,-8.45,41.05");
    url.searchParams.set("q", `${query}, Porto, Portugal`);

    const response = await fetch(url.toString(), {
      headers: {
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.5"
      }
    });
    if (!response.ok) {
      throw new Error("Não consegui procurar locais agora.");
    }

    const results = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;

    return results
      .filter((entry) => Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lon)))
      .map((entry) => ({
        name: formatLocationName(entry.display_name),
        latitude: Number(entry.lat),
        longitude: Number(entry.lon)
      }));
  }

  function formatLocationName(displayName: string) {
    return displayName
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  }

  function isUserLocationOrigin(value: string) {
    return value.toLowerCase() === USER_LOCATION_ORIGIN_LABEL.toLowerCase();
  }

  function createJourneyPlanOptions(
    origin: UserLocation,
    destination: DestinationCandidate,
    payload: LinesPayload
  ): JourneyPlan[] {
    const originCoordinate: [number, number] = [origin.longitude, origin.latitude];
    const destinationCoordinate: [number, number] = [destination.longitude, destination.latitude];
    const plans: JourneyPlan[] = [createDirectWalkPlan(originCoordinate, destinationCoordinate, destination.name)];
    const contexts = payload.lines.flatMap((line) =>
      line.directions
        .filter((direction) => direction.stops.length >= 2)
        .map((direction) => ({
          line,
          direction,
          cumulativeMeters: buildStopCumulativeMeters(direction.stops),
          boardCandidates: getNearbyStopCandidates(direction.stops, originCoordinate, 1_600, 5),
          exitCandidates: getNearbyStopCandidates(direction.stops, destinationCoordinate, 1_600, 5)
        }))
    );

    for (const context of contexts) {
      for (const board of context.boardCandidates) {
        for (const exit of context.exitCandidates) {
          if (exit.index <= board.index) continue;
          const plan = createTransitPlanFromLegs(originCoordinate, destinationCoordinate, destination.name, [
            createRideLeg(context.line, context.direction, context.cumulativeMeters, board.index, exit.index)
          ]);
          if (plan) plans.push(plan);
        }
      }
    }

    const boardContexts = contexts
      .filter((context) => context.boardCandidates.length > 0)
      .sort((a, b) => a.boardCandidates[0].walkMeters - b.boardCandidates[0].walkMeters)
      .slice(0, 28);
    const exitContexts = contexts
      .filter((context) => context.exitCandidates.length > 0)
      .sort((a, b) => a.exitCandidates[0].walkMeters - b.exitCandidates[0].walkMeters)
      .slice(0, 28);

    for (const first of boardContexts) {
      for (const second of exitContexts) {
        if (first.line.number === second.line.number && first.direction.direction_id === second.direction.direction_id) {
          continue;
        }

        for (const board of first.boardCandidates.slice(0, 3)) {
          for (const exit of second.exitCandidates.slice(0, 3)) {
            const transfer = findBestTransferPair(first.direction.stops, second.direction.stops, board.index, exit.index);
            if (!transfer) continue;

            const firstLeg = createRideLeg(first.line, first.direction, first.cumulativeMeters, board.index, transfer.exitIndex);
            const secondLeg = createRideLeg(second.line, second.direction, second.cumulativeMeters, transfer.boardIndex, exit.index);
            const plan = createTransitPlanFromLegs(originCoordinate, destinationCoordinate, destination.name, [firstLeg, secondLeg]);
            if (plan) plans.push(plan);
          }
        }
      }
    }

    return selectRoughJourneyShortlist(plans);
  }

  function createDirectWalkPlan(
    originCoordinate: [number, number],
    destinationCoordinate: [number, number],
    destinationName: string
  ): JourneyPlan {
    const directDistance = distanceMeters(originCoordinate, destinationCoordinate);
    const walkMin = estimateWalkingMinutes(directDistance);

    return {
      mode: "walk",
      optionLabel: "A pé",
      destinationName,
      totalMin: walkMin,
      walkingMin: walkMin,
      transfers: 0,
      lineNumber: null,
      lineName: null,
      headsign: null,
      originStopName: null,
      destinationStopName: null,
      walkToStopMin: 0,
      waitMin: 0,
      rideMin: 0,
      walkFromStopMin: walkMin,
      distanceMeters: directDistance,
      originCoordinate,
      originStopCoordinate: null,
      destinationStopCoordinate: null,
      destinationCoordinate,
      coordinates: [originCoordinate, destinationCoordinate],
      segments: [{ kind: "walk", coordinates: [originCoordinate, destinationCoordinate], durationMin: walkMin, distanceMeters: directDistance }],
      legs: []
    };
  }

  function createTransitPlanFromLegs(
    originCoordinate: [number, number],
    destinationCoordinate: [number, number],
    destinationName: string,
    legs: JourneyRideLeg[]
  ): JourneyPlan | null {
    if (!legs.length) return null;

    const segments: JourneySegment[] = [];
    let currentCoordinate = originCoordinate;
    let walkingMeters = 0;

    for (const leg of legs) {
      const walkMeters = distanceMeters(currentCoordinate, leg.fromCoordinate);
      walkingMeters += walkMeters;
      segments.push({
        kind: "walk",
        coordinates: [currentCoordinate, leg.fromCoordinate],
        durationMin: estimateWalkingMinutes(walkMeters),
        distanceMeters: walkMeters
      });
      segments.push({
        kind: "ride",
        coordinates: leg.coordinates,
        lineNumber: leg.lineNumber,
        color: getLineTheme(leg.lineNumber).color,
        durationMin: leg.rideMin,
        distanceMeters: getPolylineDistanceMeters(leg.coordinates)
      });
      currentCoordinate = leg.toCoordinate;
    }

    const walkFromStopMeters = distanceMeters(currentCoordinate, destinationCoordinate);
    walkingMeters += walkFromStopMeters;
    segments.push({
      kind: "walk",
      coordinates: [currentCoordinate, destinationCoordinate],
      durationMin: estimateWalkingMinutes(walkFromStopMeters),
      distanceMeters: walkFromStopMeters
    });

    const rideMin = legs.reduce((sum, leg) => sum + leg.rideMin, 0);
    const waitMin = legs.reduce((sum, leg, index) => sum + (index === 0 ? leg.waitMin : Math.max(2, leg.waitMin * 0.8)), 0);
    const walkingMin = estimateWalkingMinutes(walkingMeters);
    const totalMin = walkingMin + rideMin + waitMin;
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    return {
      mode: "stcp",
      optionLabel: legs.length > 1 ? "Com troca" : "Direta",
      destinationName,
      totalMin,
      walkingMin,
      transfers: Math.max(0, legs.length - 1),
      lineNumber: firstLeg.lineNumber,
      lineName: firstLeg.lineName,
      headsign: firstLeg.headsign,
      originStopName: firstLeg.fromStopName,
      destinationStopName: lastLeg.toStopName,
      walkToStopMin: estimateWalkingMinutes(distanceMeters(originCoordinate, firstLeg.fromCoordinate)),
      waitMin,
      rideMin,
      walkFromStopMin: estimateWalkingMinutes(walkFromStopMeters),
      distanceMeters: segments.reduce((sum, segment) => sum + (segment.distanceMeters ?? getPolylineDistanceMeters(segment.coordinates)), 0),
      originCoordinate,
      originStopCoordinate: firstLeg.fromCoordinate,
      destinationStopCoordinate: lastLeg.toCoordinate,
      destinationCoordinate,
      coordinates: compactCoordinates(segments.flatMap((segment) => segment.coordinates)),
      segments,
      legs
    };
  }

  function createRideLeg(
    line: TransitLine,
    direction: TransitLine["directions"][number],
    cumulativeMeters: number[],
    boardIndex: number,
    exitIndex: number
  ): JourneyRideLeg {
    const boardStop = direction.stops[boardIndex];
    const exitStop = direction.stops[exitIndex];
    const stopsSegment = direction.stops.slice(boardIndex, exitIndex + 1);
    const rideMeters = Math.max(0, cumulativeMeters[exitIndex] - cumulativeMeters[boardIndex]);

    return {
      lineNumber: line.number,
      lineName: line.name,
      headsign: direction.headsign,
      fromStopName: boardStop.stop_name,
      toStopName: exitStop.stop_name,
      fromCoordinate: stopCoordinate(boardStop),
      toCoordinate: stopCoordinate(exitStop),
      waitMin: getEstimatedWaitMin(line.number),
      rideMin: Math.max(1, rideMeters / 290),
      coordinates: buildRideCoordinates(line.number, direction.direction_id, boardStop, exitStop, stopsSegment)
    };
  }

  function getNearbyStopCandidates(stops: TransitStop[], coordinate: [number, number], maxMeters: number, limit: number) {
    return stops
      .map((stop, index) => ({
        stop,
        index,
        walkMeters: distanceMeters(coordinate, stopCoordinate(stop))
      }))
      .filter((candidate) => candidate.walkMeters <= maxMeters)
      .sort((a, b) => a.walkMeters - b.walkMeters)
      .slice(0, limit);
  }

  function findBestTransferPair(
    firstStops: TransitStop[],
    secondStops: TransitStop[],
    boardIndex: number,
    exitIndex: number
  ) {
    let bestTransfer: { exitIndex: number; boardIndex: number; walkMeters: number } | null = null;

    for (let firstIndex = boardIndex + 1; firstIndex < firstStops.length; firstIndex += 1) {
      for (let secondIndex = 0; secondIndex < exitIndex; secondIndex += 1) {
        const walkMeters = distanceMeters(stopCoordinate(firstStops[firstIndex]), stopCoordinate(secondStops[secondIndex]));
        if (walkMeters > 450) continue;
        if (!bestTransfer || walkMeters < bestTransfer.walkMeters) {
          bestTransfer = {
            exitIndex: firstIndex,
            boardIndex: secondIndex,
            walkMeters
          };
        }
      }
    }

    return bestTransfer;
  }

  function selectRoughJourneyShortlist(plans: JourneyPlan[]) {
    const unique = dedupeJourneyPlans(plans);
    const fastest = [...unique].sort((a, b) => a.totalMin - b.totalMin).slice(0, 4);
    const fewestTransfers = [...unique].sort((a, b) => a.transfers - b.transfers || a.totalMin - b.totalMin)[0];
    const leastWalking = [...unique].sort((a, b) => a.walkingMin - b.walkingMin || a.totalMin - b.totalMin)[0];
    return dedupeJourneyPlans([...(fastest ?? []), fewestTransfers, leastWalking].filter((plan): plan is JourneyPlan => Boolean(plan))).slice(0, 6);
  }

  function selectDisplayJourneyOptions(plans: JourneyPlan[]) {
    const unique = dedupeJourneyPlans(plans);
    const fastest = [...unique].sort((a, b) => a.totalMin - b.totalMin)[0];
    const fewestTransfers = [...unique].sort((a, b) => a.transfers - b.transfers || a.totalMin - b.totalMin)[0];
    const leastWalking = [...unique].sort((a, b) => a.walkingMin - b.walkingMin || a.totalMin - b.totalMin)[0];
    const options = [
      fastest ? { ...fastest, optionLabel: "Mais rápida" } : null,
      fewestTransfers ? { ...fewestTransfers, optionLabel: "Menos trocas" } : null,
      leastWalking ? { ...leastWalking, optionLabel: "Menos caminhada" } : null
    ].filter((plan): plan is JourneyPlan => Boolean(plan));

    return dedupeJourneyPlans(options).sort((a, b) => {
      if (a.optionLabel === "Mais rápida") return -1;
      if (b.optionLabel === "Mais rápida") return 1;
      return a.totalMin - b.totalMin;
    });
  }

  function dedupeJourneyPlans(plans: JourneyPlan[]) {
    const seen = new Set<string>();
    const uniquePlans: JourneyPlan[] = [];

    for (const plan of plans) {
      const key = plan.mode === "walk"
        ? "walk"
        : plan.legs.map((leg) => `${leg.lineNumber}:${leg.fromStopName}:${leg.toStopName}`).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      uniquePlans.push(plan);
    }

    return uniquePlans;
  }

  async function enrichJourneyPlanWithWalkingRoutes(plan: JourneyPlan): Promise<JourneyPlan> {
    if (plan.mode === "walk") {
      const walk = await getWalkingRoute(plan.originCoordinate, plan.destinationCoordinate);
      return {
        ...plan,
        totalMin: walk.durationMin,
        walkingMin: walk.durationMin,
        walkFromStopMin: walk.durationMin,
        distanceMeters: walk.distanceMeters,
        coordinates: walk.coordinates,
        segments: [{ kind: "walk", coordinates: walk.coordinates, durationMin: walk.durationMin, distanceMeters: walk.distanceMeters }]
      };
    }

    const enrichedSegments = await Promise.all(
      plan.segments.map(async (segment) => {
        if (segment.kind !== "walk" || segment.coordinates.length < 2) return segment;

        const walk = await getWalkingRoute(segment.coordinates[0], segment.coordinates[segment.coordinates.length - 1]);
        return {
          ...segment,
          coordinates: walk.coordinates,
          durationMin: walk.durationMin,
          distanceMeters: walk.distanceMeters
        };
      })
    );

    const walkingMin = enrichedSegments
      .filter((segment) => segment.kind === "walk")
      .reduce((sum, segment) => sum + (segment.durationMin ?? 0), 0);
    const walkingMeters = enrichedSegments
      .filter((segment) => segment.kind === "walk")
      .reduce((sum, segment) => sum + (segment.distanceMeters ?? getPolylineDistanceMeters(segment.coordinates)), 0);
    const rideDistanceMeters = enrichedSegments
      .filter((segment) => segment.kind === "ride")
      .reduce((sum, segment) => sum + (segment.distanceMeters ?? getPolylineDistanceMeters(segment.coordinates)), 0);
    const walkSegments = enrichedSegments.filter((segment) => segment.kind === "walk");

    return {
      ...plan,
      walkToStopMin: walkSegments[0]?.durationMin ?? plan.walkToStopMin,
      walkFromStopMin: walkSegments[walkSegments.length - 1]?.durationMin ?? plan.walkFromStopMin,
      walkingMin,
      totalMin: walkingMin + plan.waitMin + plan.rideMin,
      distanceMeters: walkingMeters + rideDistanceMeters,
      coordinates: compactCoordinates(enrichedSegments.flatMap((segment) => segment.coordinates)),
      segments: enrichedSegments
    };
  }

  async function getWalkingRoute(from: [number, number], to: [number, number]): Promise<WalkingRoute> {
    const fallbackDistanceMeters = distanceMeters(from, to);
    const fallback = {
      coordinates: [from, to],
      durationMin: estimateWalkingMinutes(fallbackDistanceMeters),
      distanceMeters: fallbackDistanceMeters
    };

    try {
      const url = new URL(`https://router.project-osrm.org/route/v1/foot/${from[0]},${from[1]};${to[0]},${to[1]}`);
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("steps", "false");

      const response = await fetch(url.toString());
      if (!response.ok) return fallback;

      const payload = (await response.json()) as {
        code?: string;
        routes?: Array<{
          distance: number;
          duration: number;
          geometry?: {
            coordinates?: Array<[number, number]>;
          };
        }>;
      };
      const route = payload.routes?.[0];
      const coordinates = route?.geometry?.coordinates;

      if (payload.code !== "Ok" || !route || !coordinates || coordinates.length < 2) {
        return fallback;
      }

      return {
        coordinates,
        durationMin: estimateWalkingMinutes(route.distance),
        distanceMeters: route.distance
      };
    } catch {
      return fallback;
    }
  }

  function getPolylineDistanceMeters(coordinates: Array<[number, number]>) {
    let totalMeters = 0;

    for (let index = 1; index < coordinates.length; index += 1) {
      totalMeters += distanceMeters(coordinates[index - 1], coordinates[index]);
    }

    return totalMeters;
  }

  function estimateWalkingMinutes(distanceMetersValue: number) {
    if (!Number.isFinite(distanceMetersValue) || distanceMetersValue <= 0) return 0;
    if (distanceMetersValue < 90) return Math.max(0.5, distanceMetersValue / 70);
    return Math.max(1, distanceMetersValue / WALKING_SPEED_METERS_PER_MINUTE);
  }

  function buildStopCumulativeMeters(stops: TransitStop[]) {
    const cumulativeMeters = [0];

    for (let index = 1; index < stops.length; index += 1) {
      cumulativeMeters[index] =
        cumulativeMeters[index - 1] + distanceMeters(stopCoordinate(stops[index - 1]), stopCoordinate(stops[index]));
    }

    return cumulativeMeters;
  }

  function buildJourneyCoordinates(
    originCoordinate: [number, number],
    destinationCoordinate: [number, number],
    lineNumber: string,
    directionId: string,
    boardStop: TransitStop,
    exitStop: TransitStop,
    stopsSegment: TransitStop[]
  ) {
    const boardCoordinate = stopCoordinate(boardStop);
    const exitCoordinate = stopCoordinate(exitStop);
    const rideCoordinates = buildRideCoordinates(lineNumber, directionId, boardStop, exitStop, stopsSegment);

    return compactCoordinates([
      originCoordinate,
      boardCoordinate,
      ...rideCoordinates,
      exitCoordinate,
      destinationCoordinate
    ]);
  }

  function buildRideCoordinates(
    lineNumber: string,
    directionId: string,
    boardStop: TransitStop,
    exitStop: TransitStop,
    stopsSegment: TransitStop[]
  ) {
    const boardCoordinate = stopCoordinate(boardStop);
    const exitCoordinate = stopCoordinate(exitStop);
    const shape = routeShapesRef.current.get(routeShapeKey(lineNumber, directionId));
    let rideCoordinates = stopsSegment.map(stopCoordinate);

    if (shape) {
      const boardProjection = projectCoordinateToShape(boardCoordinate, shape);
      const exitProjection = projectCoordinateToShape(exitCoordinate, shape);
      if (exitProjection.distanceAlongShapeMeters > boardProjection.distanceAlongShapeMeters) {
        rideCoordinates = getShapeCoordinatesBetween(
          shape,
          boardProjection.distanceAlongShapeMeters,
          exitProjection.distanceAlongShapeMeters
        );
      }
    }

    return compactCoordinates([boardCoordinate, ...rideCoordinates, exitCoordinate]);
  }

  function getShapeCoordinatesBetween(shape: RouteShape, startMeters: number, endMeters: number) {
    const coordinates: Array<[number, number]> = [
      pointCoordinate(getPointAtDistance(shape, startMeters))
    ];

    for (let index = 1; index < shape.coordinates.length; index += 1) {
      const distance = shape.cumulativeMeters[index];
      if (distance > startMeters && distance < endMeters) {
        coordinates.push(shape.coordinates[index]);
      }
    }

    coordinates.push(pointCoordinate(getPointAtDistance(shape, endMeters)));
    return coordinates;
  }

  function compactCoordinates(coordinates: Array<[number, number]>) {
    return coordinates.filter((coordinate, index) => {
      if (index === 0) return true;
      return distanceMeters(coordinates[index - 1], coordinate) > 3;
    });
  }

  function stopCoordinate(stop: TransitStop): [number, number] {
    return [stop.longitude, stop.latitude];
  }

  function pointCoordinate(point: { longitude: number; latitude: number }): [number, number] {
    return [point.longitude, point.latitude];
  }

  function getEstimatedWaitMin(lineNumber: string) {
    const activeVehicles = getActiveVehicleCountForLine(lineNumber);
    if (activeVehicles <= 0) return 12;
    return clamp(24 / (activeVehicles + 1), 3, 10);
  }

  function focusJourneyPlan(plan: JourneyPlan) {
    const map = mapRef.current;
    if (!map || plan.coordinates.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    plan.coordinates.forEach((coordinate) => bounds.extend(coordinate));
    map.fitBounds(bounds, {
      padding: 92,
      maxZoom: 15.6,
      duration: 800
    });
  }

  function formatJourneyMinutes(minutes: number) {
    if (!Number.isFinite(minutes)) return "--";
    if (minutes < 1) return "<1 min";
    if (minutes < 60) return `${Math.round(minutes)} min`;

    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest > 0 ? `${hours}h ${rest}min` : `${hours}h`;
  }

  function formatJourneySummary(plan: JourneyPlan) {
    if (plan.mode === "walk") return "Caminho direto a pé";
    return plan.legs
      .map((leg) => `Linha ${leg.lineNumber} sentido ${leg.headsign}`)
      .join(" · ");
  }

  function replaceVehicles(vehicles: VehiclePosition[]) {
    const now = performance.now();
    const next = new globalThis.Map<string, AnimatedVehicle>();

    for (const vehicle of vehicles) {
      const existing = vehiclesRef.current.get(vehicle.vehicle_id);
      const old = existing?.current ?? vehicle;
      const previous = existing ? getInterpolatedVehicle(vehicle.vehicle_id, now) ?? old : vehicle;
      const animationDurationMs = existing ? getAnimationDurationMs(old, vehicle) : SNAPSHOT_BOOTSTRAP_MS;

      next.set(vehicle.vehicle_id, createAnimatedVehicle(previous, vehicle, now, animationDurationMs));
    }

    vehiclesRef.current = next;
    setVehicleCount(next.size);
    setDataVersion((version) => version + 1);
  }

  function applyDelta(delta: VehicleDelta) {
    const now = performance.now();

    for (const vehicleId of delta.removed) {
      vehiclesRef.current.delete(vehicleId);
      if (selectedId === vehicleId) setSelectedId(null);
    }

    for (const vehicle of delta.upserted) {
      const existing = vehiclesRef.current.get(vehicle.vehicle_id);
      const old = existing?.current ?? vehicle;
      const previous = existing ? getInterpolatedVehicle(vehicle.vehicle_id, now) ?? old : vehicle;
      const animationDurationMs = existing ? getAnimationDurationMs(old, vehicle) : SNAPSHOT_BOOTSTRAP_MS;

      vehiclesRef.current.set(
        vehicle.vehicle_id,
        createAnimatedVehicle(previous, vehicle, now, animationDurationMs)
      );
    }

    setVehicleCount(vehiclesRef.current.size);
    setDataVersion((version) => version + 1);
  }

  function renderVehicles(lineFilters: string[], now = performance.now()) {
    const source = mapRef.current?.getSource(BUS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const normalizedLineFilters = lineFilters
      .map((lineFilter) => lineFilter.toLowerCase().trim())
      .filter((lineFilter) => lineFilter.length > 0);
    const features: Array<{
      type: "Feature";
      geometry: {
        type: "Point";
        coordinates: [number, number];
      };
      properties: {
        vehicle_id: string;
        line_number: string;
        bearing: number;
        opacity: number;
        icon_id: string;
        line_color: string;
        text_color: string;
      };
    }> = [];
    let selectedVehicleForPopup: VehiclePosition | null = null;

    for (const [vehicleId, animated] of vehiclesRef.current) {
      const vehicle = getInterpolatedVehicle(vehicleId, now) ?? animated.current;
      const canonicalLineNumber = getCanonicalLineNumber(animated.current.line_number);
      const visible =
        normalizedLineFilters.length === 0 ||
        normalizedLineFilters.some((lineFilter) => lineMatchesSearch(canonicalLineNumber, lineFilter));
      if (!visible) continue;
      if (vehicleId === selectedIdRef.current) {
        selectedVehicleForPopup = vehicle;
      }

      const lineTheme = getLineTheme(canonicalLineNumber);

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [vehicle.longitude, vehicle.latitude]
        },
        properties: {
          vehicle_id: vehicleId,
          line_number: canonicalLineNumber,
          bearing: vehicle.bearing,
          opacity: getVehicleOpacity(animated.current),
          icon_id: getBusIconId(canonicalLineNumber),
          line_color: lineTheme.color,
          text_color: lineTheme.text
        }
      });
    }

    source.setData({
      type: "FeatureCollection",
      features
    });
    syncVehiclePopup(selectedVehicleForPopup);
    if (selectedIdRef.current || routeOverlayOwnerRef.current === "vehicle") {
      syncSelectedRouteOverlay(selectedVehicleForPopup);
    }
  }

  function clearVehicleLayer() {
    const source = mapRef.current?.getSource(BUS_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: [] });
    clearSelectedRouteOverlay();
  }

  async function setupMapLayers(map: MapLibreMap) {
    await Promise.all([loadStops(map), loadRouteShapes(), loadMetroNetwork(map)]);
    addJourneyLayers(map);
    addBusLayers(map);
    updateLayerVisibility();
    renderUserLocation();
    renderJourneyPlan(journeyPlan);
    renderVehicles(selectedLineFilters);
    void loadLines();
  }

  async function loadStops(map: MapLibreMap) {
    const response = await fetch(`${apiBaseUrl}/stops`);
    if (!response.ok) return;

    const stops = (await response.json()) as StopsGeoJson;
    setStopCount(stops.features.length);

    if (map.getSource(STOPS_SOURCE_ID)) {
      const source = map.getSource(STOPS_SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(stops);
      }
      addStopOverviewHandlers(map);
      return;
    }

    map.addSource(STOPS_SOURCE_ID, {
      type: "geojson",
      data: stops
    });

    map.addLayer({
      id: "stcp-stop-halo",
      type: "circle",
      source: STOPS_SOURCE_ID,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 5],
        "circle-color": "#f7d154",
        "circle-opacity": 0.18
      }
    });

    map.addLayer({
      id: "stcp-stop-dot",
      type: "circle",
      source: STOPS_SOURCE_ID,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 16, 2.8],
        "circle-color": "#f6f8fb",
        "circle-opacity": 0.82,
        "circle-stroke-color": "#111820",
        "circle-stroke-width": 1
      }
    });

    map.addLayer({
      id: "stcp-stop-label",
      type: "symbol",
      source: STOPS_SOURCE_ID,
      minzoom: 15,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-size": 10,
        "text-offset": [0, 0.9],
        "text-anchor": "top"
      },
      paint: {
        "text-color": "#d8e0e8",
        "text-halo-color": "#07090c",
        "text-halo-width": 1.2,
        "text-opacity": 0.78
      }
    });

    map.addLayer({
      id: STOPS_HIT_LAYER_ID,
      type: "circle",
      source: STOPS_SOURCE_ID,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 18],
        "circle-color": "#ffffff",
        "circle-opacity": 0.001
      }
    });

    addStopOverviewHandlers(map);
  }

  function addStopOverviewHandlers(map: MapLibreMap) {
    if (stopOverviewHandlersReadyRef.current) return;

    map.on("mouseenter", STOPS_HIT_LAYER_ID, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", STOPS_HIT_LAYER_ID, () => {
      map.getCanvas().style.cursor = "";
    });

    map.on("click", STOPS_HIT_LAYER_ID, (event) => {
      event.originalEvent.stopPropagation();

      if (selectedIdRef.current && getNearestSelectedRouteStop(event.point)) {
        return;
      }

      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return;

      const stopId = String(feature.properties?.id ?? feature.properties?.stop_id ?? "");
      const stopName = String(feature.properties?.name ?? feature.properties?.stop_name ?? "Paragem");

      void showStopOverviewPopup(
        [Number(feature.geometry.coordinates[0]), Number(feature.geometry.coordinates[1])],
        { id: stopId, name: stopName }
      );
    });

    stopOverviewHandlersReadyRef.current = true;
  }

  function addJourneyLayers(map: MapLibreMap) {
    if (!map.getSource(USER_LOCATION_SOURCE_ID)) {
      map.addSource(USER_LOCATION_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getSource(JOURNEY_ROUTE_SOURCE_ID)) {
      map.addSource(JOURNEY_ROUTE_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getSource(JOURNEY_POINTS_SOURCE_ID)) {
      map.addSource(JOURNEY_POINTS_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getLayer(JOURNEY_ROUTE_CASING_LAYER_ID)) {
      map.addLayer({
        id: JOURNEY_ROUTE_CASING_LAYER_ID,
        type: "line",
        source: JOURNEY_ROUTE_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": "#05080c",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 12],
          "line-opacity": 0.86
        }
      });
    }

    if (!map.getLayer(JOURNEY_ROUTE_LAYER_ID)) {
      map.addLayer({
        id: JOURNEY_ROUTE_LAYER_ID,
        type: "line",
        source: JOURNEY_ROUTE_SOURCE_ID,
        filter: ["!=", ["get", "kind"], "walk"],
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#7de0d4"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7],
          "line-opacity": 0.94
        }
      });
    }

    if (!map.getLayer(JOURNEY_WALK_LAYER_ID)) {
      map.addLayer({
        id: JOURNEY_WALK_LAYER_ID,
        type: "line",
        source: JOURNEY_ROUTE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "walk"],
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#7de0d4"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7],
          "line-opacity": 0.92,
          "line-dasharray": [1.4, 1.2]
        }
      });
    }

    if (!map.getLayer(JOURNEY_POINTS_LAYER_ID)) {
      map.addLayer({
        id: JOURNEY_POINTS_LAYER_ID,
        type: "circle",
        source: JOURNEY_POINTS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 10],
          "circle-color": ["coalesce", ["get", "color"], "#7de0d4"],
          "circle-stroke-color": "#05080c",
          "circle-stroke-width": 3
        }
      });
    }

    if (!map.getLayer(JOURNEY_LABELS_LAYER_ID)) {
      map.addLayer({
        id: JOURNEY_LABELS_LAYER_ID,
        type: "symbol",
        source: JOURNEY_POINTS_SOURCE_ID,
        minzoom: 12,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 11,
          "text-offset": [0, 1.25],
          "text-anchor": "top"
        },
        paint: {
          "text-color": "#f6f8fb",
          "text-halo-color": "#05080c",
          "text-halo-width": 1.6
        }
      });
    }

    if (!map.getLayer(USER_LOCATION_LAYER_ID)) {
      map.addLayer({
        id: USER_LOCATION_LAYER_ID,
        type: "circle",
        source: USER_LOCATION_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 7, 16, 11],
          "circle-color": "#1f8ff2",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
          "circle-opacity": 0.98
        }
      });
    }
  }

  async function loadMetroNetwork(map: MapLibreMap) {
    const response = await fetch(`${apiBaseUrl}/metro/network`);
    if (!response.ok) return;

    const metroNetwork = (await response.json()) as MetroNetworkPayload;
    setMetroStationCount(metroNetwork.stations.features.length);
    setMetroLineCount(metroNetwork.routes.length);

    if (!map.getSource(METRO_LINES_SOURCE_ID)) {
      map.addSource(METRO_LINES_SOURCE_ID, {
        type: "geojson",
        data: metroNetwork.lines
      });
    }

    if (!map.getSource(METRO_STATIONS_SOURCE_ID)) {
      map.addSource(METRO_STATIONS_SOURCE_ID, {
        type: "geojson",
        data: metroNetwork.stations
      });
    }

    if (!map.getLayer("metro-line-casing")) {
      map.addLayer({
        id: "metro-line-casing",
        type: "line",
        source: METRO_LINES_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": "#06100f",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 15, 9],
          "line-opacity": 0.9
        }
      });
    }

    if (!map.getLayer("metro-lines")) {
      map.addLayer({
        id: "metro-lines",
        type: "line",
        source: METRO_LINES_SOURCE_ID,
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 6],
          "line-opacity": 0.95
        }
      });
    }

    if (!map.getLayer("metro-station-halo")) {
      map.addLayer({
        id: "metro-station-halo",
        type: "circle",
        source: METRO_STATIONS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 8],
          "circle-color": "#06100f",
          "circle-opacity": 0.88
        }
      });
    }

    if (!map.getLayer("metro-stations")) {
      map.addLayer({
        id: "metro-stations",
        type: "circle",
        source: METRO_STATIONS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.4, 15, 4.8],
          "circle-color": "#f6f8fb",
          "circle-stroke-color": "#111820",
          "circle-stroke-width": 1.4
        }
      });
    }

    if (!map.getLayer("metro-station-labels")) {
      map.addLayer({
        id: "metro-station-labels",
        type: "symbol",
        source: METRO_STATIONS_SOURCE_ID,
        minzoom: 13,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 10.5,
          "text-offset": [0, 1.1],
          "text-anchor": "top"
        },
        paint: {
          "text-color": "#f6f8fb",
          "text-halo-color": "#07090c",
          "text-halo-width": 1.4
        }
      });
    }

    addMetroTrainLayers(map);
    await loadMetroEstimatedVehicles();
  }

  function addMetroTrainLayers(map: MapLibreMap) {
    if (!map.hasImage(METRO_TRAIN_ICON_ID)) {
      map.addImage(METRO_TRAIN_ICON_ID, createMetroTrainIconImageData(), { pixelRatio: 2 });
    }

    if (!map.getSource(METRO_TRAINS_SOURCE_ID)) {
      map.addSource(METRO_TRAINS_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });
    }

    if (!map.getLayer(METRO_TRAIN_SELECTED_LAYER_ID)) {
      map.addLayer({
        id: METRO_TRAIN_SELECTED_LAYER_ID,
        type: "circle",
        source: METRO_TRAINS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 15, 13],
          "circle-color": "#ffffff",
          "circle-opacity": 0.2,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2
        }
      });
    }

    if (!map.getLayer(METRO_TRAIN_LAYER_ID)) {
      map.addLayer({
        id: METRO_TRAIN_LAYER_ID,
        type: "symbol",
        source: METRO_TRAINS_SOURCE_ID,
        layout: {
          "icon-image": METRO_TRAIN_ICON_ID,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.72, 15, 1.05],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["get", "line"],
          "text-size": 10,
          "text-font": ["Open Sans Bold"],
          "text-anchor": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true
        },
        paint: {
          "text-color": "#06100f"
        }
      });
    }
  }

  async function loadMetroEstimatedVehicles() {
    const map = mapRef.current;
    const source = map?.getSource(METRO_TRAINS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const response = await fetch(`${apiBaseUrl}/metro/estimated-vehicles`);
    if (!response.ok) return;

    const payload = (await response.json()) as MetroEstimatedVehiclesPayload;
    source.setData(payload);
    setEstimatedTrainCount(payload.features.length);
    setMetroScheduleSource(payload.meta.schedule_source);
  }

  function updateLayerVisibility() {
    const map = mapRef.current;
    if (!map) return;

    const stcpVisibility = mode === "bus" ? "visible" : "none";
    const metroVisibility = mode === "metro" ? "visible" : "none";

    for (const layerId of STCP_LAYER_IDS) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", stcpVisibility);
      }
    }

    for (const layerId of METRO_LAYER_IDS) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", metroVisibility);
      }
    }
  }

  async function loadRouteShapes() {
    const response = await fetch(`${apiBaseUrl}/route-shapes`);
    if (!response.ok) return;

    const payload = (await response.json()) as RouteShapePayload;
    const routeShapes = new globalThis.Map<string, RouteShape>();
    const fallbackShapes = new globalThis.Map<string, RouteShape>();
    const candidateShapes = new globalThis.Map<string, RouteShape[]>();

    for (const rawShape of payload.shapes) {
      const shape = buildRouteShape(rawShape);
      const key = routeShapeKey(shape.route_id, shape.direction_id);
      routeShapes.set(key, shape);
      candidateShapes.set(shape.route_id, [...(candidateShapes.get(shape.route_id) ?? []), shape]);

      if (!fallbackShapes.has(shape.route_id)) {
        fallbackShapes.set(shape.route_id, shape);
      }
    }

    routeShapesRef.current = routeShapes;
    routeShapeFallbackRef.current = fallbackShapes;
    routeShapeCandidatesRef.current = candidateShapes;

    const now = performance.now();
    for (const [vehicleId, animated] of vehiclesRef.current) {
      vehiclesRef.current.set(
        vehicleId,
        createAnimatedVehicle(animated.previous, animated.current, animated.animationStartedAt, animated.animationDurationMs)
      );
    }
    renderVehicles(selectedLineFilters);
  }

  function addBusLayers(map: MapLibreMap) {
    for (const family of BUS_LINE_FAMILIES) {
      const iconId = `${BUS_ICON_PREFIX}-${family.key}`;
      if (!map.hasImage(iconId)) {
        map.addImage(iconId, createBusIconImageData(family.color), { pixelRatio: 2 });
      }
    }

    if (!map.getSource(BUS_SOURCE_ID)) {
      map.addSource(BUS_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });
    }

    addSelectedRouteLayers(map);

    if (!map.getLayer(BUS_SELECTED_LAYER_ID)) {
      map.addLayer({
        id: BUS_SELECTED_LAYER_ID,
        type: "circle",
        source: BUS_SOURCE_ID,
        filter: ["==", ["get", "vehicle_id"], selectedId ?? ""],
        paint: {
          "circle-radius": 12,
          "circle-color": ["coalesce", ["get", "line_color"], "#f7d154"],
          "circle-opacity": 0.28,
          "circle-stroke-color": ["coalesce", ["get", "line_color"], "#f7d154"],
          "circle-stroke-width": 2
        }
      });
    }

    if (!map.getLayer(BUS_LAYER_ID)) {
      map.addLayer({
        id: BUS_LAYER_ID,
        type: "symbol",
        source: BUS_SOURCE_ID,
        layout: {
          "icon-image": ["get", "icon_id"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.82, 16, 1.15],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["get", "line_number"],
          "text-font": ["Open Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 8, 16, 10],
          "text-anchor": "center",
          "text-offset": [0, 0.08],
          "text-allow-overlap": true,
          "text-ignore-placement": true
        },
        paint: {
          "icon-opacity": ["coalesce", ["get", "opacity"], 1],
          "text-color": ["coalesce", ["get", "text_color"], "#06100f"],
          "text-opacity": ["coalesce", ["get", "opacity"], 1],
          "text-halo-color": "rgba(255,255,255,0.36)",
          "text-halo-width": 0.4
        }
      });

      map.on("click", BUS_LAYER_ID, (event) => {
        const vehicleId = event.features?.[0]?.properties?.vehicle_id;
        if (typeof vehicleId === "string") {
          setSelectedId(vehicleId);
        }
      });

      map.on("mouseenter", BUS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", BUS_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
      });
    }
  }

  function addSelectedRouteLayers(map: MapLibreMap) {
    if (!map.getSource(SELECTED_ROUTE_SOURCE_ID)) {
      map.addSource(SELECTED_ROUTE_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getSource(SELECTED_ROUTE_STOPS_SOURCE_ID)) {
      map.addSource(SELECTED_ROUTE_STOPS_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection()
      });
    }

    if (!map.getLayer(SELECTED_ROUTE_CASING_LAYER_ID)) {
      map.addLayer(
        {
          id: SELECTED_ROUTE_CASING_LAYER_ID,
          type: "line",
          source: SELECTED_ROUTE_SOURCE_ID,
          layout: {
            "line-cap": "round",
            "line-join": "round"
          },
          paint: {
            "line-color": "#05080c",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 8, 16, 14],
            "line-opacity": 0.78
          }
        },
        "stcp-stop-halo"
      );
    }

    if (!map.getLayer(SELECTED_ROUTE_LAYER_ID)) {
      map.addLayer(
        {
          id: SELECTED_ROUTE_LAYER_ID,
          type: "line",
          source: SELECTED_ROUTE_SOURCE_ID,
          layout: {
            "line-cap": "round",
            "line-join": "round"
          },
          paint: {
            "line-color": ["coalesce", ["get", "color"], "#7de0d4"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 8],
            "line-opacity": 0.86
          }
        },
        "stcp-stop-halo"
      );
    }

    if (!map.getLayer(SELECTED_ROUTE_STOP_HALO_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_ROUTE_STOP_HALO_LAYER_ID,
        type: "circle",
        source: SELECTED_ROUTE_STOPS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 7],
          "circle-color": ["coalesce", ["get", "color"], "#7de0d4"],
          "circle-opacity": 0.3,
          "circle-stroke-color": "#f6f8fb",
          "circle-stroke-width": 0.6
        }
      });
    }

    if (!map.getLayer(SELECTED_ROUTE_STOP_DOT_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_ROUTE_STOP_DOT_LAYER_ID,
        type: "circle",
        source: SELECTED_ROUTE_STOPS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 3.5],
          "circle-color": ["coalesce", ["get", "color"], "#7de0d4"],
          "circle-stroke-color": "#05080c",
          "circle-stroke-width": 1.2
        }
      });
    }

    if (!map.getLayer(SELECTED_ROUTE_STOP_LABEL_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_ROUTE_STOP_LABEL_LAYER_ID,
        type: "symbol",
        source: SELECTED_ROUTE_STOPS_SOURCE_ID,
        minzoom: 12,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 11,
          "text-offset": [0, 1.25],
          "text-anchor": "top",
          "text-allow-overlap": false
        },
        paint: {
          "text-color": "#f6f8fb",
          "text-halo-color": "#05080c",
          "text-halo-width": 2
        }
      });
    }

    if (!map.getLayer(SELECTED_ROUTE_STOP_HIT_LAYER_ID)) {
      map.addLayer({
        id: SELECTED_ROUTE_STOP_HIT_LAYER_ID,
        type: "circle",
        source: SELECTED_ROUTE_STOPS_SOURCE_ID,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 18, 16, 28],
          "circle-color": "#ffffff",
          "circle-opacity": 0.001
        }
      });
    }

    if (!selectedRouteStopHandlersReadyRef.current) {
      map.on("click", SELECTED_ROUTE_STOP_HIT_LAYER_ID, (event) => {
        event.originalEvent.stopPropagation();
        showSelectedStopEta(event);
      });

      map.on("mouseenter", SELECTED_ROUTE_STOP_HIT_LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", SELECTED_ROUTE_STOP_HIT_LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", (event) => {
        if (!selectedIdRef.current) return;

        const nearestStop = getNearestSelectedRouteStop(event.point);
        if (nearestStop) {
          showSelectedStopPopup(nearestStop.coordinates, nearestStop.properties);
          return;
        }

        const features = map.queryRenderedFeatures(event.point, {
          layers: [SELECTED_ROUTE_STOP_HIT_LAYER_ID].filter((layerId) => map.getLayer(layerId))
        });

        if (!features[0]) return;
        showSelectedStopFeature(features[0]);
      });

      selectedRouteStopHandlersReadyRef.current = true;
    }
  }

  function createBusIconImageData(color: string) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;

    const context = canvas.getContext("2d");
    if (!context) {
      return new ImageData(64, 64);
    }

    context.clearRect(0, 0, 64, 64);
    context.translate(32, 32);

    context.fillStyle = "#06100f";
    context.globalAlpha = 0.35;
    context.beginPath();
    context.ellipse(0, 15, 13, 5, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;

    context.fillStyle = color;
    context.strokeStyle = "rgba(255,255,255,0.82)";
    context.lineWidth = 3;
    roundedRect(context, -13, -16, 26, 35, 7);
    context.fill();
    context.stroke();

    context.fillStyle = "#06100f";
    context.globalAlpha = 0.2;
    roundedRect(context, -9, -10, 18, 18, 5);
    context.fill();
    context.globalAlpha = 1;

    context.fillStyle = color;
    context.beginPath();
    context.moveTo(0, -25);
    context.lineTo(10, -15);
    context.lineTo(-10, -15);
    context.closePath();
    context.fill();
    context.stroke();

    return context.getImageData(0, 0, 64, 64);
  }

  function createMetroTrainIconImageData() {
    const canvas = document.createElement("canvas");
    canvas.width = 56;
    canvas.height = 56;

    const context = canvas.getContext("2d");
    if (!context) return new ImageData(56, 56);

    context.clearRect(0, 0, 56, 56);
    context.translate(28, 28);

    context.fillStyle = "rgba(0,0,0,0.36)";
    context.beginPath();
    context.ellipse(0, 14, 12, 4, 0, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#f6f8fb";
    context.strokeStyle = "#06100f";
    context.lineWidth = 3;
    roundedRect(context, -12, -16, 24, 33, 7);
    context.fill();
    context.stroke();

    context.fillStyle = "#111820";
    roundedRect(context, -7, -10, 14, 8, 3);
    context.fill();

    context.fillStyle = "#7de0d4";
    context.beginPath();
    context.moveTo(0, -22);
    context.lineTo(9, -15);
    context.lineTo(-9, -15);
    context.closePath();
    context.fill();
    context.stroke();

    return context.getImageData(0, 0, 56, 56);
  }

  function roundedRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number
  ) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
    const map = mapRef.current;
    if (map?.getLayer(BUS_SELECTED_LAYER_ID)) {
      map.setFilter(BUS_SELECTED_LAYER_ID, ["==", ["get", "vehicle_id"], selectedId ?? ""]);
    }

    if (!selectedId) {
      popupRef.current?.remove();
      popupRef.current = null;
      popupHtmlRef.current = "";
      if (routeOverlayOwnerRef.current === "vehicle") {
        clearSelectedRouteOverlay();
      }
    }

    renderVehicles(selectedLineFilters);
  }, [selectedId, selectedLineFilters]);

  function getInterpolatedVehicle(vehicleId: string, now: number): VehiclePosition | null {
    const animated = vehiclesRef.current.get(vehicleId);
    if (!animated) return null;

    const rawProgress = (now - animated.animationStartedAt) / animated.animationDurationMs;
    const progress = clamp(rawProgress);
    const routeMotion = animated.routeMotion;
    const routeShape = routeMotion ? routeShapesRef.current.get(routeMotion.shapeKey) : null;

    if (routeMotion && routeShape) {
      const distance =
        rawProgress <= 1
          ? lerp(routeMotion.fromMeters, routeMotion.toMeters, progress)
          : getPredictedRouteDistance(animated, routeMotion, now);
      const point = getPointAtDistance(routeShape, distance);

      return {
        ...animated.current,
        latitude: point.latitude,
        longitude: point.longitude,
        bearing: point.bearing
      };
    }

    return {
      ...animated.current,
      latitude: lerp(animated.previous.latitude, animated.current.latitude, progress),
      longitude: lerp(animated.previous.longitude, animated.current.longitude, progress),
      bearing: lerpAngle(animated.previous.bearing, animated.current.bearing, progress)
    };
  }

  function getPredictedRouteDistance(
    animated: AnimatedVehicle,
    routeMotion: NonNullable<AnimatedVehicle["routeMotion"]>,
    now: number
  ) {
    if (isGpsVeryStale(animated.current)) {
      return routeMotion.toMeters;
    }

    const speedMetersPerSecond = clamp(animated.current.speed ?? 0, 0, MAX_REASONABLE_CITY_SPEED_MPS);
    if (speedMetersPerSecond < 0.5) {
      return routeMotion.toMeters;
    }

    const predictionMs = Math.min(
      MAX_PREDICTION_MS,
      Math.max(0, now - (animated.animationStartedAt + animated.animationDurationMs))
    );
    return routeMotion.toMeters + routeMotion.direction * speedMetersPerSecond * (predictionMs / 1000);
  }

  function createAnimatedVehicle(
    previous: VehiclePosition,
    current: VehiclePosition,
    animationStartedAt: number,
    animationDurationMs: number
  ): AnimatedVehicle {
    const shape = getShapeForVehicle(current);
    const routeMotion = shape ? createRouteMotion(shape, previous, current) : undefined;

    return {
      current,
      previous,
      animationStartedAt,
      animationDurationMs,
      routeMotion
    };
  }

  function createRouteMotion(shape: RouteShape, previous: VehiclePosition, current: VehiclePosition) {
    const from = projectVehicleToShape(previous, shape);
    const to = projectVehicleToShape(current, shape);

    if (from.distanceFromShapeMeters > MAX_SNAP_DISTANCE_METERS || to.distanceFromShapeMeters > MAX_SNAP_DISTANCE_METERS) {
      return undefined;
    }

    let fromMeters = from.distanceAlongShapeMeters;
    const toMeters = to.distanceAlongShapeMeters;
    const direction = inferRouteDirection(shape, fromMeters, toMeters, current);

    if (Math.abs(toMeters - fromMeters) > shape.totalMeters * 0.55) {
      fromMeters = toMeters;
    }

    return {
      shapeKey: routeShapeKey(shape.route_id, shape.direction_id),
      fromMeters,
      toMeters,
      direction
    };
  }

  function getRouteIdForLineNumber(lineNumber: string) {
    const line = linesPayload?.lines.find((l) => l.number.toUpperCase() === lineNumber.toUpperCase());
    return line ? line.id : lineNumber;
  }

  function getShapeForVehicle(vehicle: VehiclePosition) {
    const routeId = getRouteIdForLineNumber(vehicle.line_number);
    if (vehicle.direction_id) {
      const exact = routeShapesRef.current.get(routeShapeKey(routeId, vehicle.direction_id));
      if (exact) return exact;
    }

    const candidates = routeShapeCandidatesRef.current.get(routeId) ?? [];
    if (!candidates.length) return routeShapeFallbackRef.current.get(routeId);

    let bestShape: RouteShape | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const projection = projectVehicleToShape(vehicle, candidate);
      const routePoint = getPointAtDistance(candidate, projection.distanceAlongShapeMeters);
      const bearingPenalty = angleDifference(routePoint.bearing, vehicle.bearing) * 1.25;
      const score = projection.distanceFromShapeMeters + bearingPenalty;

      if (score < bestScore) {
        bestScore = score;
        bestShape = candidate;
      }
    }

    return bestShape ?? routeShapeFallbackRef.current.get(routeId);
  }

  function buildRouteShape(shape: RouteShapePayload["shapes"][number]): RouteShape {
    const cumulativeMeters = [0];

    for (let index = 1; index < shape.coordinates.length; index += 1) {
      cumulativeMeters[index] =
        cumulativeMeters[index - 1] +
        distanceMeters(shape.coordinates[index - 1], shape.coordinates[index]);
    }

    return {
      ...shape,
      cumulativeMeters,
      totalMeters: cumulativeMeters[cumulativeMeters.length - 1] ?? 0
    };
  }

  function projectVehicleToShape(vehicle: VehiclePosition, shape: RouteShape) {
    return projectCoordinateToShape([vehicle.longitude, vehicle.latitude], shape);
  }

  function projectCoordinateToShape(point: [number, number], shape: RouteShape) {
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

  function getPointAtDistance(shape: RouteShape, distance: number) {
    const targetDistance = clamp(distance, 0, shape.totalMeters);
    let low = 1;
    let high = shape.cumulativeMeters.length - 1;
    let segmentIndex = high;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);

      if (targetDistance <= shape.cumulativeMeters[middle]) {
        segmentIndex = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    const previousDistance = shape.cumulativeMeters[segmentIndex - 1] ?? 0;
    const nextDistance = shape.cumulativeMeters[segmentIndex] ?? previousDistance;
    const segmentProgress = nextDistance === previousDistance ? 0 : (targetDistance - previousDistance) / (nextDistance - previousDistance);
    const start = shape.coordinates[segmentIndex - 1] ?? shape.coordinates[0];
    const end = shape.coordinates[segmentIndex] ?? start;

    return {
      longitude: lerp(start[0], end[0], segmentProgress),
      latitude: lerp(start[1], end[1], segmentProgress),
      bearing: bearingBetween(start, end)
    };
  }

  function projectPointToSegment(point: [number, number], start: [number, number], end: [number, number]) {
    const origin = point;
    const p = toLocalMeters(point, origin);
    const a = toLocalMeters(start, origin);
    const b = toLocalMeters(end, origin);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared);

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

  function inferRouteDirection(shape: RouteShape, fromMeters: number, toMeters: number, vehicle: VehiclePosition): 1 | -1 {
    const movedMeters = toMeters - fromMeters;
    if (Math.abs(movedMeters) > 1) {
      return movedMeters > 0 ? 1 : -1;
    }

    const routeBearing = getPointAtDistance(shape, toMeters).bearing;
    return angleDifference(routeBearing, vehicle.bearing) > 100 ? -1 : 1;
  }

  function angleDifference(from: number, to: number) {
    return Math.abs(((((to - from) % 360) + 540) % 360) - 180);
  }

  function getGpsAgeMs(vehicle: VehiclePosition) {
    const gpsTime = new Date(vehicle.updated_at).getTime();
    if (!Number.isFinite(gpsTime)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Date.now() - gpsTime);
  }

  function isGpsVeryStale(vehicle: VehiclePosition) {
    return getGpsAgeMs(vehicle) > VERY_STALE_GPS_AFTER_MS;
  }

  function getVehicleOpacity(vehicle: VehiclePosition) {
    const ageMs = getGpsAgeMs(vehicle);
    if (ageMs > VERY_STALE_GPS_AFTER_MS) return 0.38;
    if (ageMs > STALE_GPS_AFTER_MS) return 0.62;
    return 1;
  }

  function getLineTheme(lineNumber: string) {
    const lineData = linesById.get(lineNumber);
    if (lineData?.color) {
      return { 
        key: lineData.number, 
        label: lineData.name, 
        color: lineData.color, 
        text: lineData.text_color ?? "#FFFFFF" 
      };
    }
    const familyKey = getLineFamilyKey(lineNumber);
    return BUS_LINE_FAMILIES.find((family) => family.key === familyKey) ?? BUS_LINE_FAMILIES[BUS_LINE_FAMILIES.length - 1];
  }

  function getBusIconId(lineNumber: string) {
    const lineData = linesById.get(lineNumber);
    if (lineData) {
      return `${BUS_ICON_PREFIX}-${lineData.number}`;
    }
    return `${BUS_ICON_PREFIX}-${getLineFamilyKey(lineNumber)}`;
  }

  function syncVehiclePopup(vehicle: VehiclePosition | null) {
    const map = mapRef.current;
    if (!map || !selectedIdRef.current || !vehicle) {
      popupRef.current?.remove();
      popupRef.current = null;
      popupHtmlRef.current = "";
      return;
    }

    const lineTheme = getLineTheme(vehicle.line_number);
    const popupHtml = createVehiclePopupHtml(vehicle, lineTheme.color);

    if (!popupRef.current) {
      popupRef.current = new maplibregl.Popup({
        anchor: "bottom",
        closeButton: true,
        closeOnClick: false,
        className: "vehicle-map-popup",
        offset: [0, -22],
        maxWidth: "230px"
      }).on("close", () => {
        setSelectedId(null);
      });
    }

    popupRef.current.setLngLat([vehicle.longitude, vehicle.latitude]);

    if (popupHtmlRef.current !== popupHtml) {
      popupRef.current.setHTML(popupHtml);
      popupHtmlRef.current = popupHtml;
    }

    if (!popupRef.current.isOpen()) {
      popupRef.current.addTo(map);
    }
  }

  function syncSelectedRouteOverlay(vehicle: VehiclePosition | null) {
    const map = mapRef.current;
    const routeSource = map?.getSource(SELECTED_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    const stopsSource = map?.getSource(SELECTED_ROUTE_STOPS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!routeSource || !stopsSource) return;

    if (!selectedIdRef.current || !vehicle) {
      if (routeOverlayOwnerRef.current === "vehicle") {
        clearSelectedRouteOverlay();
      }
      return;
    }

    routeOverlayOwnerRef.current = "vehicle";
    const lineTheme = getLineTheme(vehicle.line_number);
    const shape = getShapeForVehicle(vehicle);
    const stops = getStopsForSelectedVehicle(vehicle);

    routeSource.setData({
      type: "FeatureCollection",
      features: shape
        ? [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: shape.coordinates
              },
              properties: {
                color: lineTheme.color,
                line_number: vehicle.line_number
              }
            }
          ]
        : []
    });

    const stopFeatures = stops.map((stop, index) => {
      const nextArrival = shape ? getNextBusArrivalForStop(vehicle, stop, shape) : null;

      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [stop.longitude, stop.latitude] as [number, number]
        },
        properties: {
          color: lineTheme.color,
          id: stop.stop_id,
          name: stop.stop_name,
          sequence: index + 1,
          line_number: vehicle.line_number,
          vehicle_id: vehicle.vehicle_id,
          next_vehicle_id: nextArrival?.vehicleId ?? null,
          eta_label: nextArrival?.estimate.label ?? "Sem estimativa",
          eta_min: nextArrival?.estimate.etaMin ?? null,
          distance_meters: nextArrival?.estimate.distanceMeters ?? null
        }
      };
    });

    selectedRouteStopClickTargetsRef.current = stopFeatures.map((feature) => ({
      coordinates: feature.geometry.coordinates,
      properties: feature.properties
    }));

    stopsSource.setData({
      type: "FeatureCollection",
      features: stopFeatures
    });
  }

  function syncSelectedLineOverlay(lineNumbers: string[]) {
    const map = mapRef.current;
    const routeSource = map?.getSource(SELECTED_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    const stopsSource = map?.getSource(SELECTED_ROUTE_STOPS_SOURCE_ID) as GeoJSONSource | undefined;
    if (!routeSource || !stopsSource) return;

    if (selectedIdRef.current) {
      return;
    }

    if (lineNumbers.length === 0) {
      if (routeOverlayOwnerRef.current === "line") {
        clearSelectedRouteOverlay();
      }
      return;
    }

    routeOverlayOwnerRef.current = "line";

    const features: any[] = [];
    const stopFeatures: any[] = [];

    for (const lineNumber of lineNumbers) {
      const lineTheme = getLineTheme(lineNumber);
      const routeId = getRouteIdForLineNumber(lineNumber);
      const candidates = routeShapeCandidatesRef.current.get(routeId) ?? [];
      const shapes = candidates.length > 0 ? candidates : (routeShapeFallbackRef.current.get(routeId) ? [routeShapeFallbackRef.current.get(routeId)!] : []);

      for (const shape of shapes) {
        features.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: shape.coordinates
          },
          properties: {
            color: lineTheme.color,
            line_number: lineNumber
          }
        });
      }

      const line = linesPayload?.lines.find((l) => l.number === lineNumber);
      if (line) {
        const uniqueStops = new Map<string, any>();
        for (const direction of line.directions) {
          for (const stop of direction.stops) {
            uniqueStops.set(stop.stop_id, stop);
          }
        }

        let index = 0;
        for (const stop of uniqueStops.values()) {
          stopFeatures.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [stop.longitude, stop.latitude]
            },
            properties: {
              color: lineTheme.color,
              id: stop.stop_id,
              name: stop.stop_name,
              sequence: index + 1,
              line_number: lineNumber,
              vehicle_id: null,
              next_vehicle_id: null,
              eta_label: "Sem estimativa",
              eta_min: null,
              distance_meters: null
            }
          });
          index++;
        }
      }
    }

    routeSource.setData({
      type: "FeatureCollection",
      features
    });

    selectedRouteStopClickTargetsRef.current = stopFeatures.map((feature) => ({
      coordinates: feature.geometry.coordinates,
      properties: feature.properties
    }));

    stopsSource.setData({
      type: "FeatureCollection",
      features: stopFeatures
    });
  }

  function clearSelectedRouteOverlay(removePopup = true) {
    const routeSource = mapRef.current?.getSource(SELECTED_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    const stopsSource = mapRef.current?.getSource(SELECTED_ROUTE_STOPS_SOURCE_ID) as GeoJSONSource | undefined;

    routeSource?.setData(emptyFeatureCollection());
    stopsSource?.setData(emptyFeatureCollection());
    selectedRouteStopClickTargetsRef.current = [];
    routeOverlayOwnerRef.current = null;
    if (removePopup) {
      stopPopupRef.current?.remove();
      stopPopupRef.current = null;
    }
  }

  function getStopsForSelectedVehicle(vehicle: VehiclePosition) {
    const line = linesPayload?.lines.find((entry) => entry.number === vehicle.line_number || entry.id === vehicle.line_number);
    if (!line) return [];

    if (vehicle.direction_id) {
      const exactDirection = line.directions.find((direction) => direction.direction_id === vehicle.direction_id);
      if (exactDirection) return exactDirection.stops;
    }

    return line.directions[0]?.stops ?? [];
  }

  function getStopArrivalEstimate(
    vehicle: VehiclePosition,
    stop: TransitStop,
    shape: RouteShape,
    directionOverride?: 1 | -1
  ) {
    const vehicleProjection = projectVehicleToShape(vehicle, shape);
    const stopProjection = projectCoordinateToShape([stop.longitude, stop.latitude], shape);
    const animated = vehiclesRef.current.get(vehicle.vehicle_id);
    const direction = directionOverride ?? animated?.routeMotion?.direction ?? 1;
    const distanceMeters =
      direction >= 0
        ? getForwardDistance(vehicleProjection.distanceAlongShapeMeters, stopProjection.distanceAlongShapeMeters, shape.totalMeters)
        : getBackwardDistance(vehicleProjection.distanceAlongShapeMeters, stopProjection.distanceAlongShapeMeters, shape.totalMeters);
    const speedMetersPerSecond = Math.max(MIN_ETA_SPEED_MPS, Math.min(MAX_REASONABLE_CITY_SPEED_MPS, vehicle.speed ?? 0));
    const etaMin = distanceMeters < 40 ? 0 : Math.max(1, Math.ceil(distanceMeters / speedMetersPerSecond / 60));

    return {
      distanceMeters: Math.round(distanceMeters),
      etaMin,
      label: etaMin === 0 ? "menos de 1 min" : `${etaMin} min`
    };
  }

  function getNextBusArrivalForStop(selectedVehicle: VehiclePosition, stop: TransitStop, selectedShape: RouteShape) {
    const now = performance.now();
    let bestArrival: {
      vehicleId: string;
      estimate: ReturnType<typeof getStopArrivalEstimate>;
    } | null = null;

    for (const [vehicleId, animated] of vehiclesRef.current) {
      const currentVehicle = animated.current;
      if (currentVehicle.line_number !== selectedVehicle.line_number) continue;
      if (selectedVehicle.direction_id && currentVehicle.direction_id && currentVehicle.direction_id !== selectedVehicle.direction_id) {
        continue;
      }
      if (isGpsVeryStale(currentVehicle)) continue;

      const candidateShape = animated.routeMotion
        ? routeShapesRef.current.get(animated.routeMotion.shapeKey)
        : getShapeForVehicle(currentVehicle);
      if (!candidateShape) continue;
      if (candidateShape.route_id !== selectedShape.route_id || candidateShape.direction_id !== selectedShape.direction_id) continue;

      const vehicle = getInterpolatedVehicle(vehicleId, now) ?? currentVehicle;
      const estimate = getStopArrivalEstimate(vehicle, stop, candidateShape, animated.routeMotion?.direction);

      if (
        !bestArrival ||
        estimate.etaMin < bestArrival.estimate.etaMin ||
        (estimate.etaMin === bestArrival.estimate.etaMin &&
          estimate.distanceMeters < bestArrival.estimate.distanceMeters)
      ) {
        bestArrival = {
          vehicleId: vehicleId.replace(/^stcp-/, ""),
          estimate
        };
      }
    }

    return bestArrival;
  }

  function getForwardDistance(fromMeters: number, toMeters: number, totalMeters: number) {
    return toMeters >= fromMeters ? toMeters - fromMeters : totalMeters - fromMeters + toMeters;
  }

  function getBackwardDistance(fromMeters: number, toMeters: number, totalMeters: number) {
    return toMeters <= fromMeters ? fromMeters - toMeters : fromMeters + (totalMeters - toMeters);
  }

  function showSelectedStopEta(event: maplibregl.MapLayerMouseEvent) {
    const feature = event.features?.[0];
    if (!feature) return;
    showSelectedStopFeature(feature);
  }

  function showSelectedStopFeature(feature: NonNullable<maplibregl.MapLayerMouseEvent["features"]>[number]) {
    const coordinates = feature?.geometry.type === "Point" ? feature.geometry.coordinates : null;
    if (!feature?.properties || !Array.isArray(coordinates)) return;
    showSelectedStopPopup([Number(coordinates[0]), Number(coordinates[1])], feature.properties as SelectedRouteStopClickTarget["properties"]);
  }

  function showSelectedStopPopup(
    coordinates: [number, number],
    properties: SelectedRouteStopClickTarget["properties"]
  ) {
    const map = mapRef.current;
    if (!map) return;

    const stopName = String(properties.name ?? "Paragem");
    const lineNumber = String(properties.line_number ?? "");
    const vehicleId = String(properties.next_vehicle_id ?? properties.vehicle_id ?? "").replace(/^stcp-/, "");
    const etaLabel = String(properties.eta_label ?? "Sem estimativa");
    const distanceMeters =
      typeof properties.distance_meters === "number"
        ? properties.distance_meters
        : Number(properties.distance_meters);
    const distanceLabel = Number.isFinite(distanceMeters)
      ? distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(1)} km`
        : `${Math.round(distanceMeters)} m`
      : "distância indisponível";

    replaceStopPopup();
    stopPopupRef.current = new maplibregl.Popup({
      anchor: "bottom",
      closeButton: true,
      closeOnClick: false,
      className: "stop-eta-popup",
      offset: [0, -12],
      maxWidth: "230px"
    }).on("close", () => {
      stopPopupRef.current = null;
      if (replacingStopPopupRef.current) return;
      if (routeOverlayOwnerRef.current === "stop") {
        clearSelectedRouteOverlay(false);
      }
    })
      .setLngLat(coordinates)
      .setHTML(
        createStopEtaPopupHtml({
          stopName,
          lineNumber,
          vehicleId,
          etaLabel,
          distanceLabel
        })
      )
      .addTo(map);
  }

  function getNearestSelectedRouteStop(point: maplibregl.Point) {
    const map = mapRef.current;
    if (!map) return null;

    let nearestStop: SelectedRouteStopClickTarget | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const stop of selectedRouteStopClickTargetsRef.current) {
      const projected = map.project(stop.coordinates);
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestStop = stop;
      }
    }

    return nearestStop && nearestDistance <= 30 ? nearestStop : null;
  }

  function createStopEtaPopupHtml({
    stopName,
    lineNumber,
    vehicleId,
    etaLabel,
    distanceLabel
  }: {
    stopName: string;
    lineNumber: string;
    vehicleId: string;
    etaLabel: string;
    distanceLabel: string;
  }) {
    return `
      <article class="stop-eta-card">
        <p class="eyebrow">Linha ${escapeHtml(lineNumber)}</p>
        <h3>${escapeHtml(stopName)}</h3>
        <div class="stop-next-vehicle">
          <span>Próximo autocarro</span>
          <b>${vehicleId ? `N.º ${escapeHtml(vehicleId)}` : "Sem veículo ativo"}</b>
        </div>
        <strong>${escapeHtml(etaLabel)}</strong>
        <span>${escapeHtml(distanceLabel)} até esta paragem</span>
        <small>Estimativa baseada nos veículos em circulação nesta linha.</small>
      </article>
    `;
  }

  function emptyFeatureCollection() {
    return {
      type: "FeatureCollection" as const,
      features: []
    };
  }

  function replaceStopPopup() {
    if (!stopPopupRef.current) return;
    replacingStopPopupRef.current = true;
    stopPopupRef.current.remove();
    replacingStopPopupRef.current = false;
    stopPopupRef.current = null;
  }

  function getCanonicalLineNumber(lineNumber: string | null | undefined) {
    const candidate = lineNumber?.trim();
    if (!candidate) return "";
    const candidateUpper = candidate.toUpperCase();

    if (HARDCODED_STCP_LINES[candidateUpper]) {
      return candidateUpper;
    }

    if (canonicalLineCache.has(candidateUpper)) {
      return canonicalLineCache.get(candidateUpper)!;
    }

    let resolved = candidateUpper;
    const exactMatches = (linesPayload?.lines ?? []).filter((entry) => {
      const values = [entry.number, entry.id, entry.name]
        .map((value) => value?.trim().toUpperCase())
        .filter(Boolean) as string[];
      return values.some((value) => normalizeLineReference(value) === normalizeLineReference(candidate));
    });

    if (exactMatches.length) {
      const match = exactMatches.find(m => HARDCODED_STCP_LINES[m.number?.toUpperCase()]) ?? exactMatches[0];
      resolved = match.number?.toUpperCase() ?? candidateUpper;
    }

    canonicalLineCache.set(candidateUpper, resolved);
    return resolved;
  }

  function createVehiclePopupHtml(vehicle: VehiclePosition, lineColor: string) {
    const vehicleNumber = vehicle.vehicle_id.replace(/^stcp-/, "");
    const lineData = linesById.get(vehicle.line_number);
    const resolvedLineNumber = getCanonicalLineNumber(vehicle.line_number) || lineData?.number || vehicle.line_number;
    const directionData = lineData?.directions.find((direction) => direction.direction_id === vehicle.direction_id) ?? null;
    const directionTerminalStop = directionData?.stops?.length
      ? directionData.stops[directionData.stops.length - 1].stop_name
      : null;
    const nextStop = escapeHtml(vehicle.next_stop_name ?? vehicle.next_stop_id ?? "Não disponível");
    const directionLabel = escapeHtml(directionTerminalStop ?? directionData?.headsign ?? "Direção não disponível");
    const eta = vehicle.next_stop_eta_min === null ? "ETA não disponível" : `${vehicle.next_stop_eta_min} min até à próxima`;
    const gpsTime = new Date(vehicle.updated_at).toLocaleTimeString("pt-PT");
    const speed = vehicle.speed === null ? "" : `${Math.round(vehicle.speed * 3.6)} km/h`;

    return `
      <article class="vehicle-popover" style="--line-color: ${lineColor}">
        <header>
          <strong>${escapeHtml(resolvedLineNumber)}</strong>
          <span>${directionLabel}</span>
        </header>
        <div class="vehicle-popover-body">
          <p><span class="popup-dot">P</span><b>Próxima:</b> ${nextStop}</p>
          <p class="popup-eta"><span class="popup-clock">○</span>${escapeHtml(eta)}</p>
          <p class="popup-meta">${escapeHtml(speed ? `${speed} · GPS ${gpsTime}` : `GPS ${gpsTime}`)}</p>
          <p class="popup-vehicle">Veículo n.º ${escapeHtml(vehicleNumber)}</p>
        </div>
      </article>
    `;
  }

  function escapeHtml(value: string | null | undefined) {
    if (value == null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getActiveVehicleCountForLine(lineId: string) {
    let count = 0;
    for (const vehicle of vehiclesRef.current.values()) {
      if (vehicle.current.line_number === lineId) count += 1;
    }
    return count;
  }

  function lineMatchesSearch(vehicleLineId: string, normalizedQuery: string) {
    const query = normalizeSearchText(normalizedQuery);
    if (!query) return true;
    
    const cacheKey = `${vehicleLineId}|${query}`;
    if (searchMatchCache.has(cacheKey)) {
      return searchMatchCache.get(cacheKey)!;
    }

    const normalizedLine = normalizeSearchText(vehicleLineId);
    const isNumericQuery = /^\d+[a-z]?$/i.test(query);

    const line = linesById.get(vehicleLineId);
    const exactLineExists = linesPayload?.lines.some((entry) => normalizeSearchText(entry.number) === query);
    
    let result = false;
    if (isNumericQuery) {
      result = exactLineExists ? normalizedLine === query : normalizedLine.startsWith(query);
    } else if (normalizedLine.includes(query)) {
      result = true;
    } else if (!line) {
      result = false;
    } else {
      result = (
        normalizeSearchText(line.name).includes(query) ||
        line.directions.some((direction) =>
          normalizeSearchText(direction.headsign).includes(query) ||
          direction.stops.some((stop) => normalizeSearchText(stop.stop_name).includes(query))
        )
      );
    }

    searchMatchCache.set(cacheKey, result);
    return result;
  }

  function normalizeSearchText(value: string) {
    return value
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim();
  }

  function routeShapeKey(routeId: string, directionId: string) {
    return `${routeId}:${directionId}`;
  }

  function getAnimationDurationMs(previous: VehiclePosition, next: VehiclePosition) {
    const previousGpsTime = new Date(previous.updated_at).getTime();
    const nextGpsTime = new Date(next.updated_at).getTime();
    const gpsInterval = nextGpsTime - previousGpsTime;

    if (!Number.isFinite(gpsInterval) || gpsInterval <= 0) {
      return DEFAULT_GPS_INTERVAL_MS;
    }

    return Math.min(
      MAX_ANIMATION_INTERVAL_MS,
      Math.max(UPDATE_INTERVAL_MS, gpsInterval)
    );
  }
  const searchLineSuggestions = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    if (!query || query.length < 1) return [];
    
    return allLinesSearchIndex
      .filter((item) => 
        item.numberNorm.includes(query) ||
        item.nameNorm.includes(query) ||
        item.headsignsNorm.some((h) => h.includes(query))
      )
      .map((item) => item.line)
      .slice(0, 5);
  }, [searchQuery, allLinesSearchIndex]);

  const searchStopSuggestions = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    if (!query || query.length < 3) return [];
    
    return allUniqueStops
      .filter((stop) => 
        stop.nameNorm.includes(query) || stop.idNorm.includes(query)
      )
      .slice(0, 5);
  }, [searchQuery, allUniqueStops]);

  return (
    <div className="responsive-app-frame" aria-label="STCP Live Tracking">
    <main className="shell">
      <div ref={mapContainerRef} className="map" />

      <div className="top-stack">
        <section className="topbar" aria-label="Controlos do mapa">
          <div>
            <p className="eyebrow">STCP Live</p>
            <h1>{mode === "bus" ? "Radar de autocarros" : "Metro do Porto"}</h1>
            <div className="topbar-actions">
              <div className="mode-tabs" aria-label="Modo de transporte">
                <button
                  className={mode === "bus" ? "is-active" : ""}
                  onClick={() => {
                    setMode("bus");
                    setActiveMobilePanel(null);
                    setSettingsOpen(false);
                  }}
                  aria-label="Autocarros STCP"
                  title="Autocarros STCP"
                >
                  <StcpLogo />
                </button>
                <button
                  className={mode === "metro" ? "is-active" : ""}
                  onClick={() => {
                    setMode("metro");
                    setActiveMobilePanel(null);
                    setSettingsOpen(false);
                  }}
                  aria-label="Metro do Porto"
                  title="Metro do Porto"
                >
                  <MetroLogo />
                </button>
              </div>
              <button className="topbar-refresh-button" type="button" onClick={() => void refreshVehicleSnapshot()} aria-label="Atualizar dados" title="Atualizar dados">
                <RefreshIcon />
              </button>
            </div>
          </div>

        </section>

      {mode === "bus" && journeyOpen ? (
        <section className={activeMobilePanel === "journey" ? "journey-card is-mobile-panel-open" : "journey-card"} aria-label="Pesquisar caminho">
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p className="eyebrow">Percurso rápido</p>
              <h2>Para onde pretende ir?</h2>
            </div>
            <button type="button" onClick={() => setIsJourneyExpanded(!isJourneyExpanded)} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", padding: "8px" }}>
              <ChevronIcon expanded={!isJourneyExpanded} />
            </button>
          </header>

          {isJourneyExpanded ? (
            <>
          <form className="journey-form" onSubmit={calculateJourney}>
            <div className="journey-time-row">
              <label>
                <span>Quando</span>
                <select value={journeyTimeMode} onChange={(event) => setJourneyTimeMode(event.target.value as "depart" | "arrive")}>
                  <option value="depart">Partir às</option>
                  <option value="arrive">Chegar às</option>
                </select>
              </label>
              <label>
                <span>Hora</span>
                <input
                  type="datetime-local"
                  value={journeyDateTime}
                  onChange={(event) => setJourneyDateTime(event.target.value)}
                />
              </label>
            </div>
            <label className="journey-field">
              <span>Origem</span>
              <input
                value={originQuery}
                onFocus={() => setActiveSuggestionField("origin")}
                onBlur={() => window.setTimeout(() => setActiveSuggestionField(null), 140)}
                onChange={(event) => {
                  setOriginQuery(event.target.value);
                  setOriginCandidate(null);
                  setActiveSuggestionField("origin");
                }}
                placeholder={USER_LOCATION_ORIGIN_LABEL}
              />
              {activeSuggestionField === "origin" && originSuggestions.length > 0 ? (
                <div className="journey-suggestions">
                  {originSuggestions.map((suggestion) => (
                    <button
                      type="button"
                      key={`${suggestion.name}-${suggestion.latitude}-${suggestion.longitude}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setOriginCandidate(suggestion);
                        setOriginQuery(suggestion.name);
                        setOriginSuggestions([]);
                        setActiveSuggestionField(null);
                      }}
                    >
                      {suggestion.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>

            <label className="journey-field">
              <span>Destino</span>
              <input
                value={destinationQuery}
                onFocus={() => setActiveSuggestionField("destination")}
                onBlur={() => window.setTimeout(() => setActiveSuggestionField(null), 140)}
                onChange={(event) => {
                  setDestinationQuery(event.target.value);
                  setDestinationCandidate(null);
                  setActiveSuggestionField("destination");
                }}
                placeholder="Ex.: Aliados, Casa da Música"
              />
              {activeSuggestionField === "destination" && destinationSuggestions.length > 0 ? (
                <div className="journey-suggestions">
                  {destinationSuggestions.map((suggestion) => (
                    <button
                      type="button"
                      key={`${suggestion.name}-${suggestion.latitude}-${suggestion.longitude}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDestinationCandidate(suggestion);
                        setDestinationQuery(suggestion.name);
                        setDestinationSuggestions([]);
                        setActiveSuggestionField(null);
                      }}
                    >
                      {suggestion.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>
            <div className="journey-actions">
              <button type="submit" className="icon-action" disabled={journeyLoading} aria-label="Calcular percurso" title="Calcular percurso">
                {journeyLoading ? <span className="button-loading-dot" aria-hidden="true" /> : <SendIcon />}
              </button>
              <button type="button" className="secondary icon-action" onClick={clearJourneyPlanner} aria-label="Limpar percurso" title="Limpar percurso">
                <TrashIcon />
              </button>
            </div>
          </form>

          <div className="journey-location">
            <span className={locationStatus === "ready" ? "pulse is-online" : "pulse"} />
            {locationStatus === "ready"
              ? "Localização pronta"
              : locationStatus === "pending"
                ? "A pedir localização..."
                : locationStatus === "denied"
                  ? "Localização bloqueada"
                  : locationStatus === "unsupported"
                    ? "Localização indisponível"
                    : "Localização ainda não recebida"}
            {locationStatus === "denied" || locationStatus === "unsupported" ? (
              <button onClick={() => requestUserLocation(true)}>Tentar novamente</button>
            ) : null}
          </div>

          {journeyError ? <p className="journey-error">{journeyError}</p> : null}

          {journeyOptions.length > 1 ? (
            <div className="journey-options" aria-label="Opções de percurso">
              {journeyOptions.map((option) => (
                <button
                  key={`${option.optionLabel}-${option.mode}-${option.legs.map((leg) => `${leg.lineNumber}-${leg.fromStopName}-${leg.toStopName}`).join("-")}`}
                  className={option === journeyPlan ? "is-active" : ""}
                  type="button"
                  onClick={() => {
                    setJourneyPlan(option);
                    focusJourneyPlan(option);
                  }}
                >
                  <span>{option.optionLabel}</span>
                  <strong>{formatJourneyMinutes(option.totalMin)}</strong>
                  <small>
                    {option.transfers === 0 ? "Sem trocas" : `${option.transfers} troca${option.transfers > 1 ? "s" : ""}`} · {formatJourneyMinutes(option.walkingMin)} a pé
                  </small>
                </button>
              ))}
            </div>
          ) : null}

          {journeyPlan ? (
            <article className="journey-result">
              <div>
                <div>
                  <span>Tempo estimado</span>
                  <strong>{formatJourneyMinutes(journeyPlan.totalMin)}</strong>
                </div>
                <button
                  type="button"
                  className="details-toggle"
                  onClick={() => setJourneyDetailsOpen((open) => !open)}
                  aria-expanded={journeyDetailsOpen}
                >
                  {journeyDetailsOpen ? "Ocultar" : "Detalhes"}
                </button>
              </div>
              {journeyDetailsOpen && journeyPlan.mode === "stcp" ? (
                <>
                  <p>{formatJourneySummary(journeyPlan)}</p>
                  <ol>
                    {journeyPlan.legs.map((leg, index) => (
                      <li key={`${leg.lineNumber}-${leg.fromStopName}-${leg.toStopName}-${index}`}>
                        {index === 0
                          ? `Caminhar ${formatJourneyMinutes(journeyPlan.walkToStopMin)} até ${leg.fromStopName}`
                          : `Trocar para a linha ${leg.lineNumber} em ${leg.fromStopName}`}
                        <br />
                        <b>Linha {leg.lineNumber}</b> sentido {leg.headsign}, sair em {leg.toStopName}
                      </li>
                    ))}
                    <li>Caminhar {formatJourneyMinutes(journeyPlan.walkFromStopMin)} até ao destino</li>
                  </ol>
                </>
              ) : journeyDetailsOpen ? (
                <p>Sem ligação direta rápida por STCP perto desse destino. Caminho direto estimado no mapa.</p>
              ) : null}
            </article>
          ) : null}
            </>
          ) : null}
        </section>
      ) : null}

        {mode === "metro" ? (
          <section className="notice-bar">
            Carruagens estimadas por horário GTFS. A camada fica pronta para trocar por tempo real quando existir feed público.
          </section>
        ) : null}
      </div>

      {mode === "bus" ? (
        <section className={activeMobilePanel === "journey" || activeMobilePanel === "stops" || settingsOpen || linesOpen || infoDialog ? "floating-search is-hidden-for-panel" : "floating-search"} aria-label="Pesquisar linha ou paragem">
          <label className="search search-with-icon">
            <span className="search-inline-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7de0d4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              onBlur={() => setTimeout(() => setIsSearchFocused(false), 200)}
              placeholder="Pesquisar Linha ou Paragem..."
            />
            {searchQuery && (
              <button 
                className="search-clear" 
                onClick={() => {
                  setSearchQuery("");
                }}
                aria-label="Limpar pesquisa"
              >
                ✕
              </button>
            )}
          </label>
          
          {isSearchFocused && searchQuery.trim().length > 0 && (
            <div className="search-dropdown" style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(600px, calc(100vw - 36px))",
              background: "#111820",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "8px",
              marginTop: "4px",
              maxHeight: "300px",
              overflowY: "auto",
              zIndex: 10,
              display: "flex"
            }}>
              <div style={{ flex: 1, padding: "8px", borderRight: "1px solid rgba(255,255,255,0.1)" }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "0.8rem", color: "#8a96a3", textTransform: "uppercase" }}>Linhas</h4>
                {searchLineSuggestions.length === 0 ? (
                  <p style={{ fontSize: "0.85rem", color: "#6b7280", margin: 0 }}>Sem resultados</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
                    {searchLineSuggestions.map(line => {
                      const theme = getLineTheme(line.number);
                      return (
                        <li key={line.id}>
                          <button
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              padding: "6px",
                              background: "transparent",
                              border: "none",
                              color: "white",
                              cursor: "pointer",
                              textAlign: "left",
                              borderRadius: "4px"
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectSingleLineFilter(line.id);
                              setSearchQuery(line.id);
                            }}
                          >
                            <span style={{ 
                              background: theme.color, 
                              color: theme.text,
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontWeight: "bold",
                              fontSize: "0.8rem"
                            }}>
                              {line.id}
                            </span>
                            <span style={{ fontSize: "0.85rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {line.name}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div style={{ flex: 1, padding: "8px" }}>
                <h4 style={{ margin: "0 0 8px 0", fontSize: "0.8rem", color: "#8a96a3", textTransform: "uppercase" }}>Paragens</h4>
                {searchStopSuggestions.length === 0 ? (
                  <p style={{ fontSize: "0.85rem", color: "#6b7280", margin: 0 }}>Sem resultados</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
                    {searchStopSuggestions.map(stop => (
                      <li key={stop.id}>
                        <button
                          style={{
                            width: "100%",
                            padding: "6px",
                            background: "transparent",
                            border: "none",
                            color: "white",
                            cursor: "pointer",
                            textAlign: "left",
                            borderRadius: "4px"
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSearchQuery("");
                            mapRef.current?.easeTo({
                              center: [stop.lon, stop.lat],
                              zoom: 15.5,
                              duration: 700
                            });
                          }}
                        >
                          <div style={{ fontWeight: "bold", fontSize: "0.85rem" }}>{stop.name}</div>
                          <div style={{ fontSize: "0.75rem", color: "#8a96a3" }}>{stop.id}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      ) : null}

      {mode === "bus" ? (
        <section className={`line-rail ${isLinesFilterExpanded ? "is-expanded" : "is-collapsed"} ${activeMobilePanel === "stops" ? "is-mobile-panel-open" : ""}`} aria-label="Filtro rápido por linha">
          <div className="line-rail-header">
            <div className="line-rail-actions">
              <button className="lines-button is-active" onClick={() => setLinesOpen(true)} style={{ width: "100%", minWidth: 0, padding: "0 8px", borderLeftWidth: "1px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", boxSizing: "border-box" }}>
                <span aria-hidden="true">≡</span>
                <span>Paragens</span>
              </button>
              <button className="refresh-button icon-button" onClick={() => void refreshVehicleSnapshot()} aria-label="Atualizar" title="Atualizar" style={{ width: "auto", flex: "0 0 32px", height: "32px", borderLeftWidth: "1px", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                <RefreshIcon />
              </button>
            </div>
            <span>Filtrar por</span>
            <button className={selectedLineFilters.length === 0 ? "is-active" : ""} onClick={() => setSelectedLineFilters([])}>
              Todas
            </button>
          </div>
          <div className="line-rail-list">
            {visibleRailLines.length === 0 ? (
              <div style={{ padding: "6px", fontSize: "0.72rem", color: "rgba(255,255,255,0.4)", textAlign: "center" }}>
                Sem favoritos
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", alignItems: "start" }}>
                {(() => {
                  let currentGroup = "";
                  return visibleRailLines.map((line) => {
                    const isFavorite = favoriteLineNumbers.includes(line);
                    const label = isFavorite ? "Favoritos" : getGroupLabel(line);
                    const showHeader = label !== currentGroup;
                    if (showHeader) {
                      currentGroup = label;
                    }

                    const lineTheme = getLineTheme(line);
                    const isActive = selectedLineFilters.includes(line);

                    return (
                      <Fragment key={line}>
                        {showHeader && (
                          <div style={{
                            gridColumn: "1 / -1",
                            fontSize: '0.6rem',
                            textTransform: 'uppercase',
                            color: 'rgba(255, 255, 255, 0.5)',
                            marginTop: '8px',
                            marginBottom: '2px',
                            fontWeight: 600,
                            textAlign: 'center',
                            letterSpacing: '0.5px'
                          }}>
                            {label}
                          </div>
                        )}
                        <button
                          className={`${isActive ? "is-active" : ""} ${isFavorite ? "is-favorite" : ""}`}
                          onClick={() => toggleSelectedLineFilter(line)}
                          style={{
                            borderColor: lineTheme.color,
                            borderLeftColor: lineTheme.color,
                            background: isActive ? lineTheme.color : undefined,
                            color: isActive ? lineTheme.text : "#ffffff"
                          }}
                          title={`Mostrar linha ${line}`}
                        >
                          <span className="line-number-text">{line}</span>
                          <span
                            className="line-favorite-star"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFavoriteLine(line);
                            }}
                            title={isFavorite ? `Remover linha ${line} dos favoritos` : `Adicionar linha ${line} aos favoritos`}
                          >
                            {isFavorite ? "★" : "☆"}
                          </span>
                        </button>
                      </Fragment>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          <button className="line-rail-toggle" onClick={() => setIsLinesFilterExpanded(!isLinesFilterExpanded)} aria-label={isLinesFilterExpanded ? "Colapsar lista de linhas" : "Expandir lista de linhas"} style={{ marginTop: "4px" }}>
            <ChevronIcon expanded={isLinesFilterExpanded} />
          </button>
        </section>
      ) : null}


      {favoriteResult ? (
        <article className="favorite-result-card" aria-label="Resultado do favorito">
          <button className="modal-close" onClick={() => setFavoriteResult(null)} aria-label="Fechar resultado">
            x
          </button>
          <p className="eyebrow">Favorito</p>
          <h2>Linha {favoriteResult.lineNumber}</h2>
          <p>{favoriteResult.headsign}</p>
          <strong>Autocarro n.º {favoriteResult.vehicleId}</strong>
          <span>
            Chega a {favoriteResult.stopName} em {favoriteResult.etaLabel}
          </span>
          <small>{favoriteResult.distanceLabel} até à paragem mais próxima de ti</small>
        </article>
      ) : null}

      <section className="statusbar" aria-label="Estado da ligação">
        {mode === "bus" ? (
          <>
            <span className={connected ? "pulse is-online" : "pulse"} />
            {connected ? "Tempo real ligado" : "A reconectar"}
          </>
        ) : (
          <>
            <span className="pulse is-metro" />
            Metro estimado
            <span className="stop-count">{metroStationCount} estações</span>
            <span className="stop-count">{estimatedTrainCount} carruagens</span>
            <span className="realtime-note">
              {metroScheduleSource === "weekday_template" ? "horário-base" : "por horário"}
            </span>
          </>
        )}
        <div className="status-actions">
          <button onClick={() => setInfoDialog("about")}>Sobre</button>
          <button onClick={() => setInfoDialog("donate")}>Donativos</button>
        </div>
      </section>


      <nav className="mobile-nav-pill" aria-label={"Navega\u00e7\u00e3o principal mobile"}>
        <button
          type="button"
          className={activeMobilePanel === "navigation" && linesOpen ? "is-active" : ""}
          onClick={() => {
            const shouldOpen = activeMobilePanel !== "navigation" || !linesOpen;
            setMode("bus");
            setLinesOpen(shouldOpen);
            setJourneyOpen(false);
            setIsSearchFocused(false);
            setSettingsOpen(false);
            setActiveMobilePanel(shouldOpen ? "navigation" : null);
          }}
          aria-label={"Navega\u00e7\u00e3o"}
          title={"Navega\u00e7\u00e3o"}
        >
          <NavInfoIcon />
          <span>{"Navega\u00e7\u00e3o"}</span>
        </button>
        <button
          type="button"
          className={activeMobilePanel === "journey" ? "is-active" : ""}
          onClick={() => {
            const shouldOpen = activeMobilePanel !== "journey";
            setMode("bus");
            setLinesOpen(false);
            setJourneyOpen(true);
            setIsJourneyExpanded(shouldOpen);
            setIsSearchFocused(false);
            setSettingsOpen(false);
            setActiveMobilePanel(shouldOpen ? "journey" : null);
          }}
          aria-label="Percurso"
          title="Percurso"
        >
          <NavRouteIcon />
          <span>Percurso</span>
        </button>
        <button
          type="button"
          className={activeMobilePanel === "stops" ? "is-active" : ""}
          onClick={() => {
            const shouldOpen = activeMobilePanel !== "stops";
            setMode("bus");
            setLinesOpen(false);
            setJourneyOpen(false);
            setIsSearchFocused(false);
            setSettingsOpen(false);
            setIsLinesFilterExpanded(shouldOpen);
            setActiveMobilePanel(shouldOpen ? "stops" : null);
          }}
          aria-label="Paragens"
          title="Paragens"
        >
          <NavStopsIcon />
          <span>Paragens</span>
        </button>
        <button
          type="button"
          className={activeMobilePanel === "settings" && settingsOpen ? "is-active" : ""}
          onClick={() => {
            const shouldOpen = activeMobilePanel !== "settings" || !settingsOpen;
            setLinesOpen(false);
            setJourneyOpen(false);
            setIsSearchFocused(false);
            setSettingsOpen(shouldOpen);
            setActiveMobilePanel(shouldOpen ? "settings" : null);
          }}
          aria-label={"Defini\u00e7\u00f5es"}
          title={"Defini\u00e7\u00f5es"}
        >
          <NavSettingsIcon />
          <span>{"Defini\u00e7\u00f5es"}</span>
        </button>
      </nav>

      {settingsOpen && activeMobilePanel === "settings" ? (
        <section className="mobile-settings-popover" aria-label={"Defini\u00e7\u00f5es r\u00e1pidas"}>
          <button
            type="button"
            onClick={() => {
              setInfoDialog("about");
              setSettingsOpen(false);
              setActiveMobilePanel(null);
            }}
          >
            <span className="settings-menu-label">
              <span className="settings-menu-icon settings-menu-icon-about" aria-hidden="true" />
              Sobre
            </span>
          </button>
          <button type="button" disabled title="Dispon\u00edvel futuramente">
            <span className="settings-menu-label">
              <span className="settings-menu-icon settings-menu-icon-theme" aria-hidden="true" />
              Modo claro
            </span>
            <small>Brevemente</small>
          </button>
          <button
            type="button"
            onClick={() => {
              setInfoDialog("donate");
              setSettingsOpen(false);
              setActiveMobilePanel(null);
            }}
          >
            <span className="settings-menu-label">
              <span className="settings-menu-icon settings-menu-icon-donate" aria-hidden="true" />
              Donativos
            </span>
          </button>
        </section>
      ) : null}
      {infoDialog ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setInfoDialog(null)}>
          <section className="info-modal" role="dialog" aria-modal="true" aria-label={infoDialog === "about" ? "Sobre" : "Donativos"} onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">{infoDialog === "about" ? "Projeto" : "Apoiar"}</p>
                <h2>{infoDialog === "about" ? "Sobre" : "Donativos"}</h2>
              </div>
              <button className="modal-close" onClick={() => setInfoDialog(null)} aria-label="Fechar">
                x
              </button>
            </header>

            {infoDialog === "about" ? (
              <div className="info-modal-body">
                <p>
                  Esta plataforma foi desenvolvida no âmbito de um projeto de faculdade, com o objetivo de explorar
                  formas mais intuitivas de visualizar e consultar a mobilidade pública na cidade do Porto.
                </p>
                <p>
                  A aplicação permite acompanhar autocarros da STCP num mapa em tempo real, consultar linhas e
                  paragens, filtrar rapidamente por número de linha, ver detalhes de cada veículo e estimar tempos de
                  chegada a paragens selecionadas.
                </p>
                <p>
                  Inclui também uma vista dedicada ao Metro do Porto, com estações, linhas e carruagens estimadas por
                  horário, bem como uma pesquisa de percurso que combina a localização do utilizador com as paragens
                  disponíveis para sugerir uma deslocação prática.
                </p>
                <p>
                  Os dados apresentados dependem das fontes públicas disponíveis e podem sofrer atrasos, pelo que a
                  informação deve ser entendida como uma aproximação visual e funcional ao estado da rede.
                </p>
              </div>
            ) : (
              <div className="info-modal-body donate-body">
                <p>
                  Se este projeto te for útil, podes apoiar o desenvolvimento e a manutenção dos dados, servidores e
                  melhorias da interface.
                </p>
                <div className="donate-options" aria-label="Opções de donativo">
                  <button type="button" className="donate-option paypal-option">
                    <span>PayPal</span>
                  </button>
                  <button type="button" className="donate-option revolut-option">
                    <span>Revolut</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {favoritesOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => { setFavoritesOpen(false); setActiveMobilePanel(null); }}>
          <section className="favorites-modal" role="dialog" aria-modal="true" aria-label="Linhas favoritas" onClick={(event) => event.stopPropagation()}>
            <header className="lines-modal-header">
              <div>
                <p className="eyebrow">Atalhos</p>
                <h2>Linhas favoritas</h2>
              </div>
              <button className="modal-close" onClick={() => { setFavoritesOpen(false); setActiveMobilePanel(null); }} aria-label="Fechar favoritos">
                x
              </button>
            </header>

            <div className="favorites-modal-body">
              <section className="favorite-section">
                <h3>Escolher favorito</h3>
                {linesLoading ? <p className="lines-empty">A carregar linhas...</p> : null}
                {!linesLoading && favoriteLineNumbers.length === 0 ? (
                  <p className="favorite-empty">Ainda não tens linhas favoritas. Adiciona uma linha abaixo.</p>
                ) : null}
                <div className="favorite-line-grid">
                  {favoriteLineNumbers.map((lineNumber) => {
                    const line = linesPayload?.lines.find((entry) => entry.number === lineNumber);
                    const lineTheme = getLineTheme(lineNumber);
                    const isSelected = selectedFavoriteLine === lineNumber;

                    return (
                      <button
                        key={lineNumber}
                        className={isSelected ? "favorite-line is-active" : "favorite-line"}
                        onClick={() => selectFavoriteLine(lineNumber)}
                        style={{
                          borderColor: isSelected ? lineTheme.color : undefined
                        }}
                      >
                        <span style={{ background: line?.color ?? lineTheme.color, color: line?.text_color ?? lineTheme.text }}>
                          {lineNumber}
                        </span>
                        <b>{line?.name ?? "Linha favorita"}</b>
                      </button>
                    );
                  })}
                </div>
              </section>

              {selectedFavoriteLineData ? (
                <section className="favorite-section">
                  <h3>Escolher sentido</h3>
                  <div className="favorite-direction-list">
                    {selectedFavoriteLineData.directions.map((direction) => {
                      const isSelected = favoriteDirectionId === direction.direction_id;
                      return (
                        <button
                          key={`${selectedFavoriteLineData.id}-${direction.direction_id}`}
                          className={isSelected ? "is-active" : ""}
                          onClick={() => handleFavoriteDirection(selectedFavoriteLineData, direction)}
                        >
                          <span>{direction.headsign}</span>
                          <small>{direction.stops.length} paragens</small>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section className="favorite-section">
                <h3>Adicionar linhas</h3>
                <div className="favorite-add-grid">
                  {linesAvailableForFavorite.map((line) => {
                    const isFavorite = favoriteLineNumbers.includes(line.number);
                    return (
                      <button
                        key={line.id}
                        className={isFavorite ? "is-favorite" : ""}
                        onClick={() => toggleFavoriteLine(line.number)}
                      >
                        <span className="favorite-star" aria-hidden="true">
                          {isFavorite ? "★" : "☆"}
                        </span>
                        <span className="line-badge" style={{ background: line.color, color: line.text_color }}>
                          {line.number}
                        </span>
                        <b>{line.name}</b>
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="journey-location">
                <span className={locationStatus === "ready" ? "pulse is-online" : "pulse"} />
                {locationStatus === "ready"
                  ? "Localização pronta"
                  : locationStatus === "pending"
                    ? "A pedir localização..."
                    : locationStatus === "denied"
                      ? "Localização bloqueada"
                      : locationStatus === "unsupported"
                        ? "Localização indisponível"
                        : "Localização ainda não recebida"}
                {locationStatus === "denied" || locationStatus === "unsupported" ? (
                  <button onClick={() => requestUserLocation(true)}>Tentar novamente</button>
                ) : null}
              </div>

              {favoriteError ? <p className="journey-error">{favoriteError}</p> : null}
            </div>
          </section>
        </div>
      ) : null}

      {linesOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => { setLinesOpen(false); setActiveMobilePanel(null); }}>
          <section className={activeMobilePanel === "navigation" ? "lines-modal is-navigation-modal" : "lines-modal"} role="dialog" aria-modal="true" aria-label={activeMobilePanel === "navigation" ? "Navega\u00e7\u00e3o e favoritos" : "Paragens e favoritos"} onClick={(event) => event.stopPropagation()}>
            <header className="lines-modal-header">
              <div>
                <p className="eyebrow">STCP</p>
                <h2>{activeMobilePanel === "navigation" ? "Navega\u00e7\u00e3o" : "Paragens"}</h2>
              </div>
              <button className="modal-close" onClick={() => { setLinesOpen(false); setActiveMobilePanel(null); }} aria-label="Fechar paragens">
                x
              </button>
            </header>

            <div className="lines-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7de0d4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 16px" }}>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={lineSearch}
                onChange={(event) => setLineSearch(event.target.value)}
                placeholder="Procurar linha, destino ou paragem..."
              />
              {lineSearch ? (
                <button onClick={() => setLineSearch("")} aria-label="Limpar pesquisa">
                  x
                </button>
              ) : null}
            </div>

            <div className="lines-modal-body">

              {linesLoading ? <p className="lines-empty">A carregar linhas...</p> : null}
              {linesError ? <p className="lines-empty">{linesError}</p> : null}
              {!linesLoading && !linesError && filteredTransitLines.length === 0 ? (
                <p className="lines-empty">Nenhuma linha encontrada.</p>
              ) : null}

              {!linesLoading && !linesError
                ? (() => {
                    const favorites = filteredTransitLines.filter((line) => favoriteLineNumbers.includes(line.number));
                    const others = filteredTransitLines;

                    return (
                      <>
                        {favorites.length > 0 && (
                          <div className="favorites-group">
                            <div style={{
                              position: "sticky",
                              top: "-10px",
                              zIndex: 10,
                              background: "#0b1118",
                              fontSize: '0.65rem',
                              textTransform: 'uppercase',
                              color: 'rgba(255, 255, 255, 0.5)',
                              padding: '12px 10px 6px 10px',
                              margin: '0 -10px',
                              fontWeight: 'bold'
                            }}>
                              Favoritos
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '8px 0', paddingBottom: '16px' }}>
                              {favorites.map((line) => {
                                const lineTheme = getLineTheme(line.number);
                                const isExpanded = expandedLineId === line.id;
                                return (
                                  <button
                                    key={`modal-fav-badge-${line.id}`}
                                    onClick={() => setExpandedLineId(isExpanded ? null : line.id)}
                                    style={{
                                      display: 'grid',
                                      placeItems: 'center',
                                      minWidth: '50px',
                                      minHeight: '30px',
                                      background: lineTheme.color,
                                      color: lineTheme.text,
                                      padding: '0 8px',
                                      borderRadius: '7px',
                                      border: 'none',
                                      fontSize: '0.9rem',
                                      fontWeight: 900,
                                      cursor: 'pointer',
                                      boxShadow: isExpanded ? `0 0 0 2px #0b1118, 0 0 0 4px ${lineTheme.color}` : 'none',
                                      transition: 'box-shadow 0.15s ease, transform 0.1s ease',
                                      transform: isExpanded ? 'scale(1.05)' : 'scale(1)'
                                    }}
                                  >
                                    {line.number}
                                  </button>
                                );
                              })}
                            </div>
                            {(() => {
                              const expandedFav = favorites.find(f => f.id === expandedLineId);
                              if (!expandedFav) return null;
                              return (
                                <article className="line-card is-expanded" style={{ marginTop: 0, marginBottom: '16px' }}>
                                  <div className="line-directions">
                                    {expandedFav.directions.map((direction) => (
                                      <section className="line-direction" key={`${expandedFav.id}-${direction.direction_id}`}>
                                        <h3>{direction.headsign}</h3>
                                        <ol>
                                          {direction.stops.map((stop, index) => (
                                            <li key={`${direction.direction_id}-${stop.stop_id}-${index}`}>
                                              <span>{index + 1}</span>
                                              <button
                                                onClick={() => {
                                                  mapRef.current?.easeTo({
                                                    center: [stop.longitude, stop.latitude],
                                                    zoom: 15.5,
                                                    duration: 700
                                                  });
                                                  setLinesOpen(false);
                                                }}
                                              >
                                                {stop.stop_name}
                                              </button>
                                            </li>
                                          ))}
                                        </ol>
                                      </section>
                                    ))}
                                  </div>
                                </article>
                              );
                            })()}
                          </div>
                        )}

                        {(() => {
                          let currentGroup = "";
                          return others.map((line) => {
                            const label = getGroupLabel(line.number);
                            const showHeader = label !== currentGroup;
                            if (showHeader) {
                              currentGroup = label;
                            }

                            const lineTheme = getLineTheme(line.number);
                            const activeVehicles = getActiveVehicleCountForLine(line.number);
                            const isExpanded = expandedLineId === line.id;

                            return (
                              <Fragment key={line.id}>
                                {showHeader && (
                                  <div style={{
                                    position: "sticky",
                                    top: "-10px",
                                    zIndex: 10,
                                    background: "#0b1118",
                                    fontSize: '0.65rem',
                                    textTransform: 'uppercase',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                    padding: '12px 10px 6px 10px',
                                    margin: '0 -10px',
                                    fontWeight: 'bold'
                                  }}>
                                    {label}
                                  </div>
                                )}
                                <article className={`line-card ${isExpanded ? "is-expanded" : ""}`}>
                                  <div className="line-card-summary">
                                    <button
                                      className={favoriteLineNumbers.includes(line.number) ? "line-favorite-toggle is-favorite" : "line-favorite-toggle"}
                                      onClick={() => toggleFavoriteLine(line.number)}
                                      aria-label={favoriteLineNumbers.includes(line.number) ? `Remover linha ${line.number} dos favoritos` : `Adicionar linha ${line.number} aos favoritos`}
                                      title={favoriteLineNumbers.includes(line.number) ? "Remover favorito" : "Adicionar favorito"}
                                    >
                                      {favoriteLineNumbers.includes(line.number) ? "★" : "☆"}
                                    </button>
                                    <button className="line-card-expand" onClick={() => setExpandedLineId(isExpanded ? null : line.id)}>
                                      <span className="line-badge" style={{ background: lineTheme.color, color: lineTheme.text }}>
                                        {line.number}
                                      </span>
                                      <span className="line-card-title">
                                        <strong>{line.name}</strong>
                                        <small>
                                          {line.directions.length} sentidos · {activeVehicles} em circulação
                                        </small>
                                      </span>
                                      <span className="line-card-chevron" aria-hidden="true">
                                        {isExpanded ? "−" : "+"}
                                      </span>
                                    </button>
                                  </div>

                                  {isExpanded ? (
                                    <div className="line-directions">
                                      {line.directions.map((direction) => (
                                        <section className="line-direction" key={`${line.id}-${direction.direction_id}`}>
                                          <h3>{direction.headsign}</h3>
                                          <ol>
                                            {direction.stops.map((stop, index) => (
                                              <li key={`${direction.direction_id}-${stop.stop_id}-${index}`}>
                                                <span>{index + 1}</span>
                                                <button
                                                  onClick={() => {
                                                    mapRef.current?.easeTo({
                                                      center: [stop.longitude, stop.latitude],
                                                      zoom: 15.5,
                                                      duration: 700
                                                    });
                                                    setLinesOpen(false);
                                                  }}
                                                >
                                                  {stop.stop_name}
                                                </button>
                                              </li>
                                            ))}
                                          </ol>
                                        </section>
                                      ))}
                                    </div>
                                  ) : null}
                                </article>
                              </Fragment>
                            );
                          });
                        })()}
                      </>
                    );
                  })()
                : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
    </div>
  );
}
