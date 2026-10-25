import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { deleteSession, getUserBySession, loginUser, registerUser } from "./auth/auth.service.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import {
  appendMessage,
  createConversation,
  endCall,
  getConversation,
  getAgent,
  listAgents,
} from "./conversations/conversation.store.js";
import { initializeDatabase, pool } from "./db/database.js";
import {
  bridgeTwilioMedia,
  createTelephonyCall,
  isValidTwilioRequest,
  twimlForCall,
} from "./telephony/twilio.js";

const app = express();
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(currentDirectory, "..", "public")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/twilio/voice", async (request, response, next) => {
  try {
    if (!isValidTwilioRequest(request)) {
      return response.status(403).type("text/plain").send("Invalid Twilio signature");
    }
    const call = await createTelephonyCall(request.body.CallSid);
    response.type("text/xml").send(twimlForCall({
      callId: call.callId,
      conversationId: call.id,
      agentId: call.agent.id,
    }));
  } catch (error) {
    next(error);
  }
});

function sessionId(request) {
  const match = request.get("cookie")?.match(/(?:^|;\s*)session=([^;]+)/);
  return match?.[1];
}

async function requireAuth(request, response, next) {
  try {
    const user = await getUserBySession(sessionId(request));
    if (!user) return response.status(401).json({ error: "Authentication required" });
    request.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function setSessionCookie(response, session) {
  response.setHeader(
    "Set-Cookie",
    `session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${env.cookieSecure ? "; Secure" : ""}`,
  );
}

app.post("/api/auth/register", async (request, response, next) => {
  try {
    const { companyName, email, password } = request.body ?? {};
    if (
      typeof companyName !== "string" || companyName.trim().length < 2 ||
      typeof email !== "string" || !email.includes("@") ||
      typeof password !== "string" || password.length < 12
    ) {
      return response.status(400).json({
        error: "Company name, valid email, and a password of at least 12 characters are required",
      });
    }
    const session = await registerUser({ companyName, email, password });
    setSessionCookie(response, session.sessionId);
    return response.status(201).json({ user: session.user });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const { email, password } = request.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return response.status(400).json({ error: "Email and password are required" });
    }
    const session = await loginUser({ email, password });
    setSessionCookie(response, session.sessionId);
    return response.json({ user: session.user });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/logout", async (request, response, next) => {
  try {
    await deleteSession(sessionId(request));
    response.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", requireAuth, (request, response) => {
  response.json({ user: request.user });
});

app.get("/api/agents", requireAuth, async (request, response, next) => {
  try {
    response.json({ agents: await listAgents(request.user.companyId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/conversations/:conversationId", requireAuth, async (request, response, next) => {
  try {
    const conversation = await getConversation(
      request.user.companyId,
      request.params.conversationId,
    );
    if (!conversation) {
      return response.status(404).json({ error: "Conversation not found" });
    }
    return response.json({ conversation });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/calls/:callId/summary", requireAuth, async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT cs.summary, cs.customer_intent AS "customerIntent",
              cs.resolution_status AS "resolutionStatus",
              cs.follow_up_required AS "followUpRequired",
              cs.follow_up_notes AS "followUpNotes",
              cs.created_at AS "createdAt", cs.updated_at AS "updatedAt"
       FROM call_summaries cs
       WHERE cs.call_id = $1 AND cs.company_id = $2`,
      [request.params.callId, request.user.companyId],
    );
    if (!result.rows[0]) return response.status(404).json({ error: "Summary not found" });
    return response.json({ summary: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/realtime/client-secret", requireAuth, async (request, response, next) => {
  try {
    const agent = await getAgent(
      request.user.companyId,
      request.body?.agentId ?? "customer-support",
    );
    if (!agent) {
      return response.status(400).json({ error: "Unknown agent" });
    }
    const conversation = await createConversation({
      companyId: request.user.companyId,
      agentId: agent.id,
    });
    const openAiResponse = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: env.realtimeModel,
            audio: {
              input: {
                transcription: {
                  model: env.transcriptionModel,
                },
              },
              output: {
                voice: env.realtimeVoice,
              },
            },
            instructions: agent.instructions,
          },
        }),
      },
    );

    const payload = await openAiResponse.json();
    if (!openAiResponse.ok) {
      const message = payload?.error?.message ?? "Realtime session creation failed";
      const error = new Error(message);
      error.statusCode = openAiResponse.status;
      throw error;
    }

    response.json({
      clientSecret: payload.value,
      conversationId: conversation.id,
      callId: conversation.callId,
      agent: { id: agent.agentId, name: agent.name },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/calls/:callId/end", requireAuth, async (request, response, next) => {
  try {
    const call = await endCall(
      request.user.companyId,
      request.params.callId,
      request.body?.reason ?? "client_stopped",
    );
    if (!call) return response.status(404).json({ error: "Active call not found" });
    return response.json({ call });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/conversations/:conversationId/messages",
  requireAuth,
  async (request, response, next) => {
    try {
      const { speaker, transcript, providerItemId } = request.body ?? {};
      if (
        !["user", "assistant"].includes(speaker) ||
        typeof transcript !== "string" ||
        !transcript.trim()
      ) {
        return response.status(400).json({ error: "Invalid transcript message" });
      }

      const conversation = await appendMessage(
        request.user.companyId,
        request.params.conversationId,
        {
          speaker,
          transcript: transcript.trim(),
          providerItemId:
            typeof providerItemId === "string" ? providerItemId : undefined,
        },
      );
      return response.status(201).json({ conversation });
    } catch (error) {
      return next(error);
    }
  },
);

app.use((error, _request, response, _next) => {
  console.error(error);
  const clientError = error.statusCode >= 400 && error.statusCode < 500;
  response.status(error.statusCode ?? 500).json({
    error: clientError ? error.message : "Internal server error",
  });
});

try {
  await initializeDatabase();
  const server = http.createServer(app);
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/twilio/media") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (webSocket) => {
    let metadata;
    webSocket.on("message", async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.event === "start") {
        metadata = {
          ...event.start.customParameters,
          streamSid: event.start.streamSid,
          companyId: env.telephonyCompanyId,
        };
        const agent = await getAgent(metadata.companyId, metadata.agentId);
        if (!agent) return webSocket.close(1008, "Unknown agent");
        metadata.instructions = agent.instructions;
        await bridgeTwilioMedia(webSocket, metadata);
      }
    });
  });
  server.listen(env.port, () => {
    console.log(`Voice prototype listening at http://localhost:${env.port}`);
  });
} catch (error) {
  console.error("Unable to initialize the database.", error);
  await pool.end();
  process.exitCode = 1;
}
