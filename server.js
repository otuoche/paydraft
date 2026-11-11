import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { paypal, MOCK, PayPalError } from "./lib/paypal.js";
import { runAgent, runTool, executeAction, rejectAction, agentInfo } from "./lib/agent.js";
import { listActions, addSseClient, broadcast, log, recentActivity } from "./lib/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "public")));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    let status = 500;
    let message = err.message || String(err);
    if (err instanceof PayPalError) status = err.status >= 500 ? 502 : 400;
    else if (err instanceof Cerebras.AuthenticationError) { status = 502; message = "Cerebras API key is missing or invalid."; }
    else if (err instanceof Cerebras.RateLimitError) { status = 429; message = "Cerebras rate limit hit (free tier is 5 requests/min). Wait a few seconds and retry."; }
    else if (err instanceof Cerebras.APIError) { status = 502; message = `Cerebras: ${err.message}`; }
    res.status(status).json({ error: message });
  });

app.get("/api/config", (req, res) => {
  res.json({ mock: MOCK, paypalEnv: MOCK ? "mock" : process.env.PAYPAL_ENV === "live" ? "live" : "sandbox", ...agentInfo });
});

app.get("/api/invoices", wrap(async (req, res) => {
  res.json(await paypal.list());
}));

app.post("/api/agent", wrap(async (req, res) => {
  const { sessionId, message, images } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const result = await runAgent(String(sessionId), String(message || ""), Array.isArray(images) ? images.slice(0, 2) : []);
  res.json({ ...result, actions: listActions(String(sessionId)).filter((a) => result.actions.includes(a.id)) });
}));

app.get("/api/actions", (req, res) => res.json(listActions(String(req.query.sessionId || ""))));

app.post("/api/actions/:id/approve", wrap(async (req, res) => {
  res.json(await executeAction(req.params.id, req.body?.overrides));
}));

app.post("/api/actions/:id/reject", wrap(async (req, res) => {
  res.json(rejectAction(req.params.id));
}));

app.get("/api/activity", (req, res) => res.json(recentActivity()));

// Live updates to the browser (invoice paid, action approved, ...)
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(": connected\n\n");
  addSseClient(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => clearInterval(ping));
});

// PayPal webhooks: INVOICING.INVOICE.PAID / CANCELLED / REFUNDED ...
app.post("/api/webhooks/paypal", wrap(async (req, res) => {
  const event = req.body;
  const ok = await paypal.verifyWebhook(req.headers, event).catch(() => false);
  console.log(`[webhook] ${event?.event_type} ${event?.id} verified=${ok}`);
  if (!ok) return res.status(400).json({ error: "signature verification failed" });
  const inv = event.resource?.invoice || event.resource;
  const num = inv?.detail?.invoice_number;
  const who = inv?.primary_recipients?.[0]?.billing_info?.business_name
    || inv?.primary_recipients?.[0]?.billing_info?.email_address || "client";
  const amount = inv?.amount;
  if (event.event_type === "INVOICING.INVOICE.PAID") {
    log("paid", `Invoice #${num} paid by ${who}`, { amount: Number(amount?.value || 0), currency: amount?.currency_code });
  } else if (event.event_type?.startsWith("INVOICING.")) {
    log("event", `${event.event_type.replace("INVOICING.INVOICE.", "Invoice ").toLowerCase()} · #${num}`);
  }
  broadcast({ type: "invoices-changed" });
  res.sendStatus(200);
}));

// Mock-mode stand-in for the PayPal payer page (only when PAYPAL_MOCK=true).
if (MOCK) {
  // Dev hook: run an agent tool directly (no LLM call) to exercise the UI.
  app.post("/api/dev/tool", wrap(async (req, res) => {
    const { sessionId, name, input } = req.body;
    res.json({ out: await runTool(sessionId, name, input), actions: listActions(sessionId) });
  }));
  app.get("/mock-pay/:id", wrap(async (req, res) => {
    const inv = await paypal.get(req.params.id);
    res.send(`<!doctype html><meta name=viewport content="width=device-width"><title>Pay invoice</title>
      <body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">
      <p style="color:#888">MOCK PAYER PAGE (not PayPal)</p><h2>Invoice #${inv.number}</h2>
      <p>${inv.client} · ${inv.currency} ${inv.due_amount.toFixed(2)} due</p>
      <form method=post><button style="padding:12px 20px;font-size:16px">Pay now</button></form>`);
  }));
  app.post("/mock-pay/:id", wrap(async (req, res) => {
    const inv = await paypal.markPaidByPayer(req.params.id);
    if (inv) log("paid", `Invoice #${inv.number} paid by ${inv.client}`, { amount: inv.total, currency: inv.currency });
    broadcast({ type: "invoices-changed" });
    res.send(`<body style="font-family:system-ui;max-width:420px;margin:60px auto"><h2>Paid ✓</h2>You can close this tab.`);
  }));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`PayDraft on http://localhost:${port}  (PayPal: ${MOCK ? "MOCK" : process.env.PAYPAL_ENV || "sandbox"}, model: ${agentInfo.model})`);
});
