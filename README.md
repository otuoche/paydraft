# PayDraft

**From "can you bill me for this?" to paid, with you approving every step.**

PayDraft is an AI accounts-receivable agent for freelancers and small businesses, built on **PayPal Invoicing** and fast open models on **Cerebras Inference**. Paste a messy client email, drop in a chat screenshot, or dictate a voice note. PayDraft drafts the PayPal invoice, you check it and approve it, and PayPal emails it with a pay link. When the client pays, a PayPal webhook updates your dashboard live. If they don't pay, the agent drafts reminders whose tone matches how late the invoice is.

Built for the PayPal AI Hackathon (2026).

**Demo video:** https://youtu.be/-Kn52fU9Y_s · **Devpost:** https://devpost.com/software/paydraft

**Live demo:** https://paydraft-h3u4.onrender.com (PayPal sandbox; on the free tier, the first load can take ~30–50 s to wake up)

## The problem

Freelancers lose hours every month turning client conversations into invoices and then chasing them. The details live in emails, Slack threads and WhatsApp messages ("14 hours at the €90 rate plus the test session, net 30 is fine"). Retyping them into an invoicing form is slow and error-prone. Chasing late payers is awkward, so it gets put off and cash flow suffers.

## What it does

- **Message → invoice.** The agent reads the text, a screenshot or a voice transcript. It works out the line items, hours vs. fixed fees, currency (€, £, ₦…), payment terms, and writes a short note to the client. It checks the arithmetic against any total the client stated.
- **Never guesses an email.** It reuses addresses from past PayPal invoices, or asks you.
- **Human in the loop.** Every write action is a *proposal*: an invoice, a reminder, a cancellation, or recording an off-PayPal payment. Each appears as an editable approval card. Nothing reaches PayPal until you click approve.
- **Chasing on autopilot.** "Chase everything overdue" makes the agent read your ledger and draft one reminder per late invoice. The tone escalates with lateness (friendly → firm → final notice).
- **Receivables Q&A.** Ask "who owes me money?" and get answers from live PayPal data, reported per currency.
- **Live ledger.** An AG Grid table of all PayPal invoices, plus KPI tiles (outstanding, overdue, collected) and an activity feed. A PayPal `INVOICING.INVOICE.PAID` webhook pushes updates instantly over Server-Sent Events.

## How it uses PayPal

| PayPal API | Used for |
|---|---|
| OAuth 2.0 client credentials | Server-side auth, with the token cached |
| `POST /v2/invoicing/invoices` | Create the invoice from the approved draft |
| `POST /v2/invoicing/invoices/{id}/send` | Email the invoice and pay link to the client |
| `GET /v2/invoicing/invoices` | Ledger, KPIs and the agent's `list_invoices` tool |
| `GET /v2/invoicing/invoices/{id}` | The agent's `get_invoice` tool |
| `POST /v2/invoicing/invoices/{id}/remind` | Approved payment reminders |
| `POST /v2/invoicing/invoices/{id}/cancel` | Approved cancellations |
| `POST /v2/invoicing/invoices/{id}/payments` | Record cash, bank or check payments |
| Webhooks + `POST /v1/notifications/verify-webhook-signature` | Verified real-time "invoice paid" events |

## How it uses AI

- **Qwen 3.8 27B on Cerebras Inference** (`qwen-3.8-27b`) through the official `@cerebras/cerebras_cloud_sdk`, running a tool-calling agent loop (`lib/agent.js`). Cerebras is fast enough that a multi-step agent turn (read the ledger, draft, check) comes back in a couple of seconds, and cheap enough to run on every message. Set `CEREBRAS_MODEL=gpt-oss-120b` for an even cheaper text-only setup.
- Tools: `list_invoices`, `get_invoice`, `propose_invoice`, `propose_reminder`, `propose_cancel`, `propose_record_payment`.
- Vision input reads screenshots of emails, chats and timesheets. Browser speech recognition handles dictated voice notes.
- Read tools run immediately. `propose_*` tools only queue an action. When you approve one, the result goes back into the conversation as a system update, so the agent knows what really happened.
- The server validates every draft (email, currency, quantities, terms). Validation errors go back to the model so it can fix the draft or ask you.

## Architecture

```
Browser (vanilla JS + AG Grid)
  │  chat / approvals / SSE
  ▼
Express server ── lib/agent.js ── Cerebras Inference (tool calling)
       │                │
       │                └── lib/paypal.js ── PayPal Invoicing v2 (sandbox)
       └── /api/webhooks/paypal ◄── PayPal webhooks (INVOICING.INVOICE.PAID…)
```

## Run it locally

Requirements: Node 20+, a PayPal developer account (free), and a Cerebras API key ([cloud.cerebras.ai](https://cloud.cerebras.ai)).

1. **PayPal sandbox app:** go to [developer.paypal.com](https://developer.paypal.com/) → Apps & Credentials → **Sandbox** → Create App. Copy the Client ID and Secret. Under **Testing Tools → Sandbox Accounts** you'll find a sandbox *Personal* account. Use it to pay invoices.
2. Set up and start:
   ```bash
   git clone <this repo> && cd paydraft
   npm install
   cp .env.example .env    # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, CEREBRAS_API_KEY
   npm start               # http://localhost:3000
   ```
3. Click **Try a sample client email** → Send → review the draft → **Approve & send**.
4. Open the **Pay link**, log in with the sandbox personal account, and pay. Locally, press **Refresh** (or wait 30 s) to see the invoice flip to *Paid*. Live webhooks need a public URL (see below).

Sandbox emails don't go to real inboxes. They appear under *Sandbox → Notifications* in the PayPal developer dashboard.

**No credentials?** Set `PAYPAL_MOCK=true` to use an in-memory fake PayPal with seeded invoices and a fake pay page. You still need a Cerebras key for the agent.

## Deploy on Render

`render.yaml` is included: **New → Blueprint** → pick the repo → fill in the secret env vars. Then add a webhook in your PayPal sandbox app:

- URL: `https://<your-app>.onrender.com/api/webhooks/paypal`
- Events: `Invoicing invoice paid`, `Invoicing invoice cancelled`, `Invoicing invoice updated`

Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`. Paid invoices will now show up live with a toast.

## Testing notes for judges

- Everything runs against the **PayPal sandbox**. No real money moves.
- Try:
  - Paste the sample email.
  - Attach a screenshot of a client chat.
  - "Who owes me money?"
  - "Chase everything overdue."
  - "Sofia paid the Brightloop invoice by bank transfer, record it."

## License

MIT, see [LICENSE](LICENSE).
