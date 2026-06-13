# Panduan Pengembang (Developer Guide) - JawaraLite for Orthanc

Dokumen ini adalah panduan lengkap untuk instalasi, konfigurasi, dan pengembangan sistem **JawaraLite** — DICOM Viewer berbasis web yang terintegrasi dengan Orthanc PACS dan Mirth Connect.

---

## Daftar Isi

1. [Arsitektur Sistem](#1-arsitektur-sistem)
2. [Instalasi Orthanc PACS](#2-instalasi-orthanc-pacs)
3. [Konfigurasi Orthanc](#3-konfigurasi-orthanc)
4. [Instalasi JawaraLite](#4-instalasi-jawaralite)
5. [Integrasi Mirth Connect (HL7 Worklist)](#5-integrasi-mirth-connect-hl7-worklist)
6. [Integrasi SIMRS](#6-integrasi-simrs)
7. [Pengujian dan Validasi](#7-pengujian-dan-validasi)
8. [Pemeliharaan & Troubleshooting](#8-pemeliharaan--troubleshooting)

---

## 1. Arsitektur Sistem

![Flowchart End-to-End JawaraLite](/Volumes/Data 1/project-orthanc-viewer/flowchart_end_to_end.png)

### Penjelasan Alur

**Swim Lane 1 — Alur Order / Worklist (atas):**
1. **SIMRS** mengirim order pemeriksaan ke Mirth Connect dalam format HL7 ORM via protokol MLLP (TCP).
2. **Mirth Connect** meneruskan pesan HL7 raw ke Node.js Receiver via HTTP POST.
3. **Node.js Receiver** (port 8090) mem-parsing segmen HL7 (PID, ORC, OBR) dan menulis file ASCII dump sementara.
4. **dump2dcm (DCMTK)** mengompilasi dump ASCII menjadi file biner DICOM `.wl`.
5. File `.wl` disimpan di **WorklistsDatabase**.
6. **Orthanc PACS** (port 4242) memindai folder dan melayani query C-FIND MWL dari modalitas.

**Swim Lane 2 — Alur Akuisisi & Viewing (bawah):**
1. **Modalitas DICOM** (CR/CT/MR/US) mengambil worklist dari Orthanc, melakukan akuisisi, lalu mengirim gambar via DICOM C-STORE.
2. **Orthanc PACS** (port 8042) menyimpan gambar dan meng-host JawaraLite via plugin ServeFolders.
3. **SIMRS** membuka viewer dengan URL yang berisi parameter `patientID` atau `study UUID`.
4. **JawaraLite Viewer** memanggil REST API Orthanc untuk menampilkan gambar di browser radiolog.

---

## 2. Instalasi Orthanc PACS

### 2.1 Unduh Orthanc

Unduh paket Orthanc yang sesuai dengan sistem operasi dari laman resmi:
- **Halaman unduhan**: https://www.orthanc-server.com/download.php
- **Versi yang digunakan**: Orthanc 26.4.2 Stable (bundle lengkap)

### 2.2 Instalasi di macOS

```bash
# Ekstrak arsip yang sudah diunduh
# Letakkan folder di lokasi yang permanen, misalnya:
/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable/

# Berikan izin eksekusi
chmod +x "/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable/Orthanc"
```

Untuk menjalankan:
```bash
cd "/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable"
./Orthanc configMacOS.json --verbose
```

### 2.3 Instalasi di Linux (Ubuntu/Debian)

```bash
# Tambahkan repository resmi Orthanc
sudo add-apt-repository ppa:sdorra/orthanc
sudo apt update
sudo apt install orthanc

# Atau instalasi manual bundle lengkap:
wget https://lsb.orthanc-server.com/orthanc/...  # sesuaikan URL versi

# Jalankan sebagai service
sudo systemctl enable orthanc
sudo systemctl start orthanc

# Cek status
sudo systemctl status orthanc
```

### 2.4 Instalasi di Windows

1. Unduh installer `.exe` dari https://www.orthanc-server.com/download.php
2. Jalankan installer, pilih direktori instalasi (misalnya `C:\Orthanc\`)
3. Installer secara otomatis mendaftarkan Orthanc sebagai **Windows Service**
4. Salin file konfigurasi dan plugin ke direktori instalasi
5. Edit file konfigurasi di `C:\Orthanc\orthanc.json`
6. Restart service: buka **Services** → cari **Orthanc** → klik **Restart**

### 2.5 Instalasi Plugin Wajib

Berikut adalah daftar plugin yang digunakan dalam sistem ini. Salin file plugin ke direktori yang sama dengan binary Orthanc:

| Plugin | Fungsi |
|---|---|
| `libOrthancExplorer2` | UI web modern Orthanc Explorer 2 |
| `libOrthancWorklists` | DICOM Modality Worklist (MWL) |
| `libOrthancDicomWeb` | REST API DICOMweb (WADO-RS, STOW-RS) |
| `libServeFolders` | Hosting aset statis (untuk JawaraLite) |
| `libConnectivityChecks` | Health check konektivitas |
| `libOrthancTransfers` | Transfer antar instance Orthanc |
| `libOrthancWebViewer` | Web viewer bawaan |

> **Ekstensi file plugin per OS:**
> - macOS: `.dylib`
> - Linux: `.so`
> - Windows: `.dll`

---

## 3. Konfigurasi Orthanc

Buat atau edit file konfigurasi (misalnya `configMacOS.json`) di folder Orthanc:

```json
{
  "Name": "MyOrthanc",
  "HttpPort": 8042,
  "DicomPort": 4242,
  "DicomAet": "ORTHANC",
  "StorageDirectory": "OrthancStorage",
  "IndexDirectory": "OrthancStorage",
  "RemoteAccessAllowed": true,
  "AuthenticationEnabled": false,

  "Plugins": [
    "libOrthancExplorer2-universal.dylib",
    "libOrthancWorklists-universal.dylib",
    "libOrthancDicomWeb.dylib",
    "libConnectivityChecks.dylib",
    "libOrthancTransfers.dylib",
    "libOrthancWebViewer.dylib",
    "libServeFolders.dylib"
  ],

  "OrthancExplorer2": {
    "Enable": true,
    "IsDefaultOrthancUI": false,
    "UiOptions": {
      "CustomButtons": {
        "study": [
          {
            "Id": "open-in-jawaralite",
            "Title": "Open in JawaraLite",
            "Icon": "bi bi-eye",
            "Url": "../../jawaralite/index.html?study={UUID}",
            "HttpMethod": "GET",
            "Tooltip": "Open this study in JawaraLite"
          }
        ]
      }
    }
  },

  "Worklists": {
    "Enable": true,
    "Database": "./WorklistsDatabase"
  },

  "DicomModalities": {
    "JAWARALITE_PUSH": ["JAWARALITE", "127.0.0.1", 21112],
    "JAWARALITE_PULL": ["JAWARALITE", "127.0.0.1", 21114],
    "MIGRATOR":        ["MIGRATOR",   "127.0.0.1", 21119]
  },

  "ServeFolders": {
    "/jawaralite": "/path/to/project-orthanc-viewer/frontend/dist"
  }
}
```

> **Sesuaikan path** `/path/to/project-orthanc-viewer/frontend/dist` dengan lokasi aktual proyek di server Anda.

### 3.1 Konfigurasi Database PostgreSQL (Opsional)

Jika menggunakan PostgreSQL sebagai backend penyimpanan index:

```bash
# Instal PostgreSQL
# macOS:
brew install postgresql
brew services start postgresql

# Linux:
sudo apt install postgresql
sudo systemctl start postgresql

# Windows:
# Unduh installer dari https://www.postgresql.org/download/windows/
```

Buat database:
```sql
CREATE USER orthanc WITH PASSWORD '12345678';
CREATE DATABASE orthanc_db OWNER orthanc;
GRANT ALL PRIVILEGES ON DATABASE orthanc_db TO orthanc;
```

Tambahkan ke konfigurasi Orthanc:
```json
{
  "Plugins": [
    "libOrthancPostgreSQLIndex.dylib",
    "libOrthancPostgreSQLStorage.dylib"
  ],
  "PostgreSQL": {
    "EnableIndex": true,
    "EnableStorage": true,
    "Host": "localhost",
    "Port": 5432,
    "Database": "orthanc_db",
    "Username": "orthanc",
    "Password": "12345678"
  }
}
```

---

## 4. Instalasi JawaraLite

JawaraLite adalah Single Page Application (SPA) berbasis **Vite** yang di-host langsung oleh Orthanc melalui plugin ServeFolders.

### 4.1 Instalasi Node.js

Node.js diperlukan untuk mengompilasi aset frontend JawaraLite **dan** menjalankan server penerima HL7 Worklist.

**Versi minimum Node.js: v18 LTS**

#### macOS

```bash
# Opsi 1: Menggunakan Homebrew (disarankan)
brew install node

# Opsi 2: Menggunakan NVM (Node Version Manager) — untuk multi-versi
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc   # atau ~/.zshrc
nvm install 20
nvm use 20

# Verifikasi instalasi
node --version   # harapan: v20.x.x
npm --version    # harapan: 10.x.x
```

#### Linux (Ubuntu/Debian)

```bash
# Opsi 1: Menggunakan NodeSource repository (disarankan)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Opsi 2: Menggunakan NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Verifikasi
node --version
npm --version
```

#### Windows

```powershell
# Opsi 1: Unduh installer resmi
# Kunjungi https://nodejs.org/en/download dan unduh versi LTS (v20.x)
# Jalankan installer .msi, centang opsi "Add to PATH"

# Opsi 2: Menggunakan Chocolatey
choco install nodejs-lts

# Opsi 3: Menggunakan Winget
winget install OpenJS.NodeJS.LTS

# Verifikasi (buka Command Prompt baru)
node --version
npm --version
```

### 4.2 Instalasi DCMTK

DCMTK diperlukan untuk mengonversi text dump menjadi file DICOM biner (`.wl`).

#### macOS

```bash
brew install dcmtk

# Verifikasi
dump2dcm --version
```

#### Linux (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install dcmtk

# Verifikasi
dump2dcm --version
findscu --version
```

#### Windows

1. Unduh binary DCMTK dari: https://dicom.offis.de/en/dcmtk/dcmtk-software-development/
2. Ekstrak ke folder, misalnya `C:\dcmtk\`
3. Tambahkan `C:\dcmtk\bin\` ke **PATH** environment variable:
   - Buka **System Properties** → **Environment Variables**
   - Edit variabel `Path` → tambahkan `C:\dcmtk\bin`
4. Buka Command Prompt baru dan verifikasi:
   ```cmd
   dump2dcm --version
   ```

### 4.3 Clone / Salin Proyek JawaraLite

```bash
# Salin folder proyek ke lokasi permanen
# Contoh di macOS/Linux:
cp -r /path/to/project-orthanc-viewer /Volumes/Data\ 1/project-orthanc-viewer

# Atau clone dari repository jika ada:
# git clone https://github.com/your-repo/project-orthanc-viewer.git
```

### 4.4 Build Aset Frontend

```bash
# Masuk ke direktori frontend
cd "/Volumes/Data 1/project-orthanc-viewer/frontend"

# Instal dependensi (hanya perlu sekali atau saat package.json berubah)
npm install

# Build produksi
npm run build
```

Perintah ini menghasilkan folder `frontend/dist/` berisi aset statis:
```
frontend/dist/
├── index.html
└── assets/
    ├── index-[hash].js
    └── index-[hash].css
```

### 4.5 Konfigurasi Path di Orthanc

Edit konfigurasi Orthanc untuk mengarahkan `/jawaralite` ke folder `dist`:

```json
"ServeFolders": {
  "/jawaralite": "/Volumes/Data 1/project-orthanc-viewer/frontend/dist"
}
```

> **Windows**: Gunakan forward slash atau escape backslash:
> ```json
> "/jawaralite": "C:/project-orthanc-viewer/frontend/dist"
> ```

Restart Orthanc, lalu buka di browser:
```
http://localhost:8042/jawaralite/index.html
```

---

## 5. Integrasi Mirth Connect (HL7 Worklist)

Modul penerima HL7 (`mirth_worklist_receiver.js`) menerima pesan ORM dari Mirth Connect melalui HTTP POST dan mengonversinya menjadi file DICOM Modality Worklist (`.wl`).

### 5.1 Menjalankan Server Receiver

```bash
cd "/Volumes/Data 1/project-orthanc-viewer"
node mirth_worklist_receiver.js
```

Server akan berjalan di port **8090**. Untuk menjalankan otomatis saat sistem boot, gunakan `pm2`:

```bash
# Instal pm2
npm install -g pm2

# Daftarkan script
pm2 start mirth_worklist_receiver.js --name "wl-receiver"
pm2 save
pm2 startup
```

### 5.2 Konfigurasi Channel Mirth Connect

**Source (TCP Listener - MLLP):**
- Connector Type: `TCP Listener`
- Transmission Mode: `MLLP`
- Local Port: `2575` (port standar HL7)

**Destination "Jawaralite for Orthanc" (HTTP Sender):**
- Connector Type: `HTTP Sender`
- Method: `POST`
- URL: `http://127.0.0.1:8090/`
- Content Type: `text/plain`

Di tab **Edit Transformer** → **Outbound Template**:
```
${message.rawData}
```

Di **Destination Settings**:
- `Validate Response`: **No**
- `Queue Messages`: **Never**

**Deploy Channel** setelah semua diatur.

### 5.3 Konfigurasi `mirth_worklist_receiver.js`

Sesuaikan variabel berikut di baris awal file script:

```javascript
// Port HTTP tempat server ini mendengarkan request dari Mirth
const PORT = 8090;

// Path absolut ke folder WorklistsDatabase milik Orthanc
const ORTHANC_WORKLIST_DIR = '/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable/WorklistsDatabase';
```

> **Windows**: Gunakan format path Windows:
> ```javascript
> const ORTHANC_WORKLIST_DIR = 'C:\\Orthanc\\WorklistsDatabase';
> ```

---

## 6. Integrasi SIMRS

### 6.1 Buka Viewer dari URL

SIMRS dapat membuka JawaraLite menggunakan salah satu format URL berikut:

**Menggunakan Study UUID (paling cepat):**
```
http://[ip-server]:8042/jawaralite/index.html?study={studyUUID}
```

**Menggunakan Patient ID dan Accession Number:**
```
http://[ip-server]:8042/jawaralite/index.html?patientID={patientID}&accessionNumber={accessionNumber}
```

Cara kerja fallback:
1. JawaraLite membaca parameter URL
2. Jika `study` tersedia → langsung load
3. Jika `patientID` + `accessionNumber` → query `/tools/find` ke Orthanc untuk resolve ke `studyUUID`
4. Jika hanya `patientID` → tampilkan semua riwayat studi pasien tersebut

---

## 7. Pengujian dan Validasi

### 7.1 Uji Koneksi Orthanc

```bash
# Cek REST API
curl http://localhost:8042/system

# Cek daftar pasien
curl http://localhost:8042/patients
```

### 7.2 Uji Server Penerima HL7

```bash
# Kirim file HL7 sampel ke server
curl -v --data-binary @hl7_test.hl7 http://localhost:8090/
```

Respons sukses:
```json
{
  "status": "success",
  "message": "DICOM Worklist successfully generated",
  "file": "562259_35.wl",
  "order": {
    "patientId": "0030005502",
    "patientName": "123^Testing Voucher^^Ms",
    "modality": "CR",
    ...
  }
}
```

### 7.3 Uji DICOM Worklist (MWL C-FIND)

```bash
findscu -W -aet JAWARALITE -aec ORTHANC localhost 4242 \
  -k PatientName="" \
  -k PatientID="" \
  -k AccessionNumber=""
```

Respons sukses akan menampilkan daftar worklist yang ditemukan.

### 7.4 Verifikasi JawaraLite di Browser

Buka URL berikut dan pastikan viewer dapat menampilkan gambar DICOM:
```
http://localhost:8042/jawaralite/index.html
```

---

## 8. Pemeliharaan & Troubleshooting

### 8.1 Rebuild Frontend

Jika ada perubahan kode di folder `frontend/src/`, rebuild diperlukan:
```bash
cd "/Volumes/Data 1/project-orthanc-viewer/frontend"
npm run build
```
Tidak perlu restart Orthanc — plugin ServeFolders otomatis menyajikan file yang baru di-build.

### 8.2 Cek Log Sistem

| Komponen | Cara Cek Log |
|---|---|
| **Orthanc** | Output terminal saat `./Orthanc configMacOS.json --verbose` |
| **Node.js Receiver** | Output terminal saat `node mirth_worklist_receiver.js` |
| **Mirth Connect** | Panel **Channel Messages** → klik baris → tab **Messages/Errors** |

### 8.3 Tabel Troubleshooting

| Gejala | Kemungkinan Penyebab | Solusi |
|---|---|---|
| Worklist semua "Unknown" | Mirth mengirim XML bukan HL7 raw | Set Outbound Template ke `${message.rawData}` |
| File `.wl` tidak muncul | `dump2dcm` tidak ditemukan | Instal DCMTK, pastikan ada di PATH |
| `findscu` ditolak | AET tidak terdaftar di Orthanc | Tambahkan AET ke `DicomModalities` di config |
| Port 8090 tidak bisa diakses | Mirth dan receiver beda mesin | Ganti `localhost` dengan IP aktual server |
| JawaraLite tidak muncul | Folder dist belum di-build | Jalankan `npm run build` di folder frontend |
| Orthanc tidak muat plugin | Ekstensi plugin salah | Sesuaikan `.dylib`/`.so`/`.dll` dengan OS |

### 8.4 Membersihkan Worklist Lama

File `.wl` yang sudah dikerjakan modalitas perlu dibersihkan secara berkala. Gunakan cron job (Linux/macOS):

```bash
# Hapus file .wl berumur lebih dari 7 hari, setiap jam 00:00
0 0 * * * find "/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable/WorklistsDatabase" -name "*.wl" -mtime +7 -delete
```

Di Windows, gunakan **Task Scheduler** dengan perintah:
```cmd
forfiles /p "C:\Orthanc\WorklistsDatabase" /m *.wl /d -7 /c "cmd /c del @file"
```
