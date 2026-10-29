// Every front-end script must parse (2026-10-29). purchase_orders.js and suppliers.js once shipped with escaped
// backticks and failed to load in the browser. This only PARSES each file with node:vm; nothing is executed.
// XSS_STATIC points the check at another static directory (as harness.js does), e.g. to prove it can fail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = process.env.XSS_STATIC || path.resolve(__dirname, "..", "..", "static");
const DIRS = ["assets/js", "js"];

const files = DIRS.flatMap((dir) => {
  const abs = path.join(STATIC, dir);
  return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => f.endsWith(".js")).map((f) => path.join(abs, f)) : [];
});

test("there are front-end scripts to check", () => {
  assert.ok(files.length > 0, `no .js files found under ${STATIC}`);
});

for (const file of files) {
  const name = path.relative(STATIC, file).split(path.sep).join("/");
  test(`parses: ${name}`, () => {
    try {
      new vm.Script(fs.readFileSync(file, "utf8"), { filename: name });
    } catch (e) {
      assert.fail(`${name} does not parse: ${e.message}`);
    }
  });
}
