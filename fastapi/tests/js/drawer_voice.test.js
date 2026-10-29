// Cash Drawer view gate and voice ordering (2026-10-28). Runs the real views.js in jsdom with a scripted
// fetch and a FAKE SpeechRecognition. This proves the page's own logic (state, cart, messages, cleanup);
// it does NOT prove real microphone access, browser permission prompts or speech-recognition accuracy.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

const SCRIPTS = ["js/storage.js", "assets/js/utils.js", "assets/js/auth.js", "assets/js/permissions.js", "assets/js/views.js"];
const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });

const PRODUCTS = [
  { id: 1, name: "Coke Zero", sku: "CK-ZERO", price: 30, is_active: true, category_id: null },
  { id: 2, name: "Coke Light", sku: "CK-LIGHT", price: 35, is_active: true, category_id: null },
  { id: 3, name: "Burger Steak", sku: "BST-01", price: 120, is_active: true, category_id: null },
  { id: 4, name: "Old Pancit", sku: "OLD-9", price: 50, is_active: false, category_id: null },
];
const DRAWER = { total_cash_in_drawers: 100, shifts: [
  { id: 1, cashier_id: 7, cashier_username: "cash", cashier_name: "Me", role: "cashier", status: "open", start_cash: 0, expected_cash: 100,
    cash_sales: 100, non_cash_sales: 0, total_sales: 100, paid_in: 0, paid_out: 0, movements: [] }] };

async function page(role = "cashier", userId = 7) {
  const w = load(SCRIPTS);
  w.calls = [];
  w.toasts = [];
  w.fetch = async (url, options = {}) => {
    url = String(url);
    w.calls.push({ url, method: options.method || "GET" });
    if (url.endsWith("/api/v1/products")) return json(200, PRODUCTS);
    if (url.endsWith("/api/v1/categories")) return json(200, []);
    if (url.includes("/shifts/drawer-summary")) return json(200, DRAWER);
    if (url.includes("/customer-orders/pending")) return json(200, []);
    return json(200, {});
  };
  w.localStorage.setItem("RESTOTRACK_USER", JSON.stringify({ id: userId, username: "user" + userId, role }));
  w.localStorage.setItem("role", role);
  w.document.body.innerHTML = '<aside class="sidebar"></aside><span id="current-page-title"></span><div id="view-container"></div>';
  w.Utils.showToast = (message, type) => w.toasts.push({ message: String(message), type });
  // Fake recogniser: records start/stop/abort; the test fires its events by hand.
  w.recognisers = [];
  w.SpeechRecognition = function () {
    this.starts = 0; this.aborts = 0; this.stops = 0;
    this.start = () => { this.starts++; };
    this.stop = () => { this.stops++; };
    this.abort = () => { this.aborts++; };
    w.recognisers.push(this);
  };
  return w;
}

const view = (w) => w.document.getElementById("view-container");
async function openPos(w) {
  await w.renderView("pos", view(w));
  await tick(w);
}
const cart = (w) => (w.document.getElementById("cart-items-container") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim();
const listening = (w) => w.isVoiceListening === true && /RECORDING/.test(w.document.getElementById("pos-voice-btn-text").textContent);
function speech(transcript, isFinal) {
  const alternative = [{ transcript }];
  alternative.isFinal = isFinal;
  return { resultIndex: 0, results: [alternative] };
}
function startVoice(w) {
  w.startVoiceRecordingDirect();
  return w.recognisers[w.recognisers.length - 1];
}
const sales = (w) => w.calls.filter((c) => c.url.endsWith("/api/v1/transactions") && c.method === "POST");

// ------------------------------------------------------------------------------------------ Cash Drawer gate
test("the Cash Drawer menu item exists for managers/admins only", async () => {
  const w = await page();
  assert.equal(w.ROLE_NAV_CONFIG.cashier.some((i) => i.id === "cash_drawer"), false);
  assert.equal(w.ROLE_NAV_CONFIG.manager.some((i) => i.id === "cash_drawer"), true);
  assert.equal(w.ROLE_NAV_CONFIG.admin.some((i) => i.id === "cash_drawer"), true);
  w.close();
});

test("a cashier opening #cash_drawer directly gets the POS, not the manager screen", async () => {
  const w = await page("cashier");
  await w.renderView("cash_drawer", view(w));
  await tick(w);
  assert.doesNotMatch(view(w).textContent, /Edit Drawer|Cashier Drawer to Track/);
  assert.ok(w.document.getElementById("cart-items-container"), "fell back to the cashier's own POS screen");
  assert.equal(w.location.hash, "#pos");
  assert.equal(w.sessionStorage.getItem("active_feature"), "pos");
  assert.ok(w.toasts.some((t) => /managers and admins only/.test(t.message)));
  w.close();
});

for (const role of ["manager", "admin", "super_admin"]) {
  test(`${role} can still open the Cash Drawer`, async () => {
    const w = await page(role);
    await w.renderView("cash_drawer", view(w));
    await tick(w);
    assert.match(view(w).textContent, /Cash Drawer/);
    assert.match(view(w).textContent, /Edit Drawer/);
    w.close();
  });
}

test("a missing or unknown role fails closed", async () => {
  const w = await page("");
  w.localStorage.removeItem("RESTOTRACK_USER");
  await w.renderView("cash_drawer", view(w));
  await tick(w);
  assert.doesNotMatch(view(w).textContent, /Edit Drawer/);
  w.close();
});

test("the POS header shows only the user's own drawer, never another open shift", async () => {
  const w = await page("manager", 8);                           // a manager using the POS has no shift of their own here
  await openPos(w);
  assert.equal(w.document.getElementById("pos-cash-in-drawer-display").textContent.replace(/\s/g, ""), "₱0.00");
  w.close();
  const c = await page("cashier");
  await openPos(c);
  assert.equal(c.document.getElementById("pos-cash-in-drawer-display").textContent.replace(/\s/g, ""), "₱100.00");
  c.close();
});

// ------------------------------------------------------------------------------------------ voice: errors
const TERMINAL = {
  "not-allowed": /Microphone access is blocked/,
  "service-not-allowed": /not available in this browser/,
  "audio-capture": /No microphone was found/,
  "network": /internet connection/,
  "language-not-supported": /cannot recognise Filipino/,
  "aborted": null,
  "something-new": /stopped unexpectedly/,
};
for (const [code, message] of Object.entries(TERMINAL)) {
  test(`recognition error '${code}' ends the session once, with no restart loop`, async () => {
    const w = await page();
    await openPos(w);
    const rec = startVoice(w);
    assert.ok(listening(w));
    rec.onerror && rec.onerror({ error: code });
    rec.onend && rec.onend();                                     // browsers fire onend after onerror
    assert.equal(w.isVoiceListening, false);
    assert.equal(w.document.getElementById("pos-voice-btn-text").textContent, "VOICE ORDER");
    assert.equal(w.document.getElementById("pos-voice-live-strip").style.display, "none");
    assert.equal(rec.starts, 1, "never restarted");
    const shown = w.toasts.filter((t) => t.type === "warning");
    if (message) {
      assert.equal(shown.length, 1, "exactly one message");
      assert.match(shown[0].message, message);
    } else {
      assert.equal(shown.length, 0);
    }
    w.close();
  });
}

test("no-speech keeps listening a few times, then stops with a message instead of looping", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  for (let i = 0; i < 10; i++) {
    if (!rec.onerror) break;
    rec.onerror({ error: "no-speech" });
    rec.onend();
  }
  assert.equal(rec.starts, 1 + 3, "three silent restarts, then it stops");
  assert.equal(w.isVoiceListening, false);
  assert.equal(w.toasts.filter((t) => /no speech was heard/.test(t.message)).length, 1);
  w.close();
});

test("an insecure page explains HTTPS instead of claiming the microphone was denied", async () => {
  const w = await page();
  await openPos(w);
  Object.defineProperty(w, "isSecureContext", { value: false, configurable: true });
  w.startVoiceRecordingDirect();
  assert.equal(w.recognisers.length, 0);
  assert.equal(w.isVoiceListening, false);
  assert.match(w.toasts[0].message, /secure address \(https:\/\//);
  w.close();
});

test("an unsupported browser is told so and nothing starts", async () => {
  const w = await page();
  await openPos(w);
  w.SpeechRecognition = undefined;
  w.webkitSpeechRecognition = undefined;
  w.startVoiceRecordingDirect();
  assert.equal(w.isVoiceListening, false);
  assert.match(w.toasts[0].message, /not supported/);
  w.close();
});

test("repeated taps on VOICE ORDER start one recogniser, not several", async () => {
  const w = await page();
  await openPos(w);
  w.startVoiceRecordingDirect();
  w.startVoiceRecordingDirect();
  assert.equal(w.recognisers.length, 1);
  w.close();
});

// ------------------------------------------------------------------------------------------ voice: lifecycle
test("pressing Stop never adds interim (unfinished) speech to the cart", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("coke zero", false));
  assert.match(w.document.getElementById("pos-voice-transcript-text").textContent, /not added yet/);
  w.stopVoiceRecordingDirect();
  assert.match(cart(w), /cart is empty/i);
  assert.equal(rec.aborts, 1);
  w.close();
});

test("leaving the POS stops recognition and late results cannot change the hidden cart", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  const onresult = rec.onresult;
  await w.renderView("transactions", view(w));
  await tick(w);
  assert.equal(w.isVoiceListening, false);
  assert.equal(rec.aborts, 1, "the recogniser was released");
  onresult.call(rec, speech("coke zero", true));               // a result that was already in flight
  await openPos(w);
  assert.match(cart(w), /cart is empty/i);
  w.close();
});

test("a final result from an older, replaced session is ignored", async () => {
  const w = await page();
  await openPos(w);
  const first = startVoice(w);
  const stale = first.onresult;
  w.stopVoiceRecordingDirect();
  startVoice(w);
  stale.call(first, speech("coke zero", true));
  assert.match(cart(w), /cart is empty/i);
  w.close();
});

test("leaving the page (logout, reload) releases the microphone", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  w.dispatchEvent(new w.Event("pagehide"));
  assert.equal(w.isVoiceListening, false);
  assert.equal(rec.aborts, 1);
  w.close();
});

// ------------------------------------------------------------------------------------------ voice: matching
test("an exact name is added directly from a final result, once even if delivered twice", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("two burger steak", true));
  rec.onresult(speech("two burger steak", true));
  assert.match(cart(w), /Burger Steak/);
  assert.match(cart(w), /₱240\.00/);
  w.close();
});

test("'coke zero' is ambiguous because the existing phonetic step reads 'zero' as 0 (no silent first pick)", async () => {
  const w = await page();
  assert.equal(w.matchVoiceProductDetailed("coke 0", PRODUCTS).confidence, "ambiguous");
  w.close();
});

test("an ambiguous word asks the cashier to choose and adds nothing until they do", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("coke", true));
  assert.match(cart(w), /cart is empty/i);
  const options = [...w.document.querySelectorAll("[data-voice-choice]")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(options.length, 2);
  assert.ok(options.some((o) => /Coke Zero/.test(o)) && options.some((o) => /Coke Light/.test(o)));
  w.confirmVoiceChoice(2);
  assert.match(cart(w), /Coke Light/);
  assert.doesNotMatch(cart(w), /Coke Zero/);
  w.close();
});

test("a fuzzy (low-confidence) match is only offered for confirmation", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("burgir steek", true));
  assert.match(cart(w), /cart is empty/i);
  assert.match(w.document.body.textContent, /Confirm voice item/);
  w.cancelVoiceChoice();
  assert.match(cart(w), /cart is empty/i);
  w.close();
});

test("inactive products and unknown words are never matched", async () => {
  const w = await page();
  await openPos(w);
  assert.equal(w.matchVoiceProductDetailed("old pancit", PRODUCTS).confidence, "none");
  const rec = startVoice(w);
  rec.onresult(speech("unicorn milkshake", true));
  assert.match(cart(w), /cart is empty/i);
  assert.match(w.document.getElementById("pos-voice-transcript-text").textContent, /Item not found/);
  w.close();
});

test("quantities above 100 are rejected, per utterance and for the resulting cart line", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  // The parser only reads 1-2 digit quantities, so one utterance cannot exceed 99; the guard is still checked.
  assert.equal(w.validVoiceQty(150), false);
  assert.equal(w.validVoiceQty(0), false);
  assert.equal(w.validVoiceQty(2.5), false);
  assert.equal(w.validVoiceQty(100), true);
  rec.onresult(speech("60 burger steak", true));
  w.voiceSessionCommitted.clear();
  rec.onresult(speech("60 burger steak", true));                  // would make 120 on the line
  assert.match(cart(w), /₱7,200\.00/);                            // still 60 x 120
  assert.match(w.document.getElementById("pos-voice-transcript-text").textContent, /maximum 100 per item/);
  w.close();
});

test("a locked customer-order cart is never changed by voice, including through a choice", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("coke", true));                              // choice dialog opens while the cart is free
  w.currentOnlineOrder = { id: 5, order_number: "CUST-1", payment_method: "PAY_AT_COUNTER", items: [] };
  w.confirmVoiceChoice(1);
  rec.onresult(speech("burger steak", true));
  assert.equal(w.document.querySelectorAll("#cart-items-container .cart-item, #cart-items-container [data-product-id]").length, 0);
  assert.doesNotMatch(cart(w), /Coke|Burger/);
  w.close();
});

test("voice never submits a sale or opens checkout", async () => {
  const w = await page();
  await openPos(w);
  const rec = startVoice(w);
  rec.onresult(speech("one burger steak", true));
  rec.onresult(speech("checkout", true));
  rec.onresult(speech("confirm and complete sale", true));
  await tick(w);
  assert.match(cart(w), /Burger Steak/);
  assert.equal(sales(w).length, 0);
  assert.equal(w.document.getElementById("checkout-confirm-btn"), null);
  w.close();
});
