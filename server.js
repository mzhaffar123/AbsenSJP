const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const morgan = require('morgan');
const ExcelJS = require('exceljs');
const db = require('./db');

// Vercel Blob - hanya digunakan saat deploy di Vercel
const HAS_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobModule = null;
if (HAS_BLOB) {
  try { blobModule = require('@vercel/blob'); } catch (e) { console.warn('Vercel Blob module tidak tersedia:', e.message); }
}
let currentBlobUrl = null; // URL Excel terbaru di Vercel Blob

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
// Gunakan secret tetap yang stabil di semua instance serverless Vercel (bukan randomBytes yang berubah tiap cold start)
const AUTH_SECRET = process.env.AUTH_SECRET || 'absensjp-secure-permanent-auth-secret-key-2026-v1';
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

function createAuthToken() {
  const payload = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
  const issued = parseInt(payload, 36);
  if (isNaN(issued)) return false;
  return (Date.now() - issued) < TOKEN_MAX_AGE_MS && (Date.now() - issued) >= -60000;
}
const IS_VERCEL = !!process.env.VERCEL;
const DATA_DIR = IS_VERCEL ? '/tmp' : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const EXCEL_PATH = path.join(DATA_DIR, 'rekap-absensi.xlsx');
let excelRefreshPromise = Promise.resolve();

let dbInitialized = false;
let dbInitPromise = db.initDb().then(() => { dbInitialized = true; }).catch(console.error);

app.use(async (_req, _res, next) => {
  if (!dbInitialized) {
    await dbInitPromise;
  }
  next();
});

const defaultSettings = {
  shift1_start: '06:00',
  shift1_end: '14:00',
  shift2_start: '14:00',
  shift2_end: '22:00',
  shift3_start: '22:00',
  shift3_end: '06:00',
  late_tolerance: '30',
  admin_pin: '1234'
};

async function getSettings() {
  try {
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = { ...defaultSettings };
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch (err) {
    console.error('Gagal membaca settings:', err);
    return { ...defaultSettings };
  }
}

const timeToMinutes = (str) => {
  if (!str) return 0;
  const [h, m] = str.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.get('/sw.js', (req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const isoDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(date);
const localTime = () => new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
}).format(new Date()).replace(/\./g, ':');

const currentJakartaMinutes = () => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour').value) * 60 + Number(parts.find((part) => part.type === 'minute').value);
};

const shiftInfo = (assignedShift = 'Otomatis', settings = defaultSettings) => {
  const s1Start = timeToMinutes(settings.shift1_start);
  const s1End = timeToMinutes(settings.shift1_end);
  const s2Start = timeToMinutes(settings.shift2_start);
  const s2End = timeToMinutes(settings.shift2_end);
  const s3Start = timeToMinutes(settings.shift3_start);
  const s3End = timeToMinutes(settings.shift3_end);
  const lateTolerance = Number(settings.late_tolerance) || 30;

  const now = currentJakartaMinutes();

  let currentShift = 'Shift 1';
  if (now >= s1Start && now < s1End) {
    currentShift = 'Shift 1';
  } else if (now >= s2Start && now < s2End) {
    currentShift = 'Shift 2';
  } else {
    currentShift = 'Shift 3';
  }

  if (assignedShift === 'Otomatis') return { shift: currentShift, outside: false, late: false };

  const starts = { 'Shift 1': s1Start, 'Shift 2': s2Start, 'Shift 3': s3Start };
  const ends = { 'Shift 1': s1End, 'Shift 2': s2End, 'Shift 3': s3End };
  const start = starts[assignedShift] ?? s1Start;
  const end = ends[assignedShift] ?? s1End;

  const isOvernight = start > end;
  let outside = false;
  let late = false;

  if (isOvernight) {
    const adjustedNow = now < end ? now + 1440 : now;
    const adjustedEnd = end + 1440;
    outside = adjustedNow < start || adjustedNow >= adjustedEnd;
    late = adjustedNow >= start + lateTolerance && adjustedNow < adjustedEnd;
  } else {
    outside = now < start || now >= end;
    late = now >= start + lateTolerance && now < end;
  }

  return { shift: assignedShift, outside, late };
};

const isLateClock = (clock, shift, settings = defaultSettings) => {
  if (!clock || !['Shift 1', 'Shift 2', 'Shift 3'].includes(shift)) return false;
  const lateTolerance = Number(settings.late_tolerance) || 30;
  const starts = {
    'Shift 1': timeToMinutes(settings.shift1_start),
    'Shift 2': timeToMinutes(settings.shift2_start),
    'Shift 3': timeToMinutes(settings.shift3_start)
  };
  const ends = {
    'Shift 1': timeToMinutes(settings.shift1_end),
    'Shift 2': timeToMinutes(settings.shift2_end),
    'Shift 3': timeToMinutes(settings.shift3_end)
  };

  const [hour, minute] = clock.split(/[.:]/).map(Number);
  const minutes = hour * 60 + minute;
  const start = starts[shift] ?? 0;
  const end = ends[shift] ?? 0;

  if (start > end) {
    const adjustedMinutes = minutes < end ? minutes + 1440 : minutes;
    return adjustedMinutes >= start + lateTolerance;
  }
  return minutes >= start + lateTolerance;
};

const shiftHasEnded = (shift, settings = defaultSettings) => {
  const now = currentJakartaMinutes();
  const starts = {
    'Shift 1': timeToMinutes(settings.shift1_start),
    'Shift 2': timeToMinutes(settings.shift2_start),
    'Shift 3': timeToMinutes(settings.shift3_start)
  };
  const ends = {
    'Shift 1': timeToMinutes(settings.shift1_end),
    'Shift 2': timeToMinutes(settings.shift2_end),
    'Shift 3': timeToMinutes(settings.shift3_end)
  };
  const start = starts[shift] ?? 0;
  const end = ends[shift] ?? 0;

  if (start > end) {
    return now >= end && now < start;
  }
  return now >= end;
};

const attendanceDateForShift = (shift, settings = defaultSettings) => {
  const s3End = timeToMinutes(settings.shift3_end);
  const s3Start = timeToMinutes(settings.shift3_start);
  const isOvernight = s3Start > s3End;
  return isOvernight && shift === 'Shift 3' && currentJakartaMinutes() < s3End
    ? isoDate(new Date(Date.now() - 86400000))
    : isoDate();
};

async function refreshExcelFile() {
  const settings = await getSettings();
  const rawRows = await db.all(`
    SELECT a.tanggal, e.nama, e.nip, COALESCE(a.shift, '-') AS shift, a.jam_masuk, a.jam_keluar,
      COALESCE(a.foto_masuk, e.foto) AS foto_masuk,
      a.foto_keluar,
      CASE WHEN a.jam_keluar IS NULL THEN 'belum pulang' ELSE 'lengkap' END AS status
    FROM attendance a JOIN employees e ON e.id = a.employee_id
    ORDER BY a.tanggal DESC, a.jam_masuk DESC, e.nama
  `);

  const rows = rawRows.map((row) => ({ ...row, keterangan: isLateClock(row.jam_masuk, row.shift, settings) ? 'Terlambat' : 'Tepat Waktu' }));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AbsensiMuka';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Rekap Absensi');

  sheet.columns = [
    { header: 'Foto Masuk', key: 'foto_masuk_placeholder', width: 25 },
    { header: 'Foto Keluar', key: 'foto_keluar_placeholder', width: 25 },
    { header: 'Tanggal', key: 'tanggal', width: 16 },
    { header: 'Nama Karyawan', key: 'nama', width: 28 },
    { header: 'NIP / ID', key: 'nip', width: 18 },
    { header: 'Shift', key: 'shift', width: 15 },
    { header: 'Jam Masuk', key: 'jam_masuk', width: 15 },
    { header: 'Jam Keluar', key: 'jam_keluar', width: 15 },
    { header: 'Status Kehadiran', key: 'status', width: 20 },
    { header: 'Keterangan', key: 'keterangan', width: 16 }
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F7C72' } };
  headerRow.height = 32;
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  const borderStyle = {
    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
  };

  rows.forEach((rowItem, idx) => {
    const rowIndex = idx + 2;
    const addedRow = sheet.addRow({
      foto_masuk_placeholder: '',
      foto_keluar_placeholder: rowItem.foto_keluar ? '' : '(Belum Keluar)',
      tanggal: rowItem.tanggal,
      nama: rowItem.nama,
      nip: rowItem.nip,
      shift: rowItem.shift,
      jam_masuk: rowItem.jam_masuk || '-',
      jam_keluar: rowItem.jam_keluar || '-',
      status: rowItem.status,
      keterangan: rowItem.keterangan
    });

    addedRow.height = 72;
    addedRow.font = { name: 'Calibri', size: 11 };

    addedRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = borderStyle;
      if (colNumber === 1 || colNumber === 2 || colNumber === 3 || colNumber === 5 || colNumber === 6 || colNumber === 7 || colNumber === 8 || colNumber === 9 || colNumber === 10) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }
    });

    if (!rowItem.foto_keluar) {
      sheet.getCell(`B${rowIndex}`).font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FF888888' } };
    }

    if (rowItem.foto_masuk && typeof rowItem.foto_masuk === 'string' && rowItem.foto_masuk.includes(',')) {
      try {
        const parts = rowItem.foto_masuk.split(',');
        const base64Data = parts[1];
        const ext = parts[0].includes('png') ? 'png' : 'jpeg';
        const imageId = workbook.addImage({ base64: base64Data, extension: ext });
        sheet.addImage(imageId, {
          tl: { col: 0.12, row: rowIndex - 1 + 0.08 },
          ext: { width: 110, height: 84 },
          editAs: 'oneCell'
        });
      } catch (err) {
        console.warn('Gagal menyematkan foto masuk ke Excel:', err.message);
      }
    }

    if (rowItem.foto_keluar && typeof rowItem.foto_keluar === 'string' && rowItem.foto_keluar.includes(',')) {
      try {
        const parts = rowItem.foto_keluar.split(',');
        const base64Data = parts[1];
        const ext = parts[0].includes('png') ? 'png' : 'jpeg';
        const imageId = workbook.addImage({ base64: base64Data, extension: ext });
        sheet.addImage(imageId, {
          tl: { col: 1.12, row: rowIndex - 1 + 0.08 },
          ext: { width: 110, height: 84 },
          editAs: 'oneCell'
        });
      } catch (err) {
        console.warn('Gagal menyematkan foto keluar ke Excel:', err.message);
      }
    }
  });

  sheet.autoFilter = { from: 'A1', to: 'J1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  if (HAS_BLOB && blobModule) {
    // Di Vercel: simpan ke Vercel Blob Storage (permanen)
    const buffer = await workbook.xlsx.writeBuffer();
    const { put } = blobModule;
    const blob = await put('rekap-absensi.xlsx', buffer, {
      access: 'public',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      addRandomSuffix: false
    });
    currentBlobUrl = blob.url;
    console.log('✅ Excel tersimpan ke Vercel Blob:', currentBlobUrl);
  } else {
    // Lokal: simpan ke file disk
    const temporaryPath = `${EXCEL_PATH}.tmp`;
    await workbook.xlsx.writeFile(temporaryPath);
    try {
      fs.renameSync(temporaryPath, EXCEL_PATH);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
function queueExcelRefresh() {
  excelRefreshPromise = excelRefreshPromise.catch(() => { }).then(refreshExcelFile);
  return excelRefreshPromise;
}
const isDescriptor = (value) => Array.isArray(value) && value.length === 128 && value.every(Number.isFinite);
const isPhoto = (value) => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value);
const descriptorDistance = (first, second) => Math.sqrt(first.reduce((sum, value, index) => sum + (value - second[index]) ** 2, 0));

app.get('/api/employees', async (_req, res) => {
  try {
    const rows = await db.all('SELECT id, nama, nip, shift, foto, created_at FROM employees ORDER BY nama');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengambil data karyawan.' });
  }
});

app.get('/api/employees/descriptors', async (_req, res) => {
  try {
    const rows = await db.all('SELECT id, nama, nip, descriptor FROM employees ORDER BY nama');
    const employees = rows.map((employee) => ({ ...employee, descriptor: JSON.parse(employee.descriptor) }));
    res.json(employees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengambil descriptor.' });
  }
});

app.post('/api/employees', async (req, res) => {
  const { nama, nip, shift = 'Otomatis', descriptor, foto } = req.body || {};
  if (!nama?.trim() || !nip?.trim() || !['Otomatis', 'Shift 1', 'Shift 2', 'Shift 3'].includes(shift) || !isDescriptor(descriptor) || !isPhoto(foto)) {
    return res.status(400).json({ error: 'Nama, NIP, descriptor 128 angka, dan foto valid wajib diisi.' });
  }
  const normalizedNip = nip.trim().toUpperCase();
  const existingNip = await db.get('SELECT id, nama FROM employees WHERE UPPER(nip) = ?', [normalizedNip]);
  if (existingNip) return res.status(409).json({ error: `NIP/ID sudah digunakan oleh ${existingNip.nama}.` });
  const existingFaces = await db.all('SELECT id, nama, nip, descriptor FROM employees');
  const duplicateFace = existingFaces.find((employee) => descriptorDistance(descriptor, JSON.parse(employee.descriptor)) <= 0.45);
  if (duplicateFace) return res.status(409).json({ error: `Wajah sudah terdaftar atas nama ${duplicateFace.nama} (${duplicateFace.nip}).` });
  try {
    const result = await db.run(
      'INSERT INTO employees (nama, nip, shift, descriptor, foto) VALUES (?, ?, ?, ?, ?)',
      [nama.trim(), normalizedNip, shift, JSON.stringify(descriptor), foto]
    );
    res.status(201).json({ id: result.lastInsertRowid, nama: nama.trim(), nip: nip.trim() });
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint') || String(error.code) === '23505') return res.status(409).json({ error: 'NIP/ID tersebut sudah terdaftar.' });
    console.error(error);
    res.status(500).json({ error: 'Gagal menyimpan karyawan.' });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    const result = await db.run('DELETE FROM employees WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menghapus karyawan.' });
  }
});

app.patch('/api/employees/:id/shift', async (req, res) => {
  const { shift } = req.body || {};
  if (!['Otomatis', 'Shift 1', 'Shift 2', 'Shift 3'].includes(shift)) return res.status(400).json({ error: 'Shift tidak valid.' });
  try {
    const result = await db.run('UPDATE employees SET shift = ? WHERE id = ?', [shift, req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
    res.json({ id: Number(req.params.id), shift });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengupdate shift karyawan.' });
  }
});

app.post('/api/attendance/checkin', async (req, res) => {
  const { descriptor, threshold = 0.5, mode = 'auto', foto, foto_masuk, foto_keluar } = req.body || {};
  if (!['auto', 'masuk', 'keluar'].includes(mode)) return res.status(400).json({ error: 'Mode absensi tidak valid.' });
  if (!isDescriptor(descriptor)) return res.status(400).json({ error: 'Descriptor wajah tidak valid.' });
  const safeThreshold = Math.min(Math.max(Number(threshold) || 0.5, 0.2), 1.2);
  const employees = await db.all('SELECT id, nama, nip, shift, descriptor, foto FROM employees');
  let best = null;
  for (const employee of employees) {
    const saved = JSON.parse(employee.descriptor);
    const distance = Math.sqrt(descriptor.reduce((sum, value, index) => sum + (value - saved[index]) ** 2, 0));
    if (!best || distance < best.distance) best = { ...employee, distance };
  }
  if (!best || best.distance > safeThreshold) {
    return res.status(404).json({ recognized: false, error: 'Wajah belum dikenali.', distance: best?.distance ?? null });
  }

  const nowDayName = getDayName(isoDate());
  const hasCustomSchedule = await db.get('SELECT 1 FROM schedules WHERE employee_id = ? LIMIT 1', [best.id]);
  const empScheduleToday = await db.get('SELECT shift, piket FROM schedules WHERE employee_id = ? AND hari = ?', [best.id, nowDayName]);

  let assignedShift = best.shift;
  if (hasCustomSchedule) {
    if (empScheduleToday) {
      assignedShift = empScheduleToday.shift;
    } else {
      assignedShift = 'Otomatis';
    }
  }

  const isPiketToday = Boolean(empScheduleToday && empScheduleToday.piket);
  const settings = await getSettings();

  const jam = localTime();
  const schedule = shiftInfo(assignedShift, settings);
  const shift = assignedShift === 'Otomatis' ? schedule.shift : assignedShift;
  const tanggal = attendanceDateForShift(shift, settings);
  const attendance = await db.get('SELECT id, jam_masuk, jam_keluar, shift FROM attendance WHERE employee_id = ? AND tanggal = ? AND shift = ?', [best.id, tanggal, shift]);
  let status;
  if (mode === 'masuk') {
    if (schedule.outside) return res.status(403).json({ recognized: true, outsideShift: true, status: 'di luar shift', nama: best.nama, nip: best.nip, shift, error: `Jadwal Anda adalah ${assignedShift}. Absensi hanya dapat dilakukan pada jam shift tersebut.` });
    if (attendance) return res.status(409).json({ recognized: true, duplicate: true, status: 'sudah masuk', nama: best.nama, nip: best.nip, shift: attendance.shift, error: 'Absen masuk untuk shift ini sudah tercatat.' });
    const activeOtherShift = await db.get(
      'SELECT id, shift FROM attendance WHERE employee_id = ? AND tanggal = ? AND jam_masuk IS NOT NULL AND jam_keluar IS NULL AND shift != ?',
      [best.id, tanggal, shift]
    );
    if (activeOtherShift) {
      return res.status(409).json({
        recognized: true,
        duplicate: true,
        status: 'belum pulang',
        nama: best.nama,
        nip: best.nip,
        shift: activeOtherShift.shift,
        error: `Anda belum melakukan absen keluar untuk ${activeOtherShift.shift}. Selesaikan absen keluar terlebih dahulu.`
      });
    }
    await db.run('INSERT INTO attendance (employee_id, tanggal, jam_masuk, shift, foto_masuk) VALUES (?, ?, ?, ?, ?)', [best.id, tanggal, jam, shift, foto_masuk || foto || best.foto]);
    status = 'masuk';
  } else if (mode === 'keluar') {
    if (!attendance) return res.status(409).json({ recognized: true, status: 'belum masuk', nama: best.nama, nip: best.nip, shift, error: 'Absen keluar tidak dapat dilakukan sebelum absen masuk.' });
    if (attendance.jam_keluar) return res.json({ recognized: true, duplicate: true, status: 'selesai', nama: best.nama, nip: best.nip, jam: attendance.jam_keluar, shift: attendance.shift, distance: best.distance, isPiket: isPiketToday });
    if (!shiftHasEnded(attendance.shift || shift, settings)) {
      return res.status(403).json({ recognized: true, tooEarly: true, status: 'belum selesai', nama: best.nama, nip: best.nip, shift: attendance.shift || shift, error: `Absen keluar baru dapat dilakukan setelah ${attendance.shift === 'Shift 1' ? '14.00' : attendance.shift === 'Shift 2' ? '22.00' : '06.00'}.` });
    }
    await db.run('UPDATE attendance SET jam_keluar = ?, foto_keluar = ? WHERE id = ?', [jam, foto_keluar || foto || best.foto, attendance.id]);
    status = 'keluar';
  } else if (!attendance) {
    if (schedule.outside) return res.status(403).json({ recognized: true, outsideShift: true, status: 'di luar shift', nama: best.nama, nip: best.nip, shift, error: `Jadwal Anda adalah ${assignedShift}. Absensi hanya dapat dilakukan pada jam shift tersebut.` });
    const activeOtherShiftAuto = await db.get(
      'SELECT id, shift FROM attendance WHERE employee_id = ? AND tanggal = ? AND jam_masuk IS NOT NULL AND jam_keluar IS NULL AND shift != ?',
      [best.id, tanggal, shift]
    );
    if (activeOtherShiftAuto) {
      return res.status(409).json({
        recognized: true,
        duplicate: true,
        status: 'belum pulang',
        nama: best.nama,
        nip: best.nip,
        shift: activeOtherShiftAuto.shift,
        error: `Anda belum melakukan absen keluar untuk ${activeOtherShiftAuto.shift}. Selesaikan absen keluar terlebih dahulu.`
      });
    }
    await db.run('INSERT INTO attendance (employee_id, tanggal, jam_masuk, shift, foto_masuk) VALUES (?, ?, ?, ?, ?)', [best.id, tanggal, jam, shift, foto_masuk || foto || best.foto]);
    status = 'masuk';
  } else if (!attendance.jam_keluar) {
    if (!shiftHasEnded(attendance.shift || shift, settings)) return res.status(403).json({ recognized: true, tooEarly: true, status: 'belum selesai', nama: best.nama, nip: best.nip, shift: attendance.shift || shift, error: `Absen keluar baru dapat dilakukan setelah ${attendance.shift === 'Shift 1' ? '14.00' : attendance.shift === 'Shift 2' ? '22.00' : '06.00'}.` });
    await db.run('UPDATE attendance SET jam_keluar = ?, foto_keluar = ? WHERE id = ?', [jam, foto_keluar || foto || best.foto, attendance.id]);
    status = 'keluar';
  } else {
    return res.json({ recognized: true, duplicate: true, status: 'selesai', nama: best.nama, nip: best.nip, jam: attendance.jam_keluar, shift: attendance.shift, distance: best.distance, isPiket: isPiketToday });
  }
  let excelUpdated = true;
  try {
    await queueExcelRefresh();
  } catch (error) {
    excelUpdated = false;
    console.error('Excel belum dapat diperbarui. Tutup file Excel jika sedang terbuka:', error.message);
  }
  res.json({ recognized: true, status, nama: best.nama, nip: best.nip, jam, shift, terlambat: schedule.late, isPiket: isPiketToday, excelUpdated, distance: best.distance });
});

const getDayName = (dateStr) => {
  if (!dateStr) return 'Senin';
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return days[date.getDay()];
};

app.get('/api/attendance', async (req, res) => {
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(req.query.tanggal || '') ? req.query.tanggal : isoDate();
  const dayName = getDayName(tanggal);
  const settings = await getSettings();

  const schedulesToday = await db.all('SELECT employee_id, shift, piket FROM schedules WHERE hari = ?', [dayName]);
  const scheduleMap = new Map(schedulesToday.map((s) => [s.employee_id, { shift: s.shift, piket: Boolean(s.piket) }]));
  const configuredEmployees = new Set((await db.all('SELECT DISTINCT employee_id FROM schedules')).map((s) => s.employee_id));

  const rawRows = await db.all(`
    SELECT a.id, a.tanggal, e.id AS employee_id, e.nama, e.nip, e.foto,
      COALESCE(a.foto_masuk, e.foto) AS foto_masuk,
      a.foto_keluar,
      e.shift AS default_shift, a.jam_masuk, a.jam_keluar, COALESCE(a.shift, '-') AS shift,
      CASE WHEN a.jam_keluar IS NULL THEN 'belum pulang' ELSE 'lengkap' END AS status
    FROM attendance a JOIN employees e ON e.id = a.employee_id
    WHERE a.tanggal = ? ORDER BY a.jam_masuk DESC, e.nama
  `, [tanggal]);

  const rows = rawRows.map((row) => {
    let jadwal_shift;
    let is_off = false;
    let is_piket = false;
    if (configuredEmployees.has(row.employee_id)) {
      if (scheduleMap.has(row.employee_id)) {
        const item = scheduleMap.get(row.employee_id);
        jadwal_shift = item.shift;
        is_piket = item.piket;
      } else {
        jadwal_shift = 'Libur (Off)';
        is_off = true;
      }
    } else {
      jadwal_shift = row.default_shift || 'Otomatis';
    }
    return {
      ...row,
      jadwal_shift,
      is_off,
      is_piket,
      terlambat: isLateClock(row.jam_masuk, row.shift, settings)
    };
  });

  const absentAllRaw = await db.all(`
    SELECT e.id, e.nama, e.nip, e.shift, e.foto
    FROM employees e
    WHERE e.id NOT IN (
      SELECT employee_id FROM attendance WHERE tanggal = ?
    )
    ORDER BY e.nama
  `, [tanggal]);

  const absentAll = absentAllRaw.map((emp) => {
    let jadwal_shift;
    let is_off = false;
    let is_scheduled = true;
    if (configuredEmployees.has(emp.id)) {
      if (scheduleMap.has(emp.id)) {
        jadwal_shift = scheduleMap.get(emp.id);
        is_scheduled = true;
        is_off = false;
      } else {
        jadwal_shift = 'Libur (Off)';
        is_scheduled = false;
        is_off = true;
      }
    } else {
      jadwal_shift = emp.shift || 'Otomatis';
      is_scheduled = true;
      is_off = false;
    }
    return {
      ...emp,
      jadwal_shift,
      is_scheduled,
      is_off
    };
  });

  const absent = absentAll.filter((emp) => !emp.is_off);
  const off = absentAll.filter((emp) => emp.is_off);

  const allEmployees = await db.all('SELECT id, shift FROM employees');
  let scheduledCount = 0;
  let offCount = 0;
  for (const emp of allEmployees) {
    if (configuredEmployees.has(emp.id)) {
      if (scheduleMap.has(emp.id)) scheduledCount++;
      else offCount++;
    } else {
      scheduledCount++;
    }
  }

  const shiftTimes = {
    'Shift 1': `${settings.shift1_start} - ${settings.shift1_end}`,
    'Shift 2': `${settings.shift2_start} - ${settings.shift2_end}`,
    'Shift 3': `${settings.shift3_start} - ${settings.shift3_end}`
  };

  const stats = {
    totalEmployees: allEmployees.length,
    scheduledCount,
    offCount,
    presentCount: rows.length,
    absentCount: absent.length,
    lateCount: rows.filter((r) => r.terlambat).length,
    completedCount: rows.filter((r) => Boolean(r.jam_keluar)).length
  };

  res.json({ tanggal, dayName, rows, absent, off, stats, shiftTimes });
});

app.post('/api/attendance/manual', async (req, res) => {
  try {
    const { employee_id, tanggal, shift, jam_masuk, jam_keluar } = req.body || {};
    if (!employee_id || !tanggal || !shift || !jam_masuk) {
      return res.status(400).json({ error: 'Karyawan, tanggal, shift, dan jam masuk wajib diisi.' });
    }
    const employee = await db.get('SELECT id, nama, nip, foto FROM employees WHERE id = ?', [employee_id]);
    if (!employee) return res.status(404).json({ error: 'Data karyawan tidak ditemukan.' });

    const existing = await db.get(
      'SELECT id FROM attendance WHERE employee_id = ? AND tanggal = ? AND shift = ?',
      [employee_id, tanggal, shift]
    );

    if (existing) {
      await db.run(
        'UPDATE attendance SET jam_masuk = ?, jam_keluar = ?, foto_masuk = COALESCE(foto_masuk, ?), foto_keluar = COALESCE(foto_keluar, ?) WHERE id = ?',
        [jam_masuk, jam_keluar || null, employee.foto, jam_keluar ? employee.foto : null, existing.id]
      );
    } else {
      await db.run(
        'INSERT INTO attendance (employee_id, tanggal, jam_masuk, jam_keluar, shift, foto_masuk, foto_keluar) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [employee_id, tanggal, jam_masuk, jam_keluar || null, shift, employee.foto, jam_keluar ? employee.foto : null]
      );
    }

    try { await queueExcelRefresh(); } catch (err) { console.error('Excel refresh error:', err.message); }
    res.json({ success: true, message: `Absensi manual untuk ${employee.nama} berhasil disimpan.` });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menyimpan absensi manual: ' + err.message });
  }
});

app.put('/api/attendance/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { shift, jam_masuk, jam_keluar } = req.body || {};
    if (!id || !jam_masuk) {
      return res.status(400).json({ error: 'ID dan jam masuk wajib diisi.' });
    }
    const record = await db.get('SELECT id FROM attendance WHERE id = ?', [id]);
    if (!record) return res.status(404).json({ error: 'Data absensi tidak ditemukan.' });

    await db.run(
      'UPDATE attendance SET shift = COALESCE(?, shift), jam_masuk = ?, jam_keluar = ? WHERE id = ?',
      [shift || null, jam_masuk, jam_keluar || null, id]
    );

    try { await queueExcelRefresh(); } catch (err) { console.error('Excel refresh error:', err.message); }
    res.json({ success: true, message: 'Data absensi berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memperbarui absensi: ' + err.message });
  }
});

app.delete('/api/attendance/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID tidak valid.' });
    const record = await db.get('SELECT id FROM attendance WHERE id = ?', [id]);
    if (!record) return res.status(404).json({ error: 'Data absensi tidak ditemukan.' });

    await db.run('DELETE FROM attendance WHERE id = ?', [id]);

    try { await queueExcelRefresh(); } catch (err) { console.error('Excel refresh error:', err.message); }
    res.json({ success: true, message: 'Data absensi berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus absensi: ' + err.message });
  }
});

app.get('/api/settings', async (_req, res) => {
  const settings = await getSettings();
  res.json({
    shift1_start: settings.shift1_start,
    shift1_end: settings.shift1_end,
    shift2_start: settings.shift2_start,
    shift2_end: settings.shift2_end,
    shift3_start: settings.shift3_start,
    shift3_end: settings.shift3_end,
    late_tolerance: settings.late_tolerance,
    has_pin: Boolean(settings.admin_pin)
  });
});

app.post('/api/settings', async (req, res) => {
  const body = req.body || {};
  const current = await getSettings();
  const pin = String(body.admin_pin || '').trim();

  if (current.admin_pin && pin !== current.admin_pin) {
    return res.status(401).json({ error: 'PIN Admin tidak sesuai.' });
  }

  const allowedKeys = [
    'shift1_start', 'shift1_end',
    'shift2_start', 'shift2_end',
    'shift3_start', 'shift3_end',
    'late_tolerance'
  ];

  for (const key of allowedKeys) {
    if (body[key] !== undefined) {
      await db.upsertSetting(key, String(body[key]).trim());
    }
  }
  if (body.new_admin_pin && String(body.new_admin_pin).trim()) {
    await db.upsertSetting('admin_pin', String(body.new_admin_pin).trim());
  }

  const updated = await getSettings();
  res.json({
    message: 'Pengaturan jam kerja dan kebijakan berhasil disimpan.',
    settings: {
      shift1_start: updated.shift1_start,
      shift1_end: updated.shift1_end,
      shift2_start: updated.shift2_start,
      shift2_end: updated.shift2_end,
      shift3_start: updated.shift3_start,
      shift3_end: updated.shift3_end,
      late_tolerance: updated.late_tolerance,
      has_pin: Boolean(updated.admin_pin)
    }
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { pin } = req.body || {};
  const current = await getSettings();
  const validPin = current.admin_pin || '1234';

  if (!pin || String(pin).trim() !== String(validPin).trim()) {
    return res.status(401).json({ error: 'PIN Administrator tidak sesuai.' });
  }

  const token = createAuthToken();
  res.json({ success: true, token, message: 'Login berhasil.' });
});

app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body || {};
  if (verifyAuthToken(token)) {
    return res.json({ authenticated: true });
  }
  res.status(401).json({ authenticated: false, error: 'Sesi kedaluwarsa atau tidak valid.' });
});

app.post('/api/auth/logout', (_req, res) => {
  // Token stateless — client cukup hapus dari storage
  res.json({ success: true, message: 'Logout berhasil.' });
});

app.get('/api/schedules', async (_req, res) => {
  const employees = await db.all('SELECT id, nama, nip, foto, shift FROM employees ORDER BY nama');
  const scheduleRows = await db.all('SELECT employee_id, hari, shift, piket FROM schedules');
  const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const grouped = employees.map((emp) => {
    const empSchedules = scheduleRows.filter((s) => s.employee_id === emp.id);
    const days = DAYS.map((hari) => {
      const found = empSchedules.find((s) => s.hari === hari);
      return {
        hari,
        aktif: Boolean(found),
        shift: found ? found.shift : 'Shift 1',
        piket: Boolean(found && found.piket)
      };
    });
    return { ...emp, jadwal: days };
  });
  res.json(grouped);
});

app.put('/api/schedules/:id', async (req, res) => {
  const employeeId = Number(req.params.id);
  const { jadwal } = req.body || {};
  const VALID_DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const VALID_SHIFTS = ['Shift 1', 'Shift 2', 'Shift 3'];
  if (!Array.isArray(jadwal)) return res.status(400).json({ error: 'Data jadwal tidak valid.' });
  const employee = await db.get('SELECT id FROM employees WHERE id = ?', [employeeId]);
  if (!employee) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });

  await db.run('DELETE FROM schedules WHERE employee_id = ?', [employeeId]);
  for (const item of jadwal) {
    if (item.aktif && VALID_DAYS.includes(item.hari) && VALID_SHIFTS.includes(item.shift)) {
      await db.run('INSERT INTO schedules (employee_id, hari, shift, piket) VALUES (?, ?, ?, ?)', [employeeId, item.hari, item.shift, item.piket ? 1 : 0]);
    }
  }
  res.json({ success: true, message: 'Jadwal berhasil disimpan.' });
});

app.get('/api/piket/today', async (_req, res) => {
  const tanggal = isoDate();
  const dayName = getDayName(tanggal);
  const settings = await getSettings();

  const piketList = await db.all(`
    SELECT e.id, e.nama, e.nip, e.foto, s.shift,
      CASE WHEN a.id IS NOT NULL AND a.jam_masuk IS NOT NULL THEN 1 ELSE 0 END AS sudah_absen,
      a.jam_masuk, a.jam_keluar
    FROM schedules s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.tanggal = ? AND a.shift = s.shift
    WHERE s.hari = ? AND s.piket = 1
    ORDER BY s.shift, e.nama
  `, [tanggal, dayName]);

  const shiftTimes = {
    'Shift 1': { mulai: settings.shift1_start || '06:00', selesai: settings.shift1_end || '14:00' },
    'Shift 2': { mulai: settings.shift2_start || '14:00', selesai: settings.shift2_end || '22:00' },
    'Shift 3': { mulai: settings.shift3_start || '22:00', selesai: settings.shift3_end || '06:00' },
  };

  const grouped = {};
  for (const staf of piketList) {
    const shiftKey = staf.shift || 'Shift 1';
    if (!grouped[shiftKey]) grouped[shiftKey] = { shift: shiftKey, jamMulai: shiftTimes[shiftKey]?.mulai || '-', jamSelesai: shiftTimes[shiftKey]?.selesai || '-', staf: [] };
    grouped[shiftKey].staf.push(staf);
  }

  res.json({ tanggal, dayName, piketList, grouped: Object.values(grouped) });
});

function getDatesInRange(startDate, endDate) {
  const dates = [];
  let curr = new Date(startDate + 'T00:00:00');
  const last = new Date(endDate + 'T00:00:00');
  while (curr <= last) {
    dates.push(curr.toLocaleDateString('en-CA'));
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

app.get('/api/attendance/summary-period', async (req, res) => {
  const today = isoDate();
  const [currYear, currMonth] = today.split('-');
  const defaultStart = `${currYear}-${currMonth}-01`;

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate || '') ? req.query.startDate : defaultStart;
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate || '') ? req.query.endDate : today;

  if (startDate > endDate) {
    return res.status(400).json({ error: 'Tanggal awal tidak boleh melebihi tanggal akhir.' });
  }

  const settings = await getSettings();
  const dateList = getDatesInRange(startDate, endDate);
  const employees = await db.all('SELECT id, nama, nip, shift, foto FROM employees ORDER BY nama');
  const schedules = await db.all('SELECT employee_id, hari, shift, piket FROM schedules');
  const attendances = await db.all(`
    SELECT a.id, a.employee_id, a.tanggal, a.jam_masuk, a.jam_keluar, a.shift,
      e.nama, e.nip
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.tanggal >= ? AND a.tanggal <= ?
    ORDER BY a.tanggal, a.jam_masuk
  `, [startDate, endDate]);

  const configuredEmployees = new Set(schedules.map((s) => s.employee_id));

  const summaryByEmployee = employees.map((emp) => {
    const empSchedules = schedules.filter((s) => s.employee_id === emp.id);
    const empScheduleMap = new Map(empSchedules.map((s) => [s.hari, s]));
    const isConfigured = configuredEmployees.has(emp.id);

    let totalScheduledDays = 0;
    let totalPresent = 0;
    let totalOnTime = 0;
    let totalLate = 0;
    let totalAbsent = 0;
    let totalOff = 0;
    let totalPiket = 0;

    const dailyBreakdown = {};

    for (const d of dateList) {
      const dayName = getDayName(d);
      const isPastOrToday = d <= today;
      let isWorkDay = false;
      let shiftName = emp.shift || 'Otomatis';
      let isPiket = false;

      if (isConfigured) {
        if (empScheduleMap.has(dayName)) {
          const sc = empScheduleMap.get(dayName);
          isWorkDay = true;
          shiftName = sc.shift;
          isPiket = Boolean(sc.piket);
        } else {
          isWorkDay = false;
          shiftName = 'Libur (Off)';
        }
      } else {
        isWorkDay = true;
        shiftName = emp.shift || 'Otomatis';
      }

      if (isWorkDay) {
        totalScheduledDays++;
        if (isPiket) totalPiket++;
      } else {
        totalOff++;
      }

      const att = attendances.find((a) => a.employee_id === emp.id && a.tanggal === d);
      if (att) {
        totalPresent++;
        const late = isLateClock(att.jam_masuk, att.shift, settings);
        if (late) totalLate++;
        else totalOnTime++;

        dailyBreakdown[d] = {
          status: late ? 'terlambat' : 'hadir',
          jam_masuk: att.jam_masuk,
          jam_keluar: att.jam_keluar,
          shift: att.shift,
          isWorkDay,
          isPiket
        };
      } else {
        if (isWorkDay && isPastOrToday) {
          totalAbsent++;
          dailyBreakdown[d] = {
            status: 'alpha',
            jam_masuk: null,
            jam_keluar: null,
            shift: shiftName,
            isWorkDay: true,
            isPiket
          };
        } else {
          dailyBreakdown[d] = {
            status: isWorkDay ? 'belum_berjalan' : 'libur',
            jam_masuk: null,
            jam_keluar: null,
            shift: shiftName,
            isWorkDay,
            isPiket
          };
        }
      }
    }

    const attendanceRate = totalScheduledDays > 0 ? Math.round((totalPresent / totalScheduledDays) * 100) : 100;

    return {
      id: emp.id,
      nama: emp.nama,
      nip: emp.nip,
      foto: emp.foto,
      shift: emp.shift,
      totalScheduledDays,
      totalPresent,
      totalOnTime,
      totalLate,
      totalAbsent,
      totalOff,
      totalPiket,
      attendanceRate,
      dailyBreakdown
    };
  });

  const totalEmployees = employees.length;
  const totalPresentAll = summaryByEmployee.reduce((acc, e) => acc + e.totalPresent, 0);
  const totalLateAll = summaryByEmployee.reduce((acc, e) => acc + e.totalLate, 0);
  const totalAbsentAll = summaryByEmployee.reduce((acc, e) => acc + e.totalAbsent, 0);
  const totalScheduledAll = summaryByEmployee.reduce((acc, e) => acc + e.totalScheduledDays, 0);
  const avgAttendanceRate = totalScheduledAll > 0 ? Math.round((totalPresentAll / totalScheduledAll) * 100) : 100;

  res.json({
    startDate,
    endDate,
    totalDays: dateList.length,
    dateList,
    kpi: {
      totalEmployees,
      avgAttendanceRate,
      totalPresentAll,
      totalLateAll,
      totalAbsentAll,
      totalScheduledAll
    },
    employees: summaryByEmployee
  });
});

app.get('/api/attendance/export-period.xlsx', async (req, res) => {
  try {
    const today = isoDate();
    const [currYear, currMonth] = today.split('-');
    const defaultStart = `${currYear}-${currMonth}-01`;

    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate || '') ? req.query.startDate : defaultStart;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate || '') ? req.query.endDate : today;

    const settings = await getSettings();
    const dateList = getDatesInRange(startDate, endDate);
    const employees = await db.all('SELECT id, nama, nip, shift, foto FROM employees ORDER BY nama');
    const schedules = await db.all('SELECT employee_id, hari, shift, piket FROM schedules');
    const attendances = await db.all(`
      SELECT a.id, a.employee_id, a.tanggal, a.jam_masuk, a.jam_keluar, a.shift,
        e.nama, e.nip, COALESCE(a.foto_masuk, e.foto) AS foto_masuk, a.foto_keluar,
        CASE WHEN a.jam_keluar IS NULL THEN 'belum pulang' ELSE 'lengkap' END AS status
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.tanggal >= ? AND a.tanggal <= ?
      ORDER BY a.tanggal, a.jam_masuk
    `, [startDate, endDate]);

    const configuredEmployees = new Set(schedules.map((s) => s.employee_id));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AbsensiMuka';
    workbook.created = new Date();

    const sheet1 = workbook.addWorksheet('Rekap Periode');
    sheet1.properties.defaultRowHeight = 22;

    sheet1.mergeCells('A1:J1');
    sheet1.getCell('A1').value = 'LAPORAN REKAPITULASI KEHADIRAN KARYAWAN';
    sheet1.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF09584F' } };
    sheet1.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };

    sheet1.mergeCells('A2:J2');
    sheet1.getCell('A2').value = `Periode: ${startDate} s/d ${endDate} | Total: ${dateList.length} Hari`;
    sheet1.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF555555' } };
    sheet1.getCell('A2').alignment = { vertical: 'middle', horizontal: 'center' };

    sheet1.getRow(4).values = [
      'No', 'Foto', 'NIP / ID', 'Nama Karyawan', 'Shift Utama', 'Hari Terjadwal', 'Hadir Tepat Waktu', 'Terlambat', 'Alpha (Tidak Hadir)', '% Kehadiran'
    ];
    sheet1.getRow(4).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    sheet1.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F7C72' } };
    sheet1.getRow(4).alignment = { vertical: 'middle', horizontal: 'center' };

    sheet1.columns = [
      { key: 'no', width: 6 },
      { key: 'foto', width: 16 },
      { key: 'nip', width: 16 },
      { key: 'nama', width: 26 },
      { key: 'shift', width: 14 },
      { key: 'scheduled', width: 16 },
      { key: 'onTime', width: 18 },
      { key: 'late', width: 14 },
      { key: 'absent', width: 20 },
      { key: 'rate', width: 14 }
    ];

    let rowIdx = 5;
    employees.forEach((emp, index) => {
      const empSchedules = schedules.filter((s) => s.employee_id === emp.id);
      const empScheduleMap = new Map(empSchedules.map((s) => [s.hari, s]));
      const isConfigured = configuredEmployees.has(emp.id);

      let totalScheduledDays = 0;
      let totalPresent = 0;
      let totalOnTime = 0;
      let totalLate = 0;
      let totalAbsent = 0;

      for (const d of dateList) {
        const dayName = getDayName(d);
        const isPastOrToday = d <= today;
        let isWorkDay = isConfigured ? empScheduleMap.has(dayName) : true;
        if (isWorkDay) totalScheduledDays++;

        const att = attendances.find((a) => a.employee_id === emp.id && a.tanggal === d);
        if (att) {
          totalPresent++;
          if (isLateClock(att.jam_masuk, att.shift, settings)) totalLate++;
          else totalOnTime++;
        } else if (isWorkDay && isPastOrToday) {
          totalAbsent++;
        }
      }

      const rate = totalScheduledDays > 0 ? Math.round((totalPresent / totalScheduledDays) * 100) : 100;

      const row = sheet1.getRow(rowIdx++);
      row.values = [
        index + 1,
        '',
        emp.nip,
        emp.nama,
        emp.shift || 'Otomatis',
        totalScheduledDays,
        totalOnTime,
        totalLate,
        totalAbsent,
        `${rate}%`
      ];
      row.height = 72;
      row.alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(4).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };

      if (emp.foto && typeof emp.foto === 'string' && emp.foto.includes(',')) {
        try {
          const parts = emp.foto.split(',');
          const base64Data = parts[1];
          const ext = parts[0].includes('png') ? 'png' : 'jpeg';
          const imageId = workbook.addImage({ base64: base64Data, extension: ext });
          sheet1.addImage(imageId, {
            tl: { col: 1.12, row: rowIdx - 2 + 0.08 },
            ext: { width: 70, height: 70 },
            editAs: 'oneCell'
          });
        } catch (err) {
          console.warn('Gagal menyematkan foto karyawan ke Excel:', err.message);
        }
      }
    });

    const sheet2 = workbook.addWorksheet('Detail Harian');

    sheet2.columns = [
      { header: 'Foto Masuk', key: 'foto_masuk_placeholder', width: 25 },
      { header: 'Foto Keluar', key: 'foto_keluar_placeholder', width: 25 },
      { header: 'Tanggal', key: 'tanggal', width: 16 },
      { header: 'Nama Karyawan', key: 'nama', width: 28 },
      { header: 'NIP / ID', key: 'nip', width: 18 },
      { header: 'Shift', key: 'shift', width: 15 },
      { header: 'Jam Masuk', key: 'jam_masuk', width: 15 },
      { header: 'Jam Keluar', key: 'jam_keluar', width: 15 },
      { header: 'Status Kehadiran', key: 'status', width: 20 },
      { header: 'Keterangan', key: 'keterangan', width: 16 }
    ];

    const headerRow2 = sheet2.getRow(1);
    headerRow2.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F7C72' } };
    headerRow2.height = 32;
    headerRow2.alignment = { vertical: 'middle', horizontal: 'center' };

    const borderStyle2 = {
      top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
      right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
    };

    attendances.forEach((att, idx) => {
      const isLate = isLateClock(att.jam_masuk, att.shift, settings);
      const rowIndex = idx + 2;
      const addedRow = sheet2.addRow({
        foto_masuk_placeholder: '',
        foto_keluar_placeholder: att.foto_keluar ? '' : '(Belum Keluar)',
        tanggal: att.tanggal,
        nama: att.nama,
        nip: att.nip,
        shift: att.shift || '-',
        jam_masuk: att.jam_masuk || '-',
        jam_keluar: att.jam_keluar || '-',
        status: att.status,
        keterangan: isLate ? 'Terlambat' : 'Tepat Waktu'
      });

      addedRow.height = 72;
      addedRow.font = { name: 'Calibri', size: 11 };

      addedRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = borderStyle2;
        if (colNumber === 1 || colNumber === 2 || colNumber === 3 || colNumber === 5 || colNumber === 6 || colNumber === 7 || colNumber === 8 || colNumber === 9 || colNumber === 10) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
      });

      if (!att.foto_keluar) {
        sheet2.getCell(`B${rowIndex}`).font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FF888888' } };
      }

      if (att.foto_masuk && typeof att.foto_masuk === 'string' && att.foto_masuk.includes(',')) {
        try {
          const parts = att.foto_masuk.split(',');
          const base64Data = parts[1];
          const ext = parts[0].includes('png') ? 'png' : 'jpeg';
          const imageId = workbook.addImage({ base64: base64Data, extension: ext });
          sheet2.addImage(imageId, {
            tl: { col: 0.12, row: rowIndex - 1 + 0.08 },
            ext: { width: 110, height: 84 },
            editAs: 'oneCell'
          });
        } catch (err) {
          console.warn('Gagal menyematkan foto masuk ke Excel:', err.message);
        }
      }

      if (att.foto_keluar && typeof att.foto_keluar === 'string' && att.foto_keluar.includes(',')) {
        try {
          const parts = att.foto_keluar.split(',');
          const base64Data = parts[1];
          const ext = parts[0].includes('png') ? 'png' : 'jpeg';
          const imageId = workbook.addImage({ base64: base64Data, extension: ext });
          sheet2.addImage(imageId, {
            tl: { col: 1.12, row: rowIndex - 1 + 0.08 },
            ext: { width: 110, height: 84 },
            editAs: 'oneCell'
          });
        } catch (err) {
          console.warn('Gagal menyematkan foto keluar ke Excel:', err.message);
        }
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rekap-absensi-${startDate}-sd-${endDate}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating period excel:', err);
    res.status(500).json({ error: 'Gagal mengekspor data Excel periode.' });
  }
});

app.get('/api/attendance/export.xlsx', async (req, res) => {
  try {
    await queueExcelRefresh();
  } catch (error) {
    return res.status(423).json({ error: 'File Excel sedang terbuka atau terkunci. Tutup file tersebut lalu coba lagi.' });
  }
  // Jika di Vercel dan ada Blob URL, redirect ke file cloud
  if (HAS_BLOB && currentBlobUrl) {
    return res.redirect(302, currentBlobUrl);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.download(EXCEL_PATH, 'rekap-absensi.xlsx');
});

app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
if (!IS_VERCEL) {
  queueExcelRefresh().catch((error) => console.error('Gagal membuat file Excel awal:', error));
  setInterval(() => queueExcelRefresh().catch((error) => {
    console.error('Sinkronisasi Excel tertunda. Tutup file Excel jika sedang terbuka:', error.message);
  }), 5000);
}

const sslKeyPath = path.join(__dirname, 'ssl', 'key.pem');
const sslCertPath = path.join(__dirname, 'ssl', 'cert.pem');

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
  const options = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath)
  };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`🔒 AbsensiMuka (HTTPS SSL Aktif) berjalan di https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => console.log(`AbsensiMuka berjalan di http://localhost:${PORT}`));
}

module.exports = app;
