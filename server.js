// ============================================================
// server.js  (ES Modules — note "type": "module" in package.json)
// -----------------------------------------------------------
// WHY THE ARCHITECTURE CHANGED FROM THE FIRST DEMO:
//
// The original version used raw WebRTC + Socket.io as the
// signaling layer, with peers connecting directly to each other
// (mesh). That works for 1:1 calls but falls apart for group
// study rooms of 3-30 people — a 30-person mesh would need
// ~870 individual peer connections, which no phone or laptop
// can realistically handle.
//
// The fix is an SFU (Selective Forwarding Unit): a media server
// that every participant sends ONE stream to, and receives
// everyone else's streams FROM. We're using LiveKit, a
// production-grade open-source SFU with a hosted "LiveKit Cloud"
// option, so we don't have to run our own media server yet.
//
// This backend's only job now is:
//   1. Authenticate the student (your existing auth/session logic)
//   2. Issue a short-lived LiveKit access token for the room
//      they're allowed to join
//   3. Hand that token to the browser, which connects DIRECTLY
//      to LiveKit using the livekit-client SDK (no more
//      hand-rolled RTCPeerConnection code, no more Socket.io
//      signaling — LiveKit's own client SDK handles all of that
//      internally over its own protocol).
//
// Socket.io is gone from this version. It's optional to bring
// back later ONLY for app-specific real-time features LiveKit
// doesn't cover (e.g. custom notifications), not for media.
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const {
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_URL,
  PORT = 3000,
} = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  console.warn(
    "[warning] LiveKit env vars are missing. Copy .env.example to .env " +
      "and fill in your LiveKit Cloud project credentials before testing " +
      "real calls. The server will still start, but /token will fail."
  );
}

// ------------------------------------------------------------
// POST /token
// body: { roomName: "study-room-123", participantName: "chinedu_o" }
//
// In production, DON'T trust participantName from the client.
// Pull the student's verified identity from your existing auth
// session/JWT (you likely already have this from your wallet
// funding + student auth system) instead of accepting it raw
// from the request body.
// ------------------------------------------------------------
app.post("/token", async (req, res) => {
  try {
    const { roomName, participantName } = req.body;

    if (!roomName || !participantName) {
      return res
        .status(400)
        .json({ error: "roomName and participantName are required" });
    }

    // Basic guardrails — sanitize/limit input since this becomes
    // part of a signed token and a room identifier.
    if (roomName.length > 100 || participantName.length > 100) {
      return res.status(400).json({ error: "roomName/participantName too long" });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantName,
      // Keep tokens short-lived — a student refreshing the page
      // should re-request a token, not hold one indefinitely.
      ttl: "2h",
    });

    // roomJoin grants permission to join this specific room.
    // canPublish/canSubscribe are true by default for a normal
    // participant. For a "view only" moderator dashboard or a
    // muted-by-default policy, you'd set canPublish: false here.
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true, // needed for in-call chat over LiveKit's data channel
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: LIVEKIT_URL,
    });
  } catch (err) {
    console.error("Error generating token:", err);
    res.status(500).json({ error: "Failed to generate access token" });
  }
});

// Simple health check — useful for Railway/Fly.io deploy checks
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Token server running on http://localhost:${PORT}`);
});