// ============================================================
// client.js  (ES Module — loaded via <script type="module">)
// -----------------------------------------------------------
// This replaces ALL the hand-rolled RTCPeerConnection / ICE /
// offer-answer code from the first demo. LiveKit's client SDK
// handles the entire WebRTC connection lifecycle internally —
// we just tell it which room to join and render whatever
// tracks it hands us.
// ============================================================

import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

// -------------------- DOM references --------------------
const joinScreen = document.getElementById("join-screen");
const roomScreen = document.getElementById("room-screen");
const roomInput = document.getElementById("room-input");
const nameInput = document.getElementById("name-input");
const joinBtn = document.getElementById("join-btn");
const videoGrid = document.getElementById("video-grid");
const muteBtn = document.getElementById("mute-btn");
const cameraBtn = document.getElementById("camera-btn");
const screenShareBtn = document.getElementById("screen-share-btn");
const leaveBtn = document.getElementById("leave-btn");
const screenShareContainer = document.getElementById("screen-share-container");
const screenShareLabel = document.getElementById("screen-share-label");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

let room; // the LiveKit Room instance for this session
let isMuted = false;
let isCameraOff = false;
let isScreenSharing = false;

// ============================================================
// STEP 1: Join a room
// ============================================================
joinBtn.addEventListener("click", async () => {
  const roomName = roomInput.value.trim();
  const participantName = nameInput.value.trim();

  if (!roomName || !participantName) {
    alert("Please enter both a room name and your name");
    return;
  }

  try {
    // Ask OUR OWN backend for a LiveKit access token. Our server
    // signs this using the API secret, which never touches the
    // browser — the browser only ever sees the short-lived token.
    const res = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, participantName }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to get access token");
    }

    const { token, url } = await res.json();
    await joinLiveKitRoom(url, token);
  } catch (err) {
    alert("Could not join room: " + err.message);
    console.error(err);
  }
});

// ============================================================
// STEP 2: Connect to the LiveKit room
// ============================================================
async function joinLiveKitRoom(url, token) {
  room = new Room({
    // Automatically adjusts received video quality per-subscriber
    // based on bandwidth and tile size — critical for a 30-person
    // room so someone on weak wifi doesn't get 29 full-res streams.
    adaptiveStream: true,
    // Reduces publishing bandwidth/CPU by only encoding what's needed
    dynacast: true,
  });

  // ---------------- Event listeners ----------------

  // Fired whenever ANY participant's track (ours or someone else's)
  // becomes available to render.
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    renderTrack(track, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove());

    // If the track that just ended was a screen share, hide the
    // large display area again.
    if (track.source === Track.Source.ScreenShare) {
      screenShareContainer.style.display = "none";
      screenShareLabel.textContent = "";
    }
  });

  // A participant joined/left — keep the grid accurate even for
  // participants who haven't published a track yet (e.g. audio-only,
  // or camera still initializing).
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    removeParticipantTile(participant.identity);
  });

  // Highlights whoever is currently talking — very useful once
  // you're past a handful of tiles.
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    document
      .querySelectorAll(".participant-tile")
      .forEach((el) => el.classList.remove("speaking"));

    speakers.forEach((speaker) => {
      const tile = document.getElementById(`tile-${speaker.identity}`);
      if (tile) tile.classList.add("speaking");
    });
  });

  // In-call chat, sent over LiveKit's built-in data channel —
  // no separate Socket.io connection needed for this anymore.
  room.on(RoomEvent.DataReceived, (payload, participant) => {
    const message = new TextDecoder().decode(payload);
    addChatMessage(`${participant.identity}: ${message}`);
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log("Disconnected from room");
  });

  // Browsers give the user their OWN native "Stop sharing" button
  // (usually a bar at the top of the tab/window). If they use that
  // instead of our in-app button, this event keeps our UI in sync.
  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) {
      isScreenSharing = false;
      screenShareBtn.textContent = "Share Screen";
      screenShareContainer.style.display = "none";
      screenShareLabel.textContent = "";
    }
  });

  // ---------------- Connect ----------------
  await room.connect(url, token);
  console.log("Connected to room:", room.name);

  // Publish our own camera + mic
  await room.localParticipant.enableCameraAndMicrophone();

  // Render our own local video tile too
  room.localParticipant.videoTrackPublications.forEach((pub) => {
    if (pub.track) renderTrack(pub.track, room.localParticipant);
  });

  joinScreen.style.display = "none";
  roomScreen.style.display = "block";
}

// ============================================================
// Rendering helpers
// ============================================================

// Creates (or reuses) a video/audio tile for a participant and
// attaches the given track to it. Screen-share tracks are routed
// to the large display area instead of the small camera grid,
// since that's what people expect when someone presents.
function renderTrack(track, participant) {
  if (track.source === Track.Source.ScreenShare) {
    renderScreenShare(track, participant);
    return;
  }

  const tileId = `tile-${participant.identity}`;
  let tile = document.getElementById(tileId);

  if (!tile) {
    tile = document.createElement("div");
    tile.id = tileId;
    tile.className = "participant-tile";

    const nameLabel = document.createElement("div");
    nameLabel.className = "participant-name";
    nameLabel.textContent = participant.identity;
    tile.appendChild(nameLabel);

    videoGrid.appendChild(tile);
  }

  // track.attach() returns an <audio> or <video> element already
  // wired up to play this track — we just insert it into the DOM.
  const el = track.attach();
  if (track.kind === Track.Kind.Video) {
    tile.insertBefore(el, tile.firstChild);
  } else {
    // Audio tracks don't need to be visible, just present so they play
    el.style.display = "none";
    tile.appendChild(el);
  }
}

// Displays a screen-share track in the large area above the grid.
// Only one screen share is shown at a time in this simple version —
// if you need multiple simultaneous presenters, you'd extend this
// to a small list/tab switcher instead of a single container.
function renderScreenShare(track, participant) {
  const el = track.attach();
  screenShareLabel.textContent = `${participant.identity} is sharing their screen`;

  // Clear any previous screen-share video element before adding the new one
  const existingVideo = screenShareContainer.querySelector("video");
  if (existingVideo) existingVideo.remove();

  screenShareContainer.appendChild(el);
  screenShareContainer.style.display = "block";
}

function removeParticipantTile(identity) {
  const tile = document.getElementById(`tile-${identity}`);
  if (tile) tile.remove();
}

// ============================================================
// Controls: mute / camera / leave
// ============================================================
muteBtn.addEventListener("click", async () => {
  isMuted = !isMuted;
  await room.localParticipant.setMicrophoneEnabled(!isMuted);
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
});

cameraBtn.addEventListener("click", async () => {
  isCameraOff = !isCameraOff;
  await room.localParticipant.setCameraEnabled(!isCameraOff);
  cameraBtn.textContent = isCameraOff ? "Camera On" : "Camera Off";
});

leaveBtn.addEventListener("click", () => {
  if (room) room.disconnect();
  location.reload();
});

// Screen share: setScreenShareEnabled(true) triggers the browser's
// native "choose what to share" picker (tab/window/entire screen).
// LiveKit publishes it as a video track with source = ScreenShare,
// which our renderTrack() function routes to the large display area
// for every OTHER participant automatically.
screenShareBtn.addEventListener("click", async () => {
  try {
    isScreenSharing = !isScreenSharing;

    if (isScreenSharing) {
      await room.localParticipant.setScreenShareEnabled(true, {
        audio: true, // also share system/tab audio if the browser supports it
      });
      screenShareBtn.textContent = "Stop Sharing";

      // setScreenShareEnabled doesn't hand us the track directly, so
      // pull it from our own publications to render it locally too.
      room.localParticipant.videoTrackPublications.forEach((pub) => {
        if (pub.source === Track.Source.ScreenShare && pub.track) {
          renderScreenShare(pub.track, room.localParticipant);
        }
      });
    } else {
      await room.localParticipant.setScreenShareEnabled(false);
      screenShareBtn.textContent = "Share Screen";
      screenShareContainer.style.display = "none";
      screenShareLabel.textContent = "";
    }
  } catch (err) {
    // Common cause: user clicked "Cancel" on the browser's share picker
    console.warn("Screen share cancelled or failed:", err);
    isScreenSharing = false;
    screenShareBtn.textContent = "Share Screen";
  }
});

// If we started sharing our OWN screen, render it locally too so we
// can confirm what everyone else is seeing.


// ============================================================
// Chat over LiveKit's data channel
// ============================================================
chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || !room) return;

  const data = new TextEncoder().encode(message);
  // reliable: true means it uses a guaranteed-delivery channel
  // (like TCP) rather than best-effort — appropriate for chat text.
  await room.localParticipant.publishData(data, { reliable: true });

  addChatMessage(`You: ${message}`);
  chatInput.value = "";
}

function addChatMessage(text) {
  const p = document.createElement("p");
  p.textContent = text;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}