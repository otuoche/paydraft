// PayPal Invoicing v2 client (sandbox by default), plus an in-memory mock
// that implements the same surface for offline UI development.

const BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

export const MOCK = process.env.PAYPAL_MOCK === "true";

let tokenCache = { value: null, expiresAt: 0 };

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${data.error_description || res.status}`);
  tokenCache = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

export class PayPalError extends Error {
  constructor(status, body) {
    const detail = body?.details?.map((d) => `${d.field ?? ""} ${d.description ?? d.issue}`.trim()).join("; ");
    super(`PayPal ${status}: ${body?.message || body?.name || "request failed"}${detail ? ` (${detail})` : ""}`);
    this.status = status;
    this.body = body;
  }
}

async function pp(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new PayPalError(res.status, data);
  return data;
}

const money = (currency, value) => ({ currency_code: currency, value: Number(value).toFixed(2) });
const today = () => new Date().toISOString().slice(0, 10);

function splitName(full = "") {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { given_name: parts[0] || "Client" };
  return { given_name: parts.slice(0, -1).join(" "), surname: parts.at(-1) };
}

// Draft shape produced by the agent -> PayPal invoice payload.
export function toPayPalInvoice(d) {
  const payment_term = { term_type: d.payment_term };
  if (d.payment_term === "DUE_ON_DATE_SPECIFIED" && d.due_date) payment_term.due_date = d.due_date;
  const invoice = {
    detail: {
      currency_code: d.currency,
      invoice_date: today(),
      payment_term,
      ...(d.note ? { note: d.note } : {}),
      ...(d.memo ? { memo: d.memo } : {}),
    },
    primary_recipients: [{
      billing_info: {
        name: splitName(d.recipient_name),
        email_address: d.recipient_email,
        ...(d.business_name ? { business_name: d.business_name } : {}),
      },
    }],
    items: d.items.map((it) => ({
      name: it.name.slice(0, 200),
      ...(it.description ? { description: it.description.slice(0, 1000) } : {}),
      quantity: String(it.quantity),
      unit_amount: money(d.currency, it.unit_amount),
      unit_of_measure: it.unit || "QUANTITY",
      ...(d.tax_percent ? { tax: { name: "Tax", percent: String(d.tax_percent) } } : {}),
    })),
    configuration: { allow_tip: false, tax_inclusive: false },
  };
  if (d.discount_percent) {
    invoice.amount = { breakdown: { discount: { invoice_discount: { percent: String(d.discount_percent) } } } };
  }
  if (process.env.INVOICER_BUSINESS_NAME) {
    invoice.invoicer = { business_name: process.env.INVOICER_BUSINESS_NAME };
  }
  return invoice;
}

// Normalise a PayPal invoice into the flat row the UI and agent use.
export function summarize(inv) {
  const d = inv.detail || {};
  const r = inv.primary_recipients?.[0]?.billing_info || {};
  const due = d.payment_term?.due_date || null;
  const open = ["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(inv.status);
  const daysOverdue = open && due ? Math.max(0, Math.floor((Date.now() - Date.parse(due + "T23:59:59Z")) / 86_400_000)) : 0;
  return {
    id: inv.id,
    number: d.invoice_number,
    status: inv.status,
    client: r.business_name || [r.name?.given_name, r.name?.surname].filter(Boolean).join(" ") || r.email_address || "—",
    email: r.email_address || null,
    currency: inv.amount?.currency_code || d.currency_code,
    total: Number(inv.amount?.value ?? 0),
    due_amount: Number(inv.due_amount?.value ?? inv.amount?.value ?? 0),
    issued: d.invoice_date || null,
    due_date: due,
    days_overdue: daysOverdue,
    payer_url: d.metadata?.recipient_view_url
      || (inv.id && !MOCK && inv.status !== "DRAFT"
        ? `https://www.${process.env.PAYPAL_ENV === "live" ? "" : "sandbox."}paypal.com/invoice/p/#${inv.id.replace(/^INV2-/, "").replace(/-/g, "")}`
        : null),
    items: inv.items?.map((i) => ({ name: i.name, quantity: i.quantity, unit_amount: i.unit_amount?.value })) ?? undefined,
  };
}

// ---------- Real API ----------
const real = {
  async createAndSend(draft) {
    const created = await pp("POST", "/v2/invoicing/invoices", toPayPalInvoice(draft));
    const id = created.id ?? created.href?.split("/").pop();
    await pp("POST", `/v2/invoicing/invoices/${id}/send`, {
      send_to_invoicer: true,
      send_to_recipient: true,
      ...(draft.email_subject ? { subject: draft.email_subject } : {}),
    });
    return summarize(await pp("GET", `/v2/invoicing/invoices/${id}`));
  },
  async list() {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const data = await pp("GET", `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`);
      out.push(...(data.items || []));
      if (!data.total_pages || page >= data.total_pages) break;
    }
    return out.map(summarize);
  },
  async get(id) {
    return summarize(await pp("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`));
  },
  async remind(id, { subject, note }) {
    await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      subject, note, send_to_invoicer: false, send_to_recipient: true,
    });
    return this.get(id);
  },
  async cancel(id, { note }) {
    await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      subject: "Invoice cancelled", note, send_to_invoicer: true, send_to_recipient: true,
    });
    return this.get(id);
  },
  async recordPayment(id, { amount, currency, method, note }) {
    await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
      method, payment_date: today(), amount: money(currency, amount), ...(note ? { note } : {}),
    });
    return this.get(id);
  },
  async verifyWebhook(headers, event) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return false;
    const res = await pp("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: event,
    });
    return res?.verification_status === "SUCCESS";
  },
};

// ---------- Mock (PAYPAL_MOCK=true) ----------
const mockDb = new Map();
let mockSeq = 1000;
function mockInvoice(draft, { status = "SENT", issued = today(), dueInDays } = {}) {
  const id = `INV2-MOCK-${(mockSeq++).toString(36).toUpperCase()}`;
  const sub = draft.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_amount), 0);
  const total = sub * (1 - (draft.discount_percent || 0) / 100) * (1 + (draft.tax_percent || 0) / 100);
  const termDays = { NET_10: 10, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60, NET_90: 90, DUE_ON_RECEIPT: 0 }[draft.payment_term];
  const days = dueInDays ?? termDays;
  const due = draft.due_date || (days != null ? new Date(Date.parse(issued) + days * 86_400_000).toISOString().slice(0, 10) : null);
  const inv = toPayPalInvoice(draft);
  inv.id = id;
  inv.status = status;
  inv.detail.invoice_number = String(mockSeq);
  inv.detail.invoice_date = issued;
  inv.detail.payment_term.due_date = due;
  inv.detail.metadata = { recipient_view_url: `/mock-pay/${id}` };
  inv.amount = money(draft.currency, total);
  inv.due_amount = money(draft.currency, status === "PAID" ? 0 : total);
  mockDb.set(id, inv);
  return inv;
}
function seedMock() {
  const ago = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  mockInvoice({ recipient_name: "Dana Whitfield", recipient_email: "dana@northwind.example", business_name: "Northwind Studio", currency: "USD", payment_term: "NET_15",
    items: [{ name: "Brand identity sprint", quantity: 1, unit_amount: 2400, unit: "AMOUNT" }] }, { issued: ago(40) });
  mockInvoice({ recipient_name: "Luis Ortega", recipient_email: "luis@ortega.example", currency: "EUR", payment_term: "NET_30",
    items: [{ name: "Backend consulting", quantity: 12, unit_amount: 85, unit: "HOURS" }] }, { issued: ago(9) });
  mockInvoice({ recipient_name: "Priya Raman", recipient_email: "priya@lumen.example", business_name: "Lumen Labs", currency: "USD", payment_term: "NET_10",
    items: [{ name: "Landing page build", quantity: 1, unit_amount: 1800, unit: "AMOUNT" }] }, { issued: ago(25), status: "PAID" });
}
if (MOCK) seedMock();

const mock = {
  async createAndSend(draft) { return summarize(mockInvoice(draft)); },
  async list() { return [...mockDb.values()].map(summarize).reverse(); },
  async get(id) {
    const inv = mockDb.get(id);
    if (!inv) throw new PayPalError(404, { message: `Invoice ${id} not found` });
    return summarize(inv);
  },
  async remind(id) { return this.get(id); },
  async cancel(id) { const inv = mockDb.get(id); if (inv) inv.status = "CANCELLED"; return this.get(id); },
  async recordPayment(id, { amount }) {
    const inv = mockDb.get(id);
    if (!inv) throw new PayPalError(404, { message: `Invoice ${id} not found` });
    const left = Number(inv.due_amount.value) - Number(amount);
    inv.due_amount.value = Math.max(0, left).toFixed(2);
    inv.status = left <= 0.0001 ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
    return this.get(id);
  },
  async markPaidByPayer(id) {
    const inv = mockDb.get(id);
    if (inv) { inv.status = "PAID"; inv.due_amount.value = "0.00"; }
    return inv ? summarize(inv) : null;
  },
  async verifyWebhook() { return true; },
};

export const paypal = MOCK ? mock : real;
