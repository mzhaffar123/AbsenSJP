const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

async function generateSSL() {
  const sslDir = path.join(__dirname, '..', 'ssl');
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { recursive: true });
  }

  console.log('🔒 Membuat sertifikat SSL lokal (Self-Signed)...');

  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'countryName', value: 'ID' },
    { name: 'organizationName', value: 'AbsensiMuka' }
  ];

  const pkeys = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256'
  });

  fs.writeFileSync(path.join(sslDir, 'key.pem'), pkeys.private);
  fs.writeFileSync(path.join(sslDir, 'cert.pem'), pkeys.cert);

  console.log('✅ Sertifikat SSL lokal berhasil dibuat di folder ssl/');
  console.log('   - Key:  ssl/key.pem');
  console.log('   - Cert: ssl/cert.pem');
  console.log('🚀 Sekarang jalankan `npm start` atau `npm run dev` untuk membuka https://localhost:3000');
}

generateSSL().catch((err) => {
  console.error('❌ Gagal membuat sertifikat SSL:', err);
  process.exit(1);
});
