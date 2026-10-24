const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const agentSelect = document.querySelector("#agent");
const statusElement = document.querySelector("#status");
const transcriptElement = document.querySelector("#transcript");

let peerConnection;
let microphoneStream;
let dataChannel;
let audioElement;

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
  const { clientSecret } = await tokenResponse.json();

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
      appendTranscript(message.delta);
    }
    if (message.type === "response.done") {
      appendTranscript("\n");
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

function stopSession() {
  dataChannel?.close();
  peerConnection?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  audioElement?.remove();
  dataChannel = undefined;
  peerConnection = undefined;
  microphoneStream = undefined;
  audioElement = undefined;
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("Session stopped.");
}

startButton.addEventListener("click", () => {
  startSession().catch((error) => {
    console.error(error);
    stopSession();
    setStatus(error.message);
  });
});
stopButton.addEventListener("click", stopSession);

fetch("/api/agents")
  .then((response) => {
    if (!response.ok) {
      throw new Error("Unable to load agents.");
    }
    return response.json();
  })
  .then(({ agents }) => {
    agentSelect.replaceChildren(
      ...agents.map((agent) => new Option(agent.name, agent.id)),
    );
    agentSelect.disabled = false;
  })
  .catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
