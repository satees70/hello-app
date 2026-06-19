# AVINA Portal — Step-by-step user guide

Web address: **https://production.srrieaswari.com**
Works on a computer and on a phone. Use Chrome or Safari.

This guide is task-by-task. Find your job below and follow the numbered steps.

---

## 1. Logging in
1. Open the web address above.
2. Type your **email** and **password** (given to you by Head Office).
3. Click **Log in**. You land on the **Dashboard**.
4. To leave, click **Logout** (top right).

**The menu** (top bar): click a category to open it.
- **Dashboard** · **Pending Changes**
- **Sales** → Sales Orders
- **Receiving** → Material Requests · Goods Received
- **Production** → Order Board · Packing Schedule · Grinding · Drying & Roasting · Moisture · OPRP Record
- **Reports** → Stock · Traceability · Items (+ BOM, Location Map for Head Office)
- **Setup** → Users · Allowed Networks (Head Office)

You only see the parts your account is allowed to use.

---

## 2. Sales orders (Office / Head Office)

### Upload a customer order
1. Menu: **Sales → Sales Orders**.
2. Click **Upload** and choose the order PDF.
3. Wait — the system reads it (status goes Processing → Review). The lines appear automatically.

### Check / correct a line
Lines can't be typed over directly — corrections are approved.
1. On a line, click **Request change** (or **Request delete**).
2. Choose the field, type the correct value, add a reason.
3. Click **Submit**. It now waits in **Pending Changes** for Head Office.

### Confirm to production (Head Office)
1. Open the document. In the **Confirm to production** panel you'll see a row per factory.
2. Click **Confirm** for each factory. (Blocked if that factory still has a pending change or a duplicate — fix those first.)
3. Confirmed lines turn into **production batches** on the Order Board.

---

## 3. Order board (Production planning)
1. Menu: **Production → Order Board**.
2. Each card is a **production batch** (PB-number) with the customers and quantities.
3. To plan packing: open a batch → **Pack plan** → choose the **line** and **date** → **Save**.
4. To ask the warehouse for materials: open the batch → **Materials** → set the **expiry date** → **Raise request**. (This creates a Material Request.)

---

## 4. Material requests (Warehouse)
1. Menu: **Receiving → Material Requests**.
2. **Combined picking** tab pools everything to pick.
3. Click **Release** for your factory → it becomes a numbered **pick run**.
4. Click **Download PDF** to print the picking list.
5. (Receiving the materials is done on **Goods Received**, not here.)

---

## 5. Goods received (Warehouse)
When a delivery arrives with a Delivery Order (DO):
1. Menu: **Receiving → Goods Received**.
2. Click **Upload** and choose the DO PDF. The system reads the lines.
3. Click **View Lines**.
4. For each line: tick the **QC** box and take a **photo** (📷).
5. Once QC + photo are done, click **Receive** on that line (or **Receive all ready**).
6. The stock is added as a **batch** (with expiry if any). Bag/carton quantities convert to kg automatically.

---

## 6. Stock (everyone)
1. Menu: **Reports → Stock**.
2. See on-hand per item, broken down by **batch and expiry**.
3. Materials are used **earliest-expiry-first**; expired lots are shown in red.

---

## 7. Drying & roasting (Factory — only if the product needs it)
1. Menu: **Production → Drying & Roasting → + New record**.
2. Pick the **item**, enter the **batch before oven** (e.g. 260606) and **Qty in (kg)**.
3. Enter the **new batch after oven** (e.g. 260606AH) and **Qty out (kg)**.
4. Record the oven/roast checks: click **▶ Start** when it reaches temperature, **⏹ Finish** when done (the timer runs). Fill temps + moisture.
5. Click **Save**.
6. **Re-open** the record and click **Move to stock** — this takes the old batch off stock and adds the new batch (with the weight loss). It then shows **✓ Stock moved**.

---

## 8. Grinding & mixing (Factory)

### A) Mixer — set up a recipe (one time per product)
1. Menu: **Production → Grinding → Recipes tab → + New recipe**.
2. Pick the **product** (from the item list), choose **type** (Direct / Mixing).
3. Add each **ingredient** (from the item list) with its **quantity per 1 lot**.
4. Click **Save recipe**. (Only the mixer sees recipes.)

### B) Operator — produce
1. **Production tab** → type the **product** in the search box.
2. Enter the **number of lots** → click **Produce**. The system works out the quantities. (Operators never see the formula.)

### C) Mixer — do the mixing
1. Open the produced record.
2. For each material: enter the **batch number** used and tick **Added** as you add it.
3. Use the **mix timer** (Start / Pause / Stop).
4. Click **Save**.

### D) QC — inspection part
1. Open the record → fill crusher condition, rework/rejection, **Verified by** → **Save**. (QC does not see the mixture.)

---

## 9. Moisture reading (QC)
1. Menu: **Production → Moisture → + New record**.
2. Pick the item, enter batch, sample details, **weight (g)**, **time (min)**, **moisture (%)**, checked/verified by.
3. **Save**.

---

## 10. OPRP record (QC / line)
1. Menu: **Production → OPRP Record → + New record**.
2. Pick the item and batches. Use the **process timer** (Start = in, Finish = out).
3. Fill handpicking (Pass/Fail), sieve condition (Good/Broken), needle & seal, rework/waste, done/verified by.
4. **Save**.

---

## 11. Packing schedule (Packing)
1. Menu: **Production → Packing Schedule**.
2. Pick the **date** (defaults to today). See what each line must pack.
3. Click a batch to open its **Inspection Record**.

---

## 12. Inspection record — P07-F01 (Packing / QC)
1. Opened from a batch (Packing Schedule or Order Board → **Inspection Record**).
2. Use the **production run timer**: **▶ Start** when you begin, **⏸ Pause** for breaks, **⏹ Stop** at the end.
3. Enter **Quantity produced** → click **Record production**. This **uses up the raw-material batches** (earliest expiry first) automatically.
4. Fill the QC sections: sealing, **metal detector**, sensory, sign-offs.
5. Click **Save**. Use **🖨 Print / PDF** for a paper copy.

---

## 13. Traceability / recall report (everyone)
1. Menu: **Reports → Traceability**.
2. Search and pick a **produced batch**.
3. You'll see: the finished batch + QC result, every **raw-material batch** that went into it (and which **DO** it came on), and **every other finished batch** that used the same materials (the recall scope).
4. Click **🖨 Print** for a clean report.

---

## 14. Cancelling a timer pressed by mistake
1. On any timer (grinding, drying, OPRP, inspection), click **Request to cancel**.
2. Type the reason → it goes to **Pending Changes**.
3. Head Office approves it → the timer is cleared.

---

## 15. Pending changes (Head Office)
1. Menu: **Pending Changes**.
2. **Top table** = sales-order corrections. **Timer cancellations** section = accidental timers.
3. Click **Approve** or **Reject** on each. Every decision is logged with your name.

---

## 16. Setup (Head Office / Admin)

### Items
- **Reports → Items**: search/add items; bulk upload via CSV (Download template first).

### Bill of materials (recipes for packing)
- **Reports → BOM**: define each manufactured item's components.

### Users & permissions
1. **Setup → Users → Edit** (or **+ Add User**).
2. Set name, factory access (tick one or several factories, or Head Office), role, and (optional) reset password.
3. In the **permission grid**, tick **View / Edit / Delete** per section. Leave **Grinding / Grinding recipe** unticked unless that person needs it.
4. **Save.**

### Allowed networks (office-only access)
1. **Setup → Allowed Networks**.
2. At each factory, on its Wi-Fi, click **+ Add this IP** (label it).
3. When all factories are added, switch **Office-only access ON**.

---

## Quick rules to tell staff
- You only see what you're allowed to.
- Don't share logins.
- Corrections and accidental timers go through **Pending Changes** — don't worry, just request it.
- Materials are always used **earliest-expiry / oldest-batch first**.
- Recipes are secret — only the mixer sees them.
