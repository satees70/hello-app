# EASWARI / AVINA — Production Team Manual

A step-by-step guide for the daily workflow, from a customer order to finished
goods in the warehouse. Follow the stages in order.

---

## The flow in one line

**Sales Order → Confirm to production → Order Board (raise materials) → Warehouse releases & you receive → Pack & record production → Print & receive labels → Delivered to warehouse.**

Every stage updates the next one automatically, and the people for each location
get a **🔔 notification** when something needs them.

---

## Before you start (everyone)

1. Open **production.srrieaswari.com** and **log in** with your username and password.
2. Top menu bar groups the work: **Sales · Receiving · Production · Reports · Setup**, plus **Discussion** and the **🔔 bell**.
3. The chip near your name shows your **location** (e.g. AVINA 101) or **Head Office**.
4. **Office phone:** open the site in Safari → Share → **Add to Home Screen**, open that app, then tap **🔔 → Enable on this phone → Allow**. You'll then get alerts even when the app is closed.
5. You only see and edit work for **your own location(s)**. Head Office sees everything.

---

## Stage 1 — Sales Orders (Office)

**Menu: Sales → Sales Orders**

1. Click **Choose File** and upload the customer's **Sales Order PDF**, then **Upload**. The system reads the lines automatically.
2. In **Uploaded Documents**, click **View Lines** to check what was read. Use the search box to find an item, or the column filters.
3. **Correcting a line:**
   - **Before a location confirms** — staff can fix **Location** and **Delivery Date** directly (no approval). Head Office can change any field.
   - **After a location confirms** — use **Request change**; Head Office approves it.
4. If an order is rush, click **Mark urgent** (it turns red and stays flagged through the whole journey, and notifies the location).
5. **Confirm to production:** at the bottom, each location clicks **Confirm <factory> lines**. This pushes those lines to that factory's **Order Board**.
   - A document can't be confirmed while it has pending changes.
6. Need to discuss a line? Click the **SO number** to jump to its **Discussion** thread.

---

## Stage 2 — Order Board / plan production (Factory)

**Menu: Production → Order Board**

1. Confirmed orders appear here as **batches**. Use the tabs: **not requested yet / requested / in progress / done**, and the Factory / date / sort filters.
2. Tick **Combine same item to run together** to group identical items into one run.
3. Click **Materials** on a batch (or combined group):
   - Choose the **Run mode** (Auto machine = roll, Manual = pieces) — this decides which packaging is needed.
   - Review the **shortfall** (what's missing vs system stock).
   - **Standard order:** click **Raise Material Request**.
   - **Ad-hoc order (different packaging, e.g. 1kg vs 5kg plastic):** tick **✎ Customise materials (ad-hoc)**, edit the quantities, **remove** a line, or **add** a material (e.g. the 5kg plastic), then **Raise ad-hoc request**. This does **not** change the product's saved recipe.
4. If an item shows **⚠ No BOM set**, set up its recipe first (Reports → BOM).

---

## Stage 3 — Material Requests & the warehouse

**Menu: Receiving → Material Requests**

**Factory / Head Office:**
1. New requests collect under **⏳ Waiting to release** for each factory.
2. When ready, click **Release to warehouse →**. This sends one fixed **pick run**; anything raised afterwards waits for the next release.
3. **Manual / ad-hoc request:** click **➕ Request a material manually** → optionally **Load from a product's recipe** (pick product + units), tweak the materials, then **Submit request**.

**Warehouse:**
1. Use the **Location** and **Status** dropdowns to find runs (New / SO entered / Partially received / Fully received).
2. For each released run: enter the **SO number** and **Save**.
3. Pick the whole run in one trip; type the **total received** for each material — it's split back across the original requests automatically.
4. To receive a **whole Delivery Order** at once instead, use the **Goods Received** tab.

---

## Stage 4 — Goods Received (Factory / Warehouse)

**Menu: Receiving → Goods Received**

1. Upload the **Delivery Order (DO) PDF** → the system reads the lines.
2. Click **View Lines**. Search by item if the list is long.
3. For each line: **tick QC**, add a **photo** (optional for Head Office), then **Receive**. You can receive some now and the rest later (partial). Received items **book into stock**.
4. Bag/carton quantities convert to KG automatically (set **KG per bag** on the item if prompted).
5. If a quantity was wrong, use **Correct received quantity**. To fix a code, use **Request edit**.

---

## Stage 5 — Labels (Factory)

**Menu: Receiving → Labels**

1. A label appears here once its order's raw materials are received (stage **Material received**).
2. Enter the **batch number / expiry** and the **quantity to print**, attach a **photo** of the printed label → it moves to **Printed**.
3. Tick the labels and click **Send** → then **Receive → stock** when they arrive (books label stock).
4. Need a one-off label? Use **➕ Request a label manually** (choose the label, product, qty, batch, expiry).

---

## Stage 6 — Packing Schedule (Factory)

**Menu: Production → Packing Schedule**

1. Sections: **Scheduled to pack → Ready to pack → Waiting for materials.**
2. Set each batch's **pack line**, **date**, and **run mode** (Auto/Manual).
3. Click **▸ show materials** to see, per material, the **stock batches to use** (oldest expiry first). Batches reserved for that run are marked **★ — use these first**.

---

## Stage 7 — Record production (Line / QC)

**Open the batch's Packing & Finished Goods Inspection Record**

1. **Date, Area/Line, Code, Product** are filled from the Packing Schedule and **locked** — if any is wrong, amend it in **Packing Schedule**. (The date shows red if it isn't today.)
2. **Production run timer:** **Start** when you begin, **Pause** for breaks, **Stop** at the end.
3. **Materials used:** the **batches and quantities are pre-filled** from what was allocated to this order. Adjust the **Qty used**, and use **+ add batch** if one batch wasn't enough.
4. Fill the quality checks (sealing samples, CCP2, metal detector, etc.).
5. Enter **Quantity produced** → click **Record production**. This **consumes the raw materials from stock** (earliest expiry first).
6. If **food loss is over 5%**, it's flagged to Head Office automatically.

---

## Stage 8 — Delivered to warehouse / Delivery Orders

**Menu: Sales → Delivery Orders**

1. Finished goods are dispatched to the warehouse here. When a batch is delivered, its location is notified and the order line moves to **Delivered to warehouse**.

---

## Buying from suppliers (Office)

**Menu: Sales → Supplier (to order)**

1. **To order** tab: items routed to SUPPLIER, grouped by item, with **Outstanding** (what to buy) and the next delivery date.
2. Tick items (or **Select all**), or **add an item manually** (e.g. a low-stock top-up).
3. Type the **Supplier name**, adjust quantities, **Place order** (one consolidated order).
4. **Placed orders** tab: **Mark received** when goods arrive.

---

## Talking to each other — Discussion

**Menu: Discussion**

- Post a message; **link it to an SO** so it's filed under that order.
- **@tag a person** or **@tag a whole location** (everyone there is notified).
- **Reply** to a message to quote it and notify the author.
- A **💬 badge** on a Sales Order means there's discussion on it — click to open the thread.

---

## Notifications — the 🔔 bell

- The bell shows a count of new things for **your location**. Click it to read them; clicking a notification opens the right page.
- You're alerted for: new orders, urgent orders, pick run released, order confirmed, goods received, finished goods delivered, and when someone **@mentions you or your location** in Discussion.

---

## For Head Office — Approvals

**Menu: Pending Changes** (badge shows how many are waiting)

Approve or reject: sales-order changes, document deletes, item/SO changes, batch splits, stock adjustments, received-qty moves, run-mode changes, material-request cancellations, return edits, and food-loss alerts.

---

## Quick daily checklist

- **Office:** upload new SOs → confirm to production → mark urgent ones → place supplier orders → clear Pending Changes (HO).
- **Factory:** Order Board → raise materials → receive goods (GRN) → print/send labels → schedule packing → record production.
- **Warehouse:** release pick runs → enter SO numbers → record what you pick.
- **Everyone:** check the **🔔 bell** and **Discussion**.
