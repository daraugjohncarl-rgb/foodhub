// Real-browser checks (headless Edge via the Chrome DevTools Protocol, no npm packages).
// Usage: node e2e_browser.mjs <edge.exe> <profile-dir>
import { spawn } from "node:child_process";

const [, , EDGE, PROFILE] = process.argv;
const BASE = "http://127.0.0.1:8765";
const PORT = 9333;
const PASSWORD = "E2e-password-123";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
async function token(username) {
  const r = await api("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `username=${username}&password=${PASSWORD}` });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
let version;
for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
if (!version) { console.log("FAIL could not start Edge"); process.exit(1); }

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let msgId = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
const dialogs = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map(a => a.value ?? a.description).join(" "));
  if (msg.method === "Page.javascriptDialogOpening") {
    dialogs.push(msg.params.message);
    send("Page.handleJavaScriptDialog", { accept: true, promptText: "100" });
  }
});
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
}
async function goto(path) {
  await send("Page.navigate", { url: BASE + path });
  await sleep(2500);
}
async function loginAs(login) {
  await goto("/static/README.md");
  await evaluate(`localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("access_token", ${JSON.stringify(login.access_token)});
    localStorage.setItem("username", ${JSON.stringify(login.username)});
    localStorage.setItem("role", ${JSON.stringify(login.role)});
    localStorage.setItem("tenant_id", ${JSON.stringify(String(login.tenant_id ?? "GLOBAL"))});
    localStorage.setItem("RESTOTRACK_USER", ${JSON.stringify(JSON.stringify({ username: login.username, name: login.username, role: String(login.role).toLowerCase(), tenant_id: login.tenant_id }))});
    true`);
}
await send("Page.enable");
await send("Runtime.enable");

try {
  const cashier = await token("cashier");
  const kitchen = await token("kitchen");
  const admin = await token("admin");
  const sa = await token("sa");
  const inv = await token("inv");

  // A hostile customer order through the public endpoint.
  const products = (await api("/api/v1/products", { headers: { Authorization: `Bearer ${admin.access_token}` } })).body;
  const coke = products.find(p => p.name === "Coke");
  const special = products.find(p => p.name.startsWith("Tom"));
  const evilName = `<img src=x onerror="window.__xss=1">Mallory`;
  const evilNotes = `<script>window.__xss=2</script><img src=x onerror=window.__xss=3>`;
  const order = await api("/api/v1/customer-orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: 1, customer_name: evilName, notes: evilNotes, table_number: "7", items: [{ product_id: coke.id, quantity: 2 }] }) });
  check("public order accepted", order.status === 201, String(order.status));

  // ── Cashier POS ─────────────────────────────────────────────
  await loginAs(cashier);
  exceptions.length = 0;
  await goto("/cashier");
  await sleep(1500);
  await evaluate(`openOnlineOrdersModal(); true`);
  await sleep(500);
  const modalText = await evaluate(`document.getElementById("modal-content")?.innerText || ""`);
  const imgInjected = await evaluate(`!!document.querySelector('#modal-content img[src="x"]')`);
  check("H1 customer name rendered as text in POS online orders", modalText.includes('<img src=x onerror="window.__xss=1">Mallory'), modalText.slice(0, 120).replace(/\s+/g, " "));
  check("H1 no injected element / script in POS", !imgInjected && !(await evaluate(`window.__xss || 0`)));

  // Product with quotes and markup in its name: add to cart through its onclick handler.
  await evaluate(`Utils.closeModal(); true`);
  await evaluate(`[...document.querySelectorAll('.pos-item-card')].find(c => c.innerText.includes("Tom's"))?.click(); true`);
  const cartName = await evaluate(`posCart.map(i => i.name).join("|")`);
  check("H1 quoted product name survives escJs() in onclick", cartName === special.name, cartName);

  // Checkout without a shift -> start-shift prompt (auto-answered 100) -> sale created.
  await evaluate(`openPaymentModal(); true`);
  await evaluate(`document.getElementById("pay-tendered").value = "200"; true`);
  dialogs.length = 0;
  await evaluate(`submitCheckout().then(() => true)`);
  await sleep(1500);
  const txs = (await api("/api/v1/transactions", { headers: { Authorization: `Bearer ${cashier.access_token}` } })).body;
  check("M3 checkout prompted to start a shift", dialogs.some(d => d.includes("opening cash")), JSON.stringify(dialogs));
  check("C7 browser checkout created one completed sale", Array.isArray(txs) && txs.length === 1 && txs[0].status === "completed" && txs[0].net_amount === "95.50" && txs[0].change_amount === "104.50", JSON.stringify(txs && txs[0] && { s: txs[0].status, n: txs[0].net_amount, c: txs[0].change_amount }));

  // Ring up the online order (links customer_order_id, M9).
  await evaluate(`fetchPendingOnlineOrders().then(() => { processOnlineOrder(pendingOnlineOrders[0].id); return true; })`);
  await evaluate(`openPaymentModal(); document.getElementById("pay-tendered").value = "50"; submitCheckout().then(() => true)`);
  await sleep(1500);
  const pending = (await api("/api/v1/customer-orders/pending", { headers: { Authorization: `Bearer ${cashier.access_token}` } })).body;
  check("M9 online order completed by checkout", Array.isArray(pending) && pending.length === 0, JSON.stringify(pending).slice(0, 80));
  check("cashier page: no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 300));

  // ── Kitchen display ─────────────────────────────────────────
  await loginAs(kitchen);
  exceptions.length = 0;
  await goto("/kitchen");
  await sleep(1500);
  const kdsText = await evaluate(`document.body.innerText`);
  check("M1 kitchen shows table from the order", kdsText.includes("Table 7"), "");
  check("kitchen page: no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 300));
  check("H1 kitchen: no script executed", !(await evaluate(`window.__xss || 0`)));

  // ── Admin: tables QR (L7), wastage (M12), purchases & suppliers modules ─────
  await loginAs(admin);
  exceptions.length = 0;
  await goto("/admin");
  await sleep(1000);
  await evaluate(`renderView("tables").then(() => true)`);
  await sleep(1200);
  const qrUrl = await evaluate(`document.querySelector("[data-url]")?.getAttribute("data-url") || ""`);
  check("L7 QR link uses current origin + tenant", qrUrl === `${BASE}/customer?tenant_id=1&table=7`, qrUrl);

  await evaluate(`renderView("suppliers").then(() => true)`);
  await sleep(1200);
  const supText = await evaluate(`document.getElementById("view-container")?.innerText || document.body.innerText`);
  check("H1 supplier name with markup rendered as text", supText.includes('<svg onload=window.__xss=9>'), "");
  check("H1 supplier page: no script executed", !(await evaluate(`window.__xss || 0`)));

  await evaluate(`renderView("purchases").then(() => true)`);
  await sleep(1200);
  const poMock = await evaluate(`typeof cachedPurchases !== "undefined"`);
  const poReal = await evaluate(`typeof cachedPurchaseOrders !== "undefined" && typeof setPOStatus === "function"`);
  check("purchases view uses the real API module (not mock data)", !poMock && poReal);

  await evaluate(`renderView("wastage").then(() => true)`);
  await sleep(1200);
  const wastageText = await evaluate(`document.body.innerText`);
  check("M12 wastage view loads from API (no hard-coded mock rows)", wastageText.includes("No wastage recorded yet") && !wastageText.includes("Fresh Chicken Fillet"), "");
  check("admin page: no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 300));

  // ── Inventory role: record wastage through the UI ──────────
  await loginAs(inv);
  exceptions.length = 0;
  await goto("/inventory");
  await sleep(1000);
  await evaluate(`renderView("wastage").then(() => openLogWastageModal()).then(() => true)`);
  await sleep(800);
  await evaluate(`const sel = document.getElementById("ws-item"); sel.value = sel.options[1].value;
                  document.getElementById("ws-qty").value = "1.5"; document.getElementById("ws-cost").value = "60";
                  submitLogWastage().then(() => true)`);
  await sleep(1500);
  const w = (await api("/api/v1/inventory/wastage", { headers: { Authorization: `Bearer ${inv.access_token}` } })).body;
  check("M12 wastage recorded via UI persists", Array.isArray(w) && w.length === 1 && w[0].quantity === "1.50", JSON.stringify(w).slice(0, 120));
  check("inventory page: no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 300));

  // ── Super admin pages ───────────────────────────────────────
  await loginAs(sa);
  for (const page of ["/dashboard", "/users", "/activity-logs", "/reports", "/settings", "/profile"]) {
    exceptions.length = 0;
    await goto(page);
    check(`super admin ${page}: no uncaught JS exceptions`, exceptions.length === 0, exceptions.join(" | ").slice(0, 200));
  }

  // ── Customer page ───────────────────────────────────────────
  exceptions.length = 0;
  await goto("/customer?tenant_id=1&table=7");
  await evaluate(`document.getElementById("orderButton")?.click(); true`);
  await sleep(1500);
  const menuText = await evaluate(`document.body.innerText`);
  check("customer menu renders prices", menuText.includes("₱25.00"), menuText.slice(0, 400).replace(/\s+/g, " "));
  check("customer page: no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 200));
} catch (err) {
  check("browser run completed", false, err.stack || String(err));
} finally {
  ws.close();
  edge.kill();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\nBROWSER SUMMARY: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
