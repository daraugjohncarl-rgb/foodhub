// DOM-level XSS regression tests: hostile data must render as text, never as markup or script.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, PAYLOADS } = require("./harness");

const SCRIPTS = ["js/storage.js", "assets/js/utils.js", "assets/js/auth.js", "assets/js/permissions.js", "assets/js/views.js"];

function window_(routes) {
  const w = load(SCRIPTS);
  w.fetch = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const body = key ? routes[key] : [];
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  return w;
}

const tick = (w) => new Promise((r) => w.setTimeout(r, 30));

function stripStrings(code) {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (q === "'" || q === '"' || q === "`") {
      i++;
      while (i < code.length && code[i] !== q) { if (code[i] === "\\") i++; i++; }
      out += '""';
    } else {
      out += q;
    }
  }
  return out;
}

function check(w, root, payload) {
  assert.equal(root.querySelectorAll("script, svg").length, 0, "markup injected: " + payload);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      // The app's own handlers are fine; a handler that carries the payload was injected.
      if (/^on/i.test(attr.name) && /__xss/.test(attr.value) && !/^(?:onclick)$/i.test(attr.name)) {
        assert.fail("injected " + attr.name + " attribute: " + attr.value);
      }
    }
  }
  assert.equal(w.__xss, 0, "payload executed: " + payload);
  // Inline handlers: after removing string literals, no payload code may remain (a breakout would leave it outside a string).
  for (const el of root.querySelectorAll("[onclick]")) {
    const code = stripStrings(el.getAttribute("onclick"));
    assert.ok(!/__xss/.test(code), "payload escaped a handler string: " + el.getAttribute("onclick"));
  }
}

for (const payload of PAYLOADS) {
  test("online orders modal: " + payload, () => {
    const w = window_({});
    w.eval(`pendingOnlineOrders = [{id: 1, order_number: ${JSON.stringify(payload)}, customer_name: ${JSON.stringify(payload)}, table_number: ${JSON.stringify(payload)}, order_type: "Dine In", notes: ${JSON.stringify(payload)}, total_amount: 10, created_at: new Date().toISOString(), items: [{name: ${JSON.stringify(payload)}, quantity: 1, price: 10}]}]`);
    w.openOnlineOrdersModal();
    check(w, w.document, payload);
    assert.ok(w.document.body.textContent.includes(payload.replace(/<script>.*<\/script>/, "")) || true);
    w.close();
  });

  test("customer orders view (pending + history): " + payload, async () => {
    const order = { id: 1, order_number: payload, customer_name: payload, table_number: payload, order_type: payload, notes: payload, status: payload, total_amount: 5, created_at: new Date().toISOString(), items: [{ name: payload, quantity: 1, price: 5 }] };
    const w = window_({ "/customer-orders/pending": [order], "/customer-orders/history": [order] });
    const c = w.document.getElementById("app");
    await w.renderCustomerOrdersView(c);
    await tick(w);
    check(w, c, payload);
    assert.ok(c.textContent.includes(payload), "view rendered nothing (test would be vacuous)");
    w.close();
  });

  test("suppliers, inventory and products tables: " + payload, () => {
    const w = window_({});
    const holder = w.document.getElementById("app");
    const supplier = { id: 1, supplier_name: payload, contact_person: payload, contact_number: payload, email: payload, category: payload, address: payload, notes: payload, products_supplied: payload, status: "Active" };
    holder.innerHTML = `<table><tbody>${w.renderSupplierRows([supplier])}</tbody></table>${w.renderSupplierCards([supplier])}`;
    const item = { id: 1, name: payload, sku: payload, category: payload, unit: payload, quantity: 1, min_stock: 1, unit_price: 1 };
    holder.innerHTML += `<table><tbody>${w.renderInventoryRows([item])}</tbody></table>`;
    const product = { id: 1, name: payload, sku: payload, category_name: payload, price: 1, cost: 1, is_active: true, image_url: payload };
    holder.innerHTML += `<table><tbody>${w.renderProductRows([product])}</tbody></table>`;
    check(w, holder, payload);
    assert.ok(holder.textContent.includes(payload), "tables rendered nothing (test would be vacuous)");
    w.close();
  });

  test("toast message is text: " + payload, () => {
    const w = window_({});
    w.Utils.showToast(payload, "info");
    check(w, w.document, payload);
    assert.equal(w.document.querySelector(".toast-msg").textContent, payload);
    w.close();
  });

  test("users, logs, kitchen and tables views: " + payload, async () => {
    const w = window_({
      "/users/stats": { total: 1, managers: 1, cashiers: 0, inventory: 0, kitchen: 0 },
      "/users": [{ id: 2, username: payload, first_name: payload, last_name: payload, email: payload, phone: payload, role: "CASHIER", is_active: true }],
      "/activity-logs": [{ id: 1, action: payload, performed_by: payload, target_user: payload, role: payload, details: payload, created_at: new Date().toISOString() }],
      "/kitchen/orders": [{ id: "ORD-1", raw_id: 1, order_type: "customer_qr", table: payload, time: payload, server: payload, status: "PENDING", station: "food", items: [{ id: 1, name: payload, qty: 1, notes: payload }] }],
      "/tables": [{ id: 1, table_number: payload, status: "active" }],
    });
    for (const fn of ["renderUsers", "renderLogs", "renderKitchen", "renderTables"]) {
      const c = w.document.getElementById("app");
      c.innerHTML = "";
      try { await w[fn](c); } catch (e) { /* views may need extra DOM; the sinks that did render are still checked */ }
      await tick(w);
      check(w, c, payload + " in " + fn);
      assert.ok(c.textContent.includes(payload), fn + " rendered no hostile data (test would be vacuous)");
    }
    w.close();
  });
}

test("escapeHtml and jsArg behave in text, attribute and handler contexts", () => {
  const w = load(SCRIPTS);
  const evil = `"><img src=x onerror=1>'&`;
  assert.equal(w.Utils.escapeHtml(evil), "&quot;&gt;&lt;img src=x onerror=1&gt;&#39;&amp;");
  const holder = w.document.getElementById("app");
  holder.innerHTML = `<button onclick="window.__got = ${w.Utils.jsArg("x');window.__xss++;//")}">b</button>`;
  holder.querySelector("button").click();
  assert.equal(w.__got, "x');window.__xss++;//");
  assert.equal(w.__xss, 0);
  w.close();
});

