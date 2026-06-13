const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

// Configuration
const PORT = 8090;
const ORTHANC_WORKLIST_DIR = '/Volumes/Data 1/Orthanc-MacOS-26.4.2-stable/WorklistsDatabase';

// Ensure the WorklistsDatabase directory exists
if (!fs.existsSync(ORTHANC_WORKLIST_DIR)) {
  fs.mkdirSync(ORTHANC_WORKLIST_DIR, { recursive: true });
}

// Generate valid DICOM UID under 2.25 namespace (UUID-based OID)
function generateUID() {
  const bytes = crypto.randomBytes(16);
  let dec = '';
  for (const byte of bytes) {
    dec += byte.toString();
  }
  return '2.25.' + dec.substring(0, 39);
}

// Map HL7 description/code to standard Modality code
function detectModality(desc, code) {
  const text = (desc || '').toUpperCase();
  const c = (code || '').toUpperCase();
  
  if (text.includes('MRI') || text.includes('MAGNETIC') || c.includes('MR')) return 'MR';
  if (text.includes('CT') || text.includes('COMPUTED') || c.includes('CT')) return 'CT';
  if (text.includes('USG') || text.includes('ULTRASOUND') || c.includes('US')) return 'US';
  if (text.includes('CR')) return 'CR';
  if (text.includes('DX')) return 'DX';
  if (text.includes('X-RAY') || text.includes('RONTGEN') || c.includes('RAD')) return 'DX';
  return 'OT'; // Other
}

// Format HL7 date (YYYYMMDD) and time (HHMMSS)
function formatDate(hl7Date) {
  if (!hl7Date || hl7Date.length < 8) return '';
  return hl7Date.substring(0, 8);
}

function formatTime(hl7Date) {
  if (!hl7Date || hl7Date.length < 14) return '000000';
  return hl7Date.substring(8, 14);
}

// Parse HL7 ORM Message segments (MSH, PID, ORC, OBR)
function parseHL7(hl7Text) {
  const lines = hl7Text.split(/[\r\n]+/);
  const data = {
    patientId: 'UnknownID',
    patientName: 'Anonymous',
    patientDob: '',
    patientSex: 'U',
    accessionNumber: 'UnknownAccession',
    procedureCode: 'UnknownProc',
    procedureDesc: 'Unknown Procedure',
    scheduledDateTime: '',
    modality: 'OT'
  };

  for (const line of lines) {
    const fields = line.split('|');
    const segment = fields[0];

    if (segment === 'PID') {
      // PID-3: Patient ID
      const pid3Parts = (fields[3] || '').split('^');
      data.patientId = pid3Parts[0] || 'UnknownID';

      // PID-5: Patient Name
      const pid5Parts = (fields[5] || '').split('^');
      const familyName = pid5Parts[0] || '';
      const givenName = pid5Parts[1] || '';
      const title = pid5Parts[4] || '';
      
      // DICOM PN format: FamilyName^GivenName^^Title
      let nameParts = [];
      if (familyName) nameParts.push(familyName);
      if (givenName) nameParts.push(givenName);
      let pn = nameParts.join('^');
      if (title) {
        pn += '^^' + title;
      }
      data.patientName = pn || 'Anonymous';

      // PID-7: Birth Date
      data.patientDob = fields[7] ? fields[7].substring(0, 8) : '';

      // PID-8: Sex
      data.patientSex = fields[8] || 'U';
    } 
    else if (segment === 'ORC') {
      // ORC-2: Placer Order Number (fallback accession if ORC-4 is empty)
      const orc2Parts = (fields[2] || '').split('^');
      data.accessionNumber = orc2Parts[0] || data.accessionNumber;
    } 
    else if (segment === 'OBR') {
      // OBR-3: Filler Order Number (primary Accession Number)
      const obr3Parts = (fields[3] || '').split('^');
      if (obr3Parts[0]) {
        data.accessionNumber = obr3Parts[0];
      }

      // OBR-4: Universal Service Identifier
      const obr4Parts = (fields[4] || '').split('^');
      data.procedureCode = obr4Parts[0] || 'UnknownProc';
      data.procedureDesc = obr4Parts[1] || 'Unknown Procedure';

      // Detect Modality
      data.modality = detectModality(data.procedureDesc, data.procedureCode);

      // OBR-27: Quantity/Timing (extract Scheduled Date/Time)
      const obr27Parts = (fields[27] || '').split('^');
      data.scheduledDateTime = obr27Parts[3] || '';
    }
  }

  return data;
}

// Start HTTP Server
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      console.log('Received HL7 ORM message from Mirth Connect.');
      try {
        const order = parseHL7(body);
        
        // File paths (sanitize accession number for safe filename write)
        const tempTextFile = path.join('/tmp', `wl_${Date.now()}.txt`);
        const safeAccession = order.accessionNumber.replace(/[^a-zA-Z0-9]/g, '_');
        const outputWlFile = path.join(ORTHANC_WORKLIST_DIR, `${safeAccession}.wl`);
        
        const studyInstanceUid = generateUID();
        const schedDate = formatDate(order.scheduledDateTime) || formatDate(new Date().toISOString().replace(/[-:T]/g, ''));
        const schedTime = formatTime(order.scheduledDateTime);

        // Format tags in dump2dcm standard text format
        const dumpContent = [
          `(0008,0005) CS [ISO_IR 100]`,
          `(0010,0010) PN [${order.patientName}]`,
          `(0010,0020) LO [${order.patientId}]`,
          `(0010,0030) DA [${order.patientDob}]`,
          `(0010,0040) CS [${order.patientSex}]`,
          `(0008,0050) SH [${order.accessionNumber}]`,
          `(0020,000d) UI [${studyInstanceUid}]`,
          `(0032,1060) LO [${order.procedureDesc}]`,
          `(0040,0100) SQ`,
          `(fffe,e000) na`,
          `  (0008,0060) CS [${order.modality}]`,
          `  (0040,0001) AE [JAWARALITE]`,
          `  (0040,0002) DA [${schedDate}]`,
          `  (0040,0003) TM [${schedTime}]`,
          `  (0040,0007) LO [${order.procedureDesc}]`,
          `  (0040,0009) SH [${order.procedureCode}]`,
          `(fffe,e00d) na`,
          `(fffe,e0dd) na`,
          `(0040,1001) SH [${order.accessionNumber}]`
        ].join('\n');

        // Write temp dump file
        fs.writeFileSync(tempTextFile, dumpContent);

        // Compile text file to binary DICOM .wl worklist file
        exec(`dump2dcm +te "${tempTextFile}" "${outputWlFile}"`, (error, stdout, stderr) => {
          // Clean up temp file
          try { fs.unlinkSync(tempTextFile); } catch (e) {}

          if (error) {
            console.error('Error generating worklist file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Failed to compile DICOM worklist', error: error.message }));
            return;
          }

          console.log(`Successfully generated DICOM Worklist: ${outputWlFile}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'success',
            message: 'DICOM Worklist successfully generated',
            file: `${safeAccession}.wl`,
            order: order
          }));
        });

      } catch (err) {
        console.error('Error processing order:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Invalid HL7 ORM payload', error: err.message }));
      }
    });
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  }
});

server.listen(PORT, () => {
  console.log(`Mirth Worklist Receiver listening on port ${PORT}...`);
});
