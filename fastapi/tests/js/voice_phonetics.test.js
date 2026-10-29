const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./harness");

const SCRIPTS = ["js/storage.js", "assets/js/utils.js", "assets/js/auth.js", "assets/js/permissions.js", "assets/js/views.js"];

// Full active menu items as seen on the POS terminal
const MENU_PRODUCTS = [
  { id: 1, name: "Arrozcaldo", sku: "A1", price: 55, is_active: true },
  { id: 2, name: "Burger Solo", sku: "BS-109", price: 99, is_active: true },
  { id: 3, name: "Burger With Fries", sku: "BWF-110", price: 99, is_active: true },
  { id: 4, name: "Carbonara With Bread", sku: "CWB-111", price: 99, is_active: true },
  { id: 5, name: "Molo", sku: "MOL-112", price: 99, is_active: true },
  { id: 6, name: "Nachofries", sku: "NAC-113", price: 99, is_active: true },
  { id: 7, name: "Nachos", sku: "NAC-114", price: 99, is_active: true },
  { id: 8, name: "Pancit Canton With Toasted Bread", sku: "PCW-115", price: 99, is_active: true },
  { id: 9, name: "Pancit Canton", sku: "PC-116", price: 99, is_active: true },
  { id: 10, name: "Sotanghon Guisado", sku: "SG-117", price: 99, is_active: true },
  { id: 11, name: "Sotanghon Lumpia", sku: "SL-118", price: 99, is_active: true },
  { id: 12, name: "Sotanghon With Toasted Bread", sku: "SWT-119", price: 99, is_active: true },
  { id: 13, name: "Spaghetti With Bread", sku: "SWB-120", price: 99, is_active: true },
  { id: 14, name: "Spaghetti With Burger", sku: "SWB-102", price: 99, is_active: true },
  { id: 15, name: "Toasted Bread", sku: "TB-104", price: 99, is_active: true },
  { id: 16, name: "Caramel Macchiato", sku: "CM-121", price: 99, is_active: true },
  { id: 17, name: "Coffee Jelly", sku: "CJ-122", price: 99, is_active: true },
  { id: 18, name: "Dirty Matcha", sku: "DM-123", price: 99, is_active: true },
  { id: 19, name: "French Vanilla", sku: "FV-124", price: 99, is_active: true },
  { id: 20, name: "Iced Americano", sku: "IA-125", price: 99, is_active: true },
  { id: 21, name: "Iced Coffee", sku: "IC-126", price: 99, is_active: true },
  { id: 22, name: "Matcha Milk", sku: "MM-127", price: 99, is_active: true },
  { id: 23, name: "Salted Caramel", sku: "SC-128", price: 99, is_active: true },
  { id: 24, name: "Spanish Latte", sku: "SL-129", price: 99, is_active: true },
  { id: 25, name: "Vietnamese Coffee", sku: "VC-130", price: 99, is_active: true },
  { id: 26, name: "Inactive Coffee", sku: "OLD-999", price: 50, is_active: false }
];

test("voice phonetic letter pronunciation to product code matching", () => {
  const w = load(SCRIPTS);

  // 1. Spoken 'see 122' means Coffee Jelly (CJ-122)
  const res1 = w.parseFullVoiceOrder("see 122", MENU_PRODUCTS);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].qty, 1);
  assert.ok(res1[0].product, "found product for 'see 122'");
  assert.equal(res1[0].product.sku, "CJ-122");

  // 2. Spoken 'see jay 122' means Coffee Jelly (CJ-122)
  const res2 = w.parseFullVoiceOrder("see jay 122", MENU_PRODUCTS);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].product.sku, "CJ-122");

  // 3. Spoken with quantity: 'two see 122' -> 2 x Coffee Jelly
  const res3 = w.parseFullVoiceOrder("two see 122", MENU_PRODUCTS);
  assert.equal(res3.length, 1);
  assert.equal(res3[0].qty, 2);
  assert.equal(res3[0].product.sku, "CJ-122");

  // 4. Tagalog quantity: 'dalawang see jay 122' -> 2 x Coffee Jelly
  const res4 = w.parseFullVoiceOrder("dalawang see jay 122", MENU_PRODUCTS);
  assert.equal(res4.length, 1);
  assert.equal(res4[0].qty, 2);
  assert.equal(res4[0].product.sku, "CJ-122");

  // 5. 'see em 121' -> Caramel Macchiato (CM-121)
  const res5 = w.parseFullVoiceOrder("see em 121", MENU_PRODUCTS);
  assert.equal(res5.length, 1);
  assert.equal(res5[0].product.sku, "CM-121");

  // 6. 'see double u bee 111' -> Carbonara With Bread (CWB-111)
  const res6 = w.parseFullVoiceOrder("see double u bee 111", MENU_PRODUCTS);
  assert.equal(res6.length, 1);
  assert.equal(res6[0].product.sku, "CWB-111");

  // 7. 'bee es 109' -> Burger Solo (BS-109)
  const res7 = w.parseFullVoiceOrder("bee es 109", MENU_PRODUCTS);
  assert.equal(res7.length, 1);
  assert.equal(res7[0].product.sku, "BS-109");

  // 8. 'pee see 116' -> Pancit Canton (PC-116)
  const res8 = w.parseFullVoiceOrder("pee see 116", MENU_PRODUCTS);
  assert.equal(res8.length, 1);
  assert.equal(res8[0].product.sku, "PC-116");

  // 9. 'es see 128' -> Salted Caramel (SC-128)
  const res9 = w.parseFullVoiceOrder("es see 128", MENU_PRODUCTS);
  assert.equal(res9.length, 1);
  assert.equal(res9[0].product.sku, "SC-128");

  // 10. 'eye see 126' -> Iced Coffee (IC-126)
  const res10 = w.parseFullVoiceOrder("eye see 126", MENU_PRODUCTS);
  assert.equal(res10.length, 1);
  assert.equal(res10[0].product.sku, "IC-126");

  // 11. 'vee see 130' -> Vietnamese Coffee (VC-130)
  const res11 = w.parseFullVoiceOrder("vee see 130", MENU_PRODUCTS);
  assert.equal(res11.length, 1);
  assert.equal(res11[0].product.sku, "VC-130");

  // 12. 'tee bee 104' -> Toasted Bread (TB-104)
  const res12 = w.parseFullVoiceOrder("tee bee 104", MENU_PRODUCTS);
  assert.equal(res12.length, 1);
  assert.equal(res12[0].product.sku, "TB-104");

  // 13. 'ay 1' -> Arrozcaldo (A1)
  const res13 = w.parseFullVoiceOrder("ay 1", MENU_PRODUCTS);
  assert.equal(res13.length, 1);
  assert.equal(res13[0].product.sku, "A1");

  // 14. Non-code words are NOT corrupted:
  // 'two burger steak' should not mangle burger or steak
  const nonCode = w.normalizeVoicePhonetics("two burger steak");
  assert.match(nonCode, /burger/);

  // 'carbonara with bread' should remain Carbonara With Bread
  const resName = w.parseFullVoiceOrder("carbonara with bread", MENU_PRODUCTS);
  assert.equal(resName.length, 1);
  assert.equal(resName[0].product.sku, "CWB-111");

  w.close();
});
