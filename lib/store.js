// In-memory state: chat sessions, pending actions, activity feed, SSE clients.
// PayPal is the source of truth for invoices; this only holds agent-side state.
import { randomUUID } from "node:crypto";

const sessions = new Map();
const actions = new Map();
const activity = [];
const sseClients = new Set();

export function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [], notes: [] });
  return sessions.get(id);
}

export function addAction(sessionId, type, payload, context = {}) {
  const id = "act_" + randomUUID().slice(0, 8);
  const action = { id, sessionId, type, payload, context, status: "pending", createdAt: Date.now() };
  actions.set(id, action);
  broadcast({ type: "actions-changed" });
  return action;
}

export const getAction = (id) => actions.get(id);
export const listActions = (sessionId) =>
  [...actions.values()].filter((a) => a.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);

export function log(kind, text, extra = {}) {
  const entry = { id: randomUUID().slice(0, 8), kind, text, at: Date.now(), ...extra };
  activity.unshift(entry);
  activity.length = Math.min(activity.length, 100);
  broadcast({ type: "activity", entry });
  return entry;
}
export const recentActivity = () => activity.slice(0, 30);

export function addSseClient(res) {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}
export function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(line);
}
