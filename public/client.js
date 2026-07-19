// ============================================================
// client.js  (ES Module — loaded via <script type="module">)
// -----------------------------------------------------------
// LiveKit's client SDK handles the entire WebRTC connection
// lifecycle internally — we just tell it which room to join
// and render whatever tracks/participants it hands us.
// ============================================================

import {
  Room,
  RoomEvent,
  Track,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

// -------------------- DOM references --------------------
const joinScreen = document.getElementById("join-screen");
const roomScreen = document.getElementById("room-screen");
const roomInput = document.getElementById("room-input");
const nameInput = document.getElementById("name-input");
const joinBtn = document.getElementById("join-btn");

const roomNameDisplay = document.getElementById("room-name-display");
const participantCountNum = document.getElementById("participant-count-num");
const joinExitBtn = document.getElementById("join-exit-btn");
const participantList = document.getElementById("participant-list");

const videoGrid = document.getElementById("video-grid");
const muteBtn = document.getElementById("mute-btn");
const cameraBtn = document.getElementById("camera-btn");
const screenShareBtn = document.getElementById("screen-share-btn");
const screenShareContainer = document.getElementById("screen-share-container");
const screenShareLabel = document.getElementById("screen-share-label");

const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const typingIndicator = document.getElementById("typing-indicator");

let room; // the LiveKit Room instance for this session
let isMuted = false;
let isCameraOff = false;
let isScreenSharing = false;
let typingTimeout = null; // debounce so we don't spam "typing" events

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
    await joinLiveKitRoom(url, token, roomName);
  } catch (err) {
    alert("Could not join room: " + err.message);
    console.error(err);
  }
});

// ============================================================
// STEP 2: Connect to the LiveKit room
// ============================================================
async function joinLiveKitRoom(url, token, roomName) {
  room = new Room({
    // Automatically adjusts received video quality per-subscriber
    // based on bandwidth and tile size — critical for a large
    // room so someone on weak wifi doesn't get everyone's full-res feed.
    adaptiveStream: true,
    // Reduces publishing bandwidth/CPU by only encoding what's needed
    dynacast: true,
  });

  // ---------------- Event listeners ----------------

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    renderTrack(track, participant);
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove());
    if (track.source === Track.Source.ScreenShare) {
      screenShareContainer.style.display = "none";
      screenShareLabel.textContent = "";
    }
  });

  // Keep the participant list + count in sync as people come and go
  room.on(RoomEvent.ParticipantConnected, () => refreshParticipantList());
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    removeParticipantTile(participant.identity);
    refreshParticipantList();
  });

  // Highlights whoever is currently talking — both on video tiles
  // and in the participant list.
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const speakingIds = new Set(speakers.map((s) => s.identity));

    document.querySelectorAll(".participant-tile").forEach((el) => {
      el.classList.toggle("speaking", speakingIds.has(el.dataset.identity));
    });
    document.querySelectorAll(".participant-row").forEach((el) => {
      el.querySelector(".p-name").classList.toggle(
        "speaking",
        speakingIds.has(el.dataset.identity)
      );
    });
  });

  // Chat + typing indicator both travel over LiveKit's data channel.
  // We tag each payload with a "type" so we can tell them apart.
  room.on(RoomEvent.DataReceived, (payload, participant) => {
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }

    if (data.type === "chat") {
      addChatMessage(participant.identity, data.message);
    } else if (data.type === "typing") {
      showTypingIndicator(participant.identity);
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log("Disconnected from room");
  });

  // Browsers give the user their OWN native "Stop sharing" button.
  // If they use that instead of our in-app button, this keeps our
  // UI in sync.
  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) {
      isScreenSharing = false;
      screenShareBtn.textContent = "Share Screen";
      screenShareContainer.style.display = "none";
      screenShareLabel.textContent = "";
    }
  });

  // Mic mute state changes (ours or others') should refresh the
  // little mic icon in the participant list.
  room.on(RoomEvent.TrackMuted, () => refreshParticipantList());
  room.on(RoomEvent.TrackUnmuted, () => refreshParticipantList());

  // ---------------- Connect ----------------
  await room.connect(url, token);
  console.log("Connected to room:", room.name);

  roomNameDisplay.textContent = roomName;

  // Publish our own camera + mic
  await room.localParticipant.enableCameraAndMicrophone();

  // Render our own local video tile too
  room.localParticipant.videoTrackPublications.forEach((pub) => {
    if (pub.track) renderTrack(pub.track, room.localParticipant);
  });

  refreshParticipantList();

  joinScreen.style.display = "none";
  roomScreen.classList.add("active");
}

// ============================================================
// Participant list panel — name + per-row speaker/mic controls
// ============================================================

// Tracks which remote participants we've locally muted (mute-for-me
// only — does not affect what anyone else hears).
const locallyMutedIdentities = new Set();

function refreshParticipantList() {
  if (!room) return;

  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  participantCountNum.textContent = all.length;

  participantList.innerHTML = "";

  all.forEach((participant) => {
    const isLocal = participant === room.localParticipant;
    const row = document.createElement("div");
    row.className = "participant-row";
    row.dataset.identity = participant.identity;

    const nameEl = document.createElement("div");
    nameEl.className = "p-name";
    nameEl.textContent = participant.identity + (isLocal ? " (you)" : "");
    row.appendChild(nameEl);

    const controls = document.createElement("div");
    controls.className = "row-controls";

    // Speaker icon: mute THEIR audio, just for you. Doesn't apply
    // to your own row — muting yourself is what the mic icon does.
    if (!isLocal) {
      const speakerBtn = document.createElement("button");
      speakerBtn.className = "icon-toggle";
      const isLocallyMuted = locallyMutedIdentities.has(participant.identity);
      speakerBtn.textContent = isLocallyMuted ? "🔇" : "🔊";
      speakerBtn.title = isLocallyMuted ? "Unmute for me" : "Mute for me";
      speakerBtn.addEventListener("click", () => {
        toggleLocalMuteForParticipant(participant);
      });
      controls.appendChild(speakerBtn);
    }

    // Mic icon: shows whether THIS person's mic is currently on.
    // On your own row, clicking it toggles your real mic (same
    // action as the main Mute button below).
    const micBtn = document.createElement("button");
    micBtn.className = "icon-toggle";
    const micTrackPub = [...participant.audioTrackPublications.values()].find(
      (pub) => pub.source === Track.Source.Microphone
    );
    const micIsOn = micTrackPub ? !micTrackPub.isMuted : false;
    micBtn.textContent = micIsOn ? "🎙️" : "🔈🚫";
    micBtn.title = isLocal
      ? micIsOn
        ? "Mute your mic"
        : "Unmute your mic"
      : micIsOn
      ? "Mic is on"
      : "Mic is off";

    if (isLocal) {
      micBtn.addEventListener("click", () => muteBtn.click());
    } else {
      micBtn.disabled = true; // read-only indicator for remote participants
      micBtn.style.cursor = "default";
    }
    controls.appendChild(micBtn);

    row.appendChild(controls);
    participantList.appendChild(row);
  });
}

// Mutes/unmutes a remote participant's audio locally, by muting the
// actual <audio> element their track is attached to. This does NOT
// affect what other participants hear — only your own browser.
function toggleLocalMuteForParticipant(participant) {
  const identity = participant.identity;
  const isCurrentlyMuted = locallyMutedIdentities.has(identity);

  participant.audioTrackPublications.forEach((pub) => {
    if (pub.track) {
      pub.track.attachedElements.forEach((el) => {
        el.muted = !isCurrentlyMuted;
      });
    }
  });

  if (isCurrentlyMuted) {
    locallyMutedIdentities.delete(identity);
  } else {
    locallyMutedIdentities.add(identity);
  }
  refreshParticipantList();
}

// ============================================================
// Video / screen-share rendering
// ============================================================
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
    tile.dataset.identity = participant.identity;

    const nameLabel = document.createElement("div");
    nameLabel.className = "participant-name";
    nameLabel.textContent = participant.identity;
    tile.appendChild(nameLabel);

    videoGrid.appendChild(tile);
  }

  const el = track.attach();
  if (track.kind === Track.Kind.Video) {
    tile.insertBefore(el, tile.firstChild);
  } else {
    el.style.display = "none";
    // Respect an existing local mute-for-me choice if one was made
    // before this track arrived (e.g. reconnect scenario).
    if (locallyMutedIdentities.has(participant.identity)) {
      el.muted = true;
    }
    tile.appendChild(el);
  }
}

function renderScreenShare(track, participant) {
  const el = track.attach();
  screenShareLabel.textContent = `${participant.identity} is sharing their screen`;

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
// Controls: mute / camera / screen share / join-exit
// ============================================================
muteBtn.addEventListener("click", async () => {
  isMuted = !isMuted;
  await room.localParticipant.setMicrophoneEnabled(!isMuted);
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
  refreshParticipantList();
});

cameraBtn.addEventListener("click", async () => {
  isCameraOff = !isCameraOff;
  await room.localParticipant.setCameraEnabled(!isCameraOff);
  cameraBtn.textContent = isCameraOff ? "Camera On" : "Camera Off";
});

screenShareBtn.addEventListener("click", async () => {
  try {
    isScreenSharing = !isScreenSharing;

    if (isScreenSharing) {
      await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      screenShareBtn.textContent = "Stop Sharing";

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
    console.warn("Screen share cancelled or failed:", err);
    isScreenSharing = false;
    screenShareBtn.textContent = "Share Screen";
  }
});

// Header's Join/Exit button — since you're already in the room by
// the time this screen shows, this button's job is to leave.
joinExitBtn.addEventListener("click", () => {
  if (room) room.disconnect();
  location.reload();
});

// ============================================================
// Chat + typing indicator, both over LiveKit's data channel
// ============================================================
chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Broadcast a lightweight "typing" signal as the user types,
// throttled so we're not sending an event on every keystroke.
chatInput.addEventListener("input", () => {
  if (typingTimeout) return; // already sent one recently, skip
  sendData({ type: "typing" });
  typingTimeout = setTimeout(() => {
    typingTimeout = null;
  }, 2000);
});

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || !room) return;

  await sendData({ type: "chat", message });
  addChatMessage("You", message);
  chatInput.value = "";
}

async function sendData(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  // reliable: true = guaranteed delivery, appropriate for chat text
  // and typing signals (small, infrequent messages).
  await room.localParticipant.publishData(bytes, { reliable: true });
}

function addChatMessage(sender, message) {
  const p = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = sender + ": ";
  p.appendChild(strong);
  p.appendChild(document.createTextNode(message));
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}

let typingIndicatorTimeout = null;
function showTypingIndicator(identity) {
  typingIndicator.textContent = `${identity} is typing...`;
  clearTimeout(typingIndicatorTimeout);
  typingIndicatorTimeout = setTimeout(() => {
    typingIndicator.textContent = "";
  }, 2500);
}