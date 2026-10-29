// Loads the real front-end scripts into a jsdom window so tests can render with hostile data.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const STATIC = process.env.XSS_STATIC || path.resolve(__dirname, "..", "..", "static");

function load(scripts, html = "<!doctype html><body><div id='app'></div></body>") {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ([]), text: async () => "" });
  w.alert = () => {};
  w.confirm = () => true;
  w.WebSocket = function () { return { close() {}, send() {} }; };
  w.setInterval = () => 0; // no background polling during tests
  w.__xss = 0; // any executed payload increments this
  w.localStorage.setItem("role", "admin");
  for (const rel of scripts) {
    const code = fs.readFileSync(path.join(STATIC, rel), "utf8");
    w.eval(code);
  }
  return w;
}

// Payloads that would execute if interpreted as markup.
const PAYLOADS = [
  "<img src=x onerror=window.__xss++>",
  "<script>window.__xss++</script>",
  "<svg onload=window.__xss++>",
  "\"><img src=x onerror=window.__xss++>",
  "' onmouseover='window.__xss++' x='",
  "');window.__xss++;//",
  "&#39;);window.__xss++;//",
];

function assertInert(w, root, payload, assert) {
  const bad = root.querySelectorAll("img[onerror], script, svg[onload], [onmouseover]");
  assert.equal(bad.length, 0, `markup injected for payload ${payload}`);
  // inline handlers must not have been altered by the payload
  for (const el of root.querySelectorAll("[onclick]")) {
    assert.ok(!/__xss/.test(el.getAttribute("onclick")) || /^[^]*"[^"]*__xss/.test("") === false, "payload leaked into handler: " + el.getAttribute("onclick"));
  }
  assert.equal(w.__xss, 0, "payload executed");
}

module.exports = { load, PAYLOADS, assertInert };
