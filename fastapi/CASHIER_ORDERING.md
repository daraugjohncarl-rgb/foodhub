# Cashier Ordering System

How a cashier takes an order, charges it, verifies a customer's GCash payment, and follows it through the kitchen/drinks stations, as the code works today. Updated 2026-10-24 for the idempotent checkout, one-sale-per-online-order processing and manual GCash verification; updated 2026-10-27 for strict money/payment-line validation, explicit cash classification, the void + manual refund workflow, one locked status path for customer orders, kitchen limits on POS sales, order reconciliation and (switched off) recipe-based stock deduction (section 7a).

**Source files**

| Layer | File |
|---|---|
| Cashier page shell / role guard | `static/cashier.html`, `static/assets/js/cashier.js` |
| POS, cart, checkout, GCash dialog, online orders, Today's Orders UI | `static/assets/js/views.js` |
| Customer QR page (payment choice) | `static/customer.html`, `static/assets/js/customer.js` |
| Sidebar menu per role | `static/assets/js/permissions.js` (`ROLE_NAV_CONFIG.cashier`) |
| Sale API (idempotency, order settlement) | `app/routers/transactions.py` |
| Customer orders API, GCash verification | `app/routers/customer_orders.py` |
| Payment rules (amount parsing, reference normalisation, states, fingerprint, cash classification) | `app/services/payments.py` |
| Recipe stock deduction / restoration (off unless `INVENTORY_DEDUCTION=on_sale`) | `app/services/stock.py` |
| Void + manual refund API | `app/routers/transactions.py` (`PUT /{id}/status`, `POST /{id}/refund`) |
| Repair of half-finished online orders | `scripts/reconcile_customer_orders.py` (dry run by default) |
| Food/drinks station routing and APIs | `app/routers/kitchen.py` |
| Shift / cash drawer API | `app/routers/shifts.py` |
| Access guard | `app/core/dependencies.py` (`require_pos_access`, `require_manager_or_admin`) |
| Schema (PostgreSQL) | `supabase/migrations/20261024000001_manual_gcash_verification.sql`, `supabase/migrations/20261027000001_void_refund_and_stock_ledger.sql` |

> The JS exists twice: `static/assets/js/` (canonical for the role dashboards) and `static/js/` (loaded by `customer.html`). They are byte-identical copies; edit one and copy it to the other. The legacy root-level `app/` and `static/` folders are not the deployed tree.

---

## 1. Access and navigation

- Roles allowed on the cashier page: `cashier`, `manager`, `admin`, `super_admin`.
- POS APIs use `require_pos_access`: ADMIN, SUPER_ADMIN, MANAGER, CASHIER. Resolving a payment discrepancy and reading the verification audit trail use `require_manager_or_admin`.
- Sidebar for a cashier: Point of Sale, Drinks Orders, Customer Orders, Today's Orders.

---

## 2. POS screen

`renderPOS` loads products, categories and the drawer summary. Menu grid with search and category pills on the left; **Current Cart** on the right.

**Cart rules (client side)**

- Tapping a product adds 1; max 100 of one item per order (the server limit).
- **Clear All** asks for confirmation when the cart has items.
- The cart is saved as a **draft** in `sessionStorage` (per user, per tab): product ids and quantities only. After a reload the draft is rebuilt from the *current* catalogue (current names/prices; retired or inactive items are dropped and the cashier is told). No tokens, prices or payment data are stored. Logging out clears it.
- A cart that holds a **customer order** is locked (no add/remove/quantity change) and is never saved as a draft.

Voice ordering (browser Web Speech API, `fil-PH`; updated 2026-10-28) respects the customer-order lock and never opens checkout:

- Only **final** recognition results are matched; interim words are shown as "(not added yet)" and are discarded when Stop is pressed.
- An exact SKU/POS code/name, or one product clearly containing the words, is added directly. Several equally good matches (e.g. "coke" with Coke Zero and Coke Light) open a **choice dialog**; partial-word and fuzzy matches open a **confirmation**. Nothing is added until the cashier taps an item.
- Quantities must be 1 to 100 per line, including what is already in the cart; anything else is refused with a message.
- Each error code (`not-allowed`, `service-not-allowed`, `audio-capture`, `network`, `language-not-supported`, `aborted`) ends the session with one plain message; `no-speech` restarts at most 3 times. An `http://` address other than localhost is reported as needing HTTPS (the browser blocks the microphone there).
- Leaving the POS, logging out or reloading stops recognition; late results from a stopped session are ignored and can never change a hidden cart.
- Known limitation (unchanged): the phonetic step reads "zero" as 0, so "coke zero" is treated as ambiguous and the cashier picks the item.

---

## 3. Checkout and duplicate-sale protection

### Browser

`submitCheckout` (views.js):

1. Ignores a second tap while a request is in flight; the confirm button is disabled and shows "Processing...".
2. Validates tendered cash locally. A non-cash payment must equal the amount due.
3. **Idempotency key.** `posCheckout.key` is a UUID created for the first attempt of a checkout. It is **reused** when the same checkout is retried (network failure, timeout, double tap, reopening the dialog) and **replaced** when the cart contents, the payment method or the loaded customer order change, or after a successful sale.
4. Sends `client_tx_id` with the request. Errors from the server are shown inside the dialog (not only in the console). If there is no answer at all the dialog says the sale may or may not have been saved and that pressing Confirm again is safe.

### Server: `POST /api/v1/transactions`

| Rule | Behaviour |
|---|---|
| Items | 1 to 100 lines; quantity 1 to 100 per line |
| Money | `Decimal`, 0 to 99,999,999.99. Tax, discount, tendered and payment-line amounts with **more than 2 decimals are rejected (400), never rounded**; NaN/Infinity/negative/boolean are 400 |
| Payment method | `CASH`, `GCASH` or `CARD` (any case/spacing; stored upper-case). Anything else is 400, so a new method name can never silently fall outside the drawer rules |
| Payment lines | An explicit `payments` list records applied amounts, so the lines must add up to **exactly** the amount due (previously more was accepted and inflated drawer/income figures). The cashier UI sends one method + `amount_paid` and never uses the list |
| Pricing | Always the tenant's catalogue price (or, for an online order, the price stored when the customer placed it) |
| Idempotency | `UNIQUE (tenant_id, client_tx_id)`. A repeat returns the original result with `idempotent_replay: true`; no new rows, audit entries or real-time events |
| Payload check | The sale stores a SHA-256 fingerprint of items (merged per product and sorted, so line order and split duplicate lines do not matter), tax, discount, status, payment methods, the customer order and, for an explicit `payments` list, each line's method and amount. Reusing a key with a **different** checkout returns **409**. Tendered cash on a single-method sale is excluded, so fixing the tendered amount on a retry is still the same checkout. Sales from before this change have no fingerprint and just replay |
| Response | The sale (and every replay) returns the committed `items` and `payments`; the receipt is printed from these, not from the browser cart |
| Concurrency | Concurrent identical requests hit the unique constraint; the loser rolls back and returns the winner's result |
| Non-cash tender | A single `GCASH`/`CARD` payment with `amount_paid` different from the amount due is rejected (cash keeps change) |
| Atomicity | Shift (auto-open), transaction, items, payments, order update and activity log commit together or not at all. Events are sent only after the commit |

Fulfilment status of the sale is `pending` when any item is a kitchen or drink item, otherwise `completed`.

---

## 4. Customer (QR) orders and the payment choice

The customer chooses **Pay at Counter** (default) or **GCash** on the order form. The server stores it as `customer_orders.payment_method` (`PAY_AT_COUNTER` / `GCASH`, case/space-insensitive input). A missing value is stored as `NULL` = a **legacy order**: it is never treated as GCash, and the cashier collects payment as before.

- The customer's choice and the payment state are separate. The submit endpoint ignores any `payment_status`, `verified` or amount in the body; a new order is always `unpaid`.
- The public tracking endpoint shows the customer their own method and a coarse status (`unpaid`, `verified`, `paid`, `under_review`). It never shows amounts, references or "discrepancy".
- Cashiers see the method and payment status on every order card, in the bell modal, in the history table and in the POS cart banner.

Order **fulfilment** status (`pending, accepted, preparing, ready, completed, rejected`) is unchanged and is **not** a payment status: the kitchen also moves orders to `completed`, which says nothing about payment.

### Payment status (`customer_orders.payment_status`)

| Value | Meaning |
|---|---|
| `unpaid` | Nothing recorded. For a GCash order this is shown as "GCash verification pending" |
| `verified` | GCash: the cashier-reported amount matched the amount due exactly |
| `discrepancy` | GCash: the reported amount did not match. Blocks progression until resolved |
| `invalid` | GCash: a manager/admin closed the discrepancy as an invalid payment |
| `counter_paid` | A sale for the order was recorded at the counter (cash/card, or a legacy order) |

Allowed transitions, enforced on the server with a compare-and-swap update (anything else is 409):
`unpaid → verified | discrepancy | counter_paid`, `discrepancy → verified | discrepancy | invalid`. `verified`, `invalid` and `counter_paid` are final.

While a payment is in `discrepancy` or `invalid`, the order cannot move to accepted/preparing/ready/completed (customer-orders API **and** kitchen API); it can still be **rejected**. Rejected orders cannot be verified or paid, and completed or rejected orders are never reopened.

---

## 5. Manual GCash verification

There is **no payment gateway and no GCash integration.** The flow relies on a human reading the store's GCash transaction history.

1. The customer pays the exact total by scanning the store's GCash QR at the counter.
2. The cashier opens the order (Customer Orders → **Verify GCash**, or Charge on a loaded GCash order) and opens GCash → transaction history.
3. The cashier types the **amount actually received** and, when GCash shows one, the **reference number** and transaction time.
4. `POST /api/v1/customer-orders/{id}/payment/verify` compares the typed amount to the amount due, which the server computes from the order's stored item prices (never from the request).

The dialog says "reported by you" and, after a match, "the POS did not check GCash itself". A match means the cashier reports exactly the amount due; it is **not** independent proof that GCash received the money.

### Request

```json
{ "amount_received": "100.00", "reference_no": "1234 567 890 123", "transaction_time": "2026-10-24T14:05" }
```

Only these three fields are read. Expected amount, status, outcome, verifier and tenant are always server-side.

- `amount_received`: required; at most 2 decimals (149.999 is rejected rather than rounded into a false match); greater than 0 and at most 99,999,999.99; `,` thousands separators allowed; NaN/Infinity/negative/boolean/blank are 400.
- `reference_no`: optional; whitespace removed and upper-cased, then `[A-Z0-9][A-Z0-9-_./]{3,39}`.
- `transaction_time`: optional ISO time, stored as typed, not in the future.

### Outcomes

| Result | Order payment status | Record |
|---|---|---|
| Exact match | `verified` | Attempt `matched`; reference becomes **claimed** for the tenant. Earlier open discrepancies of this order are marked `superseded` by the verifier (the originals stay) |
| Different amount (short or over) | `discrepancy` | Attempt `mismatch` with the signed difference. The response and UI show expected, reported and difference; nobody is labelled dishonest |
| Reference already used by another order of the same tenant | unchanged | Attempt `duplicate_reference`; **409** with a generic message that names no other order |
| Same verification repeated | unchanged | Returns the original result; no new row. A *different* amount/reference after `verified` is 409 |

A cashier can **re-verify** a discrepancy with the corrected amount (any POS user). Only a **manager/admin** can close a discrepancy as `invalid` (`POST .../payment/resolve`, note of 5 to 200 characters). Accepting a short or over payment is a business decision that has not been made, so it is deliberately not offered.

### Audit trail

`payment_verifications` is append-only: who (`attempted_by`), when, expected amount, reported amount, signed discrepancy, reference, transaction time, outcome. Only the write-once `resolution*` columns are filled in later (`superseded` / `invalidated`, resolver, time, note). `GET .../payment/attempts` (manager/admin) lists it with usernames. Cashiers' lists show the latest attempt's amounts only (so the warning can be displayed), never usernames, notes or references. The activity log gets one line per verification, discrepancy, duplicate-reference attempt, resolution and for rejecting an already-verified order (refunds are manual).

### Duplicate-reference policy and its limits

A reference can verify **one** order per tenant, enforced by `UNIQUE (tenant_id, claimed_reference)`; only `matched` attempts claim a reference, so a typo on a mismatch does not block the real order. Limits: references are optional and the system will not invent one; with no reference there is no duplicate check; a typed reference is not validated against GCash; and neither a unique reference nor a matching amount proves a payment arrived. They are controls that make casual double-counting and typos visible.

---

## 6. Settling an online order (one sale per order)

"Send to POS" / "Record payment" loads the order into the POS cart (after asking before it replaces a non-empty cart). **Charge & Checkout** then calls `POST /transactions` with `customer_order_id` (and `client_tx_id`). For an online order the server:

- locks the order row, requires it to belong to the cashier's tenant (404 otherwise) and not to be `rejected`;
- **ignores** any `items`, prices, tax or discount from the browser (tax/discount are rejected); lines and prices come from the order;
- enforces the payment rules: **GCash** requires `verified` (409 otherwise, with a different message for an unresolved discrepancy) and records the payment as `GCASH` with the reported amount, reference, verifier and time (any other method is 400); **Pay at Counter** is recorded as `CASH` or `CARD` and moves the order to `counter_paid`; a **legacy** order accepts the usual methods;
- creates the sale, its payment, the link `transactions.customer_order_id` (`UNIQUE (tenant_id, customer_order_id)`), the order update (pending → completed, payment status) and the audit entry in **one database transaction**;
- on a retry (same or new key, or a second cashier) returns the original sale instead of making another, and finishes any half-done update left by the old two-step flow (order still pending but already sold). The repair is audited (`Order Reconciled`), never marks a GCash order paid (only verification does), and is refused (409) when the linked sale was **voided**: a voided order is never re-sold or silently re-opened. `scripts/reconcile_customer_orders.py --confirm-host <host>` lists every such order (dry run) and applies the same repair with `--execute`; inconsistent cases (rejected order with an active sale, GCash order sold while not verified) are only reported;
- avoids a duplicate kitchen ticket when the order was already accepted: the sale is recorded with fulfilment `completed` and the order's own fulfilment status is untouched.

There is no separate "mark completed" call any more. A GCash payment is **not** recorded as a sale until the cashier completes the checkout; verifying only changes the payment status.

Pay-at-Counter orders are never marked paid because they were submitted online; payment is recorded only when the cashier completes the sale.

---

## 7. Drinks, Today's Orders, receipts, shifts

- **Drinks Orders**: queue from `GET /kitchen/drinks-orders`, status via `PUT /kitchen/orders/{id}/drinks-status`, badge refreshed every 8 s.
- **Today's Orders**: `GET /transactions?limit=50`. A **Payment** column shows the method(s) and a "cashier-verified" tick for verified GCash payments. Managers/admins additionally receive the reference, reported amount, verifier and `voided_by` in the API; cashiers do not. Voided sales show their refund state (*Refund pending* / *Refunded* / *No refund needed*); managers/admins get a **Record refund** button (section 7a). Receipts (new and reprinted) use the committed lines and totals; change is shown only for `CASH`.
- **Cash Drawer access (2026-10-28)**: the Cash Drawer screen is for MANAGER/ADMIN/SUPER_ADMIN; it is not in the cashier menu and a typed `#cash_drawer` falls back to the POS. `GET /shifts/drawer-summary` returns every cashier shift of the tenant to managers/admins but only the caller's **own** shifts and sales to a cashier (`scope: "own"`), and it is read-only (no shift is created; `has_open_shift` says whether one is open). `PUT /shifts/{id}/drawer-cash` is manager/admin only (403 for cashiers). `POST /shifts/cashout`: a cashier may cash out only their own open drawer (403 for another's), managers/admins any open drawer of the tenant; an unknown shift is 404, a closed one 409, and no shift is created. The POS header shows the user's own open drawer only.
- **Shifts / drawer**: drawer cash is an **exact** method match, `upper(trim(payment_method)) = 'CASH'` (`payments.cash_method_clause` / `is_cash_method`), in `shifts.py`, `analytics.py` and `financial_service.py`. Historical rows spelled `Cash`/`cash` still count; `GCASH`, `CARD` and look-alikes such as `CASHBACK` never do. (Before 2026-10-24 it was `LIKE '%cash%'`, which matched `GCASH`; 2026-10-24 to 2026-10-27 it was a `cash%` prefix.) Each shift also returns `voided_cash_refund_pending`: cash of voided sales that has not been recorded as returned (it is not in `expected_cash`, so the drawer counts that much over until it is handed back). Auto-opening a ₱0 shift (`AUTO_OPEN_SHIFT`) is unchanged.

---

## 7a. Voids, manual refunds and stock

**Voiding a sale** (`PUT /transactions/{id}/status` with `cancelled`/`rejected`, the Reject button in Today's Orders):

- requires a `reason` (at least 3 characters); the row is locked (`SELECT ... FOR UPDATE`) so a void, a completion and a refund of the same sale are applied one at a time;
- keeps the sale, its lines and its payment rows (payments become `cancelled`, never deleted) and stores `voided_at`, `voided_by`, `void_reason`;
- sets `refund_status = pending` when a payment had been recorded as collected, otherwise leaves it empty. **Voiding never claims money was returned**;
- restores recipe stock the sale had deducted (once; see below);
- removes the sale from drawer cash and income (unchanged rule: only `completed` sales and payments count);
- is final: a voided sale cannot be voided again, completed or re-opened.

Other values on the same endpoint: `completed` completes a `pending` sale only if its payments equal the total; a completed sale can no longer be moved back to `pending` (that used to drop it out of income reports); `preparing`/`ready` change only the fulfilment status, and not after it is `completed`.

Who may void: every POS role, as before (business decision open). `VOID_REQUIRES_MANAGER=true` restricts voids to MANAGER/ADMIN/SUPER_ADMIN without a code change.

**Recording a refund** (`POST /transactions/{id}/refund`, MANAGER/ADMIN/SUPER_ADMIN): the POS does not move money. After the money is handed back (drawer cash, a transfer from the store's GCash app, a card reversal), a manager records it:

```json
{ "outcome": "refunded", "amount": "100.00", "refund_method": "GCASH", "reference_no": "9012 345 678 901", "note": "Sent back from store GCash" }
{ "outcome": "not_required", "note": "Card was declined; nothing was charged" }
```

Only for a voided sale with `refund_status = pending`; `amount` must be the **full** amount collected and `refund_method` one of the sale's methods (partial refunds are an open decision); a note of 5 to 200 characters is required. One record per sale (`UNIQUE (tenant_id, transaction_id)` plus a compare-and-swap on `refund_status`); a second attempt is 409. The record (`sale_refunds`) keeps amount, method, reference, note, recorder and time; the response says *"Recorded by staff; the POS did not send or verify the refund."* Reports do not change: the voided sale was already excluded, so nothing is double-counted.

**Kitchen screen and sales**: `PUT /kitchen/orders/{id}/status` changes only the fulfilment status of a POS sale. It can no longer cancel/reject a sale (409): that used to set the sale to `cancelled` while leaving its payments counted as `completed`. A completed ticket cannot be re-opened there. (The kitchen page's Reject button calls the POS void endpoint, which KITCHEN accounts are not allowed to use; that behaviour is unchanged.)

**Customer orders, both routes**: `PUT /customer-orders/{id}/status` and the kitchen's `CUST-` path now share one function on a locked row. Rejecting an order that has an **active sale** is refused (409: void the sale first) so a rejected order can never keep counting as income; rejecting an order whose payment was verified or recorded is audited (`Paid Order Rejected`) from either route.

**Recipe stock** (`app/services/stock.py`): **off** unless `INVENTORY_DEDUCTION=on_sale`, because when stock should be deducted has not been decided. When on:

- only products with `product_recipes` rows are tracked; one sale deducts `recipe quantity x units` of each ingredient (summed per ingredient) **inside the sale's database transaction** with a conditional update (`quantity >= needed`). Insufficient stock rejects the whole sale (409), nothing is written, and the same `client_tx_id` can be retried after the cart is fixed;
- each deduction writes a `SALE` row in `stock_movements` (`reference_type = 'pos_sale'`, `reference_id = sale id`); a partial unique index makes a second deduction for the same sale and ingredient impossible, and an idempotent replay never reaches the deduction;
- voiding restores exactly what that sale took (`REVERSAL`, `pos_sale_void`), once, even if the setting was switched off in between;
- online orders are deducted when their sale is recorded; kitchen acceptance never deducts, so an order is never deducted twice;
- products without a recipe and orders whose product was deleted are not deducted (nothing is invented).

---

## 8. End-to-end flow

```
Customer picks GCash / Pay at Counter  ->  order (unpaid, fulfilment pending)
        |
Cashier: Customer Orders ---------------------------------------------+
   GCash:  Verify GCash (typed amount) -> verified | discrepancy       |
   Counter: nothing to verify                                          |
        |                                                              |
   Send to POS / Record payment  (cart locked to the order)            |
        |                                                              |
   Charge & Checkout -> POST /transactions {customer_order_id, client_tx_id}
        |   one DB transaction: sale + payment + order update + audit
        v
   Receipt -> cart cleared -> events (ORDER_CREATED, CUSTOMER_ORDER_UPDATED, DRAWER/FINANCIAL_UPDATED)
```

Walk-in sales skip the left column: items + method + `client_tx_id`.

---

## 9. Known gaps and open decisions

1. **Walk-in GCash/card at the POS is cashier-attested**, not verified: the POS records what the cashier confirms. The verification workflow covers *online* GCash orders only.
2. **Short/over payments** have no acceptance path (only re-verify or "invalid"); partial and split GCash payments for one order are not supported.
3. **Pay-before-preparing vs pay-at-collection** is undecided: unpaid orders can still be accepted and prepared (current behaviour preserved).
4. **Accepted orders** are handled through the kitchen's customer-order ticket and appear in the history table, not the pending queue; their payment is recorded with "Record payment".
5. **Who may void or refund** a completed sale is undecided: any POS role can void (switch: `VOID_REQUIRES_MANAGER`); recording a refund is manager/admin only (new endpoint; confirm). Voids are audited and flag a pending refund; refunds are full-amount only and are performed outside the POS.
6. **Tax and discounts** remain client-entered for walk-in sales (policy undecided; the cashier UI sends neither); the server only enforces 2 dp, >= 0 and discount <= order total. Online orders carry none.
7. **Inventory deduction is implemented but switched off** (`INVENTORY_DEDUCTION=off`) until the owner decides when stock is deducted and which products have reliable recipes (see `docs/BUSINESS_DECISIONS.md` #4).
8. **Auto-opened shifts start at ₱0**; the owner must decide when to require a drawer count (`AUTO_OPEN_SHIFT`).
9. **Legacy orders** (no recorded method) are payable by any usual method and are labelled "Method not recorded".
10. Database behaviour (row locks, unique indexes, transaction isolation) was exercised on SQLite only. `tests/test_postgres_concurrency.py` races the real API on PostgreSQL but has **not been run** (no disposable PostgreSQL database was available); see `docs/REMEDIATION_STATUS.md`.
11. Two simultaneous first sales of one cashier with no open shift can each auto-open a shift (pre-existing; no unique "one open shift per cashier" constraint).

---

## 10. API reference (new and changed)

| Endpoint | Who | Notes |
|---|---|---|
| `POST /api/v1/customer-orders` (public) | anyone, rate-limited | New optional `payment_method`: `GCASH` or `PAY_AT_COUNTER` (else 400). Payment state fields in the body are ignored |
| `GET /api/v1/customer-orders/{id}` | POS staff, own tenant | One order with `payment_method`, `payment_status`, `sale_recorded`, latest `payment_attempt` (outcome and amounts only) |
| `GET /api/v1/customer-orders/pending`, `/history` | POS staff, own tenant | Now include the same payment fields |
| `POST /api/v1/customer-orders/{id}/payment/verify` | POS staff, own tenant | Body `{amount_received, reference_no?, transaction_time?}`. 200 with `verified` true/false; 409 for duplicate reference, non-GCash order, rejected order, or a changed verified payment |
| `POST /api/v1/customer-orders/{id}/payment/resolve` | manager / admin / super admin | Body `{resolution: "invalid", note}`; only valid from `discrepancy` |
| `GET /api/v1/customer-orders/{id}/payment/attempts` | manager / admin / super admin | Full audit trail with usernames |
| `POST /api/v1/transactions` | POS staff | New `customer_order_id`; `client_tx_id` is now fingerprint-checked (409 on a different payload); replies carry `idempotent_replay` on repeats and `payment_status` for order sales |
| `GET /api/v1/transactions[...]` | POS staff | Payments show `verification: "cashier_verified"`; reference, reported amount and verifier only for manager/admin |
| `GET /api/v1/shifts/drawer-summary` | POS staff | Each shift now includes `expected_cash` and `voided_cash_refund_pending`; only `CASH` counts as cash |
| `PUT /api/v1/transactions/{id}/status` | POS staff (void: manager/admin when `VOID_REQUIRES_MANAGER=true`) | Void needs `reason`; stores who/when/why, keeps payment rows, sets `refund_status`, restores stock; completed sales cannot go back to pending; `preparing`/`ready` are fulfilment only |
| `POST /api/v1/transactions/{id}/refund` | manager / admin / super admin | Records the manual refund of a voided sale (`refunded` full amount, or `not_required`); once per sale |
| `PUT /api/v1/kitchen/orders/{id}/status` | kitchen + POS staff | POS sales: fulfilment only, no cancel/reject (409), no re-opening a completed ticket. `CUST-` orders: same locked rules as the customer-orders route |

Real-time events: `CUSTOMER_ORDER_UPDATED` carries only `order_id`, `order_number`, `status`, `payment_status`. Amounts, references and discrepancy details are never broadcast.

Database objects (migration `20261024000001`): `customer_orders.payment_method`, `customer_orders.payment_status`; `transactions.customer_order_id` (unique per tenant), `transactions.request_fingerprint`; `payments.reference_no/amount_received/verified_by/verified_at`; table `payment_verifications` (unique `(tenant_id, claimed_reference)`).
Migration `20261027000001`: `transactions.voided_at/voided_by/void_reason/refund_status`; table `sale_refunds` (unique `(tenant_id, transaction_id)`); `stock_movements` (create-if-missing, same definition as the live table) with the partial unique index `uix_stock_movements_sale_reference`.
