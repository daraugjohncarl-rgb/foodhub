# Business decisions that block full remediation

The code deliberately does **not** invent these policies. Each item lists the current behaviour and the safe default that was kept.

| # | Decision needed | Current behaviour (kept) | Risk while undecided |
|---|---|---|---|
| 1 | **Tax policy and who calculates it** (fixed rate per tenant? service charge? BIR-style receipts?) | `tax_amount` is sent by the client; the server only requires `>= 0`. | A cashier/browser can enter any tax. Totals are otherwise server-computed. |
| 2 | **Discount caps and role permissions** (percentage cap per role, manager approval) | Client-entered `discount_amount`, `0 <= discount <= order total` (a 100% discount is allowed). | A cashier can give a free order. |
| 3 | **Void / refund permissions** | Any POS role (cashier, manager, admin) may void a sale in their tenant (now with a required reason, `voided_by/at`, kept payment rows and `refund_status = pending` when money was collected). `VOID_REQUIRES_MANAGER=true` limits voids to managers/admins. Recording a refund (`POST /transactions/{id}/refund`) is manager/admin only. | A cashier can void a completed, paid sale (audited, flagged for refund). |
| 4 | **Stock deduction on sale and restoration on cancel** | Implemented for products with recipes but **off** (`INVENTORY_DEDUCTION=off`). With `on_sale` a sale deducts recipe stock atomically (no overselling, 409 when short) and a void restores it once. | While off, inventory counts drift from reality. |
| 5 | **Auto-opened shift** | A sale with no open shift opens a zero-cash shift (`AUTO_OPEN_SHIFT=true`); the UI never starts shifts. | Cash reconciliation starts from 0. Set `false` once the UI forces a drawer count. |
| 6 | **Shared cashier/kitchen devices** | Each login increments `token_version`, signing the same account out elsewhere. | Two people sharing one account log each other out; give each person an account. |
| 7 | **Product cost visibility** | Only MANAGER, ADMIN and SUPER_ADMIN receive `cost` from `/products`. Inventory staff do not. | If inventory staff need margins, add INVENTORY to `COST_VISIBLE_ROLES` in `routers/products.py`. |
| 8 | **Customer data retention / deletion** | Names, phones, emails are kept indefinitely; users are hard-deleted. | Privacy-law exposure; hard delete can fail on `RESTRICT` foreign keys. |
| 9 | **Timezone for reports** | Naive timestamps; "today" uses the app server's local time. | Day boundaries shift between environments. |
| 10 | **Password policy** | Minimum 8 characters (was 6). | Confirm 8 is acceptable or require complexity. |
| 11 | **GCash discrepancy policy** (accept a short/over payment? partial or split GCash payments? top-up flow?) | A mismatch blocks the order; a cashier may re-verify with the corrected amount, a manager/admin may close it as an *invalid payment*. No "accept difference" option exists. | Short-paid customers cannot be settled in the system; the owner handles them manually. |
| 12 | **Supervisor approval for discrepancies** | Only the existing roles are used: any POS user can verify/re-verify, MANAGER/ADMIN/SUPER_ADMIN can close a discrepancy. No approval chain or dual control was invented. | One manager can close any discrepancy. |
| 13 | **Pay before preparation, or pay at collection?** | Unchanged: an unpaid order (GCash or counter) can be accepted and prepared; only a *discrepancy/invalid* GCash payment blocks fulfilment. | Food can be made for an order that is never paid. |
| 14 | **Refunds and voids of online orders** | Rejecting a verified-paid order and voiding a sale are allowed and audited; an order with an active sale cannot be rejected until the sale is voided. The money is returned manually and a manager records it (`sale_refunds`, full amount only). A voided order is never re-sold. | Partial refunds cannot be recorded. |
| 15 | **Walk-in GCash/card verification** | Recorded as the cashier confirms; no reference/amount check (the verification workflow covers online GCash orders). | Walk-in GCash payments are cashier-attested. |
| 16 | **Legacy customer orders** | Orders placed before the payment choice have no method (`NULL`), are never assumed GCash, are payable by any usual method, and show "Method not recorded". | Accounting for old orders relies on the cashier's choice at the till. |
| 17 | **Cash vs GCash in the drawer** | Fixed: drawer cash is an exact match `upper(trim(method)) = 'CASH'` (previously `LIKE '%cash%'`, which matched `GCASH`, then a `cash%` prefix). New sales only accept CASH/GCASH/CARD. Historical reports recompute with the corrected rule; nothing was rewritten in the database. | Any figure someone exported earlier included GCash in "cash". |

## Owner decisions required (cashier ordering, 2026-10-27)

None of these were invented in code. "Current behaviour" is what runs today; "To enable" is what changes once the owner decides.

| # | Question | Current behaviour (kept) | To enable a different policy |
|---|---|---|---|
| D1 | Must a GCash payment be verified before the kitchen starts preparing? | No. An unpaid order (GCash or counter) can be accepted and prepared; only `discrepancy`/`invalid` block fulfilment, on both the customer-orders and kitchen routes. | Add the rule to `apply_customer_order_status` (one place, both routes use it). |
| D2 | Can customers pay at collection after the order was prepared? | Yes (same as D1): payment is recorded when the cashier completes the sale. | As D1. |
| D3 | Should walk-in GCash payments use the same manual verification as online orders? | No. Walk-in GCash/CARD is cashier-attested: the method is recorded for exactly the amount due, with no amount/reference check. The verification service is tied to `customer_orders`. | Needs a decision plus a small schema change (verification attempts keyed to a sale instead of an order); the parsing/normalising helpers in `services/payments.py` can be reused. |
| D4 | Who can void or cancel a completed sale? | Any POS role, with reason and audit. | `VOID_REQUIRES_MANAGER=true` (manager/admin/super admin only). |
| D5 | Who can approve or record a refund? | Manager/admin/super admin record refunds (new endpoint; confirm this choice). No approval chain. | Change the guard on `POST /transactions/{id}/refund`. |
| D6 | How are manual GCash refunds recorded? | Staff send the money from the store's GCash app, then a manager records amount, method `GCASH`, the refund's reference number and a note. The POS never claims it sent money. | Confirm, or require a reference for GCash refunds. |
| D7 | Are short or excess payments ever accepted, and who authorises them? | Never. A GCash mismatch blocks the order (re-verify or close as invalid); payment lines must equal the amount due; refunds must be the full amount. | Needs a new resolution type with its own audit; not built. |
| D8 | When is stock deducted: acceptance, preparation or sale? | Not deducted (`INVENTORY_DEDUCTION=off`). Only "at sale" is implemented. | Set `INVENTORY_DEDUCTION=on_sale` after D9; other events need new code. |
| D9 | Which products use direct stock tracking and which use recipes? | Only recipe-based tracking exists (`product_recipes`). Products without a recipe are never deducted. A retail item can be tracked by giving it a 1:1 recipe to an inventory item. | Review and complete recipes before enabling D8. |
| D10 | Must a shift start with a counted opening float? | No: a sale with no open shift auto-opens a 0.00 shift (`AUTO_OPEN_SHIFT=true`); the UI has no opening-count screen. | `AUTO_OPEN_SHIFT=false` once the UI asks for the count (`POST /shifts/start`). |
| D11 | What tax and discount policies apply to walk-in sales? | No tax or discount is entered in the cashier UI; the API accepts client values (2 dp, >= 0, discount <= order total). | Define rates/caps/roles; then compute tax server-side and guard discounts by role. |
| D12 | Are split payments required? | Not in the UI. The API accepts a `payments` list whose lines must add up exactly to the amount due. | Build and test a dedicated split-payment UI if wanted. |
