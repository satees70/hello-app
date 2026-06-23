# EASWARI / AVINA — Production Team Manual

**Full process, step by step.** Read the stages in order. Each `📷 [Screenshot]`
marker is where a picture will be added later.

---

## 0. Getting started (everyone)

**Logging in**
1. Open **production.srrieaswari.com** in your browser (on phone, use Safari).
2. Enter your **username** and **password** → **Login**.
3. You land on the **Dashboard**. The blue bar at the top is the menu:
   **Dashboard · Pending Changes · Discussion · Sales · Receiving · Production · Reports · Setup**, with the **🔔 bell** and your name on the right.
4. The chip near your name shows your access: a **factory code** (e.g. AVINA 101) or **Head Office** (sees everything).
📷 [Screenshot: Dashboard after login]

**What you can see/do**
- You only see and edit work for **your own location(s)**.
- Head Office can see all factories and approves changes.

**Phone notifications (office phone)**
1. Open the site in **Safari** → **Share** → **Add to Home Screen**.
2. Open the app from the **Home-Screen icon** (not a Safari tab).
3. Tap **🔔 → Enable on this phone → Allow**.
4. You'll now get alerts even when the app is closed.

---

## 1. Sales Orders (Office)

**Where:** Sales → Sales Orders. **Who:** Office. **When:** a customer order arrives.

**A. Upload the order**
1. Click **Choose File**, pick the customer's **Sales Order PDF**, click **Upload**.
2. The system reads the order and lists it under **Uploaded Documents** with a status (usually **Review**).
📷 [Screenshot: Sales Orders upload + uploaded documents list]

**B. Check the lines**
1. Find the document (use **Search file or item**, or the **Location / Status / Issues** filters).
2. Click **View Lines** to see each item, quantity, delivery date, location and status.
3. Use the line **Search** box or the per-column filters to find an item.
📷 [Screenshot: Lines view of a document]

**C. Fix a line if needed**
- **Before that location has confirmed:** staff can change **Location** and **Delivery Date** directly (no approval). Click **Edit** on the line. Head Office can change any field.
- **After it's confirmed:** click **Request change** — Head Office approves it.
- To move an order to another site, change the **Location** (the factory updates automatically).
📷 [Screenshot: Edit this line panel]

**D. Urgent orders**
- Click **Mark urgent** on the document. It turns red and stays flagged through the whole journey, and the location is notified.

**E. Confirm to production**
1. Scroll to **Confirm to production**.
2. Each location clicks **Confirm <factory> lines**. Those lines are pushed to that factory's **Order Board**.
3. A document can't be confirmed while it has pending changes.
📷 [Screenshot: Confirm to production section]

---

## 2. Order Board — plan production (Factory)

**Where:** Production → Order Board. **Who:** Factory planner. **When:** after lines are confirmed.

1. Confirmed orders appear as **batches**. Tabs at the top: **not requested yet / requested / in progress / done**. Filter by **Factory**, delivery date, or **Sort**.
2. Tick **Combine same item to run together** to group identical items into one run.
📷 [Screenshot: Order Board with batches]

**Raise the materials**
3. Click **Materials** on a batch (or a combined group).
4. Set the **Run mode**: *Auto machine* (roll) or *Manual* (pieces) — this decides which packaging is needed.
5. The table shows **Required vs Stock vs Shortfall**.
6. **Standard order:** click **Raise Material Request**.
7. **Ad-hoc order (different packaging, e.g. 1kg vs 5kg plastic):** tick **✎ Customise materials (ad-hoc)** → edit quantities, **remove** a line, or **add** a material (e.g. the 5kg plastic) → **Raise ad-hoc request**. This does **not** change the saved recipe.
📷 [Screenshot: Material requirements modal + ad-hoc toggle]

**If you see ⚠ No BOM set:** the recipe is missing — set it up in Reports → BOM first.

---

## 3. Material Requests & the warehouse

**Where:** Receiving → Material Requests.

**Factory / Head Office — release to the warehouse**
1. New requests collect under **⏳ Waiting to release** for each factory.
2. When ready, click **Release to warehouse →**. This sends one fixed **pick run**; anything raised later waits for the next release.
📷 [Screenshot: Waiting to release + Release button]

**Raise materials by hand (ad-hoc / not from a batch)**
1. Click **➕ Request a material manually**.
2. (Optional) **Load from a product's recipe** — pick the product + units to pre-fill its recipe, then swap the plastic / edit quantities.
3. Or add items one by one (search the item, enter qty, **+ Add item**).
4. **Submit request** — it joins Waiting to release.
📷 [Screenshot: Manual request form]

**Warehouse — pick and record**
1. Use the **Location** and **Status** dropdowns to find runs (New / SO entered / Partially received / Fully received).
2. For each released run: type the **SO number**, click **Save**.
3. Pick the whole run in one trip; type the **total received** for each material — it splits back across the original requests automatically.
📷 [Screenshot: Released pick run, warehouse view]

---

## 4. Goods Received (Factory / Warehouse)

**Where:** Receiving → Goods Received. **When:** a delivery arrives.

1. Click **Choose File**, upload the **Delivery Order (DO) PDF**, **Upload**. The system reads the lines.
2. Click **View Lines** (use the item **Search** if the list is long).
3. For each line: **tick QC**, add a **photo** (optional for Head Office), then **Receive**. Partial is fine — receive some now, the rest later. Received items **book into stock**.
4. Bag/carton quantities convert to KG automatically. If asked, set **KG per bag** on the item.
5. Wrong quantity? Use **Correct received quantity**. Wrong code? Use **Request edit**.
📷 [Screenshot: Goods Received lines with QC/photo/Receive]

---

## 5. Labels (Factory)

**Where:** Receiving → Labels.

1. A label appears once its order's raw materials are received (stage **Material received**).
2. Enter the **batch number / expiry** and the **quantity to print**, attach a **photo** of the printed label → stage becomes **Printed**.
3. Tick the labels → **Send** → then **Receive → stock** when they arrive (books label stock).
4. One-off label? **➕ Request a label manually** (choose label, product, qty, batch, expiry).
📷 [Screenshot: Labels pipeline]

---

## 6. Packing Schedule (Factory)

**Where:** Production → Packing Schedule.

1. Sections: **Scheduled to pack → Ready to pack → Waiting for materials**.
2. Set each batch's **pack line**, **date**, and **run mode**.
3. Click **▸ show materials** to see, per material, the **stock batches to use** (oldest expiry first). Batches reserved for that run are marked **★ — use these first**.
📷 [Screenshot: Packing Schedule + show materials]

---

## 7. Record production (Line / QC)

**Where:** open the batch's **Packing & Finished Goods Inspection Record**.

1. **Date, Area/Line, Code, Product** come from the Packing Schedule and are **locked**. If any is wrong, fix it in **Packing Schedule** (the date shows red if it isn't today).
2. **Production timer:** **Start** at the beginning, **Pause** for breaks, **Stop** at the end.
3. **Materials used:** the **batches & quantities are pre-filled** from what was allocated. Adjust **Qty used**; use **+ add batch** if one batch wasn't enough.
4. Fill the quality checks (sealing samples, CCP2, metal detector, etc.).
5. Enter **Quantity produced** → **Record production**. This **consumes the raw materials from stock** (earliest expiry first).
6. If **food loss > 5%**, it's flagged to Head Office automatically.
📷 [Screenshot: Inspection record — header, timer, materials used]

---

## 8. Delivered to warehouse / Delivery Orders

**Where:** Sales → Delivery Orders.

1. Finished goods are dispatched to the warehouse here. When delivered, the location is notified and the order line moves to **Delivered to warehouse**.
📷 [Screenshot: Delivery Orders]

---

## 9. Buying from suppliers (Office)

**Where:** Sales → Supplier (to order).

1. **To order** tab: items routed to SUPPLIER, grouped by item, with **Outstanding** (what to buy) and the next delivery date.
2. Tick items (or **Select all**), or **add an item manually** (low-stock top-up).
3. Type the **Supplier name**, adjust quantities, **Place order** (one consolidated order).
4. **Placed orders** tab: **Mark received** when goods arrive.
📷 [Screenshot: Supplier to-order + place order]

---

## 10. Discussion (talk to each other)

**Where:** Discussion (top menu).

- Post a message; **link it to an SO** so it's filed under that order.
- **@tag a person** or **@tag a whole location** (everyone there is notified).
- **Reply** to a message to quote it and notify the author.
- A **💬 badge** on a Sales Order means there's discussion on it — click to open the thread.
📷 [Screenshot: Discussion board]

---

## 11. The 🔔 bell (notifications)

- Shows a count of new things for **your location**. Click to read; clicking one opens the right page.
- You're alerted for: new orders, urgent orders, pick run released, order confirmed, goods received, finished goods delivered, and **@mentions** in Discussion.

---

## 12. Head Office — Approvals

**Where:** Pending Changes (the badge shows how many are waiting).

Approve/reject: sales-order changes, document deletes, item/SO changes, batch splits, stock adjustments, received-qty moves, run-mode changes, material-request cancellations, return edits, food-loss alerts.

---

## Quick daily checklist

| Role | Do this |
|---|---|
| **Office** | Upload SOs → confirm to production → mark urgent ones → place supplier orders |
| **Factory** | Order Board → raise materials → receive goods → print/send labels → schedule packing → record production |
| **Warehouse** | Release pick runs → enter SO numbers → record what you pick |
| **Head Office** | Clear Pending Changes |
| **Everyone** | Check the 🔔 bell and Discussion |
