# TelurKu Railway Scheduler

Worker Node.js untuk menjalankan penjadwalan panen otomatis di Railway.

## Fungsi Utama

- Menjalankan cek jadwal setiap menit (timezone default `Asia/Jakarta`).
- Membaca jadwal aktif dari `kontrol/penjadwalan`.
- Membaca sensor dari `data` berdasarkan `infraPath` kandang (`kontrol/kandang`).
- Menyimpan hasil ke:
  - `panen_snapshot/{yyyy-MM-dd}`
  - `riwayat/records`
  - `riwayat/summary`
- Mencegah duplikasi eksekusi dengan lock harian di `scheduler_runs/{yyyy-MM-dd}`.

## Struktur Folder

- `worker.js` : engine scheduler + health endpoint
- `package.json` : dependency dan start command
- `Dockerfile` : container build untuk Railway
- `.dockerignore` : optimasi image build
- `.env.example` : template environment variables
- `railway.json` : config deploy Railway

## Environment Variables (Railway)

Gunakan nilai ini di Railway Variables:

- `PORT=3000`
- `TZ=Asia/Jakarta`
- `SCHEDULER_ENABLED=true`
- `FIREBASE_SERVICE_ACCOUNT_JSON=<json-service-account-penuh>` (opsi paling mudah)
- `FIREBASE_PROJECT_ID=telurku-fa78c`
- `FIREBASE_CLIENT_EMAIL=<service-account-email>`
- `FIREBASE_PRIVATE_KEY=<private-key-dengan-escaped-newline>`
- `FIREBASE_DATABASE_URL=https://telurku-fa78c-default-rtdb.asia-southeast1.firebasedatabase.app`

Catatan untuk `FIREBASE_PRIVATE_KEY`:
- Gunakan format satu baris dengan `\n` (lihat `.env.example`).
- Jangan commit private key ke Git.

Catatan untuk `FIREBASE_SERVICE_ACCOUNT_JSON`:
- Bisa isi seluruh JSON service account dalam satu variable Railway.
- Tetap jangan taruh nilainya di source code atau file yang di-commit.

## Deploy di Railway

1. Buat service baru dari repo ini.
2. Set **Root Directory** ke `railway-scheduler`.
3. Railway bisa build via `Dockerfile` atau Nixpacks.
4. Isi semua environment variables.
5. Deploy.
6. Cek log, pastikan muncul:
   - `[init] Firebase Admin connected`
   - `[init] Scheduler active`

## Health Check

- Endpoint: `/health`
- Response: `{ "ok": true, "service": "telurku-railway-scheduler" }`

## Local Test

```bash
cd railway-scheduler
npm install
cp .env.example .env
# isi env yang benar
npm start
```

## Data Path yang Dipakai

- Read: `kontrol/penjadwalan`
- Read: `kontrol/kandang`
- Read: `data`
- Write: `riwayat/records`
- Write: `riwayat/summary`
- Write: `panen_snapshot/{date}`
- Write lock: `scheduler_runs/{date}`

## Reset Otomatis Sore

Setelah jadwal sore berhasil dieksekusi, worker akan me-reset:

- `data/infra1 = 0`
- `data/infra2 = 0`

Ringkasan harian di `riwayat/summary` tetap disimpan untuk kebutuhan tampilan Flutter.
