const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const agentSelect = document.querySelector("#agent");
const statusElement = document.querySelector("#status");
const transcriptElement = document.querySelector("#transcript");
const authForm = document.querySelector("#auth");
const companyNameInput = document.querySelector("#company-name");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const loginButton = document.querySelector("#login");
const logoutButton = document.querySelector("#logout");
const dashboard = document.querySelector("#dashboard");
const callsElement = document.querySelector("#calls");
const refreshCallsButton = document.querySelector("#refresh-calls");
const agentSettingsElement = document.querySelector("#agent-settings");

let peerConnection;
let microphoneStream;
let dataChannel;
let audioElement;
let conversationId;
let callId;
let assistantTranscript = "";

function setStatus(message) {
  statusElement.textContent = message;
}

function appendTranscript(text) {
  transcriptElement.textContent += text;
}

async function startSession() {
  startButton.disabled = true;
  setStatus("Creating a secure realtime session...");

  const tokenResponse = await fetch("/api/realtime/client-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agentSelect.value }),
  });
  if (!tokenResponse.ok) {
    throw new Error("The server could not create a realtime session.");
  }
  const session = await tokenResponse.json();
  conversationId = session.conversationId;
  callId = session.callId;

  peerConnection = new RTCPeerConnection();
  audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  document.body.append(audioElement);
  peerConnection.ontrack = (event) => {
    audioElement.srcObject = event.streams[0];
  };

  microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of microphoneStream.getTracks()) {
    peerConnection.addTrack(track, microphoneStream);
  }

  dataChannel = peerConnection.createDataChannel("oai-events");
  dataChannel.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "response.output_audio_transcript.delta") {
      assistantTranscript += message.delta;
      appendTranscript(message.delta);
    }
    if (message.type === "response.done") {
      appendTranscript("\n");
      saveMessage("assistant", assistantTranscript, message.response?.id);
      assistantTranscript = "";
    }
    if (message.type === "conversation.item.input_audio_transcription.completed") {
      appendTranscript(`You: ${message.transcript}\n`);
      saveMessage("user", message.transcript, message.item_id);
    }
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  const realtimeResponse = await fetch(
    "https://api.openai.com/v1/realtime/calls",
    {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
    },
  );
  if (!realtimeResponse.ok) {
    throw new Error("The realtime connection was rejected.");
  }
  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: await realtimeResponse.text(),
  });

  stopButton.disabled = false;
  setStatus("Connected. You can speak now.");
}

async function saveMessage(speaker, transcript, providerItemId) {
  if (!conversationId || !transcript.trim()) {
    return;
  }
  const response = await fetch(
    `/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker, transcript, providerItemId }),
    },
  );
  if (!response.ok) {
    console.error("Unable to save transcript message.");
  }
}

async function stopSession(reason = "client_stopped") {
  try {
    if (callId) {
      const response = await fetch(`/api/calls/${callId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        throw new Error("Unable to finalize the call.");
      }
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message);
  } finally {
    dataChannel?.close();
    peerConnection?.close();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    audioElement?.remove();
    dataChannel = undefined;
    peerConnection = undefined;
    microphoneStream = undefined;
    audioElement = undefined;
    conversationId = undefined;
    callId = undefined;
    assistantTranscript = "";
    startButton.disabled = false;
    stopButton.disabled = true;
    if (!statusElement.textContent.startsWith("Unable")) {
      setStatus("Session stopped.");
    }
  }
}

startButton.addEventListener("click", () => {
  startSession().catch((error) => {
    console.error(error);
    stopSession();
    setStatus(error.message);
  });
});
stopButton.addEventListener("click", stopSession);

async function authenticate(path) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      companyName: companyNameInput.value,
      email: emailInput.value,
      password: passwordInput.value,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Authentication failed");
}

async function loadAgents() {
  const response = await fetch("/api/agents");
  if (response.status === 401) {
    setStatus("Log in or register to start a session.");
    return;
  }
  if (!response.ok) throw new Error("Unable to load agents.");
  const { agents } = await response.json();
  agentSelect.replaceChildren(
    ...agents.map((agent) => new Option(agent.name, agent.id)),
  );
  agentSelect.disabled = false;
  dashboard.hidden = false;
  renderAgentSettings(agents);
  await loadCalls();
}

async function loadCalls() {
  const response = await fetch("/api/calls");
  if (!response.ok) throw new Error("Unable to load calls.");
  const { calls } = await response.json();
  callsElement.replaceChildren(...calls.map((call) => {
    const row = document.createElement("tr");
    const summary = call.summary ?? "Pending";
    row.innerHTML = `<td>${new Date(call.startedAt).toLocaleString()}</td>
      <td>${escapeHtml(call.agentName)}</td>
      <td>${escapeHtml(call.status)}</td>
      <td>${escapeHtml(summary)}</td>
      <td><button type="button" data-conversation="${call.conversationId}">View transcript</button></td>`;
    row.querySelector("button").addEventListener("click", () => viewConversation(call.conversationId));
    return row;
  }));
}

async function viewConversation(conversationId) {
  const response = await fetch(`/api/conversations/${conversationId}`);
  if (!response.ok) return setStatus("Unable to load conversation.");
  const { conversation } = await response.json();
  transcriptElement.textContent = conversation.messages
    .map((message) => `${message.speaker}: ${message.transcript}`)
    .join("\n");
  setStatus(conversation.summary ?? "Transcript loaded.");
}

function renderAgentSettings(agents) {
  agentSettingsElement.replaceChildren(...agents.map((agent) => {
    const form = document.createElement("form");
    form.innerHTML = `<h3>${escapeHtml(agent.name)}</h3>
      <input name="name" value="${escapeHtml(agent.name)}" required>
      <textarea name="instructions" required>${escapeHtml(agent.instructions ?? "")}</textarea>
      <label><input name="enabled" type="checkbox" ${agent.enabled !== false ? "checked" : ""}> Enabled</label>
      <button>Save</button>`;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = {
        name: form.elements.name.value,
        instructions: form.elements.instructions.value,
        enabled: form.elements.enabled.checked,
      };
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setStatus(response.ok ? "Agent saved." : "Unable to save agent.");
      if (response.ok) await loadAgents();
    });
    return form;
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await authenticate("/api/auth/register");
    setStatus("Registered. You can start a voice session.");
    await loadAgents();
  } catch (error) {
    setStatus(error.message);
  }
});

loginButton.addEventListener("click", async () => {
  try {
    await authenticate("/api/auth/login");
    setStatus("Logged in. You can start a voice session.");
    await loadAgents();
  } catch (error) {
    setStatus(error.message);
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  agentSelect.replaceChildren(new Option("Log in to load agents.", ""));
  agentSelect.disabled = true;
  dashboard.hidden = true;
  setStatus("Logged out.");
});

refreshCallsButton.addEventListener("click", () => {
  loadCalls().catch((error) => setStatus(error.message));
});

loadAgents().catch((error) => {
  console.error(error);
  setStatus(error.message);
});
