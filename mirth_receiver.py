import json
import os
import sys
import uuid
import re
import logging
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.sequence import Sequence
from pydicom.uid import generate_uid

# ==========================================
# CONFIGURATION & LOGGING
# ==========================================
# Tentukan lokasi folder tempat script/exe ini berada
if getattr(sys, 'frozen', False):
    app_path = os.path.dirname(sys.executable)
else:
    app_path = os.path.dirname(os.path.abspath(__file__))

# Konfigurasi Log
logging.basicConfig(filename=os.path.join(app_path, "mirth_receiver.log"),
                    level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s')

CONFIG_FILE = os.path.join(app_path, "config.json")
config_data = {
    "PORT": 8090,
    "WORKLIST_DIR": "C:\\Orthanc\\worklists"
}

# Baca atau buat file config.json
if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, 'r') as f:
            config_data.update(json.load(f))
    except Exception as e:
        logging.error(f"Gagal membaca config.json: {e}")
else:
    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config_data, f, indent=4)
    except Exception as e:
        logging.error(f"Gagal membuat config.json: {e}")

PORT = config_data.get("PORT", 8090)
WORKLIST_DIR = config_data.get("WORKLIST_DIR", "C:\\Orthanc\\worklists")

# Buat folder jika belum ada
if not os.path.exists(WORKLIST_DIR):
    try:
        os.makedirs(WORKLIST_DIR, exist_ok=True)
    except Exception as e:
        logging.error(f"Gagal membuat folder {WORKLIST_DIR}: {str(e)}")

# ==========================================
# HELPERS
# ==========================================
def detect_modality(desc, code):
    text = (desc or "").upper()
    c = (code or "").upper()
    if "MRI" in text or "MAGNETIC" in text or "MR" in c: return "MR"
    if "CT" in text or "COMPUTED" in text or "CT" in c: return "CT"
    if "USG" in text or "ULTRASOUND" in text or "US" in c: return "US"
    if "CR" in text: return "CR"
    if "DX" in text or "X-RAY" in text or "RONTGEN" in text or "RAD" in c: return "DX"
    return "OT"

def parse_pid(fields, data):
    f = fields + [""] * max(0, 9 - len(fields))
    if f[3]: data["patientId"] = f[3].split('^')[0] or "UnknownID"
    if f[5]:
        pid5 = (f[5] + "^^^^").split('^')
        name_parts = [p for p in [pid5[0], pid5[1]] if p]
        pn = "^".join(name_parts)
        if pid5[4]: pn += "^^" + pid5[4]
        data["patientName"] = pn or "Anonymous"
    if f[7]: data["patientDob"] = f[7][:8]
    if f[8]: data["patientSex"] = f[8]

def parse_orc(fields, data):
    f = fields + [""] * max(0, 3 - len(fields))
    if f[2]: data["accessionNumber"] = f[2].split('^')[0] or data["accessionNumber"]

def parse_obr(fields, data):
    f = fields + [""] * max(0, 28 - len(fields))
    if f[3]: data["accessionNumber"] = f[3].split('^')[0] or data["accessionNumber"]
    if f[4]:
        obr4 = (f[4] + "^").split('^')
        data["procedureCode"] = obr4[0] or "UnknownProc"
        data["procedureDesc"] = obr4[1] or "Unknown Procedure"
        data["modality"] = detect_modality(data["procedureDesc"], data["procedureCode"])
    if f[27]:
        obr27 = (f[27] + "^^^").split('^')
        data["scheduledDateTime"] = obr27[3] or data["scheduledDateTime"]

def parse_hl7(hl7_text):
    lines = hl7_text.splitlines()
    data = {
        "patientId": "UnknownID",
        "patientName": "Anonymous",
        "patientDob": "",
        "patientSex": "U",
        "accessionNumber": "UnknownAccession",
        "procedureCode": "UnknownProc",
        "procedureDesc": "Unknown Procedure",
        "scheduledDateTime": "",
        "modality": "OT"
    }

    for line in lines:
        fields = line.split('|')
        if len(fields) < 2: continue
        segment = fields[0]

        if segment == 'PID': parse_pid(fields, data)
        elif segment == 'ORC': parse_orc(fields, data)
        elif segment == 'OBR': parse_obr(fields, data)
            
    return data

def format_date(hl7_date):
    if not hl7_date or len(hl7_date) < 8: return datetime.now().strftime("%Y%m%d")
    return hl7_date[:8]

def format_time(hl7_date):
    if not hl7_date or len(hl7_date) < 14: return "000000"
    return hl7_date[8:14]

def create_dicom_worklist(order, output_file):
    # Setup File Meta Information
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = '1.2.276.0.7230010.3.1.0.1' # Modality Worklist Information Model - FIND
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.ImplementationClassUID = '1.2.276.0.7230010.3.0.3.6.4'
    file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian

    # Create the Dataset
    ds = FileDataset(output_file, {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    # Main Tags
    ds.SpecificCharacterSet = 'ISO_IR 100'
    ds.PatientName = order['patientName']
    ds.PatientID = order['patientId']
    ds.PatientBirthDate = order['patientDob']
    ds.PatientSex = order['patientSex']
    ds.AccessionNumber = order['accessionNumber']
    ds.StudyInstanceUID = generate_uid()
    ds.RequestedProcedureDescription = order['procedureDesc']
    
    # Scheduled Procedure Step Sequence
    step = Dataset()
    step.Modality = order['modality']
    step.ScheduledStationAETitle = "JAWARALITE"
    step.ScheduledProcedureStepStartDate = format_date(order['scheduledDateTime'])
    step.ScheduledProcedureStepStartTime = format_time(order['scheduledDateTime'])
    step.ScheduledProcedureStepDescription = order['procedureDesc']
    step.ScheduledProcedureStepID = order['accessionNumber']
    
    ds.ScheduledProcedureStepSequence = Sequence([step])
    
    # Save file
    ds.save_as(output_file, write_like_original=False)

# ==========================================
# HTTP SERVER
# ==========================================
class MirthReceiverHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/mirth-hl7':
            self.send_response(404)
            self.end_headers()
            return
            
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        logging.info("Menerima pesan HL7 ORM dari Mirth...")
        
        try:
            order = parse_hl7(body)
            safe_accession = re.sub(r'[^a-zA-Z0-9]', '_', order['accessionNumber'])
            output_file = os.path.join(WORKLIST_DIR, f"{safe_accession}.wl")
            
            create_dicom_worklist(order, output_file)
            
            logging.info(f"Berhasil mencetak file WL -> {output_file}")
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            response = {
                "status": "success",
                "message": "DICOM Worklist successfully generated",
                "file": f"{safe_accession}.wl",
                "order": order
            }
            self.wfile.write(json.dumps(response).encode('utf-8'))
            
        except Exception as e:
            logging.error(f"Error: {str(e)}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))

    def log_message(self, format, *args):
        # Mencegah logging default http.server yang menggunakan print sys.stderr
        logging.info("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format%args))

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, MirthReceiverHandler)
    logging.info(f"=============================================")
    logging.info(f" Mirth Worklist Receiver (Standalone)")
    logging.info(f" Mendengarkan HL7 POST di http://localhost:{PORT}/mirth-hl7")
    logging.info(f" Menyimpan .wl ke: {WORKLIST_DIR}")
    logging.info(f"=============================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()

if __name__ == '__main__':
    run_server()
