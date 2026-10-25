import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  databaseUrl: required("DATABASE_URL"),
  openAiApiKey: required("OPENAI_API_KEY"),
  realtimeModel: required("OPENAI_REALTIME_MODEL"),
  realtimeVoice: required("OPENAI_REALTIME_VOICE"),
  transcriptionModel:
    process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ?? "gpt-4o-mini-transcribe",
  summaryModel:
    process.env.OPENAI_SUMMARY_MODEL?.trim() ?? "gpt-4o-mini",
  cookieSecure: process.env.NODE_ENV === "production",
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  telephonyCompanyId: required("TELEPHONY_COMPANY_ID"),
  telephonyAgentId: required("TELEPHONY_AGENT_ID"),
};

if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
