// ============================================================
// client.js
// -----------------------------------------------------------
// This file has two jobs:
//   1. Talk to the Socket.io server (signaling)
//   2. Set up the actual WebRTC peer connection (the real
//      video/audio stream, which goes directly browser-to-browser)
// ============================================================

// -------------------- DOM references --------------------
const joinScreen = document.getElementById("join-screen");
const videoContainer = document.getElementById("video-container");
const roomInput = document.getElementById("room-input");
const joinBtn = document.getElementById("join-btn");
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const muteBtn = document.getElementById("mute-btn");
const cameraBtn = document.getElementById("camera-btn");
const hangupBtn = document.getElementById("hangup-btn");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

// -------------------- State --------------------
let socket; // socket.io connection
let localStream; // our own camera/mic stream
let peerConnection; // the WebRTC connection to the other person
let roomId;

// STUN servers help each browser discover its public-facing
// network address so peers can find each other. These are free
// public Google STUN servers — fine for development/testing.
// NOTE: for production, especially with users on mobile data or
// restrictive networks (common for students on campus wifi),
// you will ALSO need a TURN server, or some calls will fail to
// connect. STUN alone is not enough in the real world.
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ============================================================
// STEP 1: Join a room
// ============================================================
joinBtn.addEventListener("click", async () => {
  roomId = roomInput.value.trim();
  if (!roomId) {
    alert("Please enter a room ID");
    return;
  }

  // Ask the browser for camera + mic access.
  // This will pop up a permission prompt.
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    alert("Could not access camera/microphone: " + err.message);
    return;
  }

  localVideo.srcObject = localStream;

  // Switch UI from "join screen" to "in-call screen"
  joinScreen.style.display = "none";
  videoContainer.style.display = "block";

  // Now connect to the signaling server
  connectSocket();
});

// ============================================================
// STEP 2: Connect to Socket.io and set up signaling listeners
// ============================================================
function connectSocket() {
  socket = io(); // connects to the same host that served this page

  socket.on("connect", () => {
    console.log("Connected to signaling server:", socket.id);
    socket.emit("join-room", roomId);
  });

  socket.on("room-full", () => {
    alert("This room already has 2 people. Try a different room ID.");
  });

  // Fired on the FIRST person's browser when a SECOND person joins.
  // The first person becomes the "caller" and starts the offer.
  socket.on("user-joined", async () => {
    console.log("Another user joined — creating offer...");
    await createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", { roomId, offer });
  });

  // Fired on the SECOND person's browser when they receive the offer.
  socket.on("offer", async ({ offer }) => {
    console.log("Received offer — creating answer...");
    await createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit("answer", { roomId, answer });
  });

  // Fired on the FIRST person's browser once the second person answers.
  socket.on("answer", async ({ answer }) => {
    console.log("Received answer — connection should establish now");
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  // ICE candidates are potential network paths (IP/port combos)
  // that WebRTC discovers over time. Both sides trade these until
  // they find a path that works between them.
  socket.on("ice-candidate", async ({ candidate }) => {
    try {
      if (candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error("Error adding received ICE candidate", err);
    }
  });

  // The other person disconnected — clean up on our side too
  socket.on("user-left", () => {
    console.log("Other user left the call");
    remoteVideo.srcObject = null;
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
  });

  // Simple chat messages, using the same emit/on pattern
  socket.on("chat-message", ({ message }) => {
    addChatMessage("Them: " + message);
  });
}

// ============================================================
// STEP 3: Create the actual WebRTC peer connection
// ============================================================
async function createPeerConnection() {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  // Add our own camera/mic tracks to the connection so the
  // other person can receive them.
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // Fired whenever WebRTC finds a new possible network path.
  // We forward it to the other peer via the signaling server.
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", { roomId, candidate: event.candidate });
    }
  };

  // Fired when we start receiving the OTHER person's video/audio.
  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  // Useful for debugging connection issues
  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);
  };
}

// ============================================================
// Call controls: mute / camera toggle / hang up
// ============================================================
let isMuted = false;
muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
});

let isCameraOff = false;
cameraBtn.addEventListener("click", () => {
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach((track) => (track.enabled = !isCameraOff));
  cameraBtn.textContent = isCameraOff ? "Camera On" : "Camera Off";
});

hangupBtn.addEventListener("click", () => {
  if (peerConnection) peerConnection.close();
  if (socket) socket.disconnect();
  localStream.getTracks().forEach((track) => track.stop());
  location.reload(); // simplest way to fully reset the demo
});


// ============================================================
// Simple chat alongside the call
// ============================================================
chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  socket.emit("chat-message", { roomId, message });
  addChatMessage("You: " + message);
  chatInput.value = "";
}

function addChatMessage(text) {
  const p = document.createElement("p");
  p.textContent = text;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}