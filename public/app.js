// ── PWA: Registrasi Service Worker ───────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[PWA] SW terdaftar:', reg.scope))
      .catch(err => console.warn('[PWA] Gagal register SW:', err));
  });
}

const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
let modelsReady = false;
let audioContext;
let soundEnabled = true;
const $ = (selector) => document.querySelector(selector);
const showStatus = (element, text, type = '') => { if (element) { element.textContent = text; element.className = `status ${type}`; } };
function enableAudio() {
  if (!soundEnabled || !window.AudioContext) return;
  audioContext ||= new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
}
function playNotification(type) {
  if (!soundEnabled) return;
  enableAudio();
  if (!audioContext) return;
  const patterns = {
    success: [523, 659],
    warning: [392, 330],
    error: [220, 165],
    info: [440]
  };
  const now = audioContext.currentTime;
  patterns[type].forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + index * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.16, now + index * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.16);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now + index * 0.12); oscillator.stop(now + index * 0.12 + 0.18);
  });
}

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 4 && hour < 11) return 'Selamat pagi';
  if (hour >= 11 && hour < 15) return 'Selamat siang';
  if (hour >= 15 && hour < 18) return 'Selamat sore';
  return 'Selamat malam';
}

function getIndonesianFemaleVoice(voices) {
  const idVoices = voices.filter((v) => {
    const lang = (v.lang || '').replace('_', '-').toLowerCase();
    return lang.startsWith('id');
  });

  // Nama-nama voice laki-laki yang harus dihindari
  const maleNames = ['ardi', 'andika', 'hemant', 'male'];

  const isMale = (name) => maleNames.some((m) => name.includes(m));

  if (idVoices.length) {
    // 1. Google Bahasa Indonesia (Chrome) — biasanya suara perempuan yang jernih
    const googleVoice = idVoices.find((v) => (v.name || '').toLowerCase().includes('google'));
    if (googleVoice) return googleVoice;

    // 2. Cari suara wanita eksplisit: Microsoft Gadis, atau nama mengandung female/wanita
    const femaleVoice = idVoices.find((v) => {
      const name = (v.name || '').toLowerCase();
      return name.includes('gadis') || name.includes('female') || name.includes('wanita') ||
             name.includes('siti') || name.includes('putri');
    });
    if (femaleVoice) return femaleVoice;

    // 3. Suara Natural yang bukan laki-laki
    const naturalFemale = idVoices.find((v) => {
      const name = (v.name || '').toLowerCase();
      return name.includes('natural') && !isMale(name);
    });
    if (naturalFemale) return naturalFemale;

    // 4. Suara apapun yang bukan laki-laki
    const nonMale = idVoices.find((v) => !isMale((v.name || '').toLowerCase()));
    if (nonMale) return nonMale;
  }

  // 5. Fallback: cari suara perempuan dari bahasa Melayu (ms) atau Inggris
  const fallbackFemale = voices.find((v) => {
    const name = (v.name || '').toLowerCase();
    const lang = (v.lang || '').replace('_', '-').toLowerCase();
    return (lang.startsWith('ms') || lang.startsWith('en')) &&
           (name.includes('female') || name.includes('zira') || name.includes('hazel') ||
            name.includes('susan') || name.includes('linda') || name.includes('google') && lang.startsWith('en'));
  });
  if (fallbackFemale) return fallbackFemale;

  // Terakhir: kembalikan voice Indonesia pertama (pitch akan dinaikkan di speakGreeting)
  return idVoices[0] || null;
}

function speakGreeting(text) {
  if (!soundEnabled || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const voice = getIndonesianFemaleVoice(voices);
    if (voice) utterance.voice = voice;

    // Deteksi apakah voice yang terpilih kemungkinan laki-laki
    const voiceName = (voice?.name || '').toLowerCase();
    const isMaleVoice = ['ardi', 'andika', 'hemant', 'male'].some((m) => voiceName.includes(m));

    // Pitch tinggi untuk suara feminin; lebih tinggi lagi jika terpaksa pakai voice laki-laki
    utterance.pitch = isMaleVoice ? 1.5 : 1.2;

    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.warn('Speech synthesis error:', error);
  }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    try { window.speechSynthesis.getVoices(); } catch (_) {}
  };
}


async function loadModels() {
  if (modelsReady) return;
  if (!window.faceapi) throw new Error('Library face-api.js belum termuat.');
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
  ]);
  modelsReady = true;
}
async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 540 } }, audio: false });
  video.srcObject = stream;
  await video.play();
}
function stopCamera(video) { video?.srcObject?.getTracks().forEach((track) => track.stop()); }
function getDescriptor(video, canvas) {
  return faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 }))
    .withFaceLandmarks().withFaceDescriptor().then((result) => {
      if (!result) return null;
      const displaySize = { width: video.clientWidth, height: video.clientHeight };
      faceapi.matchDimensions(canvas, displaySize);
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      const resized = faceapi.resizeResults(result, displaySize);
      faceapi.draw.drawDetections(canvas, resized);
      return Array.from(result.descriptor);
    });
}
function nav(active) { document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === active)); }

async function initRegister() {
  nav('register');
  const video = $('#registerVideo'); const canvas = $('#registerCanvas'); const status = $('#registerStatus');
  const form = $('#registerForm');
  if (!$('#shift')) {
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label for="shift">Shift kerja</label><select id="shift"><option>Otomatis</option><option>Shift 1</option><option>Shift 2</option><option>Shift 3</option></select>';
    form.querySelector('button').before(field);
  }
  try { showStatus(status, 'Mengaktifkan kamera...'); await startCamera(video); showStatus(status, 'Kamera aktif. Memuat model wajah...'); await loadModels(); showStatus(status, 'Kamera siap. Isi data, lalu ambil wajah.','ok'); }
  catch (error) { showStatus(status, error.message + ' Pastikan izin kamera diberikan dan model tersedia.', 'error'); return; }
  setInterval(() => getDescriptor(video, canvas).catch(() => {}), 500);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const descriptor = await getDescriptor(video, canvas);
    if (!descriptor) return showStatus(status, 'Wajah belum terdeteksi. Posisikan wajah di area kamera.', 'error');
    const imageCanvas = document.createElement('canvas'); imageCanvas.width = 320; imageCanvas.height = 240;
    const ctx = imageCanvas.getContext('2d'); ctx.translate(320, 0); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, 320, 240);
    try {
      showStatus(status, 'Menyimpan data...');
      const response = await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nama: $('#nama').value, nip: $('#nip').value, shift: $('#shift').value, descriptor, foto: imageCanvas.toDataURL('image/jpeg', .72) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      event.target.reset(); showStatus(status, 'Karyawan berhasil didaftarkan.', 'ok'); loadEmployees();
    } catch (error) { showStatus(status, error.message, 'error'); }
  });
  loadEmployees();
}
async function loadEmployees() {
  const tbody = $('#employeeRows'); if (!tbody) return;
  const employees = await fetch('/api/employees').then((response) => response.json());
  tbody.innerHTML = employees.length ? employees.map((employee) => `<tr><td><img src="${employee.foto}" alt="" width="42" height="32" style="object-fit:cover;border-radius:6px"></td><td><strong>${escapeHtml(employee.nama)}</strong></td><td>${escapeHtml(employee.nip)}</td><td><select class="schedule-select" data-schedule="${employee.id}" aria-label="Jadwal shift ${escapeHtml(employee.nama)}"><option ${employee.shift === 'Otomatis' ? 'selected' : ''}>Otomatis</option><option ${employee.shift === 'Shift 1' ? 'selected' : ''}>Shift 1</option><option ${employee.shift === 'Shift 2' ? 'selected' : ''}>Shift 2</option><option ${employee.shift === 'Shift 3' ? 'selected' : ''}>Shift 3</option></select></td><td><button class="btn btn-danger" data-delete="${employee.id}">Hapus</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Belum ada karyawan.</td></tr>';
  tbody.querySelectorAll('[data-schedule]').forEach((select) => select.addEventListener('change', async () => {
    const response = await fetch(`/api/employees/${select.dataset.schedule}/shift`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shift: select.value }) });
    if (!response.ok) { const data = await response.json(); alert(data.error || 'Jadwal shift gagal diperbarui.'); loadEmployees(); }
  }));
  tbody.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => { if (confirm('Hapus karyawan ini?')) { await fetch(`/api/employees/${button.dataset.delete}`, { method: 'DELETE' }); loadEmployees(); } }));
}
async function initKiosk() {
  nav('kiosk'); const video = $('#kioskVideo'); const canvas = $('#kioskCanvas'); const status = $('#kioskStatus'); let busy = false; let lastSeen = 0; let waitingForFaceToLeave = false; let faceAbsentSince = 0; let attendanceMode = 'auto';
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'btn btn-secondary'; soundButton.textContent = 'Suara: aktif';
  soundButton.title = 'Aktifkan atau matikan notifikasi suara';
  soundButton.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundButton.textContent = `Suara: ${soundEnabled ? 'aktif' : 'mati'}`;
    if (soundEnabled) {
      enableAudio();
      playNotification('info');
      speakGreeting('Suara diaktifkan');
    } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  });
  $('#threshold').closest('.field')?.after(soundButton);
  const modeControls = document.createElement('div');
  modeControls.className = 'mode-controls';
  modeControls.innerHTML = '<span>Mode absensi</span><button type="button" class="btn btn-secondary active" data-mode="auto">Otomatis</button><button type="button" class="btn btn-secondary" data-mode="masuk">Absen Masuk</button><button type="button" class="btn btn-secondary" data-mode="keluar">Absen Keluar</button>';
  modeControls.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    attendanceMode = button.dataset.mode;
    modeControls.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
    waitingForFaceToLeave = false; faceAbsentSince = 0; lastSeen = 0;
    showStatus(status, `Mode dipilih: ${button.textContent}. Hadapkan wajah ke kamera.`, 'ok');
  }));
  $('#threshold').closest('.field')?.after(modeControls);

  let currentKioskDate = new Date().toLocaleDateString('en-CA');

  // Fungsi memuat dan menampilkan petugas piket hari ini di kiosk
  const loadPiketToday = async () => {
    try {
      const todayDateStr = new Date().toLocaleDateString('en-CA');
      // Otomatis reset status kiosk jika terjadi pergantian hari
      if (todayDateStr !== currentKioskDate) {
        currentKioskDate = todayDateStr;
        waitingForFaceToLeave = false;
        faceAbsentSince = 0;
        lastSeen = 0;
        showStatus(status, 'Hari telah berganti. Siap melakukan absensi baru.', 'ok');
      }

      const res = await fetch(`/api/piket/today?_t=${Date.now()}`);
      const data = await res.json();
      const piketBadge = $('#piketDayBadge');
      if (piketBadge && data.dayName) piketBadge.textContent = data.dayName;

      const piketListEl = $('#piketStaffList');
      if (!piketListEl) return;

      // Tidak ada piket sama sekali hari ini
      if (!data.grouped || !data.grouped.length) {
        piketListEl.innerHTML = `
          <div style="color:var(--muted);font-size:13px;padding:6px 0;text-align:center;">
            🗓️ Tidak ada jadwal piket untuk hari ini.
          </div>`;
        return;
      }

      // Tentukan shift yang sedang aktif berdasarkan jam lokal
      const nowHour = new Date().getHours();
      const getActiveShift = (h) => {
        if (h >= 6 && h < 14)  return 'Shift 1';
        if (h >= 14 && h < 22) return 'Shift 2';
        return 'Shift 3';
      };
      const activeShift = getActiveShift(nowHour);

      piketListEl.innerHTML = data.grouped.map((group) => {
        const isActive = group.shift === activeShift;
        const headerStyle = isActive
          ? 'background:#fff3cd;border:1px solid #fae8cb;border-radius:8px;padding:6px 10px;margin-bottom:6px;'
          : 'background:#f7f7f7;border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin-bottom:6px;';
        const shiftColor = isActive ? '#856404' : 'var(--muted)';
        const activePill = isActive
          ? `<span style="background:#b35a00;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;margin-left:6px;">Sekarang</span>`
          : '';

        const staffRows = group.staf.map((staf) => `
          <div class="piket-item">
            <img src="${staf.foto || ''}" alt="" width="34" height="34"
              style="object-fit:cover;border-radius:8px;background:#e2ebe6;flex-shrink:0;border:2px solid ${staf.sudah_absen ? 'var(--teal)' : '#ddd'};">
            <div class="piket-item-info">
              <div class="piket-item-name">${escapeHtml(staf.nama)}</div>
              <div class="piket-item-sub">${escapeHtml(staf.nip)}</div>
            </div>
            <span class="piket-status-badge ${staf.sudah_absen ? 'hadir' : 'belum'}">
              ${staf.sudah_absen ? '✓ Hadir' : '⏳ Belum'}
            </span>
          </div>`).join('');

        return `
          <div>
            <div style="${headerStyle}">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <span style="font-weight:700;font-size:12px;color:${shiftColor};">
                  🕐 ${escapeHtml(group.shift)}${activePill}
                </span>
                <span style="font-size:11px;color:var(--muted);">${escapeHtml(group.jamMulai)} – ${escapeHtml(group.jamSelesai)}</span>
              </div>
            </div>
            <div style="display:grid;gap:6px;">${staffRows}</div>
          </div>`;
      }).join('');

    } catch (e) {
      console.warn('Gagal memuat staf piket:', e);
    }
  };

  loadPiketToday();
  setInterval(loadPiketToday, 5000);


  try { showStatus(status, 'Mengaktifkan kamera...'); await startCamera(video); showStatus(status, 'Kamera aktif. Memuat model wajah...'); await loadModels(); showStatus(status, 'Kamera aktif. Berdiri menghadap kamera.', 'ok'); }
  catch (error) { showStatus(status, error.message + ' Pastikan izin kamera diberikan dan model tersedia.', 'error'); return; }
  const threshold = () => Number($('#threshold').value) || .5;

  const captureSnapshot = (type = 'masuk') => {
    try {
      const snapCanvas = document.createElement('canvas');
      const width = 480;
      const height = 360;
      snapCanvas.width = width;
      snapCanvas.height = height;
      const ctx = snapCanvas.getContext('2d');

      // Gambar frame video cermin (mirror)
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, width, height);
      ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform agar teks tidak terbalik

      // Timestamp Real-time Indonesia
      const now = new Date();
      const tglStr = now.toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      const jamStr = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(/\./g, ':');
      const timestampStr = `${tglStr} · ${jamStr} WIB`;

      const isKeluar = String(type).toLowerCase().includes('keluar');

      // Banner Gelap Semi-Transparan di Bawah Foto
      const bannerHeight = 52;
      ctx.fillStyle = 'rgba(10, 20, 24, 0.88)';
      ctx.fillRect(0, height - bannerHeight, width, bannerHeight);

      // Garis aksen di atas banner (Hijau untuk Masuk, Biru untuk Keluar)
      const accentColor = isKeluar ? '#0284c7' : '#059669';
      ctx.fillStyle = accentColor;
      ctx.fillRect(0, height - bannerHeight, width, 4);

      // Badge Status Kotak di Kiri Bawah (🟢 ABSEN MASUK / 🔵 ABSEN KELUAR)
      const badgeWidth = isKeluar ? 140 : 135;
      const badgeHeight = 26;
      const badgeX = 12;
      const badgeY = height - bannerHeight + 14;

      ctx.fillStyle = isKeluar ? 'rgba(2, 132, 199, 0.25)' : 'rgba(5, 150, 105, 0.25)';
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 5);
      ctx.fill();
      ctx.stroke();

      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = isKeluar ? '#38bdf8' : '#34d399';
      const labelText = isKeluar ? '🔵 ABSEN KELUAR' : '🟢 ABSEN MASUK';
      ctx.fillText(labelText, badgeX + 10, badgeY + 17);

      // Cetak Teks Timestamp di Kanan Badge
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#fef08a'; // Kuning keemasan jelas
      ctx.fillText(`🕒 ${timestampStr}`, badgeX + badgeWidth + 14, badgeY + 17);

      return snapCanvas.toDataURL('image/jpeg', 0.85);
    } catch (_) {
      return null;
    }
  };

  const scan = async () => {
    if (busy) return;
    const descriptor = await getDescriptor(video, canvas);
    if (waitingForFaceToLeave) {
      if (!descriptor) {
        faceAbsentSince ||= Date.now();
        if (Date.now() - faceAbsentSince >= 1500) {
          waitingForFaceToLeave = false; faceAbsentSince = 0; lastSeen = 0;
          showStatus(status, 'Siap. Hadapkan wajah untuk absensi berikutnya.', 'ok');
        }
      } else faceAbsentSince = 0;
      return;
    }
    if (Date.now() - lastSeen < 4500 || !descriptor) return;
    busy = true;
    
    // Ambil snapshot khusus masuk dan keluar secara terpisah dengan watermark masing-masing
    const snapMasuk = captureSnapshot('masuk');
    const snapKeluar = captureSnapshot('keluar');

    const response = await fetch('/api/attendance/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        descriptor,
        threshold: threshold(),
        mode: attendanceMode,
        foto: attendanceMode === 'keluar' ? snapKeluar : snapMasuk,
        foto_masuk: snapMasuk,
        foto_keluar: snapKeluar
      })
    });
    const data = await response.json();
    lastSeen = Date.now(); busy = false; const feedback = $('#kioskFeedback');
    feedback.className = `feedback ${data.recognized && !data.outsideShift && !data.tooEarly ? data.status === 'keluar' ? 'checkout' : 'success' : 'failed'}`;
    playNotification(!data.recognized ? 'error' : data.outsideShift ? 'warning' : data.status === 'selesai' ? 'info' : 'success');

    if (data.recognized) {
      const piketNoteAudio = data.isPiket ? '. Pengingat: Anda bertugas piket hari ini, jangan lupa laksanakan tugas piket.' : '';

      if (data.outsideShift) {
        speakGreeting(`Maaf ${data.nama}, jadwal absensi Anda di luar jam shift.`);
      } else if (data.tooEarly) {
        speakGreeting(`Maaf ${data.nama}, jam kerja shift Anda belum selesai.`);
      } else if (data.status === 'belum masuk') {
        speakGreeting(`${data.nama}, silakan lakukan absen masuk terlebih dahulu.`);
      } else if (data.status === 'sudah masuk') {
        speakGreeting(`${data.nama}, absen masuk sudah tercatat${piketNoteAudio}`);
      } else if (data.status === 'selesai') {
        speakGreeting(`${data.nama}, absensi hari ini sudah lengkap.`);
      } else if (data.status === 'masuk') {
        const greeting = getTimeGreeting();
        const lateNote = data.terlambat ? ', Anda tercatat terlambat' : '';
        speakGreeting(`${greeting}, ${data.nama}. Absen masuk berhasil dicatat${lateNote}${piketNoteAudio}`);
      } else if (data.status === 'keluar') {
        speakGreeting(`Terima kasih, ${data.nama}. Absen pulang berhasil dicatat. Selamat beristirahat.`);
      }
      loadPiketToday();
    } else {
      speakGreeting('Wajah belum dikenali. Silakan hadapkan wajah dengan jelas.');
    }

    const piketBannerHtml = data.recognized && data.isPiket
      ? '<div style="margin-top:8px;background:#fff3cd;color:#856404;font-weight:700;padding:5px 9px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px;">🧹 PENGINGAT: Anda bertugas PIKET hari ini!</div>'
      : '';

    feedback.innerHTML = data.recognized
      ? `<strong>${escapeHtml(data.nama)}</strong><div>${data.outsideShift || data.tooEarly || data.status === 'belum masuk' || data.status === 'sudah masuk' ? escapeHtml(data.error) : data.status === 'selesai' ? 'Absensi hari ini sudah lengkap' : data.status === 'masuk' ? 'ABSEN MASUK berhasil' : 'ABSEN KELUAR berhasil'}${data.terlambat ? ' · terlambat' : ''}</div><small>${data.jam || ''} · ${escapeHtml(data.nip)} · ${escapeHtml(data.shift || '')}${data.excelUpdated === false ? ' · Tutup file Excel agar dapat diperbarui' : ''}</small>${piketBannerHtml}`
      : `<strong>Belum dikenali</strong><div>${data.error || 'Coba posisikan wajah lebih jelas.'}</div>`;

    if (data.recognized && !data.outsideShift && !data.tooEarly && ['masuk', 'keluar', 'selesai'].includes(data.status)) {
      waitingForFaceToLeave = true;
      showStatus(status, 'Absensi tercatat. Silakan menjauh dari kamera sebelum absensi berikutnya.', 'ok');
    }
  };
  setInterval(() => scan().catch((error) => showStatus(status, error.message, 'error')), 700);

}
async function initDashboard() {
  nav('dashboard');
  const date = $('#dateFilter');
  date.value = new Date().toLocaleDateString('en-CA');

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'btn btn-primary';
  exportButton.textContent = 'Export Excel';
  exportButton.addEventListener('click', () => {
    window.location.href = `/api/attendance/export.xlsx?tanggal=${date.value}`;
  });
  $('#filterForm').append(exportButton);

  let currentRows = [];
  let currentAbsent = [];
  let currentOff = [];
  let currentShiftTimes = {};
  let searchQuery = '';

  const tabPresentBtn = $('#tabPresentBtn');
  const tabAbsentBtn = $('#tabAbsentBtn');
  const tabOffBtn = $('#tabOffBtn');
  const presentTableWrap = $('#presentTableWrap');
  const absentTableWrap = $('#absentTableWrap');
  const offTableWrap = $('#offTableWrap');

  const switchTab = (tab) => {
    tabPresentBtn?.classList.toggle('active', tab === 'present');
    tabAbsentBtn?.classList.toggle('active', tab === 'absent');
    tabOffBtn?.classList.toggle('active', tab === 'off');

    if (presentTableWrap) presentTableWrap.style.display = tab === 'present' ? 'block' : 'none';
    if (absentTableWrap) absentTableWrap.style.display = tab === 'absent' ? 'block' : 'none';
    if (offTableWrap) offTableWrap.style.display = tab === 'off' ? 'block' : 'none';
  };

  tabPresentBtn?.addEventListener('click', () => switchTab('present'));
  tabAbsentBtn?.addEventListener('click', () => switchTab('absent'));
  tabOffBtn?.addEventListener('click', () => switchTab('off'));

  const matchesSearch = (item, query) => {
    if (!query) return true;
    return (item.nama && item.nama.toLowerCase().includes(query)) ||
           (item.nip && item.nip.toLowerCase().includes(query));
  };

  const formatTanggalId = (isoStr) => {
    if (!isoStr) return '';
    try {
      const [y, m, d] = isoStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      return isoStr;
    }
  };

  const renderTables = () => {
    // TAB 1: SUDAH HADIR
    const filteredRows = currentRows.filter((r) => matchesSearch(r, searchQuery));
    const recordRows = $('#recordRows');
    if (recordRows) {
      recordRows.innerHTML = filteredRows.length
        ? filteredRows.map((row) => {
            const isDifferentShift = row.jadwal_shift && row.jadwal_shift !== 'Libur (Off)' && row.jadwal_shift !== 'Otomatis' && row.shift !== row.jadwal_shift;
            const imgMasuk = row.foto_masuk || row.foto || '';
            const imgKeluar = row.foto_keluar || '';
            return `
            <tr>
              <td>
                ${imgMasuk ? `<img src="${imgMasuk}" alt="Foto Masuk" width="56" height="42" style="object-fit:cover;border-radius:6px;background:#e2ebe6;border:1.5px solid #10b981;cursor:pointer;" title="Klik untuk lihat foto masuk" onclick="window.open('${imgMasuk}','_blank')">` : '<span style="color:var(--muted);font-size:11px;">—</span>'}
              </td>
              <td>
                ${imgKeluar ? `<img src="${imgKeluar}" alt="Foto Keluar" width="56" height="42" style="object-fit:cover;border-radius:6px;background:#e2ebe6;border:1.5px solid #0284c7;cursor:pointer;" title="Klik untuk lihat foto keluar" onclick="window.open('${imgKeluar}','_blank')">` : '<span class="badge" style="background:#f1f5f9;color:#64748b;font-size:10px;padding:3px 6px;">Belum Pulang</span>'}
              </td>
              <td>
                <strong>${escapeHtml(row.nama)}</strong>
                ${row.is_piket ? '<span class="badge piket" style="font-size:10px;padding:1px 6px;margin-left:4px;">🧹 Piket</span>' : ''}
              </td>
              <td>${escapeHtml(row.nip)}</td>
              <td><span class="badge ${row.jadwal_shift === 'Libur (Off)' ? 'off' : 'shift-badge'}">${escapeHtml(row.jadwal_shift || '-')}</span></td>
              <td>
                <span class="badge ${isDifferentShift ? 'mismatch' : 'ok'}">${escapeHtml(row.shift || '-')}</span>
                ${isDifferentShift ? '<small style="color:#b37418;display:block;font-size:10px;">(beda jadwal)</small>' : ''}
              </td>
              <td>${row.jam_masuk || '-'}</td>
              <td>${row.jam_keluar || '-'}</td>
              <td><span class="badge ${row.status === 'lengkap' ? 'ok' : 'pending'}">${row.status}${row.terlambat ? ' · terlambat' : ''}</span></td>
            </tr>
          `;
          }).join('')
        : `<tr><td colspan="9" class="empty">${searchQuery ? 'Tidak ada hasil yang cocok dengan pencarian.' : 'Belum ada data kehadiran pada tanggal ini.'}</td></tr>`;
    }

    // TAB 2: BELUM HADIR (ALPHA)
    const filteredAbsent = currentAbsent.filter((r) => matchesSearch(r, searchQuery));
    const absentRows = $('#absentRows');
    if (absentRows) {
      absentRows.innerHTML = filteredAbsent.length
        ? filteredAbsent.map((emp) => `
            <tr>
              <td><img src="${emp.foto || ''}" alt="" width="42" height="32" style="object-fit:cover;border-radius:6px;background:#e2ebe6"></td>
              <td>
                <strong>${escapeHtml(emp.nama)}</strong>
                ${emp.is_piket ? '<span class="badge piket" style="font-size:10px;padding:1px 6px;margin-left:4px;">🧹 Piket</span>' : ''}
              </td>
              <td>${escapeHtml(emp.nip)}</td>
              <td><span class="badge shift-badge">${escapeHtml(emp.jadwal_shift || 'Shift 1')}</span></td>
              <td><span style="font-size:13px;color:var(--muted);">${currentShiftTimes[emp.jadwal_shift] || '06:00 - 14:00'}</span></td>
              <td><span class="badge fail">Alpha / Belum Masuk</span></td>
            </tr>
          `).join('')
        : `<tr><td colspan="6" class="empty">${searchQuery ? 'Tidak ada hasil yang cocok dengan pencarian.' : (currentRows.length ? 'Semua karyawan yang terjadwal kerja hari ini sudah hadir.' : 'Tidak ada karyawan yang belum hadir.')}</td></tr>`;
    }

    // TAB 3: LIBUR / OFF
    const filteredOff = currentOff.filter((r) => matchesSearch(r, searchQuery));
    const offRows = $('#offRows');
    if (offRows) {
      offRows.innerHTML = filteredOff.length
        ? filteredOff.map((emp) => `
            <tr>
              <td><img src="${emp.foto || ''}" alt="" width="42" height="32" style="object-fit:cover;border-radius:6px;background:#e2ebe6"></td>
              <td><strong>${escapeHtml(emp.nama)}</strong></td>
              <td>${escapeHtml(emp.nip)}</td>
              <td><span class="badge off">Libur (Off)</span></td>
              <td><span style="font-size:13px;color:var(--muted);">Tidak ada jadwal kerja pada hari ini</span></td>
            </tr>
          `).join('')
        : `<tr><td colspan="5" class="empty">${searchQuery ? 'Tidak ada hasil yang cocok dengan pencarian.' : 'Tidak ada karyawan yang libur hari ini.'}</td></tr>`;
    }
  };

  const searchInput = $('#searchInput');
  searchInput?.addEventListener('input', (event) => {
    searchQuery = event.target.value.trim().toLowerCase();
    renderTables();
  });

  const refresh = async () => {
    try {
      const response = await fetch(`/api/attendance?tanggal=${date.value}`);
      const data = await response.json();
      currentRows = data.rows || [];
      currentAbsent = data.absent || [];
      currentOff = data.off || [];
      currentShiftTimes = data.shiftTimes || {};

      const formattedDate = formatTanggalId(date.value);
      if ($('#currentDayBadge')) $('#currentDayBadge').textContent = formattedDate;
      if ($('#subheadDate')) $('#subheadDate').textContent = `Menampilkan kehadiran & jadwal shift untuk ${formattedDate}.`;

      const stats = data.stats || {
        totalEmployees: currentRows.length + currentAbsent.length + currentOff.length,
        scheduledCount: currentRows.length + currentAbsent.length,
        offCount: currentOff.length,
        presentCount: currentRows.length,
        absentCount: currentAbsent.length,
        lateCount: currentRows.filter((r) => r.terlambat).length
      };

      if ($('#statTotalEmployees')) $('#statTotalEmployees').textContent = stats.totalEmployees;
      if ($('#statScheduledCount')) $('#statScheduledCount').textContent = stats.scheduledCount ?? (stats.presentCount + stats.absentCount);
      if ($('#statPresentCount')) $('#statPresentCount').textContent = stats.presentCount;
      if ($('#statAbsentCount')) $('#statAbsentCount').textContent = stats.absentCount;
      if ($('#statOffCount')) $('#statOffCount').textContent = stats.offCount ?? 0;
      if ($('#statLateCount')) $('#statLateCount').textContent = stats.lateCount;

      if ($('#presentTabBadge')) $('#presentTabBadge').textContent = stats.presentCount;
      if ($('#absentTabBadge')) $('#absentTabBadge').textContent = stats.absentCount;
      if ($('#offTabBadge')) $('#offTabBadge').textContent = stats.offCount ?? 0;

      renderTables();
    } catch (error) {
      console.error('Gagal memperbarui data rekap:', error);
    }
  };

  $('#filterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    refresh();
  });
  date.addEventListener('change', refresh);

  refresh();
  setInterval(refresh, 5000);
}

async function initJadwal() {
  nav('jadwal');
  const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const SHIFTS = ['Shift 1', 'Shift 2', 'Shift 3'];
  const loading = $('#scheduleLoading');
  const grid = $('#scheduleGrid');
  const emptyEl = $('#scheduleEmpty');
  const tbody = $('#scheduleRows');
  const searchInput = $('#jadwalSearchInput');

  // Ambil data pengaturan jam shift untuk tooltip dan tampilan jam
  let shiftTimes = {
    'Shift 1': '06:00 - 14:00',
    'Shift 2': '14:00 - 22:00',
    'Shift 3': '22:00 - 06:00'
  };
  try {
    const sRes = await fetch('/api/settings').then((r) => r.json());
    if (sRes.shift1_start && sRes.shift1_end) shiftTimes['Shift 1'] = `${sRes.shift1_start} - ${sRes.shift1_end}`;
    if (sRes.shift2_start && sRes.shift2_end) shiftTimes['Shift 2'] = `${sRes.shift2_start} - ${sRes.shift2_end}`;
    if (sRes.shift3_start && sRes.shift3_end) shiftTimes['Shift 3'] = `${sRes.shift3_start} - ${sRes.shift3_end}`;
  } catch (_) {}

  // Tentukan nama hari ini dalam bahasa Indonesia
  const dayIdMap = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const todayName = dayIdMap[new Date().getDay()];

  // Highlight kolom header hari ini
  const highlightTodayHeader = () => {
    document.querySelectorAll('#jadwalHeader th[data-day]').forEach((th) => {
      const isToday = th.dataset.day === todayName;
      th.classList.toggle('day-today-th', isToday);
      if (isToday) {
        th.innerHTML = `
          <div style="font-size:10px;background:#2563eb;color:#fff;border-radius:4px;padding:2px 6px;margin-bottom:3px;display:inline-block;font-weight:800;letter-spacing:0.04em;">HARI INI</div>
          <div style="font-size:13px;font-weight:800;">${th.dataset.day}</div>
        `;
      } else {
        th.innerHTML = `<div style="font-size:13px;font-weight:700;">${th.dataset.day}</div>`;
      }
    });
  };

  // Modal elemen
  const modal = $('#editModal');
  const modalName = $('#modalEmployeeName');
  const modalNip = $('#modalEmployeeNip');
  const modalStatus = $('#modalStatus');
  const dayEditorGrid = $('#dayEditorGrid');
  const modalSaveBtn = $('#modalSaveBtn');
  const modalClose = $('#modalClose');
  const modalCancelBtn = $('#modalCancelBtn');

  let currentEmployee = null;

  const closeModal = () => {
    modal.style.display = 'none';
    currentEmployee = null;
    modalStatus.textContent = '';
    modalStatus.className = 'status';
  };
  modalClose?.addEventListener('click', closeModal);
  modalCancelBtn?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  const renderDayCell = (day, isToday) => {
    const todayBorder = isToday ? 'border: 2px solid #2563eb; background: #f0f7ff;' : 'border: 1px solid #e2e8f0; background: #fff;';
    if (day.aktif) {
      const sNum = day.shift === 'Shift 1' ? 's1' : day.shift === 'Shift 2' ? 's2' : 's3';
      const sIcon = day.shift === 'Shift 1' ? '🟢' : day.shift === 'Shift 2' ? '🔵' : '🟠';
      const sJam = shiftTimes[day.shift] || '';
      return `
        <div class="schedule-day-box" style="${todayBorder}">
          <div class="schedule-chip-btn ${sNum}" title="${day.shift} (${sJam})">
            <span>${sIcon} ${day.shift}</span>
          </div>
          <div class="schedule-time-hint">${sJam}</div>
          ${day.piket ? '<div class="schedule-piket-tag">🧹 Piket</div>' : ''}
        </div>
      `;
    }
    return `
      <div class="schedule-day-box" style="${todayBorder}">
        <div class="schedule-chip-btn off" title="Libur (Off)">
          <span>⚪ Libur</span>
        </div>
      </div>
    `;
  };

  let allData = [];
  let searchQuery = '';

  const renderRows = () => {
    let filtered = allData;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = allData.filter((e) => e.nama.toLowerCase().includes(q) || e.nip.toLowerCase().includes(q));
    }

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">Tidak ada karyawan yang cocok dengan kata kunci pencarian.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((emp) => {
      const hariKerja = emp.jadwal?.filter((d) => d.aktif).length || 0;
      const hariPiket = emp.jadwal?.filter((d) => d.aktif && d.piket).length || 0;
      const defaultShiftBadge = emp.shift && emp.shift !== 'Otomatis'
        ? `<span class="badge shift-badge" style="font-size:10px;padding:3px 7px;">${escapeHtml(emp.shift)}</span>` : '';
      return `
        <tr data-id="${emp.id}" title="Klik untuk edit jadwal ${escapeHtml(emp.nama)}" style="cursor:pointer;">
          <td style="padding:14px 18px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <img src="${emp.foto || ''}" alt="" width="44" height="44"
                style="object-fit:cover;border-radius:10px;background:#e2ebe6;flex-shrink:0;border:2px solid var(--line);">
              <div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <strong style="font-size:15px;color:var(--ink);">${escapeHtml(emp.nama)}</strong>
                  ${defaultShiftBadge}
                </div>
                <div style="font-size:12px;color:var(--muted);margin-top:3px;">
                  <span style="font-weight:600;color:#334155;">${escapeHtml(emp.nip)}</span>
                  · <span style="color:var(--teal-dark);font-weight:700;">${hariKerja} hari/minggu</span>
                  ${hariPiket ? `· <span style="color:#b45309;font-weight:700;">🧹 ${hariPiket}× piket</span>` : ''}
                </div>
              </div>
            </div>
          </td>
          ${emp.jadwal.map((d) => {
            const isToday = d.hari === todayName;
            return `<td class="day-col" style="text-align:center;padding:8px 6px;">${renderDayCell(d, isToday)}</td>`;
          }).join('')}
          <td style="text-align:center;padding:14px 16px;">
            <button type="button" class="btn btn-secondary" style="padding:8px 14px;font-size:12px;white-space:nowrap;font-weight:700;"
              data-edit="${emp.id}">✏️ Edit</button>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(Number(btn.dataset.edit));
      });
    });
    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => openModal(Number(row.dataset.id)));
    });
  };

  const loadSchedules = async () => {
    try {
      const data = await fetch('/api/schedules').then((r) => r.json());
      allData = data;
      loading.style.display = 'none';
      if (!data.length) { emptyEl.style.display = 'block'; grid.style.display = 'none'; return; }
      emptyEl.style.display = 'none';
      grid.style.display = 'block';

      // Update stat cards
      const totalKary = data.length;
      const kerjaHariIni = data.filter((e) => e.jadwal?.find((d) => d.hari === todayName && d.aktif)).length;
      const piketHariIni = data.filter((e) => e.jadwal?.find((d) => d.hari === todayName && d.aktif && d.piket)).length;
      const liburHariIni = totalKary - kerjaHariIni;
      if ($('#statTotalKaryawan')) $('#statTotalKaryawan').textContent = totalKary;
      if ($('#statHariIniKerja')) $('#statHariIniKerja').textContent = kerjaHariIni;
      if ($('#statHariIniPiket')) $('#statHariIniPiket').textContent = piketHariIni;
      if ($('#statHariIniLibur')) $('#statHariIniLibur').textContent = liburHariIni;

      highlightTodayHeader();
      renderRows();
    } catch (err) {
      loading.textContent = 'Gagal memuat jadwal: ' + err.message;
    }
  };

  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderRows();
  });

  const openModal = (employeeId) => {
    const emp = allData.find((e) => e.id === employeeId);
    if (!emp) return;
    currentEmployee = emp;
    modalName.textContent = emp.nama;
    modalNip.textContent = 'NIP / ID: ' + emp.nip;
    modalStatus.textContent = '';
    modalStatus.className = 'status';

    // Injeksi tombol preset cepat ke dalam modal jika belum ada
    let presetsContainer = $('#modalPresetsContainer');
    if (!presetsContainer) {
      presetsContainer = document.createElement('div');
      presetsContainer.id = 'modalPresetsContainer';
      presetsContainer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line);';
      presetsContainer.innerHTML = `
        <span style="font-size:12px;font-weight:700;color:var(--muted);align-self:center;">Preset Cepat:</span>
        <button type="button" class="btn btn-secondary btn-preset-modal" data-preset="5days" style="font-size:11px;padding:5px 9px;">⚡ Sen - Jum (5 Hari)</button>
        <button type="button" class="btn btn-secondary btn-preset-modal" data-preset="6days" style="font-size:11px;padding:5px 9px;">⚡ Sen - Sab (6 Hari)</button>
        <button type="button" class="btn btn-secondary btn-preset-modal" data-preset="all7" style="font-size:11px;padding:5px 9px;">⚡ Semua 7 Hari</button>
        <button type="button" class="btn btn-secondary btn-preset-modal" data-preset="clear" style="font-size:11px;padding:5px 9px;color:var(--coral);">Reset Libur</button>
      `;
      dayEditorGrid.parentNode.insertBefore(presetsContainer, dayEditorGrid);

      presetsContainer.querySelectorAll('.btn-preset-modal').forEach((pBtn) => {
        pBtn.addEventListener('click', () => {
          const type = pBtn.dataset.preset;
          const days5 = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
          const days6 = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
          dayEditorGrid.querySelectorAll('.day-editor-item').forEach((item) => {
            const hari = item.dataset.hari;
            const chk = item.querySelector('.day-check');
            const sel = item.querySelector('.day-shift');
            const piketChk = item.querySelector('.piket-check');
            let shouldCheck = false;
            if (type === '5days') shouldCheck = days5.includes(hari);
            else if (type === '6days') shouldCheck = days6.includes(hari);
            else if (type === 'all7') shouldCheck = true;
            else if (type === 'clear') shouldCheck = false;

            chk.checked = shouldCheck;
            sel.disabled = !shouldCheck;
            if (piketChk) {
              piketChk.disabled = !shouldCheck;
              if (!shouldCheck) piketChk.checked = false;
            }
            item.classList.toggle('day-on', shouldCheck);
          });
        });
      });
    }

    dayEditorGrid.innerHTML = emp.jadwal.map((day) => `
      <div class="day-editor-item ${day.aktif ? 'day-on' : ''}" data-hari="${day.hari}">
        <label class="day-label" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
          <span style="font-weight:700;font-size:14px;">${day.hari}</span>
          <input type="checkbox" ${day.aktif ? 'checked' : ''} class="day-check" data-hari="${day.hari}">
        </label>
        <select class="day-shift" data-hari="${day.hari}" ${!day.aktif ? 'disabled' : ''}>
          ${SHIFTS.map((s) => `<option value="${s}" ${day.shift === s ? 'selected' : ''}>${s} (${shiftTimes[s] || ''})</option>`).join('')}
        </select>
        <div class="day-piket-wrap">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;width:100%;">
            <input type="checkbox" class="piket-check" data-hari="${day.hari}" ${day.piket ? 'checked' : ''} ${!day.aktif ? 'disabled' : ''}>
            <span>🧹 Giliran Piket</span>
          </label>
        </div>
      </div>
    `).join('');

    dayEditorGrid.querySelectorAll('.day-check').forEach((chk) => {
      const item = chk.closest('.day-editor-item');
      const sel = item.querySelector('.day-shift');
      const piketChk = item.querySelector('.piket-check');
      chk.addEventListener('change', () => {
        sel.disabled = !chk.checked;
        if (piketChk) {
          piketChk.disabled = !chk.checked;
          if (!chk.checked) piketChk.checked = false;
        }
        item.classList.toggle('day-on', chk.checked);
      });
    });

    modal.style.display = 'flex';
  };

  modalSaveBtn?.addEventListener('click', async () => {
    if (!currentEmployee) return;
    const jadwal = DAYS.map((hari) => {
      const item = dayEditorGrid.querySelector(`[data-hari="${hari}"]`);
      const aktif = item?.querySelector('.day-check')?.checked || false;
      const shift = item?.querySelector('.day-shift')?.value || 'Shift 1';
      const piket = item?.querySelector('.piket-check')?.checked || false;
      return { hari, aktif, shift, piket };
    });

    try {
      modalSaveBtn.disabled = true;
      modalSaveBtn.textContent = 'Menyimpan...';
      const res = await fetch(`/api/schedules/${currentEmployee.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jadwal })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan jadwal.');

      showStatus(modalStatus, '✓ Jadwal berhasil diperbarui!', 'ok');
      await loadSchedules();
      setTimeout(closeModal, 800);
    } catch (err) {
      showStatus(modalStatus, err.message, 'error');
    } finally {
      modalSaveBtn.disabled = false;
      modalSaveBtn.textContent = '💾 Simpan jadwal';
    }
  });

  await loadSchedules();
}

async function initSettings() {
  nav('settings');
  const form = $('#settingsForm');
  const status = $('#settingsStatus');
  if (!form) return;

  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    if ($('#shift1_start')) $('#shift1_start').value = data.shift1_start || '06:00';
    if ($('#shift1_end')) $('#shift1_end').value = data.shift1_end || '14:00';
    if ($('#shift2_start')) $('#shift2_start').value = data.shift2_start || '14:00';
    if ($('#shift2_end')) $('#shift2_end').value = data.shift2_end || '22:00';
    if ($('#shift3_start')) $('#shift3_start').value = data.shift3_start || '22:00';
    if ($('#shift3_end')) $('#shift3_end').value = data.shift3_end || '06:00';
    if ($('#late_tolerance')) $('#late_tolerance').value = data.late_tolerance || 30;
  } catch (error) {
    showStatus(status, 'Gagal memuat pengaturan awal: ' + error.message, 'error');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      shift1_start: $('#shift1_start').value,
      shift1_end: $('#shift1_end').value,
      shift2_start: $('#shift2_start').value,
      shift2_end: $('#shift2_end').value,
      shift3_start: $('#shift3_start').value,
      shift3_end: $('#shift3_end').value,
      late_tolerance: $('#late_tolerance').value,
      admin_pin: $('#admin_pin').value,
      new_admin_pin: $('#new_admin_pin').value
    };

    try {
      showStatus(status, 'Menyimpan pengaturan...');
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gagal menyimpan pengaturan.');

      showStatus(status, 'Pengaturan berhasil disimpan!', 'ok');
      $('#admin_pin').value = '';
      $('#new_admin_pin').value = '';
    } catch (error) {
      showStatus(status, error.message, 'error');
    }
  });
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
window.addEventListener('beforeunload', () => stopCamera(document.querySelector('video')));

function getAuthToken() {
  return localStorage.getItem('admin_token');
}
function setAuthToken(token) {
  localStorage.setItem('admin_token', token);
}
function clearAuthToken() {
  localStorage.removeItem('admin_token');
  sessionStorage.removeItem('admin_token'); // bersihkan sisa lama
}

function setupAdminNav() {
  const navContainer = document.querySelector('.nav');
  if (!navContainer) return;
  const token = getAuthToken();

  if (token) {
    if (!$('#logoutBtn')) {
      const logoutBtn = document.createElement('a');
      logoutBtn.id = 'logoutBtn';
      logoutBtn.href = '#';
      logoutBtn.className = 'logout-nav-btn';
      logoutBtn.innerHTML = 'Keluar (Logout)';
      logoutBtn.style.color = 'var(--coral)';
      logoutBtn.style.fontWeight = '700';
      logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
        } catch (_) {}
        clearAuthToken();
        window.location.replace('/');
      });
      navContainer.appendChild(logoutBtn);
    }
  } else {
    const currentPath = window.location.pathname;
    if (currentPath === '/' || currentPath.endsWith('index.html')) {
      if (!$('#loginNavBtn')) {
        const loginLink = document.createElement('a');
        loginLink.id = 'loginNavBtn';
        loginLink.href = '/login.html';
        loginLink.textContent = '🔒 Login Admin';
        loginLink.style.fontWeight = '700';
        navContainer.appendChild(loginLink);
      }
    }
  }
}

async function initLaporan() {
  nav('laporan');

  const startDateInput = $('#lapStartDate');
  const endDateInput = $('#lapEndDate');
  const shiftFilterSelect = $('#lapShiftFilter');
  const form = $('#laporanFilterForm');
  const statusEl = $('#laporanStatus');
  const loadingEl = $('#reportLoading');
  const containerEl = $('#reportContainer');
  const tbody = $('#repTableBody');
  const btnExportExcel = $('#btnExportExcelPeriod');
  const btnPrintPdf = $('#btnPrintPdf');

  const presetBtns = document.querySelectorAll('.preset-btn');

  const today = new Date().toLocaleDateString('en-CA');

  const setDateRange = (start, end) => {
    startDateInput.value = start;
    endDateInput.value = end;
  };

  const applyPreset = (preset) => {
    const now = new Date();
    if (preset === 'thisMonth') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-CA');
      setDateRange(firstDay, today);
    } else if (preset === 'lastMonth') {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString('en-CA');
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).toLocaleDateString('en-CA');
      setDateRange(firstDay, lastDay);
    } else if (preset === 'last7') {
      const past7 = new Date();
      past7.setDate(past7.getDate() - 6);
      setDateRange(past7.toLocaleDateString('en-CA'), today);
    } else if (preset === 'today') {
      setDateRange(today, today);
    }
  };

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyPreset(btn.dataset.preset);
      loadReport();
    });
  });

  applyPreset('thisMonth');

  let currentReportData = null;

  const formatDateIndo = (dateStr) => {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-');
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    return `${d} ${months[Number(m) - 1]} ${y}`;
  };

  const loadReport = async () => {
    const start = startDateInput.value;
    const end = endDateInput.value;
    if (!start || !end) return;

    loadingEl.style.display = 'block';
    containerEl.style.display = 'none';
    statusEl.textContent = '';

    try {
      const res = await fetch(`/api/attendance/summary-period?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat rekap periode.');

      currentReportData = data;
      renderReport();
    } catch (err) {
      loadingEl.style.display = 'none';
      showStatus(statusEl, err.message, 'error');
    }
  };

  const renderReport = () => {
    if (!currentReportData) return;
    const data = currentReportData;
    const selectedShift = shiftFilterSelect.value;

    let filteredEmployees = data.employees;
    if (selectedShift !== 'ALL') {
      filteredEmployees = filteredEmployees.filter((e) => (e.shift || 'Shift 1') === selectedShift);
    }

    loadingEl.style.display = 'none';
    containerEl.style.display = 'block';

    // Meta
    $('#docPrintDate').textContent = new Date().toLocaleDateString('id-ID', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    $('#repPeriodRange').textContent = `${formatDateIndo(data.startDate)} s/d ${formatDateIndo(data.endDate)}`;
    $('#repTotalDays').textContent = data.totalDays;

    // KPI
    const totalEmp = filteredEmployees.length;
    const totalPresent = filteredEmployees.reduce((acc, e) => acc + e.totalPresent, 0);
    const totalLate = filteredEmployees.reduce((acc, e) => acc + e.totalLate, 0);
    const totalAbsent = filteredEmployees.reduce((acc, e) => acc + e.totalAbsent, 0);
    const totalScheduled = filteredEmployees.reduce((acc, e) => acc + e.totalScheduledDays, 0);
    const avgRate = totalScheduled > 0 ? Math.round((totalPresent / totalScheduled) * 100) : 100;

    $('#repKpiTotalEmp').textContent = totalEmp;
    $('#repKpiAvgRate').textContent = `${avgRate}%`;
    $('#repKpiTotalLate').textContent = totalLate;
    $('#repKpiTotalAbsent').textContent = totalAbsent;

    // Table rows
    if (!filteredEmployees.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted);">Tidak ada data karyawan yang sesuai filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = filteredEmployees.map((emp, index) => {
      const rateClass = emp.attendanceRate >= 90 ? 'color:var(--teal-dark);' : emp.attendanceRate >= 75 ? 'color:#b37418;' : 'color:var(--coral);';
      return `
        <tr>
          <td style="text-align:center;">${index + 1}</td>
          <td><strong>${escapeHtml(emp.nip)}</strong></td>
          <td>
            <div style="font-weight:600;">${escapeHtml(emp.nama)}</div>
          </td>
          <td style="text-align:center;"><span class="badge shift-badge" style="font-size:10px;">${escapeHtml(emp.shift || 'Otomatis')}</span></td>
          <td style="text-align:center;font-weight:600;">${emp.totalScheduledDays} hari</td>
          <td style="text-align:center;color:var(--teal-dark);font-weight:700;">${emp.totalOnTime}</td>
          <td style="text-align:center;color:#b37418;font-weight:700;">${emp.totalLate}</td>
          <td style="text-align:center;color:var(--coral);font-weight:700;">${emp.totalAbsent}</td>
          <td style="text-align:center;font-weight:800;${rateClass}">${emp.attendanceRate}%</td>
        </tr>
      `;
    }).join('');
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    presetBtns.forEach((b) => b.classList.remove('active'));
    loadReport();
  });

  shiftFilterSelect.addEventListener('change', renderReport);

  btnExportExcel.addEventListener('click', () => {
    const start = startDateInput.value;
    const end = endDateInput.value;
    if (!start || !end) return;
    window.location.href = `/api/attendance/export-period.xlsx?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`;
  });

  btnPrintPdf.addEventListener('click', () => {
    window.print();
  });

  loadReport();
}

function protectAdminPages() {
  const currentPath = window.location.pathname;
  const protectedPages = ['register.html', 'dashboard.html', 'settings.html', 'jadwal.html', 'laporan.html'];
  const isProtected = protectedPages.some((page) => currentPath.endsWith(page));

  if (isProtected) {
    const token = getAuthToken();
    if (!token) {
      window.location.replace('/login.html?redirect=' + encodeURIComponent(currentPath));
      return false;
    }
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    }).then((res) => {
      if (!res.ok) {
        clearAuthToken();
        window.location.replace('/login.html?redirect=' + encodeURIComponent(currentPath));
      }
    }).catch(() => {});
  }
  return true;
}

function initLogin() {
  const form = $('#loginForm');
  const status = $('#loginStatus');
  if (!form) return;

  // Jika sudah login, langsung alihkan
  if (getAuthToken()) {
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/dashboard.html';
    window.location.replace(redirect);
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('#loginPin')?.value.trim();
    if (!pin) return;

    try {
      showStatus(status, 'Memverifikasi PIN...');
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'PIN tidak sesuai.');

      setAuthToken(data.token);
      showStatus(status, 'Login berhasil! Mengalihkan...', 'ok');

      const redirect = new URLSearchParams(window.location.search).get('redirect') || '/dashboard.html';
      setTimeout(() => {
        window.location.replace(redirect);
      }, 400);
    } catch (err) {
      showStatus(status, err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  protectAdminPages();
  setupAdminNav();
  if (document.querySelector('#loginForm')) initLogin();
  if (document.querySelector('#registerVideo')) initRegister();
  if (document.querySelector('#kioskVideo')) initKiosk();
  if (document.querySelector('#recordRows')) initDashboard();
  if (document.querySelector('#scheduleRows')) initJadwal();
  if (document.querySelector('#reportContainer')) initLaporan();
  if (document.querySelector('#settingsForm')) initSettings();
});



