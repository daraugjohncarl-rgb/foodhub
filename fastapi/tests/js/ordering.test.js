// Cashier ordering UI: checkout idempotency key, double-tap guard, cart drafts, customer-order cart lock,
// and the manual GCash verification dialog. Runs the real views.js inside jsdom with a scripted fetch.
// State is driven through the same public functions and DOM the cashier uses (views.js keeps its cart in
// a script-scoped `let`, which is deliberately not reached into from here).
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, PAYLOADS } = require("./harness");

const SCRIPTS = ["js/storage.js", "assets/js/utils.js", "assets/js/auth.js", "assets/js/permissions.js", "assets/js/views.js"];
const tick = (w, ms = 20) => new Promise((r) => w.setTimeout(r, ms));

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } };
}

const CATALOGUE = [
  { id: 1, name: "Cake", sku: "CAKE", price: 100, is_active: true, category_id: null },
  { id: 2, name: "Tea", sku: "TEA", price: 20, is_active: true, category_id: null },
];

// handlers: [(url, options) => response | Error | undefined]; the first one returning something wins.
async function pos(handlers = [], { products = CATALOGUE, role = "cashier", draft = null, attempt = null } = {}) {
  const w = load(SCRIPTS);
  w.calls = [];
  w.fetch = async (url, options = {}) => {
    url = String(url);
    w.calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    for (const h of handlers) {
      const r = await h(url, options);
      if (r instanceof Error) throw r;
      if (r) return r;
    }
    if (url.endsWith("/api/v1/products")) return json(200, products);
    if (url.endsWith("/api/v1/categories")) return json(200, []);
    if (url.endsWith("/shifts/drawer-summary")) return json(200, { shifts: [] });
    if (url.includes("/customer-orders/pending")) return json(200, []);
    return json(200, {});
  };
  w.localStorage.setItem("RESTOTRACK_USER", JSON.stringify({ id: 7, username: "cash", role }));
  w.localStorage.setItem("role", role);
  if (draft) w.sessionStorage.setItem("pos_cart_draft_v1:7", JSON.stringify(draft));
  if (attempt) w.sessionStorage.setItem("pos_checkout_attempt_v1:7", JSON.stringify(attempt));
  const app = w.document.getElementById("app");
  await w.renderPOS(app);
  w.calls.length = 0;
  return w;
}

const sales = (w) => w.calls.filter((c) => c.url.endsWith("/api/v1/transactions") && c.method === "POST");
const cartText = (w) => w.document.getElementById("cart-items-container").textContent;
const SALE_OK = (url, o) => (url.endsWith("/api/v1/transactions") && o.method === "POST")
  ? json(201, { id: 9, order_code: "TXN-0009", net_amount: 100, status: "completed", created_at: new Date().toISOString() })
  : null;

test("a retried checkout reuses its idempotency key; a new sale gets a new one", async () => {
  let attempt = 0;
  const w = await pos([(url, o) => {
    if (url.endsWith("/api/v1/transactions") && o.method === "POST" && ++attempt === 1) return new TypeError("Failed to fetch");   // outcome unknown
  }, SALE_OK]);
  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  await w.submitCheckout();
  const box = w.document.getElementById("checkout-error");
  assert.ok(box && box.style.display === "block" && /may or may not have been saved/.test(box.textContent));
  assert.ok(w.document.getElementById("checkout-confirm-btn"), "modal stays open so the cashier can retry");
  await w.submitCheckout();
  const [first, retry] = sales(w);
  assert.ok(first.body.client_tx_id && first.body.client_tx_id.length <= 36);
  assert.equal(retry.body.client_tx_id, first.body.client_tx_id, "retry must reuse the key");
  assert.match(cartText(w), /cart is empty/, "cart cleared after the sale succeeded");

  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  await w.submitCheckout();
  assert.notEqual(sales(w)[2].body.client_tx_id, first.body.client_tx_id, "a genuinely new sale gets a new key");
  w.close();
});

test("after a page reload the unfinished checkout keeps its key, so a retry cannot double charge", async () => {
  // First page: the request is lost; the key and the cart draft are left in sessionStorage.
  const first = await pos([(url, o) => (url.endsWith("/api/v1/transactions") && o.method === "POST") ? new TypeError("Failed to fetch") : null]);
  first.addToCart(1, "Cake", 100);
  await first.openPaymentModal();
  await first.submitCheckout();
  const key = JSON.parse(first.sessionStorage.getItem("pos_checkout_attempt_v1:7"));
  const draft = JSON.parse(first.sessionStorage.getItem("pos_cart_draft_v1:7"));
  assert.ok(key && key.key && draft.length === 1);
  first.close();
  // Second page (reload): same tab storage.
  const w = await pos([SALE_OK], { draft, attempt: key });
  await w.openPaymentModal();
  await w.submitCheckout();
  assert.equal(sales(w)[0].body.client_tx_id, key.key);
  assert.equal(w.sessionStorage.getItem("pos_checkout_attempt_v1:7"), null, "cleared after success");
  w.close();
});

test("a stale saved key is not reused for a different cart", async () => {
  const w = await pos([SALE_OK], { draft: [{ product_id: 2, quantity: 1 }], attempt: { key: "old-key-for-another-cart", signature: "|CASH|1x1" } });
  await w.openPaymentModal();
  await w.submitCheckout();
  assert.notEqual(sales(w)[0].body.client_tx_id, "old-key-for-another-cart");
  w.close();
});

test("changing the cart between attempts replaces the key and the server message is shown", async () => {
  let n = 0;
  const w = await pos([(url, o) => { if (url.endsWith("/api/v1/transactions") && o.method === "POST" && ++n === 1) return json(400, { detail: "Product 'Cake' is unavailable." }); }, SALE_OK]);
  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  await w.submitCheckout();
  assert.match(w.document.getElementById("checkout-error").textContent, /unavailable/);
  w.addToCart(1, "Cake", 100);   // quantity 2
  await w.openPaymentModal();
  await w.submitCheckout();
  const [a, b] = sales(w);
  assert.notEqual(a.body.client_tx_id, b.body.client_tx_id);
  w.close();
});

test("double tapping confirm sends one request", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = await pos([async (url, o) => { if (url.endsWith("/api/v1/transactions") && o.method === "POST") { await gate; } }, SALE_OK]);
  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  const first = w.submitCheckout();
  const second = w.submitCheckout();
  assert.ok(w.document.getElementById("checkout-confirm-btn").disabled, "button is disabled while the request is in flight");
  release();
  await Promise.all([first, second]);
  assert.equal(sales(w).length, 1);
  w.close();
});

test("non-cash checkout must equal the amount due", async () => {
  const w = await pos([SALE_OK]);
  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  w.document.getElementById("pay-method").value = "GCASH";
  w.document.getElementById("pay-tendered").value = "150";
  await w.submitCheckout();
  assert.equal(sales(w).length, 0);
  assert.match(w.document.getElementById("checkout-error").textContent, /exactly the amount due/);
  w.close();
});

function gcashOrder(extra = {}) {
  return { id: 5, order_number: "CUST-ABC", customer_name: "Maria", order_type: "Dine In", table_number: "5", status: "pending", total_amount: 100,
    payment_method: "GCASH", payment_status: "unpaid", payment_attempt: null, sale_recorded: false,
    items: [{ name: "Cake", quantity: 1, price: 100, product_id: 1 }], ...extra };
}
const serveOrder = (order) => (url) => url.endsWith("/api/v1/customer-orders/5") ? json(200, order) : null;

test("a verified GCash order is settled by order id only: no items, prices or method are sent", async () => {
  const order = gcashOrder({ payment_status: "verified" });
  const w = await pos([serveOrder(order), SALE_OK]);
  await w.loadOnlineOrderIntoPOS(order);
  assert.match(cartText(w), /Cake/);
  await w.openPaymentModal();
  assert.match(w.document.body.textContent, /Amount matches/);
  assert.match(w.document.body.textContent, /did not check GCash itself/, "never claims GCash confirmed it");
  await w.submitCheckout();
  const [sale] = sales(w);
  assert.equal(sale.body.customer_order_id, 5);
  assert.ok(!("items" in sale.body) && !("payment_method" in sale.body) && !("amount_paid" in sale.body));
  assert.equal(w.currentOnlineOrder, null, "order unloaded after the sale");
  assert.ok(!w.calls.some((c) => /customer-orders\/5\/status/.test(c.url)), "no second, separate status call");
  w.close();
});

test("an unverified GCash order cannot be completed from the checkout dialog", async () => {
  const order = gcashOrder();
  const w = await pos([serveOrder(order), SALE_OK]);
  await w.loadOnlineOrderIntoPOS(order);
  await w.openPaymentModal();
  assert.ok(w.document.getElementById("gc-amount"), "amount input is shown");
  assert.match(w.document.body.textContent, /reported by you/);
  assert.equal(w.document.getElementById("checkout-confirm-btn"), null, "no complete-sale button before verification");
  w.close();
});

test("a mismatch is shown with expected, reported and the difference, and blocks completion", async () => {
  const order = gcashOrder({ payment_status: "discrepancy",
    payment_attempt: { outcome: "mismatch", expected_amount: 100, reported_amount: 90, discrepancy_amount: -10 } });
  const w = await pos([serveOrder(order)]);
  await w.openGcashModal(5, true);
  const text = w.document.body.textContent;
  assert.match(text, /AMOUNT DOES NOT MATCH/);
  assert.match(text, /₱100\.00/);
  assert.match(text, /₱90\.00/);
  assert.match(text, /-₱10\.00 \(short\)/);
  assert.equal(w.document.getElementById("checkout-confirm-btn"), null);
  w.close();
});

test("the manager review box appears for managers only", async () => {
  const order = gcashOrder({ payment_status: "discrepancy",
    payment_attempt: { outcome: "mismatch", expected_amount: 100, reported_amount: 90, discrepancy_amount: -10 } });
  const cashier = await pos([serveOrder(order)]);
  await cashier.openGcashModal(5);
  assert.equal(cashier.document.getElementById("gc-resolve-note"), null);
  cashier.close();
  const manager = await pos([serveOrder(order)], { role: "manager" });
  await manager.openGcashModal(5);
  assert.ok(manager.document.getElementById("gc-resolve-note"));
  manager.close();
});

test("submitting the verification sends only what the cashier typed", async () => {
  const order = gcashOrder();
  const w = await pos([(url) => url.endsWith("/payment/verify") ? json(200, { verified: true, payment_status: "verified" }) : null, serveOrder(order)]);
  await w.openGcashModal(5);
  w.document.getElementById("gc-amount").value = " 100.00 ";
  w.document.getElementById("gc-ref").value = "gc 1234 5678";
  await w.submitGcashVerification(5, false);
  const call = w.calls.find((c) => c.url.endsWith("/payment/verify"));
  assert.deepEqual(call.body, { amount_received: "100.00", reference_no: "gc 1234 5678" });
  w.close();
});

test("a duplicate-reference error from the server is shown in the dialog", async () => {
  const order = gcashOrder();
  const w = await pos([(url) => url.endsWith("/payment/verify") ? json(409, { detail: "This GCash reference number was already used to verify another order." }) : null, serveOrder(order)]);
  await w.openGcashModal(5);
  w.document.getElementById("gc-amount").value = "100";
  await w.submitGcashVerification(5, false);
  const box = w.document.getElementById("gc-error");
  assert.equal(box.style.display, "block");
  assert.match(box.textContent, /already used/);
  w.close();
});

test("the cart draft stores ids and quantities only", async () => {
  const w = await pos();
  w.addToCart(1, "Cake", 100);
  w.addToCart(1, "Cake", 100);
  w.addToCart(2, "Tea", 20);
  const raw = w.sessionStorage.getItem("pos_cart_draft_v1:7");
  assert.deepEqual(JSON.parse(raw), [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 1 }]);
  assert.ok(!/price|name|token|amount/i.test(raw));
  w.close();
});

test("a restored draft uses current server prices and drops retired items", async () => {
  const w = await pos([], {
    products: [{ id: 1, name: "Cake", sku: "CAKE", price: 120, is_active: true, category_id: null }],   // price changed, Tea retired
    draft: [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 1 }, { product_id: 1, quantity: "x" }],
  });
  const text = cartText(w);
  assert.match(text, /Cake/);
  assert.match(text, /₱240\.00/, "2 x the CURRENT price");
  assert.ok(!/Tea/.test(text));
  w.close();
});

test("a cleared cart leaves no draft", async () => {
  const w = await pos();
  w.addToCart(1, "Cake", 100);
  assert.ok(w.sessionStorage.getItem("pos_cart_draft_v1:7"));
  w.clearCart();
  assert.equal(w.sessionStorage.getItem("pos_cart_draft_v1:7"), null);
  w.close();
});

test("a loaded customer order locks the cart; replacing a non-empty cart asks first", async () => {
  const order = gcashOrder();
  const w = await pos();
  w.indexCustomerOrders([order]);
  w.addToCart(2, "Tea", 20);
  w.processOnlineOrder(5);
  assert.match(w.document.getElementById("modal-content").textContent, /Replace the current cart/);
  assert.equal(w.currentOnlineOrder, null, "nothing replaced yet");
  assert.match(cartText(w), /Tea/);
  w.document.getElementById("confirm-btn-action").onclick();
  await tick(w, 60);
  assert.equal(w.currentOnlineOrder.id, 5);
  assert.match(cartText(w), /Cake/);
  w.addToCart(2, "Tea", 20);
  assert.ok(!/Tea/.test(cartText(w)), "cannot add to a customer order's cart");
  assert.equal(w.sessionStorage.getItem("pos_cart_draft_v1:7"), null, "customer orders are never saved as drafts");
  w.close();
});

test("Clear All asks before discarding a non-empty cart", async () => {
  const w = await pos();
  w.addToCart(1, "Cake", 100);
  w.requestClearCart();
  assert.match(cartText(w), /Cake/);
  assert.match(w.document.getElementById("modal-content").textContent, /Clear this cart/);
  w.close();
});

for (const payload of PAYLOADS) {
  test("GCash dialog renders hostile order data as text: " + payload, async () => {
    const order = gcashOrder({ order_number: payload, customer_name: payload, table_number: payload,
      items: [{ name: payload, quantity: 1, price: 100, product_id: 1 }] });
    const w = await pos([serveOrder(order)]);
    await w.openGcashModal(5);
    const root = w.document;
    assert.equal(root.querySelectorAll("script, svg, img[onerror]").length, 0, "markup injected");
    assert.equal(w.__xss, 0, "payload executed");
    for (const el of root.querySelectorAll("[onclick]")) {
      assert.ok(!/__xss/.test(el.getAttribute("onclick")), "payload reached a handler");
    }
    assert.ok(root.body.textContent.includes(payload), "dialog rendered nothing (test would be vacuous)");
    w.close();
  });
}

// ---------------------------------------------------------------------- 2026-10-27: receipts and refunds
test("the receipt shows the lines and totals the server committed, not the current cart", async () => {
  const replay = (url, o) => (url.endsWith("/api/v1/transactions") && o.method === "POST")
    ? json(201, { id: 9, order_code: "TXN-0009", net_amount: 20, total_amount: 20, status: "completed", idempotent_replay: true,
        created_at: new Date().toISOString(), items: [{ product_id: 2, name: "Tea", quantity: 1, unit_price: 20, total_price: 20 }],
        payments: [{ payment_method: "CASH", amount: 20, status: "completed" }] })
    : null;
  const w = await pos([replay]);
  w.addToCart(1, "Cake", 100);                 // the browser cart differs from the sale that was already saved
  await w.openPaymentModal();
  w.document.getElementById("pay-tendered").value = "100";
  await w.submitCheckout();
  const r = w.lastCompletedOrder;
  assert.deepEqual(r.items.map((i) => [i.name, i.quantity, i.total_price]), [["Tea", 1, 20]]);
  assert.equal(r.net_amount, 20);
  assert.equal(r.change, 80);
  w.close();
});

test("a GCash receipt never shows change", async () => {
  const gcash = (url, o) => (url.endsWith("/api/v1/transactions") && o.method === "POST")
    ? json(201, { id: 9, order_code: "TXN-0009", net_amount: 100, total_amount: 100, status: "completed", created_at: new Date().toISOString(),
        items: [{ product_id: 1, name: "Cake", quantity: 1, unit_price: 100, total_price: 100 }],
        payments: [{ payment_method: "GCASH", amount: 100, status: "completed" }] })
    : null;
  const w = await pos([gcash]);
  w.addToCart(1, "Cake", 100);
  await w.openPaymentModal();
  w.document.getElementById("pay-method").value = "GCASH";
  w.onPayMethodChange(100);
  await w.submitCheckout();
  assert.equal(w.lastCompletedOrder.payment_method, "GCASH");
  assert.equal(w.lastCompletedOrder.change, 0);
  w.close();
});

test("refund state is shown on voided sales and only managers get the Record refund action", async () => {
  for (const [role, expectButton] of [["cashier", false], ["manager", true], ["admin", true]]) {
    const w = await pos([], { role });
    const pending = w.refundStatusHtml({ id: 3, refund_status: "pending" });
    assert.match(pending, /Refund pending/);
    assert.equal(/Record refund/.test(pending), expectButton, role);
    assert.match(w.refundStatusHtml({ id: 3, refund_status: "refunded" }), /Refunded/);
    assert.equal(w.refundStatusHtml({ id: 3, refund_status: null }), "");
    w.close();
  }
});

test("recording a refund sends only outcome, amount, method, reference and note", async () => {
  const w = await pos([(url, o) => url.endsWith("/api/v1/transactions/3/refund") ? json(200, { refund_status: "refunded" }) : null], { role: "manager" });
  w._recentTransactionsCache = [{ id: 3, net_amount: 100, refund_status: "pending", payments: [{ payment_method: "GCASH", amount: 100, status: "cancelled" }] }];
  w.promptRecordRefund(3);
  assert.equal(w.document.getElementById("refund-amount").value, "100.00");
  w.document.getElementById("refund-reference").value = "9012 345";
  w.document.getElementById("refund-note").value = "Sent back from store GCash";
  await w.submitRecordRefund(3);
  const call = w.calls.find((c) => c.url.endsWith("/refund"));
  assert.deepEqual(call.body, { outcome: "refunded", note: "Sent back from store GCash", amount: "100.00", refund_method: "GCASH", reference_no: "9012 345" });
  w.close();
});

test("a server refusal of the refund is shown in the dialog", async () => {
  const w = await pos([(url) => url.endsWith("/refund") ? json(400, { detail: "A refund must be the full amount collected" }) : null], { role: "manager" });
  w._recentTransactionsCache = [{ id: 3, payments: [{ payment_method: "CASH", amount: 100 }] }];
  w.promptRecordRefund(3);
  w.document.getElementById("refund-note").value = "Handed back";
  await w.submitRecordRefund(3);
  assert.match(w.document.getElementById("refund-error").textContent, /full amount collected/);
  w.close();
});
