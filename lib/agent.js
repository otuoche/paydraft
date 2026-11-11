// The PayDraft agent: an LLM on Cerebras Inference + tools over PayPal Invoicing.
// Read tools run immediately. Write tools only *propose* an action; a human
// approves it in the UI, and only then does it hit PayPal (see executeAction).
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { paypal } from "./paypal.js";
import { getSession, addAction, getAction, log, broadcast } from "./store.js";

let client;
const llm = () => {
  if (!process.env.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY is not set. Add it to .env and restart.");
  return (client ??= new Cerebras({ warmTCPConnection: false }));
};
// qwen-3.8-27b: tool calling + image input. gpt-oss-120b: cheaper, text only.
const MODEL = process.env.CEREBRAS_MODEL || "qwen-3.8-27b";
const EFFORT = process.env.CEREBRAS_REASONING_EFFORT || "low";
const VISION = !/^gpt-oss/.test(MODEL);

const TERMS = ["DUE_ON_RECEIPT", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90", "DUE_ON_DATE_SPECIFIED"];
const METHODS = ["BANK_TRANSFER", "CASH", "CHECK", "CREDIT_CARD", "DEBIT_CARD", "PAYPAL", "WIRE_TRANSFER", "OTHER"];

const SYSTEM = `You are PayDraft, an accounts-receivable assistant for freelancers and small businesses. You work through the user's PayPal account (Invoicing API).

Turning messages into invoices:
- When the user pastes or dictates a client email, chat message, screenshot, timesheet or voice note that describes billable work, extract a complete invoice and call propose_invoice.
- Infer line items, quantities and rates. Use unit HOURS for hourly work, AMOUNT for fixed-fee items, QUANTITY for countable goods.
- Currency: take it from symbols or wording (€ = EUR, £ = GBP, C$ = CAD, ₦ = NGN...). Use USD only when nothing indicates otherwise.
- Payment terms: use what the message says (e.g. "net 30" = NET_30, "due on receipt" = DUE_ON_RECEIPT, a specific date = DUE_ON_DATE_SPECIFIED with due_date). Default to NET_15.
- Write a short, warm note to the client (1-2 sentences) that names the work.
- Never invent a recipient email. If the message doesn't contain it, call list_invoices with the client's name to reuse an address from a past invoice. If it is still unknown, ask the user instead of proposing.
- Check arithmetic. If the message states a total that doesn't match the items, say so and explain the difference.

Chasing payment:
- Use list_invoices to answer questions about who owes what. Report amounts per currency; never add different currencies together.
- Reminder tone follows how overdue the invoice is: friendly when 0-7 days, firm when 8-30, a polite final notice beyond 30. Mention the invoice number, amount and due date. Keep notes under 600 characters. PayPal adds the payment link itself.
- When asked to chase several invoices, propose one reminder per invoice.

Approval rules:
- propose_* tools never execute anything. They queue an action the user approves or discards in the app. After proposing, say in one line what you queued. Never claim something was sent, cancelled or recorded until a system update confirms it.
- Messages that start with "[System update: ...]" are facts from the app about actions the user approved; trust them.

Style: brief, plain text, no markdown headings or tables. A few short bullets at most.

Signing: sign client-facing notes and reminders as ${process.env.INVOICER_BUSINESS_NAME || "the sender"}${process.env.INVOICER_BUSINESS_NAME ? "" : " (or just end without a signature)"}. Never leave placeholders like [Your name].`;

const toolDefs = [
  {
    name: "list_invoices",
    description: "List the user's PayPal invoices as compact rows (id, number, status, client, email, currency, total, due_amount, issued, due_date, days_overdue). Use to answer receivables questions, find invoice ids, or look up a client's email from past invoices.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "open", "overdue", "paid", "cancelled"], description: "open = sent and unpaid; overdue = open and past due date." },
        client: { type: "string", description: "Optional case-insensitive match on client name, business or email." },
      },
      required: ["filter"],
    },
  },
  {
    name: "get_invoice",
    description: "Get one invoice with its line items.",
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string", description: "PayPal invoice id, e.g. INV2-XXXX-XXXX-XXXX-XXXX" } },
      required: ["invoice_id"],
    },
  },
  {
    name: "propose_invoice",
    description: "Queue a new invoice for the user to review. On approval it is created in PayPal and emailed to the recipient with a pay link.",
    input_schema: {
      type: "object",
      properties: {
        recipient_name: { type: "string", description: "Client contact's full name" },
        recipient_email: { type: "string", description: "Client email. Never guess it." },
        business_name: { type: "string", description: "Client company, if known" },
        currency: { type: "string", description: "ISO 4217 code, e.g. USD, EUR, GBP" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number", description: "Hours, units, or 1 for a fixed fee" },
              unit_amount: { type: "number", description: "Price per unit in the invoice currency" },
              unit: { type: "string", enum: ["HOURS", "QUANTITY", "AMOUNT"] },
            },
            required: ["name", "quantity", "unit_amount", "unit"],
          },
        },
        payment_term: { type: "string", enum: TERMS },
        due_date: { type: "string", description: "YYYY-MM-DD, only with DUE_ON_DATE_SPECIFIED" },
        discount_percent: { type: "number" },
        tax_percent: { type: "number" },
        note: { type: "string", description: "Short note shown to the client on the invoice" },
        memo: { type: "string", description: "Private memo for the user only" },
        reasoning: { type: "string", description: "One line for the user: what you inferred and any assumptions (e.g. defaulted terms)." },
      },
      required: ["recipient_name", "recipient_email", "currency", "items", "payment_term", "note", "reasoning"],
    },
  },
  {
    name: "propose_reminder",
    description: "Queue a payment reminder email for an unpaid invoice. Sent by PayPal on approval.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        subject: { type: "string" },
        note: { type: "string", description: "Reminder message to the client, under 600 characters" },
      },
      required: ["invoice_id", "subject", "note"],
    },
  },
  {
    name: "propose_cancel",
    description: "Queue cancellation of a sent, unpaid invoice.",
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, note: { type: "string", description: "Message to the client explaining the cancellation" } },
      required: ["invoice_id", "note"],
    },
  },
  {
    name: "propose_record_payment",
    description: "Queue recording a payment received outside PayPal (bank transfer, cash, check...) against an invoice.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        amount: { type: "number" },
        method: { type: "string", enum: METHODS },
        note: { type: "string" },
      },
      required: ["invoice_id", "amount", "method"],
    },
  },
];

// Chat Completions (OpenAI-style) tool format used by Cerebras.
const tools = toolDefs.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ---------- validation ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateDraft(d) {
  const errs = [];
  if (!d.recipient_email || !EMAIL.test(d.recipient_email)) errs.push("recipient_email is missing or invalid; ask the user for it");
  if (!/^[A-Z]{3}$/.test(d.currency || "")) errs.push("currency must be a 3-letter ISO code");
  if (!Array.isArray(d.items) || d.items.length === 0) errs.push("at least one item is required");
  for (const [i, it] of (d.items || []).entries()) {
    if (!(Number(it.quantity) > 0)) errs.push(`items[${i}].quantity must be > 0`);
    if (!(Number(it.unit_amount) >= 0)) errs.push(`items[${i}].unit_amount must be >= 0`);
  }
  if (!TERMS.includes(d.payment_term)) errs.push(`payment_term must be one of ${TERMS.join(", ")}`);
  if (d.payment_term === "DUE_ON_DATE_SPECIFIED" && !/^\d{4}-\d{2}-\d{2}$/.test(d.due_date || "")) errs.push("due_date (YYYY-MM-DD) is required with DUE_ON_DATE_SPECIFIED");
  return errs;
}

export function draftTotal(d) {
  const sub = d.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_amount), 0);
  return +(sub * (1 - (d.discount_percent || 0) / 100) * (1 + (d.tax_percent || 0) / 100)).toFixed(2);
}

const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"];

// ---------- tool execution ----------
export async function runTool(sessionId, name, input) {
  switch (name) {
    case "list_invoices": {
      let rows = await paypal.list();
      const f = input.filter || "all";
      if (f === "open") rows = rows.filter((r) => OPEN.includes(r.status));
      if (f === "overdue") rows = rows.filter((r) => OPEN.includes(r.status) && r.days_overdue > 0);
      if (f === "paid") rows = rows.filter((r) => ["PAID", "MARKED_AS_PAID"].includes(r.status));
      if (f === "cancelled") rows = rows.filter((r) => r.status === "CANCELLED");
      if (input.client) {
        const q = input.client.toLowerCase();
        rows = rows.filter((r) => `${r.client} ${r.email}`.toLowerCase().includes(q));
      }
      return JSON.stringify(rows.slice(0, 50).map(({ items, payer_url, ...r }) => r));
    }
    case "get_invoice":
      return JSON.stringify(await paypal.get(input.invoice_id));
    case "propose_invoice": {
      const draft = { ...input, currency: String(input.currency || "").toUpperCase() };
      const errs = validateDraft(draft);
      if (errs.length) throw new Error("Draft rejected: " + errs.join("; "));
      const a = addAction(sessionId, "invoice", draft, { total: draftTotal(draft) });
      return `Queued invoice draft ${a.id} (${draft.currency} ${draftTotal(draft).toFixed(2)} to ${draft.recipient_email}) for the user's approval.`;
    }
    case "propose_reminder":
    case "propose_cancel":
    case "propose_record_payment": {
      const inv = await paypal.get(input.invoice_id);
      if (!OPEN.includes(inv.status)) throw new Error(`Invoice ${inv.number} is ${inv.status}; this action only applies to open invoices.`);
      const type = { propose_reminder: "reminder", propose_cancel: "cancel", propose_record_payment: "payment" }[name];
      if (type === "payment" && !METHODS.includes(input.method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
      const a = addAction(sessionId, type, input, { invoice: inv });
      return `Queued ${type} ${a.id} for invoice #${inv.number} (${inv.client}) for the user's approval.`;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- agent loop ----------
export async function runAgent(sessionId, text, images = []) {
  const session = getSession(sessionId);
  const rollback = session.messages.length;
  if (images.length && !VISION) {
    throw new Error(`${MODEL} can't read images. Paste the text instead, or set CEREBRAS_MODEL=qwen-3.8-27b.`);
  }
  const updates = session.notes.splice(0).map((n) => `[System update: ${n}]`);
  const today = `[Today is ${new Date().toISOString().slice(0, 10)}]`;
  const userText = [today, ...updates, text || "(see attached image)"].join("\n");
  session.messages.push({
    role: "user",
    content: images.length
      ? [{ type: "text", text: userText }, ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } }))]
      : userText,
  });

  const proposed = [];
  const steps = [];
  try {
    for (let turn = 0; turn < 10; turn++) {
      const res = await llm().chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...session.messages],
        tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning_effort: EFFORT,
        max_completion_tokens: 8000,
      });
      const choice = res.choices[0];
      const msg = choice.message;
      // Keep the assistant turn as returned (tool_calls + reasoning) so the next call has full context.
      session.messages.push({
        role: "assistant",
        content: msg.content ?? "",
        ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });

      if (!msg.tool_calls?.length) {
        const reply = (msg.content || "").trim()
          || (choice.finish_reason === "length" ? "I ran out of room thinking. Try a shorter request." : "Done.");
        return { reply, actions: proposed, steps };
      }

      const results = await Promise.all(msg.tool_calls.map(async (call) => {
        const name = call.function.name;
        steps.push(name);
        let out;
        try {
          const input = JSON.parse(call.function.arguments || "{}");
          out = await runTool(sessionId, name, input);
          const m = /(act_[0-9a-f]{8})/.exec(out);
          if (m) proposed.push(m[1]);
        } catch (err) {
          out = `Error: ${err instanceof SyntaxError ? "arguments were not valid JSON" : err.message || err}`;
        }
        return { role: "tool", tool_call_id: call.id, content: out };
      }));
      session.messages.push(...results);
    }
    return { reply: "I stopped after too many steps. Try a more specific request.", actions: proposed, steps };
  } catch (err) {
    session.messages.length = rollback; // keep history valid for the next turn
    throw err;
  }
}

// ---------- approval ----------
export async function executeAction(id, overrides) {
  const a = getAction(id);
  if (!a) throw new Error("Unknown action");
  if (a.status !== "pending") throw new Error(`Action already ${a.status}`);
  a.status = "running";
  try {
    let result, note;
    if (a.type === "invoice") {
      const draft = overrides ? { ...a.payload, ...overrides } : a.payload;
      const errs = validateDraft(draft);
      if (errs.length) throw new Error(errs.join("; "));
      a.payload = draft;
      result = await paypal.createAndSend(draft);
      note = `Invoice #${result.number} (${result.id}) for ${result.currency} ${result.total.toFixed(2)} was created and emailed to ${draft.recipient_email}.`;
      log("sent", `Invoice #${result.number} sent to ${result.client}`, { amount: result.total, currency: result.currency });
    } else if (a.type === "reminder") {
      result = await paypal.remind(a.payload.invoice_id, a.payload);
      note = `Reminder for invoice #${result.number} was emailed to ${result.client}.`;
      log("reminder", `Reminder sent for #${result.number} (${result.client})`);
    } else if (a.type === "cancel") {
      result = await paypal.cancel(a.payload.invoice_id, a.payload);
      note = `Invoice #${result.number} was cancelled.`;
      log("cancel", `Invoice #${result.number} cancelled`);
    } else if (a.type === "payment") {
      const inv = a.context.invoice;
      result = await paypal.recordPayment(a.payload.invoice_id, { ...a.payload, currency: inv.currency });
      note = `Recorded ${inv.currency} ${a.payload.amount} (${a.payload.method}) against invoice #${result.number}; status is now ${result.status}.`;
      log("payment", `Recorded ${inv.currency} ${a.payload.amount} on #${result.number}`);
    }
    a.status = "done";
    a.result = result;
    getSession(a.sessionId).notes.push(note);
    broadcast({ type: "invoices-changed" });
    broadcast({ type: "actions-changed" });
    return a;
  } catch (err) {
    a.status = "pending";
    a.error = String(err.message || err);
    throw err;
  }
}

export function rejectAction(id) {
  const a = getAction(id);
  if (!a || a.status !== "pending") throw new Error("Action is not pending");
  a.status = "discarded";
  getSession(a.sessionId).notes.push(`The user discarded the proposed ${a.type} (${a.id}).`);
  broadcast({ type: "actions-changed" });
  return a;
}

export const agentInfo = { model: MODEL, effort: EFFORT, vision: VISION, provider: "Cerebras" };
