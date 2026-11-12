// PayDraft front end: agent chat + approval cards + AG Grid ledger + live feed.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (cur, n) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD" }).format(n || 0); }
  catch { return `${cur} ${Number(n || 0).toFixed(2)}`; }
};
const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"];
const TERMS = { DUE_ON_RECEIPT: "Due on receipt", NET_10: "Net 10", NET_15: "Net 15", NET_30: "Net 30", NET_45: "Net 45", NET_60: "Net 60", NET_90: "Net 90", DUE_ON_DATE_SPECIFIED: "On a date" };

const SAMPLE_EMAIL = `From: Sofia Marchetti <sofia@brightloop.example>
Subject: invoice for the checkout work?

Hi! Thanks again for jumping on the checkout redesign last week. Can you send me an invoice? By my count it was 14 hours of design work at the €90/hr we agreed, plus the €250 flat fee for running the usability test session. Net 30 works for us.

Please address it to Brightloop GmbH. Grazie!
Sofia`;

// Fresh conversation on every page load (clean demos; invoices live in PayPal anyway).
const sessionId = crypto.randomUUID();

const thread = $("#thread");
const input = $("#input");
let pendingImages = [];
let busy = false;
let invoices = [];

// ---------- config ----------
fetch("/api/config").then((r) => r.json()).then((c) => {
  const b = $("#envBadge");
  b.innerHTML = `<i></i>${c.mock ? "Mock PayPal" : c.paypalEnv === "live" ? "PayPal Live" : "PayPal Sandbox · connected"}`;
  if (c.mock) b.classList.add("mock");
  $("#modelBadge").textContent = `${c.provider} · ${c.model}`;
  if (!c.vision) $("#file").closest("label").hidden = true;
});

// ---------- grid ----------
const gridEl = $("#grid");
gridEl.className = "grid ag-theme-quartz";

const AVATAR_HUES = [228, 262, 192, 152, 24, 330, 48];
function avatar(name) {
  const initials = String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="--h:${AVATAR_HUES[h % AVATAR_HUES.length]}">${esc(initials)}</span>`;
}

function shortDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
const RANK = (r) => (OPEN.includes(r.status) ? (r.days_overdue > 0 ? 0 : 1) : r.status === "CANCELLED" ? 3 : 2);

function statusEl(row) {
  const s = document.createElement("span");
  const overdue = OPEN.includes(row.status) && row.days_overdue > 0;
  s.className = "status " + (overdue ? "OVERDUE" : row.status);
  const label = overdue ? `Overdue · ${row.days_overdue}d` : { MARKED_AS_PAID: "Paid", SENT: "Awaiting payment", UNPAID: "Awaiting payment" }[row.status] || row.status.replace(/_/g, " ").toLowerCase();
  s.innerHTML = `<i></i>${esc(label)}`;
  return s;
}

const grid = agGrid.createGrid(gridEl, {
  rowData: [],
  rowHeight: 60,
  headerHeight: 44,
  getRowId: (p) => p.data.id,
  overlayNoRowsTemplate: '<span style="color:var(--muted)">No invoices yet. Paste a client message to draft your first one.</span>',
  defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true, minWidth: 80 },
  columnDefs: [
    { field: "number", headerName: "Invoice", width: 100, flex: 0, cellClass: "mono" },
    {
      field: "client", headerName: "Client", flex: 1.5, minWidth: 170,
      cellRenderer: (p) => {
        const d = document.createElement("div");
        d.className = "client-cell";
        d.innerHTML = `${avatar(p.data.client)}<span><b>${esc(p.data.client)}</b><small>${esc(p.data.email || "")}</small></span>`;
        return d;
      },
      getQuickFilterText: (p) => `${p.data.client} ${p.data.email}`,
    },
    { field: "total", headerName: "Amount", flex: 1, minWidth: 120, cellClass: "amount", valueFormatter: (p) => fmt(p.data.currency, p.value) },
    { field: "status", headerName: "Status", flex: 1.3, minWidth: 170, cellRenderer: (p) => statusEl(p.data) },
    { field: "due_date", headerName: "Due", flex: 0.9, minWidth: 110, valueFormatter: (p) => shortDate(p.value) },
    {
      headerName: "", colId: "actions", width: 130, flex: 0, sortable: false, resizable: false,
      cellRenderer: (p) => {
        const d = document.createElement("div");
        d.className = "row-actions";
        if (p.data.payer_url && OPEN.includes(p.data.status)) {
          const a = document.createElement("a");
          a.href = p.data.payer_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Pay link";
          d.append(a);
        }
        if (OPEN.includes(p.data.status)) {
          const b = document.createElement("button");
          b.textContent = "Nudge";
          b.title = "Ask the agent to draft a reminder";
          b.onclick = () => send(`Draft a payment reminder for invoice #${p.data.number} (id ${p.data.id}).`);
          d.append(b);
        }
        return d;
      },
    },
  ],
});
$("#quickFilter").addEventListener("input", (e) => grid.setGridOption("quickFilterText", e.target.value));

async function loadInvoices(flashId) {
  try {
    const r = await fetch("/api/invoices");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    invoices = data;
    const ordered = [...invoices].sort((a, b) => RANK(a) - RANK(b) || String(b.issued).localeCompare(String(a.issued)) || String(b.number).localeCompare(String(a.number)));
    grid.setGridOption("rowData", ordered);
    renderKpis();
    if (flashId) {
      const node = grid.getRowNode(flashId);
      if (node) grid.flashCells({ rowNodes: [node], flashDuration: 1800 });
    }
  } catch (err) {
    toast(`Couldn't load invoices: ${err.message}`);
  }
}
$("#refresh").onclick = () => loadInvoices();

function sumBy(rows, key) {
  const m = {};
  for (const r of rows) m[r.currency] = (m[r.currency] || 0) + r[key];
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function moneyKpi(entries) {
  if (!entries.length) return { value: fmt("USD", 0), extra: "" };
  const [[cur, amt], ...rest] = entries;
  return { value: fmt(cur, amt), extra: rest.map(([c, a]) => fmt(c, a)).join(" · ") };
}
function renderKpis() {
  const open = invoices.filter((r) => OPEN.includes(r.status));
  const overdue = open.filter((r) => r.days_overdue > 0);
  const paid = invoices.filter((r) => ["PAID", "MARKED_AS_PAID"].includes(r.status));
  const o = moneyKpi(sumBy(open, "due_amount"));
  const od = moneyKpi(sumBy(overdue, "due_amount"));
  const pd = moneyKpi(sumBy(paid, "total"));
  const ICON = {
    out: '<path d="M4 7h16v10H4z M4 10h16" />',
    late: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    paid: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    docs: '<path d="M7 3h7l4 4v14H7z M14 3v4h4"/>',
  };
  const tiles = [
    { icon: "out", label: "Outstanding", value: o.value, sub: o.extra ? `+ ${o.extra}` : `${open.length} open invoice${open.length === 1 ? "" : "s"}`, cls: "hero" },
    { icon: "late", label: "Overdue", value: od.value, sub: overdue.length ? `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} late` : "Nothing late", cls: overdue.length ? "bad" : "" },
    { icon: "paid", label: "Collected", value: pd.value, sub: pd.extra ? `+ ${pd.extra}` : `${paid.length} paid`, cls: "ok" },
    { icon: "docs", label: "Invoices", value: String(invoices.filter((r) => r.status !== "CANCELLED").length), sub: "in PayPal", cls: "" },
  ];
  $("#kpis").innerHTML = tiles.map((t) => `<div class="kpi ${t.cls}"><div class="label"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[t.icon]}</svg>${t.label}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join("");
}

// ---------- chat ----------
function scrollDown() { thread.scrollTop = thread.scrollHeight; }
function hideWelcome() { $("#welcome")?.remove(); }

function addMsg(role, text, images = []) {
  hideWelcome();
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  for (const img of images) {
    const i = document.createElement("img");
    i.src = `data:${img.media_type};base64,${img.data}`;
    d.append(i);
  }
  if (role === "bot") {
    // minimal formatting: escape, then **bold**
    const span = document.createElement("span");
    span.innerHTML = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    d.append(span);
  } else d.append(document.createTextNode(text));
  thread.append(d);
  scrollDown();
  return d;
}

const STEP_LABEL = {
  list_invoices: "checked your invoices", get_invoice: "opened an invoice", propose_invoice: "drafted an invoice",
  propose_reminder: "drafted a reminder", propose_cancel: "drafted a cancellation", propose_record_payment: "drafted a payment record",
};

async function send(text) {
  text = (text ?? input.value).trim();
  if (busy || (!text && !pendingImages.length)) return;
  busy = true;
  $("#send").disabled = true;
  const images = pendingImages;
  pendingImages = [];
  renderAttachments();
  input.value = "";
  addMsg("user", text, images);
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<span class=\"dots\"><i></i><i></i><i></i></span> Reading it and checking PayPal…";
  thread.append(typing);
  scrollDown();
  try {
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text, images }),
    });
    const data = await r.json();
    typing.remove();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const uniq = [...new Set(data.steps || [])].map((s) => STEP_LABEL[s] || s);
    if (uniq.length) {
      const s = document.createElement("div");
      s.className = "steps";
      s.textContent = "✓ " + uniq.join(" · ");
      thread.append(s);
    }
    const replyEl = data.reply ? addMsg("bot", data.reply) : null;
    for (const a of data.actions || []) thread.append(renderAction(a));
    // Show the reply and the top of the first draft (the "AI read this as" note), not the card's bottom.
    if ((data.actions || []).length && replyEl) thread.scrollTop = Math.max(0, replyEl.offsetTop - thread.offsetTop - 12);
    else scrollDown();
  } catch (err) {
    typing.remove();
    addMsg("bot", err.message).classList.add("error");
  } finally {
    busy = false;
    $("#send").disabled = false;
    input.focus();
  }
}

$("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
thread.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.sample) { input.value = SAMPLE_EMAIL; input.focus(); }
  else send(chip.dataset.prompt);
});

// ---------- approval cards ----------
function itemRow(it = { name: "", quantity: 1, unit_amount: 0, unit: "AMOUNT" }) {
  const tr = document.createElement("tr");
  tr.dataset.unit = it.unit || "QUANTITY";
  tr.dataset.description = it.description || "";
  tr.innerHTML = `<td><input class="iname" value="${esc(it.name)}" aria-label="Item"></td>
    <td class="num"><input class="n iqty" type="number" step="any" min="0" value="${esc(it.quantity)}" aria-label="Quantity"></td>
    <td class="num"><input class="n irate" type="number" step="any" min="0" value="${esc(it.unit_amount)}" aria-label="Rate"></td>`;
  return tr;
}

function renderAction(a) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = a.id;
  const title = { invoice: "Invoice draft", reminder: "Payment reminder", cancel: "Cancel invoice", payment: "Record payment" }[a.type];
  card.className = `card ${a.type === "invoice" ? "slip" : ""}`;
  card.innerHTML = `<div class="card-head"><strong><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5"/></svg>${title}</strong><span class="pill pending">Needs your approval</span></div><div class="card-body"></div>
    <div class="card-actions"><button class="btn ghost" data-act="reject">Discard</button><button class="btn primary" data-act="approve"></button></div>`;
  const body = $(".card-body", card);
  const approveBtn = $('[data-act="approve"]', card);
  const p = a.payload;

  if (a.type === "invoice") {
    approveBtn.textContent = "Approve & send";
    body.innerHTML = `
      ${p.reasoning ? `<div class="why"><b>AI read this as</b>${esc(p.reasoning)}</div>` : ""}
      <div class="slip-label">Bill to</div>
      <div class="fields">
        <label class="field"><span>Client name</span><input name="recipient_name" value="${esc(p.recipient_name)}"></label>
        <label class="field"><span>Email</span><input name="recipient_email" type="email" value="${esc(p.recipient_email)}"></label>
        <label class="field"><span>Company</span><input name="business_name" value="${esc(p.business_name || "")}"></label>
        <label class="field"><span>Currency</span><input name="currency" maxlength="3" value="${esc(p.currency)}"></label>
        <label class="field"><span>Terms</span><select name="payment_term">${Object.entries(TERMS).map(([k, v]) => `<option value="${k}" ${k === p.payment_term ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field"><span>Due date</span><input name="due_date" type="date" value="${esc(p.due_date || "")}"></label>
      </div>
      <table class="items"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th></tr></thead><tbody></tbody></table>
      <label class="field wide"><span>Note to client</span><textarea name="note">${esc(p.note || "")}</textarea></label>
      <div class="total"><span class="summary">${[p.discount_percent ? `${p.discount_percent}% discount` : "", p.tax_percent ? `${p.tax_percent}% tax` : ""].filter(Boolean).join(" · ") || "Total due"}</span><b class="tot"></b></div>
      <div class="err"></div>`;
    const tbody = $("tbody", body);
    p.items.forEach((it) => tbody.append(itemRow(it)));
    const dueField = $('[name="due_date"]', body).closest(".field");
    const syncDue = () => { dueField.style.display = $('[name="payment_term"]', body).value === "DUE_ON_DATE_SPECIFIED" ? "" : "none"; };
    const recalc = () => {
      const sub = [...tbody.rows].reduce((s, tr) => s + Number($(".iqty", tr).value) * Number($(".irate", tr).value), 0);
      const tot = sub * (1 - (p.discount_percent || 0) / 100) * (1 + (p.tax_percent || 0) / 100);
      $(".tot", body).textContent = fmt($('[name="currency"]', body).value.toUpperCase() || "USD", tot);
    };
    body.addEventListener("input", () => { recalc(); syncDue(); });
    recalc(); syncDue();
  } else {
    const inv = a.context.invoice;
    body.innerHTML = `<div class="summary">#${esc(inv.number)} · ${esc(inv.client)} · ${esc(fmt(inv.currency, inv.due_amount))} due ${esc(inv.due_date || "")}${inv.days_overdue ? ` · <span class="overdue">${inv.days_overdue}d late</span>` : ""}</div>`;
    if (a.type === "reminder") {
      approveBtn.textContent = "Send reminder";
      body.insertAdjacentHTML("beforeend", `<label class="field"><span>Subject</span><input name="subject" value="${esc(p.subject)}"></label>
        <label class="field"><span>Message</span><textarea name="note" rows="5">${esc(p.note)}</textarea></label>`);
    } else if (a.type === "cancel") {
      approveBtn.textContent = "Cancel invoice";
      body.insertAdjacentHTML("beforeend", `<label class="field"><span>Message to client</span><textarea name="note">${esc(p.note)}</textarea></label>`);
    } else {
      approveBtn.textContent = "Record payment";
      body.insertAdjacentHTML("beforeend", `<div>${esc(fmt(inv.currency, p.amount))} received via ${esc(p.method.replace(/_/g, " ").toLowerCase())}${p.note ? ` — ${esc(p.note)}` : ""}</div>`);
    }
    body.insertAdjacentHTML("beforeend", `<div class="err"></div>`);
  }

  card.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const buttons = card.querySelectorAll(".card-actions button");
    buttons.forEach((b) => (b.disabled = true));
    $(".err", card).textContent = "";
    try {
      if (btn.dataset.act === "reject") {
        const r = await fetch(`/api/actions/${a.id}/reject`, { method: "POST" });
        if (!r.ok) throw new Error((await r.json()).error);
        finish(card, "discarded", `<div class="summary">Discarded.</div>`);
        return;
      }
      btn.textContent = "Working…";
      const overrides = collectOverrides(a, card);
      const r = await fetch(`/api/actions/${a.id}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides }),
      });
      const done = await r.json();
      if (!r.ok) throw new Error(done.error);
      const inv = done.result;
      const msgs = {
        invoice: `Sent invoice <b>#${esc(inv.number)}</b> for <b>${esc(fmt(inv.currency, inv.total))}</b> to ${esc(inv.email || inv.client)}.`,
        reminder: `Reminder sent for #${esc(inv.number)}.`,
        cancel: `Invoice #${esc(inv.number)} cancelled.`,
        payment: `Payment recorded. #${esc(inv.number)} is now ${esc(inv.status.replace(/_/g, " ").toLowerCase())}.`,
      };
      const link = inv.payer_url ? ` <a href="${esc(inv.payer_url)}" target="_blank" rel="noopener">Open pay link ↗</a>` : "";
      finish(card, "done", `<div class="result">✓ ${msgs[a.type]}${a.type === "invoice" ? link : ""}</div>`);
      loadInvoices(inv.id);
    } catch (err) {
      $(".err", card).textContent = err.message;
      buttons.forEach((b) => (b.disabled = false));
      approveBtn.textContent = "Try again";
    }
  });
  return card;
}

function collectOverrides(a, card) {
  const val = (n) => card.querySelector(`[name="${n}"]`)?.value;
  if (a.type === "invoice") {
    const items = [...card.querySelectorAll("tbody tr")].map((tr) => ({
      name: $(".iname", tr).value.trim(),
      quantity: Number($(".iqty", tr).value),
      unit_amount: Number($(".irate", tr).value),
      unit: tr.dataset.unit,
      ...(tr.dataset.description ? { description: tr.dataset.description } : {}),
    }));
    return {
      recipient_name: val("recipient_name").trim(),
      recipient_email: val("recipient_email").trim(),
      business_name: val("business_name").trim() || undefined,
      currency: val("currency").trim().toUpperCase(),
      payment_term: val("payment_term"),
      due_date: val("due_date") || undefined,
      note: val("note"),
      items,
    };
  }
  if (a.type === "reminder") return { ...a.payload, subject: val("subject"), note: val("note") };
  if (a.type === "cancel") return { ...a.payload, note: val("note") };
  return null;
}

function finish(card, status, html) {
  const pill = $(".pill", card);
  pill.className = `pill ${status}`;
  pill.textContent = status === "done" ? "Done" : "Discarded";
  $(".card-body", card).innerHTML = html;
  $(".card-actions", card).remove();
}

// ---------- attachments & voice ----------
async function addImage(file) {
  if (!file.type.startsWith("image/")) return;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const data = c.toDataURL("image/jpeg", 0.88).split(",")[1];
  pendingImages.push({ media_type: "image/jpeg", data });
  renderAttachments();
}
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  pendingImages.forEach((img, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    t.innerHTML = `<img alt="attachment" src="data:${img.media_type};base64,${img.data}"><button type="button" aria-label="Remove">×</button>`;
    $("button", t).onclick = () => { pendingImages.splice(i, 1); renderAttachments(); };
    box.append(t);
  });
}
$("#file").addEventListener("change", (e) => { [...e.target.files].forEach(addImage); e.target.value = ""; });
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); files.forEach(addImage); }
});

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const mic = $("#mic");
  mic.hidden = false;
  let rec = null;
  mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    const base = input.value ? input.value.trimEnd() + " " : "";
    rec.onresult = (e) => {
      let txt = "";
      for (const r of e.results) txt += r[0].transcript;
      input.value = base + txt;
    };
    rec.onend = () => { rec = null; mic.classList.remove("rec"); mic.title = "Dictate a voice note"; };
    rec.onerror = (e) => toast(`Mic: ${e.error}`);
    rec.start();
    mic.classList.add("rec");
    mic.title = "Stop dictation";
  };
}

// ---------- live updates ----------
function toast(text, cls = "") {
  const t = document.createElement("div");
  t.className = `toast ${cls}`;
  t.textContent = text;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 4500);
}
function feedItem(e) {
  const li = document.createElement("li");
  li.className = e.kind;
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  li.innerHTML = `<i class="dot"></i><time>${time}</time><span>${esc(e.text)}${e.amount ? ` · <b>${esc(fmt(e.currency, e.amount))}</b>` : ""}</span>`;
  return li;
}
function addFeed(e, prepend = true) {
  const feed = $("#feed");
  $(".empty", feed)?.remove();
  prepend ? feed.prepend(feedItem(e)) : feed.append(feedItem(e));
}
fetch("/api/activity").then((r) => r.json()).then((list) => list.forEach((e) => addFeed(e, false)));

const es = new EventSource("/api/events");
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === "invoices-changed") loadInvoices();
  if (ev.type === "activity") {
    addFeed(ev.entry);
    if (ev.entry.kind === "paid") toast(`💸 ${ev.entry.text}`, "paid");
  }
};
setInterval(() => loadInvoices(), 30_000);

loadInvoices();
input.focus();
window.__paydraft = { renderAction, thread, sessionId };
