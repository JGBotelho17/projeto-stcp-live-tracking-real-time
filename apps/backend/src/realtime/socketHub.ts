import type { Server } from "socket.io";
import type { VehicleDelta, VehiclePosition } from "../types.js";

export class SocketHub {
  constructor(private readonly io: Server) {}

  broadcastDelta(delta: VehicleDelta) {
    this.io.emit("vehicle:delta", delta);
  }

  sendSnapshot(socketId: string, vehicles: VehiclePosition[]) {
    this.io.to(socketId).emit("vehicle:snapshot", {
      vehicles,
      serverTime: new Date().toISOString()
    });
  }
}
