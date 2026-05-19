require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || 'Asia/Jakarta';
const SCHEDULER_ENABLED = String(process.env.SCHEDULER_ENABLED || 'true') === 'true';
const COMPACT_MODE = String(process.env.COMPACT_MODE || 'true') === 'true';
const RIWAYAT_MAX_RECORDS = Number(process.env.RIWAYAT_MAX_RECORDS || 500);
const SCHEDULER_RUNS_RETAIN_DAYS = Number(process.env.SCHEDULER_RUNS_RETAIN_DAYS || 14);

function getEnvOrThrow(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }
  return value;
}

// PERBAIKAN:
function parseServiceAccountFromEnv() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: String(parsed.private_key || '').replace(/\\n/g, '\n'),
    };
  }

  // Panggil NAMA VARIABEL yang didaftarkan di Railway
  return {
    projectId: getEnvOrThrow('FIREBASE_PROJECT_ID'),
    clientEmail: getEnvOrThrow('FIREBASE_CLIENT_EMAIL'),
    privateKey: getEnvOrThrow('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  };
}

function initFirebase() {
  const { projectId, clientEmail, privateKey } = parseServiceAccountFromEnv();
  // Panggil NAMA VARIABEL untuk URL database
  const databaseURL = getEnvOrThrow('FIREBASE_DATABASE_URL');

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    databaseURL,
  });

  console.log('[init] Firebase Admin connected:', projectId);
}

function getJakartaNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatHHMM(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value) {
  const d = new Date(String(value || ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeKandangKey(kandangId, kandangNama) {
  const rawId = String(kandangId || '').toLowerCase();
  const rawNama = String(kandangNama || '').toLowerCase();
  const merged = `${rawId} ${rawNama}`;
  const compact = merged.replace(/[^a-z0-9]/g, '');

  if (compact.includes('kandang1')) return 'kandang1';
  if (compact.includes('kandang2')) return 'kandang2';
  return 'lainnya';
}

function parseDurasiMs(durasiRaw) {
  const text = String(durasiRaw || '').toLowerCase().trim();
  if (!text) return 30 * 60 * 1000;

  const number = Number.parseInt(text.replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(number) || number <= 0) return 30 * 60 * 1000;

  if (
    text.includes('jam') ||
    text.includes('hour') ||
    text.includes('hours') ||
    text.includes('hr')
  ) {
    return number * 60 * 60 * 1000;
  }

  return number * 60 * 1000;
}

function isAllKandangSchedule(jadwal) {
  const kandangId = String(jadwal.kandangId || '').toLowerCase().trim();
  const kandangNama = String(jadwal.kandangNama || '').toLowerCase().trim();
  return (
    kandangId === 'all' ||
    kandangId === 'global' ||
    kandangId === 'semua' ||
    kandangNama.includes('global') ||
    kandangNama.includes('semua') ||
    kandangNama.includes('all')
  );
}

function resolveTargetKandangIds(jadwal, kandangMap) {
  if (isAllKandangSchedule(jadwal)) {
    const ids = Object.keys(kandangMap || {});
    if (ids.length > 0) return ids;
    return ['kandang1', 'kandang2'];
  }

  const kandangId = String(jadwal.kandangId || '').trim();
  if (!kandangId) return [];
  return [kandangId];
}

function detectJenisPanen(jadwal) {
  const jam = String(jadwal.jam || '09:00');
  const hour = Number(jam.split(':')[0] || 9);
  const ket = String(jadwal.keterangan || '').toLowerCase();

  if (ket.includes('sore')) return 'sore';
  if (ket.includes('pagi')) return 'pagi';
  return hour >= 12 ? 'sore' : 'pagi';
}

function resolveInfraPath(kandangId, kandangData) {
  if (kandangData && kandangData.infraPath) {
    return String(kandangData.infraPath);
  }

  const id = String(kandangId || '').toLowerCase();
  if (id.includes('1')) return 'infra1';
  if (id.includes('2')) return 'infra2';
  return 'infra1';
}

async function acquireRunLock(todayKey, lockKey) {
  const lockRef = admin.database().ref(`scheduler_runs/${todayKey}/${lockKey}`);
  const tx = await lockRef.transaction((current) => {
    if (current) return current;
    return {
      executedAt: new Date().toISOString(),
      source: 'railway-scheduler',
    };
  });

  return tx.committed;
}

async function updateRiwayatSummary({ kandangId, kandangNama, jumlahTelur, dateKey }) {
  const summaryRef = admin.database().ref('riwayat/summary');
  const kandangKey = normalizeKandangKey(kandangId, kandangNama);
  const totalAdd = toInt(jumlahTelur);

  await summaryRef.transaction((current) => {
    const nowData = current || {};
    const lastDate = String(nowData.last_reset_date || '');

    let telurHariIni = toInt(nowData.telur_hari_ini);
    let kandang1 = toInt(nowData.kandang1_hari_ini);
    let kandang2 = toInt(nowData.kandang2_hari_ini);
    let totalTelur = toInt(nowData.total_telur);

    if (lastDate !== dateKey) {
      telurHariIni = 0;
      kandang1 = 0;
      kandang2 = 0;
    }

    telurHariIni += totalAdd;
    totalTelur += totalAdd;

    if (kandangKey === 'kandang1') kandang1 += totalAdd;
    if (kandangKey === 'kandang2') kandang2 += totalAdd;

    return {
      ...nowData,
      telur_hari_ini: telurHariIni,
      kandang1_hari_ini: kandang1,
      kandang2_hari_ini: kandang2,
      total_telur: totalTelur,
      last_reset_date: dateKey,
      updated_at: new Date().toISOString(),
    };
  });
}

async function resetSensorAfterEvening(todayKey) {
  const lockKey = 'evening_sensor_reset';
  const gotLock = await acquireRunLock(todayKey, lockKey);
  if (!gotLock) {
    console.log('[skip] Sensor reset sudah dieksekusi hari ini');
    return;
  }

  await admin.database().ref('data').update({
    infra1: 0,
    infra2: 0,
    last_reset_by_scheduler: new Date().toISOString(),
  });

  console.log('[ok] Sensor infra1/infra2 di-reset otomatis setelah jadwal sore');
}

async function writeRiwayat({
  kandangId,
  kandangNama,
  jumlahTelur,
  jam,
  jenisPanen,
  sensorSnapshot,
  panenSebelumnya,
  catatan,
  dateKey,
}) {
  const riwayatRef = admin.database().ref('riwayat/records').push();
  const now = new Date();
  const jumlah = toInt(jumlahTelur);
  const sensor = toInt(sensorSnapshot);

  await riwayatRef.set({
    id: `railway_${Date.now()}`,
    kandang_id: kandangId,
    kandang_nama: kandangNama,
    jumlah_telur: jumlah,
    tanggal_panen: now.toISOString(),
    jam,
    jenis_panen: jenisPanen,
    sensor_snapshot: sensor,
    panen_sebelumnya: panenSebelumnya == null ? null : Number(panenSebelumnya),
    catatan,
  });

  await updateRiwayatSummary({
    kandangId,
    kandangNama,
    jumlahTelur: jumlah,
    dateKey,
  });
}

async function shouldRunMaintenance() {
  const lockRef = admin.database().ref('maintenance/migration_v2_global_alias');
  const tx = await lockRef.transaction((current) => {
    if (current && current.done === true) return current;
    return {
      done: true,
      done_at: new Date().toISOString(),
      source: 'railway-scheduler',
    };
  });
  return tx.committed;
}

function looksLikeLegacyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'kandang_id' in value && 'tanggal_panen' in value;
}

function buildKandangNameMap(kandangMap) {
  const map = {};
  for (const kandangId of Object.keys(kandangMap || {})) {
    const kandang = kandangMap[kandangId];
    map[kandangId] = String((kandang && kandang.nama) || kandangId);
  }
  return map;
}

function parseDateKeyFromIso(iso) {
  const date = new Date(String(iso || ''));
  if (Number.isNaN(date.getTime())) return null;
  return formatDateKey(date);
}

async function inferTargetForGlobalRecord(record, kandangMap) {
  const dateKey = parseDateKeyFromIso(record.tanggal_panen);
  if (!dateKey) return null;

  const jenis = String(record.jenis_panen || '').toLowerCase();
  const sessionKey = jenis === 'sore' ? 'sore' : 'pagi';
  const sessionSnapRef = admin.database().ref(`panen_snapshot/${dateKey}/${sessionKey}`);
  const sessionSnap = await sessionSnapRef.get();
  if (!sessionSnap.exists() || typeof sessionSnap.val() !== 'object') return null;

  const snapData = sessionSnap.val();
  const candidates = [];
  for (const kandangId of Object.keys(kandangMap || {})) {
    if (!Object.prototype.hasOwnProperty.call(snapData, kandangId)) continue;
    const snapVal = toInt(snapData[kandangId]);
    if (jenis === 'sore') {
      const deltaKey = `delta_${kandangId}`;
      const deltaVal = toInt(snapData[deltaKey]);
      if (deltaVal === toInt(record.jumlah_telur) || snapVal === toInt(record.sensor_snapshot)) {
        candidates.push(kandangId);
      }
    } else if (snapVal === toInt(record.sensor_snapshot) || snapVal === toInt(record.jumlah_telur)) {
      candidates.push(kandangId);
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function migrateLegacyRiwayatData(kandangMap) {
  const riwayatRef = admin.database().ref('riwayat');
  const rootSnap = await riwayatRef.get();
  if (!rootSnap.exists() || typeof rootSnap.val() !== 'object') {
    return;
  }

  const root = rootSnap.val();
  const recordsRef = admin.database().ref('riwayat/records');
  const summaryRef = admin.database().ref('riwayat/summary');
  const kandangNameMap = buildKandangNameMap(kandangMap);

  if (!root.summary && (root.telur_hari_ini != null || root.total_telur != null)) {
    await summaryRef.update({
      telur_hari_ini: toInt(root.telur_hari_ini),
      total_telur: toInt(root.total_telur),
      last_reset_date: String(root.last_reset_date || formatDateKey(getJakartaNow())),
      kandang1_hari_ini: toInt(root.kandang1_hari_ini),
      kandang2_hari_ini: toInt(root.kandang2_hari_ini),
      updated_at: new Date().toISOString(),
      migrated_from_legacy: true,
    });
  }

  const cleanupUpdates = {};

  for (const [legacyKey, value] of Object.entries(root)) {
    if (legacyKey === 'records' || legacyKey === 'summary') continue;
    if (!looksLikeLegacyRecord(value)) {
      // Hapus field summary lama atau node lama non-record.
      cleanupUpdates[legacyKey] = null;
      continue;
    }

    const record = { ...value };
    const kandangIdRaw = String(record.kandang_id || '').toLowerCase();
    const kandangNamaRaw = String(record.kandang_nama || '').toLowerCase();
    const isGlobal =
      kandangIdRaw === 'global' ||
      kandangIdRaw === 'all' ||
      kandangIdRaw === 'semua' ||
      kandangNamaRaw.includes('global') ||
      kandangNamaRaw.includes('semua') ||
      kandangNamaRaw.includes('all');

    if (!isGlobal) {
      await recordsRef.push().set({
        ...record,
        migrated_from_legacy: true,
        migrated_at: new Date().toISOString(),
      });
      cleanupUpdates[legacyKey] = null;
      continue;
    }

    const inferredKandangId = await inferTargetForGlobalRecord(record, kandangMap);
    if (inferredKandangId) {
      await recordsRef.push().set({
        ...record,
        kandang_id: inferredKandangId,
        kandang_nama: kandangNameMap[inferredKandangId] || inferredKandangId,
        migrated_from_global: true,
        migrated_at: new Date().toISOString(),
      });
      cleanupUpdates[legacyKey] = null;
      continue;
    }

    // Fallback: jika tidak bisa infer unik, split ke semua kandang aktif.
    const kandangIds = Object.keys(kandangMap || {});
    if (kandangIds.length === 0) {
      cleanupUpdates[legacyKey] = null;
      continue;
    }

    const total = toInt(record.jumlah_telur);
    const base = Math.floor(total / kandangIds.length);
    let remainder = total % kandangIds.length;

    for (const kandangId of kandangIds) {
      const porsi = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;

      await recordsRef.push().set({
        ...record,
        kandang_id: kandangId,
        kandang_nama: kandangNameMap[kandangId] || kandangId,
        jumlah_telur: porsi,
        migrated_from_global_split: true,
        migrated_at: new Date().toISOString(),
      });
    }

    cleanupUpdates[legacyKey] = null;
  }

  if (Object.keys(cleanupUpdates).length > 0) {
    await riwayatRef.update(cleanupUpdates);
  }
}

async function normalizeRecordsNode() {
  const nestedRef = admin.database().ref('riwayat/records/records');
  const nestedSnap = await nestedRef.get();
  if (!nestedSnap.exists() || typeof nestedSnap.val() !== 'object') return;

  const recordsRef = admin.database().ref('riwayat/records');
  const nestedData = nestedSnap.val();

  for (const [key, value] of Object.entries(nestedData)) {
    if (!value || typeof value !== 'object') continue;
    await recordsRef.child(key).set(value);
  }

  await nestedRef.remove();
  console.log('[maintenance] Flattened riwayat/records/records into riwayat/records');
}

async function pruneOldRiwayatRecords(maxRecords) {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return;

  const recordsRef = admin.database().ref('riwayat/records');
  const snap = await recordsRef.get();
  if (!snap.exists() || typeof snap.val() !== 'object') return;

  const recordsData = snap.val();
  const entries = Object.entries(recordsData)
    .filter(([_, value]) => value && typeof value === 'object')
    .map(([key, value]) => {
      const date = toDate(value.tanggal_panen);
      return { key, time: date ? date.getTime() : 0 };
    })
    .sort((a, b) => b.time - a.time);

  if (entries.length <= maxRecords) return;

  const removeUpdates = {};
  for (const item of entries.slice(maxRecords)) {
    removeUpdates[item.key] = null;
  }

  await recordsRef.update(removeUpdates);
  console.log(`[maintenance] Pruned ${entries.length - maxRecords} old riwayat records (keep ${maxRecords})`);
}

async function pruneOldSchedulerRuns(retainDays) {
  if (!Number.isFinite(retainDays) || retainDays < 1) return;

  const runsRef = admin.database().ref('scheduler_runs');
  const snap = await runsRef.get();
  if (!snap.exists() || typeof snap.val() !== 'object') return;

  const runs = snap.val();
  const now = getJakartaNow();
  const cutoff = new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000);
  const removeUpdates = {};

  for (const dateKey of Object.keys(runs)) {
    const date = toDate(`${dateKey}T00:00:00+07:00`);
    if (!date) continue;
    if (date < cutoff) {
      removeUpdates[dateKey] = null;
    }
  }

  if (Object.keys(removeUpdates).length > 0) {
    await runsRef.update(removeUpdates);
    console.log(`[maintenance] Pruned old scheduler_runs older than ${retainDays} days`);
  }
}

async function runCompactMaintenance() {
  await normalizeRecordsNode();
  await pruneOldRiwayatRecords(RIWAYAT_MAX_RECORDS);
  await pruneOldSchedulerRuns(SCHEDULER_RUNS_RETAIN_DAYS);
}

async function runForSchedule(jadwalId, jadwal, dataSensor, kandangMap, todayKey) {
  const jam = String(jadwal.jam || '09:00');
  const jenisPanen = detectJenisPanen(jadwal);
  const durasiMs = parseDurasiMs(jadwal.durasi);

  console.log(
    `[info] ${jadwalId}: trigger motor dilewati di worker (durasi jadwal ${Math.round(
      durasiMs / 1000,
    )} detik), aktuator dikendalikan EPS/main.cpp`,
  );

  const targetKandangIds = resolveTargetKandangIds(jadwal, kandangMap);

  if (targetKandangIds.length === 0) {
    console.log(`[skip] ${jadwalId}: target kandang tidak ditemukan`);
    return;
  }

  for (const kandangId of targetKandangIds) {
    const lockKey = `${jadwalId}_${jenisPanen}_${kandangId}`;
    const gotLock = await acquireRunLock(todayKey, lockKey);
    if (!gotLock) {
      console.log(`[skip] ${jadwalId}/${kandangId}: sudah dieksekusi hari ini (${jenisPanen})`);
      continue;
    }

    const kandangData = kandangMap[kandangId] || null;
    const kandangNama = String(
      (kandangData && kandangData.nama) || jadwal.kandangNama || kandangId || 'Kandang',
    );
    const infraPath = resolveInfraPath(kandangId, kandangData);
    const sensorValue = Number(dataSensor[infraPath] || 0);

    if (jenisPanen === 'pagi') {
      await admin.database().ref(`panen_snapshot/${todayKey}/pagi`).update({
        [kandangId]: sensorValue,
        timestamp: new Date().toISOString(),
      });

      await writeRiwayat({
        kandangId,
        kandangNama,
        jumlahTelur: sensorValue,
        jam,
        jenisPanen: 'pagi',
        sensorSnapshot: sensorValue,
        panenSebelumnya: null,
        catatan: 'Auto-capture PAGI dari Railway scheduler',
        dateKey: todayKey,
      });

      console.log(`[ok] Pagi ${kandangNama}: ${sensorValue} telur (${infraPath})`);
      continue;
    }

    const pagiSnapRef = admin.database().ref(`panen_snapshot/${todayKey}/pagi/${kandangId}`);
    const pagiSnap = await pagiSnapRef.get();
    const nilaiPagi = pagiSnap.exists() ? Number(pagiSnap.val() || 0) : 0;
    const delta = Math.max(sensorValue - nilaiPagi, 0);

    await admin.database().ref(`panen_snapshot/${todayKey}/sore`).update({
      [kandangId]: sensorValue,
      [`delta_${kandangId}`]: delta,
      timestamp: new Date().toISOString(),
    });

    await writeRiwayat({
      kandangId,
      kandangNama,
      jumlahTelur: delta,
      jam,
      jenisPanen: 'sore',
      sensorSnapshot: sensorValue,
      panenSebelumnya: nilaiPagi,
      catatan: `Auto-capture SORE dari Railway scheduler (delta: ${sensorValue} - ${nilaiPagi})`,
      dateKey: todayKey,
    });

    console.log(`[ok] Sore ${kandangNama}: ${delta} telur (${sensorValue}-${nilaiPagi})`);
  }
}

async function runTick() {
  const now = getJakartaNow();
  const nowHHMM = formatHHMM(now);
  const todayKey = formatDateKey(now);

  const db = admin.database();
  const [jadwalSnap, dataSnap, kandangSnap] = await Promise.all([
    db.ref('kontrol/penjadwalan').get(),
    db.ref('data').get(),
    db.ref('kontrol/kandang').get(),
  ]);

  if (!jadwalSnap.exists()) {
    console.log('[tick] Tidak ada data kontrol/penjadwalan');
    return;
  }

  const jadwalMap = jadwalSnap.val() || {};
  const dataSensor = dataSnap.exists() ? dataSnap.val() : {};
  const kandangMap = kandangSnap.exists() ? kandangSnap.val() : {};

  const aktifSekarang = Object.entries(jadwalMap).filter(([_, jadwal]) => {
    if (!jadwal || jadwal.aktif !== true) return false;
    const jam = String(jadwal.jam || '').slice(0, 5);
    return jam === nowHHMM;
  });

  if (aktifSekarang.length === 0) {
    console.log(`[tick] ${nowHHMM} tidak ada jadwal aktif`);
    return;
  }

  console.log(`[tick] ${nowHHMM} eksekusi ${aktifSekarang.length} jadwal`);
  let hasEveningRun = false;

  for (const [jadwalId, jadwal] of aktifSekarang) {
    try {
      await runForSchedule(jadwalId, jadwal, dataSensor, kandangMap, todayKey);
      if (detectJenisPanen(jadwal) === 'sore') {
        hasEveningRun = true;
      }
    } catch (e) {
      console.error(`[error] Jadwal ${jadwalId} gagal:`, e.message);
    }
  }

  if (hasEveningRun) {
    await resetSensorAfterEvening(todayKey);
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'telurku-railway-scheduler' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TelurKu Railway Scheduler is running');
  });

  server.listen(PORT, () => {
    console.log(`[init] Health server listening on :${PORT}`);
  });
}

async function bootstrap() {
  initFirebase();
  startHealthServer();

  const kandangSnap = await admin.database().ref('kontrol/kandang').get();
  const kandangMap = kandangSnap.exists() ? kandangSnap.val() : {};

  const runMaintenance = await shouldRunMaintenance();
  if (runMaintenance) {
    try {
      await migrateLegacyRiwayatData(kandangMap);
      console.log('[init] Legacy riwayat migration completed');
    } catch (e) {
      console.error('[error] Legacy riwayat migration failed:', e.message);
    }
  }

  if (COMPACT_MODE) {
    try {
      await runCompactMaintenance();
      console.log('[init] Compact maintenance completed');
    } catch (e) {
      console.error('[error] Compact maintenance failed:', e.message);
    }
  }

  if (!SCHEDULER_ENABLED) {
    console.log('[init] Scheduler disabled by SCHEDULER_ENABLED=false');
    return;
  }

  // Run once at startup for visibility, then every minute.
  try {
    await runTick();
  } catch (e) {
    console.error('[error] Initial tick failed:', e.message);
  }

  cron.schedule(
    '* * * * *',
    async () => {
      try {
        await runTick();
      } catch (e) {
        console.error('[error] Tick failed:', e.message);
      }
    },
    { timezone: TZ },
  );

  console.log(`[init] Scheduler active (timezone=${TZ})`);
}

bootstrap().catch((e) => {
  console.error('[fatal] bootstrap failed:', e.message);
  process.exit(1);
});
