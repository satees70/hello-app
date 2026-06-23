# EASWARI / AVINA — Panduan Pasukan Pengeluaran

**Proses penuh, langkah demi langkah.** Ikut peringkat mengikut urutan. Tanda
`📷 [Screenshot]` ialah tempat gambar akan dimasukkan kemudian. Nama butang dan
menu dikekalkan dalam Bahasa Inggeris kerana itulah yang dipaparkan pada skrin.

---

## 0. Permulaan (semua orang)

**Log masuk**
1. Buka **production.srrieaswari.com** dalam pelayar (di telefon, guna Safari).
2. Masukkan **username** dan **password** → **Login**.
3. Anda akan tiba di **Dashboard**. Bar biru di atas ialah menu:
   **Dashboard · Pending Changes · Discussion · Sales · Receiving · Production · Reports · Setup**, dengan **🔔 loceng** dan nama anda di sebelah kanan.
4. Cip berhampiran nama anda menunjukkan akses anda: kod **kilang** (cth. AVINA 101) atau **Head Office** (boleh lihat semua).
📷 [Screenshot: Dashboard selepas login]

**Apa yang anda boleh lihat/buat**
- Anda hanya nampak dan boleh ubah kerja untuk **lokasi anda sendiri**.
- Head Office boleh lihat semua kilang dan meluluskan perubahan.

**Notifikasi telefon (telefon pejabat)**
1. Buka laman dalam **Safari** → **Share** → **Add to Home Screen**.
2. Buka aplikasi dari **ikon Home Screen** (bukan tab Safari).
3. Tekan **🔔 → Enable on this phone → Allow**.
4. Anda akan terima notifikasi walaupun aplikasi ditutup.

---

## 1. Sales Orders (Pejabat)

**Di mana:** Sales → Sales Orders. **Siapa:** Pejabat. **Bila:** apabila pesanan pelanggan tiba.

**A. Muat naik pesanan**
1. Klik **Choose File**, pilih **PDF Sales Order** pelanggan, klik **Upload**.
2. Sistem akan baca pesanan dan senaraikannya di bawah **Uploaded Documents** dengan status (biasanya **Review**).
📷 [Screenshot: Muat naik Sales Orders + senarai dokumen]

**B. Semak baris (lines)**
1. Cari dokumen (guna **Search file or item**, atau penapis **Location / Status / Issues**).
2. Klik **View Lines** untuk lihat setiap item, kuantiti, tarikh hantar, lokasi dan status.
3. Guna kotak **Search** atau penapis setiap lajur untuk cari item.
📷 [Screenshot: Paparan baris dokumen]

**C. Betulkan baris jika perlu**
- **Sebelum lokasi itu confirm:** staf boleh tukar **Location** dan **Delivery Date** terus (tanpa kelulusan). Klik **Edit** pada baris. Head Office boleh tukar mana-mana medan.
- **Selepas confirm:** klik **Request change** — Head Office akan luluskan.
- Untuk pindah pesanan ke lokasi lain, tukar **Location** (kilang akan dikemas kini automatik).
📷 [Screenshot: Panel Edit this line]

**D. Pesanan segera (urgent)**
- Klik **Mark urgent** pada dokumen. Ia bertukar merah dan kekal ditanda sepanjang proses, dan lokasi akan dimaklumkan.

**E. Confirm to production**
1. Skrol ke bahagian **Confirm to production**.
2. Setiap lokasi klik **Confirm <kilang> lines**. Baris itu akan dihantar ke **Order Board** kilang berkenaan.
3. Dokumen tidak boleh di-confirm selagi ada perubahan yang belum lulus (pending).
📷 [Screenshot: Bahagian Confirm to production]

---

## 2. Order Board — rancang pengeluaran (Kilang)

**Di mana:** Production → Order Board. **Siapa:** Perancang kilang. **Bila:** selepas baris di-confirm.

1. Pesanan yang telah di-confirm muncul sebagai **batch**. Tab di atas: **not requested yet / requested / in progress / done**. Tapis ikut **Factory**, tarikh hantar, atau **Sort**.
2. Tanda **Combine same item to run together** untuk kumpulkan item yang sama jadi satu larian.
📷 [Screenshot: Order Board dengan batch]

**Mohon bahan (raise materials)**
3. Klik **Materials** pada batch (atau kumpulan gabungan).
4. Pilih **Run mode**: *Auto machine* (roll) atau *Manual* (pieces) — ini menentukan pembungkusan yang diperlukan.
5. Jadual menunjukkan **Required vs Stock vs Shortfall**.
6. **Pesanan biasa:** klik **Raise Material Request**.
7. **Pesanan ad-hoc (pembungkusan berbeza, cth. plastik 1kg vs 5kg):** tanda **✎ Customise materials (ad-hoc)** → ubah kuantiti, **remove** baris, atau **add** bahan (cth. plastik 5kg) → **Raise ad-hoc request**. Ini **tidak** mengubah resipi (BOM) yang disimpan.
📷 [Screenshot: Tetingkap Material requirements + butang ad-hoc]

**Jika nampak ⚠ No BOM set:** resipi belum ada — sediakan dahulu di Reports → BOM.

---

## 3. Material Requests & gudang

**Di mana:** Receiving → Material Requests.

**Kilang / Head Office — release ke gudang**
1. Permohonan baru terkumpul di bawah **⏳ Waiting to release** untuk setiap kilang.
2. Bila sedia, klik **Release to warehouse →**. Ini menghantar satu **pick run** tetap; apa yang dimohon selepas itu menunggu release seterusnya.
📷 [Screenshot: Waiting to release + butang Release]

**Mohon bahan secara manual (ad-hoc / bukan dari batch)**
1. Klik **➕ Request a material manually**.
2. (Pilihan) **Load from a product's recipe** — pilih produk + bilangan unit untuk isi resipi automatik, kemudian tukar plastik / ubah kuantiti.
3. Atau tambah item satu demi satu (cari item, masukkan qty, **+ Add item**).
4. **Submit request** — ia akan masuk ke Waiting to release.
📷 [Screenshot: Borang permohonan manual]

**Gudang — pick dan rekod**
1. Guna dropdown **Location** dan **Status** untuk cari run (New / SO entered / Partially received / Fully received).
2. Bagi setiap run yang di-release: taip **SO number**, klik **Save**.
3. Pick keseluruhan run dalam satu trip; taip **total received** bagi setiap bahan — ia akan dibahagi semula kepada permohonan asal secara automatik.
📷 [Screenshot: Pick run, paparan gudang]

---

## 4. Goods Received / Terima Barang (Kilang / Gudang)

**Di mana:** Receiving → Goods Received. **Bila:** apabila penghantaran tiba.

1. Klik **Choose File**, muat naik **PDF Delivery Order (DO)**, klik **Upload**. Sistem akan baca baris.
2. Klik **View Lines** (guna **Search** item jika senarai panjang).
3. Bagi setiap baris: **tanda QC**, tambah **gambar** (pilihan untuk Head Office), kemudian **Receive**. Boleh terima sebahagian dahulu, baki kemudian. Barang yang diterima akan **masuk ke stock**.
4. Kuantiti beg/karton ditukar ke KG secara automatik. Jika diminta, tetapkan **KG per bag** pada item.
5. Kuantiti salah? Guna **Correct received quantity**. Kod salah? Guna **Request edit**.
📷 [Screenshot: Goods Received — QC/gambar/Receive]

---

## 5. Labels / Label (Kilang)

**Di mana:** Receiving → Labels.

1. Label muncul di sini sebaik bahan mentah pesanannya diterima (peringkat **Material received**).
2. Masukkan **nombor batch / tarikh luput (expiry)** dan **kuantiti untuk cetak**, lampirkan **gambar** label yang dicetak → peringkat bertukar **Printed**.
3. Tanda label → **Send** → kemudian **Receive → stock** apabila tiba (masuk stock label).
4. Label sekali sahaja? **➕ Request a label manually** (pilih label, produk, qty, batch, expiry).
📷 [Screenshot: Aliran Labels]

---

## 6. Packing Schedule / Jadual Pembungkusan (Kilang)

**Di mana:** Production → Packing Schedule.

1. Bahagian: **Scheduled to pack → Ready to pack → Waiting for materials**.
2. Tetapkan **pack line**, **tarikh**, dan **run mode** bagi setiap batch.
3. Klik **▸ show materials** untuk lihat, bagi setiap bahan, **batch stock yang perlu diguna** (expiry paling awal dahulu). Batch yang ditempah untuk run itu ditanda **★ — guna ini dahulu**.
📷 [Screenshot: Packing Schedule + show materials]

---

## 7. Rekod pengeluaran (Line / QC)

**Di mana:** buka **Packing & Finished Goods Inspection Record** bagi batch tersebut.

1. **Date, Area/Line, Code, Product** diambil dari Packing Schedule dan **dikunci**. Jika ada yang salah, betulkan di **Packing Schedule** (tarikh bertukar merah jika bukan hari ini).
2. **Timer pengeluaran:** **Start** di permulaan, **Pause** untuk rehat, **Stop** di akhir.
3. **Materials used:** **batch & kuantiti telah diisi** dari yang ditempah. Laraskan **Qty used**; guna **+ add batch** jika satu batch tidak mencukupi.
4. Isi pemeriksaan kualiti (sampel sealing, CCP2, metal detector, dll.).
5. Masukkan **Quantity produced** → **Record production**. Ini akan **menolak bahan mentah dari stock** (expiry paling awal dahulu).
6. Jika **food loss melebihi 5%**, ia akan ditanda kepada Head Office secara automatik.
📷 [Screenshot: Inspection record — header, timer, materials used]

---

## 8. Dihantar ke gudang / Delivery Orders

**Di mana:** Sales → Delivery Orders.

1. Barang siap dihantar ke gudang di sini. Apabila dihantar, lokasi dimaklumkan dan baris pesanan bertukar **Delivered to warehouse**.
📷 [Screenshot: Delivery Orders]

---

## 9. Membeli dari pembekal (Pejabat)

**Di mana:** Sales → Supplier (to order).

1. Tab **To order**: item yang dihala ke SUPPLIER, dikumpul ikut item, dengan **Outstanding** (jumlah perlu dibeli) dan tarikh hantar terdekat.
2. Tanda item (atau **Select all**), atau **tambah item secara manual** (tambah stok yang rendah).
3. Taip **nama Pembekal (Supplier name)**, laraskan kuantiti, **Place order** (satu pesanan gabungan).
4. Tab **Placed orders**: **Mark received** apabila barang tiba.
📷 [Screenshot: Supplier to-order + place order]

---

## 10. Discussion (berbincang sesama sendiri)

**Di mana:** Discussion (menu atas).

- Hantar mesej; **pautkan ke SO** supaya difailkan di bawah pesanan itu.
- **@tag seseorang** atau **@tag satu lokasi** (semua di situ akan dimaklumkan).
- **Reply** pada mesej untuk memetiknya dan memaklumkan penghantar.
- Lencana **💬** pada Sales Order bermaksud ada perbincangan — klik untuk buka.
📷 [Screenshot: Papan Discussion]

---

## 11. Loceng 🔔 (notifikasi)

- Menunjukkan bilangan perkara baru untuk **lokasi anda**. Klik untuk baca; klik satu untuk buka halaman berkaitan.
- Anda dimaklumkan untuk: pesanan baru, pesanan segera, pick run di-release, pesanan di-confirm, barang diterima, barang siap dihantar, dan **@mention** dalam Discussion.

---

## 12. Head Office — Kelulusan

**Di mana:** Pending Changes (lencana menunjukkan bilangan menunggu).

Lulus/tolak: perubahan sales order, padam dokumen, perubahan item/SO, batch split, pelarasan stock, pindah kuantiti diterima, perubahan run-mode, pembatalan material request, suntingan return, amaran food-loss.

---

## Senarai semak harian

| Peranan | Buat ini |
|---|---|
| **Pejabat** | Muat naik SO → confirm to production → tanda urgent → buat pesanan pembekal |
| **Kilang** | Order Board → mohon bahan → terima barang → cetak/hantar label → jadual pembungkusan → rekod pengeluaran |
| **Gudang** | Release pick run → masukkan SO number → rekod apa yang di-pick |
| **Head Office** | Selesaikan Pending Changes |
| **Semua** | Semak loceng 🔔 dan Discussion |
