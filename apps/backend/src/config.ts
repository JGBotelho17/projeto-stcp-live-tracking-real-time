import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  POLL_INTERVAL_MS: z.coerce.number().default(5_000),
  STALE_AFTER_SECONDS: z.coerce.number().default(180),
  FEED_SOURCE: z.enum(["ngsi", "gtfs-rt", "mock"]).default("ngsi"),
  NGSI_VEHICLE_POSITIONS_URL: z
    .string()
    .default(
      "https://broker.fiware.urbanplatform.portodigital.pt/v2/entities?q=vehicleType==bus&limit=1000"
    ),
  GTFS_STATIC_URL: z
    .string()
    .default(
      "https://opendata.porto.digital/dataset/5275c986-592c-43f5-8f87-aabbd4e4f3a4/resource/96c0ba2f-feb1-47c1-8e39-8588d0b5768d/download/gtfs_feed.zip"
    ),
  METRO_GTFS_STATIC_URL: z
    .string()
    .default(
      "https://opendata.porto.digital/dataset/15f22603-a216-492a-ab1c-40b1d8aa2f08/resource/5e2b445d-b85b-4afb-9116-90b24327151c/download/___"
    ),
  GTFS_RT_VEHICLE_POSITIONS_URL: z.string().optional().default(""),
  GTFS_RT_AUTH_HEADER: z.string().optional().default("")
});

export const config = schema.parse(process.env);
