import { io } from "socket.io-client";
import axios from "axios";

const socket = io("http://localhost:3001", {
  autoConnect: false,
  withCredentials: true,

  // Always get the latest access token
  auth: (callback) => {
    callback({
      token: localStorage.getItem("token"),
    });
  },
});

// Prevent multiple socket refresh requests
let refreshingSocket = false;

socket.on("connect_error", async (error) => {
  console.error("Socket connection error:", error.message);

  if (
    !error.message.includes("expired") &&
    !error.message.includes("Invalid")
  ) {
    return;
  }

  if (refreshingSocket) return;

  refreshingSocket = true;

  try {
    const response = await axios.post(
      "http://localhost:3001/api/auth/refresh",
      {},
      { withCredentials: true },
    );

    const newToken = response.data.token;

    if (!newToken) {
      throw new Error("Access token not received");
    }

    localStorage.setItem("token", newToken);

    // Reconnect using the latest token
    socket.connect();
  } catch (refreshError) {
    console.error("Socket token refresh failed:", refreshError);

    localStorage.removeItem("token");
    localStorage.removeItem("user");

    window.location.href = "/login";
  } finally {
    refreshingSocket = false;
  }
});

export default socket;
