// ============================================================
// server.js
// -----------------------------------------------------------
// This server does NOT handle any video/audio itself.
// Its only job is "signaling": passing small text messages
// (SDP offers/answers + ICE candidates) between two browsers
// so they can find each other and set up a direct WebRTC
// connection. Once connected, video/audio flows peer-to-peer,
// not through this server.
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the frontend (public/index.html, client.js, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
// In-memory tracking of who is in which "room".
// A room = a unique ID shared by exactly 2 people who want to
// call each other. In production you might store this in
// MongoDB/Redis instead, but for a simple demo, memory is fine.
// ------------------------------------------------------------
const rooms = {}; // { roomId: [socketId1, socketId2] }

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // --------------------------------------------------------
  // Client asks to join a specific room (call ID).
  // If the room is empty, they're the "first" person (caller).
  // If someone is already there, they're the "second" (callee).
  // --------------------------------------------------------
  socket.on("join-room", (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }

    // Simple demo limit: only allow 2 people per room (1:1 call)
    if (rooms[roomId].length >= 2) {
      socket.emit("room-full");
      return;
    }

    rooms[roomId].push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId; // remember which room this socket is in

    console.log(`[join-room] ${socket.id} joined ${roomId}`);

    // Tell the OTHER person in the room that someone new joined,
    // so they know to start the WebRTC "offer" process.
    socket.to(roomId).emit("user-joined", socket.id);
  });

  // --------------------------------------------------------
  // Relay WebRTC signaling messages between the two peers.
  // The server doesn't need to understand offer/answer/ICE data
  // — it just forwards it to whoever else is in the room.
  // --------------------------------------------------------
  socket.on("offer", (payload) => {
    // payload = { roomId, offer }
    socket.to(payload.roomId).emit("offer", {
      offer: payload.offer,
      from: socket.id,
    });
  });

  socket.on("answer", (payload) => {
    // payload = { roomId, answer }
    socket.to(payload.roomId).emit("answer", {
      answer: payload.answer,
      from: socket.id,
    });
  });

  socket.on("ice-candidate", (payload) => {
    // payload = { roomId, candidate }
    socket.to(payload.roomId).emit("ice-candidate", {
      candidate: payload.candidate,
      from: socket.id,
    });
  });

  // --------------------------------------------------------
  // Simple chat text alongside the call (optional, but shows
  // the same emit/on pattern you'll reuse everywhere).
  // --------------------------------------------------------
  socket.on("chat-message", (payload) => {
    // payload = { roomId, message }
    socket.to(payload.roomId).emit("chat-message", {
      message: payload.message,
      from: socket.id,
    });
  });

  // --------------------------------------------------------
  // Cleanup when someone disconnects (closes tab, loses network,
  // etc). Tell the other peer so they can end the call on their side.
  // --------------------------------------------------------
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    console.log(`[disconnect] ${socket.id} (room: ${roomId})`);

    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      socket.to(roomId).emit("user-left", socket.id);

      // Clean up empty rooms so the object doesn't grow forever
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});