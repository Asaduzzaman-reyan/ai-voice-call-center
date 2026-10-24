import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgent, getAllAgents } from "./agents/agent.service.js";
import { env } from "./config/env.js";

const app = express();
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

app.use(express.json());
app.use(express.static(path.join(currentDirectory, "..", "public")));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/agents", (_request, response) => {
  response.json({ agents: getAllAgents() });
});

app.post("/api/realtime/client-secret", async (request, response, next) => {
  try {
    const agent = getAgent(request.body?.agentId ?? "customer-support");
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

    response.json({ clientSecret: payload.value, agent: getAllAgents().find(({ id }) => id === agent.id) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.statusCode ?? 500).json({
    error: "Unable to create a realtime session",
  });
});

app.listen(env.port, () => {
  console.log(`Voice prototype listening at http://localhost:${env.port}`);
});
