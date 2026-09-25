import { io } from "socket.io-client";
import { getActiveBusinessId } from "../api/businessStorage";
import { backendOrigin } from "./backendUrl";

export const socket = io(import.meta.env.VITE_SOCKET_URL || backendOrigin, {
    autoConnect: false,
    transports: ["websocket", "polling"],
    tryAllTransports: true,
    auth: {
        businessId: getActiveBusinessId(),
    },
});

export function refreshSocketBusinessContext() {
    socket.auth = {
        ...(typeof socket.auth === "object" && socket.auth ? socket.auth : {}),
        businessId: getActiveBusinessId(),
    };

    if (socket.connected) {
        socket.disconnect();
        socket.connect();
    }
}
