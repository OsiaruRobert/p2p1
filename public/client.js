// ============================================================
// client.js  (ES Module)
// -----------------------------------------------------------
// Audio + text study room. No video/screen-share in this version.
// LiveKit still handles the actual audio connection (an SFU, so
// this scales the same way it did for the video version) — this
// file just wires it up to the label-by-label UI spec.
// ============================================================

import {
  Room,
  RoomEvent,
  Track,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

// -------------------- DOM references --------------------
const progressBar = document.getElementById("progress-bar");
const roomNameInput = document.getElementById("room-name-input");
const memberCountNum = document.getElementById("member-count-num");
const joinExitBtn = document.getElementById("join-exit-btn");

const ownControls = document.getElementById("own-controls");
const ownSpeakerBtn = document.getElementById("own-speaker-btn");
const ownMicBtn = document.getElementById("own-mic-btn");
const ownTextBtn = document.getElementById("own-text-btn");

const memberList = document.getElementById("member-list");
const emptyRoomInvite = document.getElementById("empty-room-invite");
const copyRoomNameBtn = document.getElementById("copy-room-name-btn");

const toastContainer = document.getElementById("toast-container");

const composeOverlay = document.getElementById("compose-overlay");
const composeInput = document.getElementById("compose-input");
const composeCancelBtn = document.getElementById("compose-cancel-btn");
const composeSendBtn = document.getElementById("compose-send-btn");

// -------------------- State --------------------
let room = null;
let isJoined = false;
let speakerOn = true; // (5) do I want to HEAR others
let micOn = true; // (6) is my mic live
let typingTimeout = null;

// Broadcast status from other members, so we can render their (9)
// speaker / (10) mic icons. identity -> { speakerOn, micOn }
const remoteStatus = new Map();

// A generated identity for this browser tab. In production, swap
// this for the student's real authenticated username.
const participantName = "student-" + Math.floor(Math.random() * 10000);

// ============================================================
// (2) Join / Exit button
// ============================================================
joinExitBtn.addEventListener("click", async () => {
  if (isJoined) {
    await leaveRoom();
  } else {
    await joinRoom();
  }
});

async function joinRoom() {
  const roomName = roomNameInput.value.trim();
  if (!roomName) {
    alert("Please enter a room name");
    return;
  }

  setProgress(true);

  try {
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
    await connectToLiveKit(url, token, roomName);

    isJoined = true;
    roomNameInput.disabled = true;
    joinExitBtn.textContent = "Exit";
    joinExitBtn.classList.remove("state-join");
    joinExitBtn.classList.add("state-exit");
    ownControls.classList.add("active");
    memberList.classList.add("active");

    refreshMemberList();
  } catch (err) {
    alert("Could not join room: " + err.message);
    console.error(err);
  } finally {
    setProgress(false);
  }
}

async function leaveRoom() {
  setProgress(true);
  try {
    if (room) {
      room.disconnect();
      room = null;
    }
  } finally {
    isJoined = false;
    roomNameInput.disabled = false;
    joinExitBtn.textContent = "Join";
    joinExitBtn.classList.remove("state-exit");
    joinExitBtn.classList.add("state-join");
    ownControls.classList.remove("active");
    memberList.classList.remove("active");
    memberList.innerHTML = "";
    memberCountNum.textContent = "0";
    remoteStatus.clear();
    emptyRoomInvite.classList.remove("active");
    setProgress(false);
  }
}

function setProgress(active) {
  progressBar.classList.toggle("active", active);
}

// ============================================================
// LiveKit connection
// ============================================================
async function connectToLiveKit(url, token, roomName) {
  room = new Room();

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    // Send our current status directly to the newcomer, since data
    // messages sent before they connected wouldn't have reached them.
    sendStatus([participant.identity]);
    refreshMemberList();
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    remoteStatus.delete(participant.identity);
    refreshMemberList();
  });

  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const speakingIds = new Set(speakers.map((s) => s.identity));
    document.querySelectorAll(".member-row").forEach((row) => {
      const identity = row.dataset.identity;
      row.querySelector(".member-name").classList.toggle(
        "speaking-name",
        speakingIds.has(identity)
      );
      const micIcon = row.querySelector(".mic-icon");
      if (micIcon) micIcon.classList.toggle("speaking", speakingIds.has(identity));
    });
  });

  room.on(RoomEvent.DataReceived, (payload, participant) => {
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }

    if (data.type === "status") {
      remoteStatus.set(participant.identity, {
        speakerOn: data.speakerOn,
        micOn: data.micOn,
      });
      refreshMemberList();
    } else if (data.type === "typing") {
      showTyping(participant.identity);
    } else if (data.type === "chat") {
      showToast(participant.identity, data.message);
    }
  });

  await room.connect(url, token);

  // Publish mic only — no camera in this version.
  await room.localParticipant.setMicrophoneEnabled(true);

  // Tell everyone already in the room our starting status.
  await sendStatus();
}

// ============================================================
// (5) Own speaker toggle — controls whether YOU hear others.
// Muting locally mutes every remote participant's audio element;
// it does not affect what anyone else hears.
// ============================================================
ownSpeakerBtn.addEventListener("click", () => {
  speakerOn = !speakerOn;
  ownSpeakerBtn.textContent = speakerOn ? "🔊 Speaker" : "🔇 Speaker";
  ownSpeakerBtn.classList.toggle("on", speakerOn);
  ownSpeakerBtn.classList.toggle("off", !speakerOn);

  room?.remoteParticipants.forEach((participant) => {
    participant.audioTrackPublications.forEach((pub) => {
      pub.track?.attachedElements.forEach((el) => {
        el.muted = !speakerOn;
      });
    });
  });

  sendStatus();
});

// ============================================================
// (6) Own mic toggle — real mute of your published microphone.
// ============================================================
ownMicBtn.addEventListener("click", async () => {
  micOn = !micOn;
  await room.localParticipant.setMicrophoneEnabled(micOn);
  ownMicBtn.textContent = micOn ? "🎙️ Mic" : "🔈🚫 Mic";
  ownMicBtn.classList.toggle("on", micOn);
  ownMicBtn.classList.toggle("off", !micOn);
  sendStatus();
});

// Broadcasts our current speaker/mic status. Pass specific
// identities to send only to them (used for newcomers); otherwise
// broadcasts to everyone in the room.
async function sendStatus(destinationIdentities) {
  if (!room) return;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ type: "status", speakerOn, micOn })
  );
  const opts = { reliable: true };
  if (destinationIdentities) opts.destinationIdentities = destinationIdentities;
  await room.localParticipant.publishData(bytes, opts);
}

// ============================================================
// (8) Member rows — everyone except yourself, per the sketch
// (your own status lives in the (5)(6)(7) control row instead)
// ============================================================
function refreshMemberList() {
  if (!room) return;

  const remoteParticipants = [...room.remoteParticipants.values()];
  const totalCount = remoteParticipants.length + 1; // + yourself
  memberCountNum.textContent = totalCount;

  memberList.innerHTML = "";

  if (remoteParticipants.length === 0) {
    emptyRoomInvite.classList.add("active");
    return;
  }
  emptyRoomInvite.classList.remove("active");

  remoteParticipants.forEach((participant) => {
    const status = remoteStatus.get(participant.identity) || {
      speakerOn: true,
      micOn: true,
    };

    const row = document.createElement("div");
    row.className = "member-row";
    row.dataset.identity = participant.identity;

    const info = document.createElement("div");
    info.className = "member-info";

    const nameEl = document.createElement("div");
    nameEl.className = "member-name";
    nameEl.textContent = participant.identity; // (12)
    info.appendChild(nameEl);

    const typingEl = document.createElement("div");
    typingEl.className = "typing-text";
    typingEl.dataset.role = "typing"; // (11)
    info.appendChild(typingEl);

    row.appendChild(info);

    const icons = document.createElement("div");
    icons.className = "member-icons";
    icons.appendChild(makeStatusIcon("speaker", status.speakerOn)); // (9)
    icons.appendChild(makeStatusIcon("mic", status.micOn)); // (10)
    row.appendChild(icons);

    memberList.appendChild(row);
  });
}

// Builds the green-on / red-slash-off SVG status icon described
// in labels (9) and (10).
function makeStatusIcon(kind, isOn) {
  const wrapper = document.createElement("span");
  wrapper.className = `status-icon ${isOn ? "on" : "off"}${kind === "mic" ? " mic-icon" : ""}`;

  const speakerPath = `<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>`;
  const speakerOffPath = `<path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
  const micPath = `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>`;
  const micOffPath = `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="1" x2="23" y2="23"/>`;

  let inner;
  if (kind === "speaker") inner = isOn ? speakerPath : speakerOffPath;
  else inner = isOn ? micPath : micOffPath;

  wrapper.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return wrapper;
}

// ============================================================
// (7) Text button -> opens (14) the write-message popup
// ============================================================
ownTextBtn.addEventListener("click", () => {
  composeOverlay.classList.add("active");
  composeInput.value = "";
  composeInput.focus();
});

composeCancelBtn.addEventListener("click", closeCompose);

function closeCompose() {
  composeOverlay.classList.remove("active");
}

composeSendBtn.addEventListener("click", sendMessage);
composeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// While typing in (14), broadcast a lightweight "typing" signal so
// this member's row shows the (11) typing indicator to others.
composeInput.addEventListener("input", () => {
  if (typingTimeout) return; // throttle so we're not spamming events
  sendData({ type: "typing" });
  typingTimeout = setTimeout(() => {
    typingTimeout = null;
  }, 2000);
});

async function sendMessage() {
  const message = composeInput.value.trim();
  if (!message || !room) return;

  await sendData({ type: "chat", message });
  showToast("You", message);
  closeCompose();
}

async function sendData(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  await room.localParticipant.publishData(bytes, { reliable: true });
}

// ============================================================
// (11) Typing indicator on a specific member's row
// ============================================================
const typingTimers = new Map();
function showTyping(identity) {
  const row = document.querySelector(`.member-row[data-identity="${identity}"]`);
  if (!row) return;
  const typingEl = row.querySelector('[data-role="typing"]');
  if (!typingEl) return;

  typingEl.textContent = "typing...";

  clearTimeout(typingTimers.get(identity));
  typingTimers.set(
    identity,
    setTimeout(() => {
      typingEl.textContent = "";
    }, 2500)
  );
}

// ============================================================
// (13) Message toast
// ============================================================
function showToast(sender, message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<strong>${escapeHtml(sender)}</strong>${escapeHtml(message)}`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Empty-room invite: copy room name to clipboard
// ============================================================
copyRoomNameBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomNameInput.value.trim());
    copyRoomNameBtn.textContent = "Copied!";
    setTimeout(() => {
      copyRoomNameBtn.textContent = "Copy Room Name";
    }, 1500);
  } catch {
    alert("Could not copy automatically — room name: " + roomNameInput.value.trim());
  }
});