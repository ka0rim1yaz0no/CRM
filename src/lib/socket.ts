import { io } from "socket.io-client";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { backendOrigin } from "./backendUrl";

function socketAuth() {
    const authUser = getAuthUser();
    return {
        businessId: getActiveBusinessId(),
        userType: authUser?.userType || "",
        userCode: authUser?.user.employeeCode || "",
    };
}

export const socket = io(import.meta.env.VITE_SOCKET_URL || backendOrigin, {
    autoConnect: false,
    transports: ["websocket", "polling"],
    tryAllTransports: true,
    auth: socketAuth(),
});

function sameSocketAuth(first: ReturnType<typeof socketAuth>, second: ReturnType<typeof socketAuth>) {
    return first.businessId === second.businessId
        && first.userType === second.userType
        && first.userCode === second.userCode;
}

export function refreshSocketBusinessContext() {
    socket.auth = socketAuth();

    if (socket.connected) {
        socket.disconnect();
        socket.connect();
    }
}

export function connectAuthenticatedSocket() {
    const nextAuth = socketAuth();
    const currentAuth = socket.auth as ReturnType<typeof socketAuth>;

    if (socket.connected && !sameSocketAuth(currentAuth, nextAuth)) {
        socket.disconnect();
    }

    socket.auth = nextAuth;
    socket.connect();
}
