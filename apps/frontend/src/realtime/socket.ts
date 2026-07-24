import { io } from "socket.io-client";

const backendUrl =
  import.meta.env.VITE_SOCKET_URL ||
  `${window.location.protocol}//${window.location.hostname}:4000`;

export const apiBaseUrl = backendUrl;

export const socket = io(apiBaseUrl, {
  transports: ["websocket"]
});
