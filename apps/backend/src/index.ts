import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { RedisVehicleStore } from "./cache/redisStore.js";
import { config } from "./config.js";
import { GtfsRealtimeVehicleFeed } from "./feeds/gtfsRealtimeFeed.js";
import { MockVehicleFeed } from "./feeds/mockFeed.js";
import { NgsiVehicleFeed } from "./feeds/ngsiVehicleFeed.js";
import { SocketHub } from "./realtime/socketHub.js";
import { GtfsLinesService } from "./services/gtfsLinesService.js";
import { GtfsNextStopsService } from "./services/gtfsNextStopsService.js";
import { GtfsRouteShapesService } from "./services/gtfsRouteShapesService.js";
import { GtfsStopsService } from "./services/gtfsStopsService.js";
import { MetroEstimatedVehiclesService } from "./services/metroEstimatedVehiclesService.js";
import { MetroNetworkService } from "./services/metroNetworkService.js";
import { VehiclePollingService } from "./services/vehiclePollingService.js";
import type { VehicleFeed } from "./types.js";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*"
  }
});

const store = new RedisVehicleStore(config.REDIS_URL);
const socketHub = new SocketHub(io);
const feed = createVehicleFeed();
const stopsService = new GtfsStopsService(config.GTFS_STATIC_URL);
const linesService = new GtfsLinesService(config.GTFS_STATIC_URL);
const routeShapesService = new GtfsRouteShapesService(config.GTFS_STATIC_URL);
const nextStopsService = new GtfsNextStopsService(config.GTFS_STATIC_URL);
const metroNetworkService = new MetroNetworkService(config.METRO_GTFS_STATIC_URL);
const metroEstimatedVehiclesService = new MetroEstimatedVehiclesService(
  config.METRO_GTFS_STATIC_URL
);

const poller = new VehiclePollingService({
  feed,
  store,
  socketHub,
  nextStopsService,
  pollIntervalMs: config.POLL_INTERVAL_MS,
  staleAfterSeconds: config.STALE_AFTER_SECONDS
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, source: config.FEED_SOURCE });
});

app.get("/vehicles", async (_request, response, next) => {
  try {
    const vehicles = [...(await store.getAll()).values()];
    response.json({ vehicles, serverTime: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/stops", async (_request, response, next) => {
  try {
    const stops = await stopsService.getStops();
    response.json({
      type: "FeatureCollection",
      features: stops.map((stop) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [stop.longitude, stop.latitude]
        },
        properties: {
          id: stop.stop_id,
          name: stop.stop_name
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/lines", async (_request, response, next) => {
  try {
    response.json({ lines: await linesService.getLines() });
  } catch (error) {
    next(error);
  }
});

app.get("/route-shapes", async (_request, response, next) => {
  try {
    const shapes = await routeShapesService.getRouteShapes();
    response.json({ shapes });
  } catch (error) {
    next(error);
  }
});

app.get("/metro/network", async (_request, response, next) => {
  try {
    response.json(await metroNetworkService.getNetwork());
  } catch (error) {
    next(error);
  }
});

app.get("/metro/estimated-vehicles", async (_request, response, next) => {
  try {
    response.json(await metroEstimatedVehiclesService.getEstimatedVehicles());
  } catch (error) {
    next(error);
  }
});

io.on("connection", async (socket) => {
  const vehicles = [...(await store.getAll()).values()];
  socketHub.sendSnapshot(socket.id, vehicles);
});

await store.connect();
poller.start();

httpServer.listen(config.PORT, "0.0.0.0", () => {
  console.info(`[server] listening on http://0.0.0.0:${config.PORT} (local network accessible)`);
});

const shutdown = async () => {
  poller.stop();
  await store.disconnect();
  httpServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function createVehicleFeed(): VehicleFeed {
  if (config.FEED_SOURCE === "mock") {
    return new MockVehicleFeed();
  }

  if (config.FEED_SOURCE === "gtfs-rt") {
    if (!config.GTFS_RT_VEHICLE_POSITIONS_URL) {
      throw new Error("GTFS_RT_VEHICLE_POSITIONS_URL is required when FEED_SOURCE=gtfs-rt");
    }

    return new GtfsRealtimeVehicleFeed({
      url: config.GTFS_RT_VEHICLE_POSITIONS_URL,
      authHeader: config.GTFS_RT_AUTH_HEADER
    });
  }

  return new NgsiVehicleFeed(config.NGSI_VEHICLE_POSITIONS_URL);
}
