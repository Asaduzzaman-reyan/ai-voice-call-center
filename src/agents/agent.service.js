import { agents } from "./agent.config.js";

export function getAllAgents() {
  return Object.values(agents).map(({ id, name }) => ({ id, name }));
}

export function getAgent(agentId) {
  const agent = agents[agentId];
  if (!agent) {
    const error = new Error(`Unknown agent: ${agentId}`);
    error.statusCode = 400;
    throw error;
  }
  return agent;
}
