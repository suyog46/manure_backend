import { WebSocketServer } from "ws";
import url from "url";
import User from "../models/user.model.js";
import Notification from "../models/notification.model.js";

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  // Map to store active WebSocket connections
  const clients = new Map();
  let esp32Client = null;

  // const heartbeat = () => (this.isAlive = true);

  wss.on("connection", async (ws, req) => {
    const queryObject = url.parse(req.url, true).query;
    const userId = queryObject.userid;
    const device = queryObject.device;
    // if (!userId) {
    //   ws.close(4001, "Missing userID in query params.");
    //   return;
    // }

    try {
      if (device === "esp32") {
        // ESP32 connection
        esp32Client = ws;
        console.log("ESP32 connected.");
        ws.on("message", (message) => handleMessage(ws, message, "esp32"));
        ws.on("close", () => {
          esp32Client = null;
          console.log("ESP32 disconnected.");
        });
      } else if (userId) {
        const user = await User.findById(userId).select(
          "-password -refreshToken"
        );
        if (!user) {
          console.error(`User not found for userID: ${userId}`);
          ws.close(4002, "User authentication fobjectailed.");
          return;
        }

        clients.set(userId, ws);
      }
      console.log(` Total connections: ${clients.size}`);

      // ws.isAlive = true;
      // ws.on("pong", heartbeat);
      //   console.log(`User connected: ${userId}`);
      // console.log(clients.get(userId));

      ws.on("message", (message) => handleMessage(ws, message, userId));
      ws.on("close", () => handleDisconnect(userId));
    } catch (error) {
      console.error(`Error during WebSocket setup: ${error.message}`);
      ws.close(4002, "Internal server error during WebSocket setup.");
    }
  });

  async function handleMessage(ws, message, sender) {
    try {
      const data = JSON.parse(message);
      if (sender === "esp32") {
        console.log("ESP32 sent data.");
        console.log(
          `Received: Temp=${data.temperature}°C, Humidity=${data.humidity}%`
        );

        // Notify all connected clients
        broadcast(data);
        ws.send(JSON.stringify(data));
        // If temperature > 30, send 'r' to ESP32
        if (data.temperature > 30) {
          if (esp32Client && esp32Client.readyState === esp32Client.OPEN) {
            esp32Client.send("r");
            console.log("Sent 'r' to ESP32 due to high temperature.");
          }

          const notification = {
            message: `⚠️ High Temperature Alert! Temp=${data.temperature}°C`,
            createdAt: new Date(),
          };

          await saveNotificationForConnectedUsers(notification);
          broadcast(notification);
        }
      } else {
        console.log(`User ${sender} sent a message:`, message);
        if (esp32Client && esp32Client.readyState === esp32Client.OPEN) {
          esp32Client.send(JSON.stringify(data));
          console.log(`Forwarded user message to ESP32:`, data);
        } else {
          console.log("ESP32 is not connected, cannot forward message.");
        }
      }
    } catch (error) {
      console.error("Invalid JSON received:", message.toString());
    }
  }
  function broadcast(notification) {
    clients.forEach((client, clientId) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(notification));
        console.log(`Sent data to user: ${clientId}`);
      }
    });
    if (esp32Client && esp32Client.readyState === esp32Client.OPEN) {
      esp32Client.send(JSON.stringify(notification));
      console.log("Sent data to ESP32.");
    }
  }

  function handleDisconnect(userId) {
    clients.delete(userId);
    console.log(
      `User disconnected: ${userId} | Active connections: ${clients.size}`
    );
  }

  async function saveNotificationForConnectedUsers(notification) {
    try {
      const connectedUserIds = Array.from(clients.keys()); // Get connected users' IDs
      if (connectedUserIds.length === 0) return; // No connected users, no need to save

      const notificationsToInsert = connectedUserIds.map((userId) => ({
        receiverID: userId,
        message: notification.message,
      }));

      await Notification.insertMany(notificationsToInsert);
      console.log("Notifications saved for connected users.");
    } catch (error) {
      console.error("Error saving notifications:", error.message);
    }
  }

  return {
    sendNotificationToSpecificUser: (targetUserId, notification) => {
      const userId = targetUserId.toString();
      const client = clients.get(userId);
      if (client && client.readyState === client.OPEN) {
        client.send(JSON.stringify(notification));
        console.log(`Socket Notification sent to user: ${userId}`);
      } else {
        console.log(`Target user ${userId} is not connected`);
      }
    },
    broadCastMessage: (message) => {
      broadcast({ message });
    },
  };
}

export { setupWebSocket };
