# AbsensiMuka

Aplikasi absensi karyawan sederhana untuk satu lokasi, menggunakan face recognition di browser dan backend Node.js + Express + SQLite.

## Fitur

- Kiosk absensi otomatis dengan kamera, bounding box, pencocokan euclidean distance, threshold configurable, cooldown, dan alur masuk/keluar per hari.
- Pendaftaran karyawan dengan nama, NIP/ID, descriptor 128 angka, dan thumbnail foto.
- Rekap absensi berdasarkan tanggal.
- Database lokal `data/attendance.db`.
- File Excel otomatis `data/rekap-absensi.xlsx`, berisi seluruh riwayat absensi dan diperbarui setiap ada absen masuk/keluar.

## Setup

Prasyarat: Node.js 18+ dan npm.

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Berikan izin kamera pada browser. Untuk penggunaan melalui perangkat lain atau jaringan, browser biasanya membutuhkan HTTPS (localhost tetap diizinkan untuk pengembangan).

## Model face-api.js

File model tidak disertakan karena ukuran dan lisensinya. Unduh tiga model berikut dari repositori resmi `face-api.js` lalu letakkan semua file manifest dan shard ke folder `public/models/`:

- `tiny_face_detector_model-weights_manifest.json` dan shard terkait
- `face_landmark_68_model-weights_manifest.json` dan shard terkait
- `face_recognition_model-weights_manifest.json` dan shard terkait

Salah satu sumber unduhan yang praktis adalah folder `weights` pada repositori `justadudewhohacks/face-api.js` di GitHub. Pastikan nama file tetap asli. Secara default aplikasi memakai model resmi dari GitHub Pages; untuk deployment offline, ubah `MODEL_URL` di `public/app.js` menjadi `/models` setelah file model diletakkan di folder tersebut.

## Endpoint

- `GET /api/employees`
- `GET /api/employees/descriptors`
- `POST /api/employees`
- `DELETE /api/employees/:id`
- `POST /api/attendance/checkin`
- `GET /api/attendance?tanggal=YYYY-MM-DD`
- `GET /api/attendance/export.xlsx?tanggal=YYYY-MM-DD`

Tombol Export Excel mengunduh file yang sama dengan nama `rekap-absensi.xlsx`. File tersebut memuat seluruh riwayat, bukan hanya tanggal yang sedang dipilih.

## Keamanan produksi

Descriptor wajah dan foto adalah data biometrik sensitif. Contoh ini ditujukan untuk skala kecil dan pengembangan lokal. Sebelum produksi, tambahkan HTTPS, autentikasi admin untuk pendaftaran/penghapusan, kontrol akses dashboard, audit log, kebijakan retensi/penghapusan data, backup terenkripsi, validasi ukuran request, dan persetujuan pemrosesan data sesuai regulasi yang berlaku. Jangan mengekspos endpoint pendaftaran secara publik.
