import crypto from "node:crypto";
import { WebSocket } from "ws";
import { env } from "../config/env.js";
import { appendMessage, createConversation, endCall, getAgent } from "../conversations/conversation.store.js";

export function isValidTwilioRequest(request) {
  const signature = request.get("x-twilio-signature");
  if (!signature) return false;

  const url = `${env.publicBaseUrl}${request.originalUrl}`;
  const data = Object.keys(request.body ?? {})
    .sort()
    .reduce((value, key) => `${value}${key}${request.body[key]}`, url);
  const expected = crypto
    .createHmac("sha1", env.twilioAuthToken)
    .update(data)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

export async function createTelephonyCall(providerCallId) {
  const agent = await getAgent(env.telephonyCompanyId, env.telephonyAgentId);
  if (!agent) throw new Error("Configured telephone agent does not exist");
  const conversation = await createConversation({
    companyId: env.telephonyCompanyId,
    agentId: agent.id,
    providerCallId,
  });
  return { ...conversation, agent };
}

export function twimlForCall({ callId, conversationId, agentId }) {
  const streamUrl = `${env.publicBaseUrl.replace(/^http/, "ws")}/twilio/media`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">
      <Parameter name="callId" value="${escapeXml(callId)}"/>
      <Parameter name="conversationId" value="${escapeXml(conversationId)}"/>
      <Parameter name="agentId" value="${escapeXml(agentId)}"/>
    </Stream>
  </Connect>
</Response>`;
}

export async function bridgeTwilioMedia(twilioSocket, metadata) {
  const openAiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(env.realtimeModel)}`,
    {
      headers: {
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
    },
  );

  openAiSocket.on("open", () => {
    openAiSocket.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: metadata.instructions,
        audio: {
          input: { format: { type: "audio/pcmu" } },
          output: { format: { type: "audio/pcmu" }, voice: env.realtimeVoice },
        },
      },
    }));
  });

  twilioSocket.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.event === "media" && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: event.media.payload,
      }));
    }
    if (event.event === "stop") {
      openAiSocket.close();
    }
  });

  openAiSocket.on("message", async (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "response.output_audio.delta" && twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.send(JSON.stringify({
        event: "media",
        streamSid: metadata.streamSid,
        media: { payload: event.delta },
      }));
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await appendMessage(metadata.companyId, metadata.conversationId, {
        speaker: "user",
        transcript: event.transcript,
        providerItemId: event.item_id,
      });
    }
    if (event.type === "response.output_audio_transcript.done") {
      await appendMessage(metadata.companyId, metadata.conversationId, {
        speaker: "assistant",
        transcript: event.transcript,
        providerItemId: event.response_id,
      });
    }
  });

  const close = async (reason) => {
    if (openAiSocket.readyState === WebSocket.OPEN) openAiSocket.close();
    await endCall(metadata.companyId, metadata.callId, reason);
  };
  twilioSocket.on("close", () => close("provider_disconnected").catch(console.error));
  twilioSocket.on("error", () => close("provider_error").catch(console.error));
  openAiSocket.on("error", () => close("realtime_error").catch(console.error));
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character]);
}
