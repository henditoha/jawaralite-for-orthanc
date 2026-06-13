// AetherDICOM Viewer - Main Application Coordinator

import './style.css';
import { DicomViewer } from './viewer.js';

// Global State
let viewers = [];
let activeViewportIndex = 0;
let activePatientId = null;
let activePatientStudies = [];
let activeStudyId = null;
let activeSeriesList = [];
let viewportSeries = [null, null, null, null];

// Auto-detect if running on Orthanc directly or via BFF
const isLocalBff = window.location.port === '5173' || window.location.port === '3000';
const bffUrl = isLocalBff ? 'http://127.0.0.1:8000' : '';
const apiPrefix = isLocalBff ? '/api' : '';

document.addEventListener('DOMContentLoaded', () => {
  initViewports();
  initLayoutControls();
  initSidebarEvents();
  initModalEvents();
  initializeViewer();
});

// Initialize Viewport Canvas Engines
function initViewports() {
  const slots = document.querySelectorAll('.viewport-slot');
  
  slots.forEach((slot, index) => {
    const canvas = slot.querySelector('.viewport-canvas');
    
    // Create new DicomViewer instance for each viewport slot
    const viewer = new DicomViewer(canvas, (state) => {
      updateOverlayText(index, state);
    });
    
    // Hook boundary callback for continuous scrolling across series
    viewer.onSeriesBoundary = (direction) => {
      handleSeriesBoundary(index, direction);
    };
    
    viewers.push(viewer);

    // Click slot to set active viewport
    slot.addEventListener('click', (e) => {
      // Don't change active viewport if clicking on toolbars or controls
      if (e.target.closest('.viewport-header') || e.target.closest('.overlay-slider-container')) {
        return;
      }
      setActiveViewport(index);
    });

    // Hook slice slider
    const slider = slot.querySelector('.slice-slider');
    slider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value);
      viewer.loadSlice(idx);
    });

    // Hook viewport specific toolbar buttons
    const toolBtns = slot.querySelectorAll('.tool-btn');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool');
        viewer.setTool(tool);
        
        // Update active class on toolbar
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const actionBtns = slot.querySelectorAll('.action-btn');
    actionBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'invert') {
          viewer.toggleInvert();
        } else if (action === 'reset') {
          viewer.reset();
        } else if (action === 'tags') {
          showTagsExplorer(viewer);
        } else if (action === 'clear-annotations') {
          viewer.clearAnnotations();
        }
      });
    });

    // W/L Preset buttons
    const presetBtns = slot.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-preset');
        viewer.applyPreset(preset);
      });
    });

  });

  // Default focus to viewport 0
  setActiveViewport(0);
}

// Set Active Viewport
function setActiveViewport(index) {
  activeViewportIndex = index;
  
  const slots = document.querySelectorAll('.viewport-slot');
  slots.forEach((slot, i) => {
    if (i === index) {
      slot.classList.add('active');
    } else {
      slot.classList.remove('active');
    }
  });

  // Sync Global Toolbar states to match active viewer tool
  const activeViewer = viewers[index];
  if (activeViewer) {
    const slot = slots[index];
    const toolBtns = slot.querySelectorAll('.tool-btn');
    toolBtns.forEach(btn => {
      if (btn.getAttribute('data-tool') === activeViewer.activeTool) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // Highlight the series card currently loaded in this viewport in the sidebar
  const currentSeries = viewportSeries[index];
  document.querySelectorAll('.series-card').forEach(card => {
    if (currentSeries && card.getAttribute('data-series-id') === currentSeries.ID) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });
}

// Layout Switcher (1x1, 1x2, 2x2 Grid)
function initLayoutControls() {
  const layoutGrid = document.getElementById('viewer-grid');
  const layoutBtns = document.querySelectorAll('.btn-layout');
  const slots = document.querySelectorAll('.viewport-slot');

  layoutBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const layout = btn.getAttribute('data-layout');

      // Update layout selector buttons
      layoutBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update layout classes on grid
      layoutGrid.className = 'viewer-workspace';
      
      if (layout === '1x1') {
        layoutGrid.classList.add('grid-1x1');
        slots[0].classList.remove('hidden');
        slots[1].classList.add('hidden');
        slots[2].classList.add('hidden');
        slots[3].classList.add('hidden');
        // Force Active Viewport to 0
        setActiveViewport(0);
      } else if (layout === '1x2') {
        layoutGrid.classList.add('grid-1x2');
        slots[0].classList.remove('hidden');
        slots[1].classList.remove('hidden');
        slots[2].classList.add('hidden');
        slots[3].classList.add('hidden');
        if (activeViewportIndex > 1) {
          setActiveViewport(0);
        }
      } else if (layout === '2x2') {
        layoutGrid.classList.add('grid-2x2');
        slots[0].classList.remove('hidden');
        slots[1].classList.remove('hidden');
        slots[2].classList.remove('hidden');
        slots[3].classList.remove('hidden');
      }

      // Trigger Resize on all active viewers so canvases fit new dimensions
      setTimeout(() => {
        viewers.forEach((viewer, idx) => {
          if (!slots[idx].classList.contains('hidden')) {
            viewer.resize();
          }
        });
      }, 50);
    });
  });
}

// Sidebar Events
function initSidebarEvents() {
  // Navigation sidebar event handlers
}

// Initialize viewer: parses query parameters or falls back to first patient
async function initializeViewer() {
  const urlParams = new URLSearchParams(window.location.search);
  let targetStudyId = urlParams.get('study');
  let targetPatientId = urlParams.get('patient') || urlParams.get('patientID') || urlParams.get('patientid');
  let targetAccession = urlParams.get('accession') || urlParams.get('accessionNumber') || urlParams.get('accessionnumber');

  const historyContainer = document.getElementById('study-history-container');
  const seriesContainer = document.getElementById('series-list-container');

  try {
    // Resolve study by PatientID + Accession Number (SIMRS Integration)
    if (targetPatientId && targetAccession) {
      const findUrl = isLocalBff ? `${bffUrl}/tools/find` : `/tools/find`;
      const findRes = await fetch(findUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Level: 'Study',
          Query: {
            PatientID: targetPatientId,
            AccessionNumber: targetAccession
          }
        })
      });

      if (findRes.ok) {
        const studies = await findRes.json();
        if (studies && studies.length > 0) {
          targetStudyId = studies[0];
          // Silently sync browser URL
          const url = new URL(window.location);
          url.searchParams.delete('patientID');
          url.searchParams.delete('patientid');
          url.searchParams.delete('accessionNumber');
          url.searchParams.delete('accessionnumber');
          url.searchParams.set('study', targetStudyId);
          window.history.pushState({}, '', url);
        }
      }
    }
    if (targetStudyId) {
      // 1. Fetch study details directly
      const studyRes = await fetch(`${bffUrl}${apiPrefix}/studies/${targetStudyId}`);
      if (!studyRes.ok) throw new Error('Study not found');
      const studyData = await studyRes.json();

      activeStudyId = targetStudyId;
      activePatientId = studyData.ParentPatient;

      // Render Patient Info Header
      if (studyData.PatientMainDicomTags) {
        renderPatientInfoHeader(studyData.PatientMainDicomTags);
      } else {
        await fetchAndRenderPatientInfo(activePatientId);
      }

      // 2. Load patient prior studies
      await loadPatientStudies(activePatientId);

      // 3. Load active study series
      await loadStudySeriesAndOpen(activeStudyId);

    } else if (targetPatientId) {
      activePatientId = targetPatientId;

      // 1. Fetch patient details
      await fetchAndRenderPatientInfo(activePatientId);

      // 2. Load patient studies
      await loadPatientStudies(activePatientId);

      // 3. Open first study
      if (activePatientStudies.length > 0) {
        activeStudyId = activePatientStudies[0].ID;
        const url = new URL(window.location);
        url.searchParams.set('study', activeStudyId);
        window.history.pushState({}, '', url);

        await loadStudySeriesAndOpen(activeStudyId);
      } else {
        seriesContainer.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No studies found for this patient';
        seriesContainer.appendChild(empty);
      }

    } else {
      // Case 3: No parameters specified - load first patient
      let url, options;
      if (isLocalBff) {
        url = `${bffUrl}/api/patients`;
        options = { method: 'GET' };
      } else {
        url = `/tools/find`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Level: 'Patient', Query: {}, Limit: 1, Expand: true })
        };
      }

      const patientsRes = await fetch(url, options);
      if (!patientsRes.ok) throw new Error('Failed to load patient list');
      const patients = await patientsRes.json();

      if (patients && patients.length > 0) {
        const defaultPatient = patients[0];
        activePatientId = defaultPatient.ID;

        renderPatientInfoHeader(defaultPatient.MainDicomTags);
        await loadPatientStudies(activePatientId);

        if (activePatientStudies.length > 0) {
          activeStudyId = activePatientStudies[0].ID;
          const url = new URL(window.location);
          url.searchParams.set('study', activeStudyId);
          window.history.pushState({}, '', url);

          await loadStudySeriesAndOpen(activeStudyId);
        } else {
          seriesContainer.replaceChildren();
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.textContent = 'No studies found for default patient';
          seriesContainer.appendChild(empty);
        }
      } else {
        historyContainer.replaceChildren();
        const emptyHistory = document.createElement('div');
        emptyHistory.className = 'empty-state';
        emptyHistory.textContent = 'No patients found in Orthanc';
        historyContainer.appendChild(emptyHistory);

        seriesContainer.replaceChildren();
        const emptySeries = document.createElement('div');
        emptySeries.className = 'empty-state';
        emptySeries.textContent = 'Orthanc PACS is empty';
        seriesContainer.appendChild(emptySeries);
      }
    }
  } catch (err) {
    console.error('Initialization error:', err);
    historyContainer.replaceChildren();
    const errorHistory = document.createElement('div');
    errorHistory.className = 'empty-state';
    errorHistory.textContent = 'Error connecting to Orthanc database';
    historyContainer.appendChild(errorHistory);

    seriesContainer.replaceChildren();
    const errorSeries = document.createElement('div');
    errorSeries.className = 'empty-state';
    errorSeries.textContent = 'Please make sure Orthanc is running';
    seriesContainer.appendChild(errorSeries);
  }
}

// Fetch and render patient metadata
async function fetchAndRenderPatientInfo(patientId) {
  try {
    const res = await fetch(`${bffUrl}${apiPrefix}/patients/${patientId}`);
    if (!res.ok) throw new Error('Patient not found');
    const patientData = await res.json();
    if (patientData.MainDicomTags) {
      renderPatientInfoHeader(patientData.MainDicomTags);
    }
  } catch (err) {
    console.error('Error fetching patient info:', err);
    renderPatientInfoHeader({ PatientName: 'Patient ' + patientId.substring(0, 8), PatientID: 'N/A' });
  }
}

// Load studies of a patient
async function loadPatientStudies(patientId) {
  try {
    const res = await fetch(`${bffUrl}${apiPrefix}/patients/${patientId}/studies`);
    if (!res.ok) throw new Error('Failed to load patient studies');
    activePatientStudies = await res.json();
    renderStudyHistory(activePatientStudies);
  } catch (err) {
    console.error('Error loading patient studies:', err);
    activePatientStudies = [];
    renderStudyHistory([]);
  }
}

// Render Patient Info Header Card
function renderPatientInfoHeader(patientTags) {
  const header = document.getElementById('patient-info-header');
  if (!header) return;
  header.replaceChildren();

  const nameDiv = document.createElement('div');
  nameDiv.className = 'patient-name';
  nameDiv.textContent = patientTags.PatientName || 'Anonymous';
  nameDiv.title = patientTags.PatientName || 'Anonymous';
  header.appendChild(nameDiv);

  const metaDiv = document.createElement('div');
  metaDiv.className = 'patient-meta';

  const sexSpan = document.createElement('span');
  sexSpan.className = 'patient-sex';
  sexSpan.textContent = patientTags.PatientSex || 'U';
  metaDiv.appendChild(sexSpan);

  const dobSpan = document.createElement('span');
  dobSpan.className = 'patient-dob';
  dobSpan.textContent = formatDate(patientTags.PatientBirthDate);
  metaDiv.appendChild(dobSpan);

  const idSpan = document.createElement('span');
  idSpan.className = 'patient-id-badge';
  idSpan.textContent = `ID: ${patientTags.PatientID || 'N/A'}`;
  metaDiv.appendChild(idSpan);

  header.appendChild(metaDiv);
}

// Render Study History list
function renderStudyHistory(studies) {
  const container = document.getElementById('study-history-container');
  if (!container) return;
  container.replaceChildren();

  const studyCountEl = document.getElementById('study-count');
  if (studyCountEl) {
    studyCountEl.textContent = studies.length;
  }

  if (!studies || studies.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No prior studies found';
    container.appendChild(empty);
    return;
  }

  // Sort studies by date descending (newest first)
  studies.sort((a, b) => {
    const dateA = a.MainDicomTags.StudyDate || '';
    const dateB = b.MainDicomTags.StudyDate || '';
    return dateB.localeCompare(dateA);
  });

  studies.forEach(study => {
    const card = document.createElement('div');
    card.className = 'study-history-card';
    if (study.ID === activeStudyId) {
      card.classList.add('active');
    }
    card.setAttribute('data-study-id', study.ID);

    const desc = document.createElement('div');
    desc.className = 'study-desc';
    desc.textContent = study.MainDicomTags.StudyDescription || 'No Study Description';
    card.appendChild(desc);

    const meta = document.createElement('div');
    meta.className = 'study-meta';

    const dateSpan = document.createElement('span');
    dateSpan.className = 'study-date';
    dateSpan.textContent = formatDate(study.MainDicomTags.StudyDate);
    meta.appendChild(dateSpan);

    const idSpan = document.createElement('span');
    idSpan.className = 'study-id';
    idSpan.textContent = study.MainDicomTags.StudyID || 'N/A';
    meta.appendChild(idSpan);

    card.appendChild(meta);

    card.addEventListener('click', async () => {
      if (study.ID === activeStudyId) return;

      activeStudyId = study.ID;

      document.querySelectorAll('.study-history-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      const url = new URL(window.location);
      url.searchParams.set('study', study.ID);
      window.history.pushState({}, '', url);

      await loadStudySeriesAndOpen(study.ID);
    });

    container.appendChild(card);
  });
}

// Load study series and open the first series
async function loadStudySeriesAndOpen(studyId) {
  const seriesContainer = document.getElementById('series-list-container');
  seriesContainer.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'loading-spinner';
  loading.textContent = 'Loading Study Series...';
  seriesContainer.appendChild(loading);

  try {
    const seriesRes = await fetch(`${bffUrl}${apiPrefix}/studies/${studyId}/series`);
    if (!seriesRes.ok) throw new Error('Failed to load study series');
    const seriesList = await seriesRes.json();

    // Attach study description to series objects
    let studyDesc = 'No Study Description';
    if (activePatientStudies) {
      const currentStudy = activePatientStudies.find(s => s.ID === studyId);
      if (currentStudy && currentStudy.MainDicomTags) {
        studyDesc = currentStudy.MainDicomTags.StudyDescription || 'No Study Description';
      }
    }

    seriesList.forEach(s => {
      s.studyDescription = studyDesc;
    });

    // Sort series by SeriesNumber
    seriesList.sort((a, b) => {
      const numA = parseInt(a.MainDicomTags.SeriesNumber) || 0;
      const numB = parseInt(b.MainDicomTags.SeriesNumber) || 0;
      return numA - numB;
    });

    document.getElementById('series-count').textContent = seriesList.length;
    renderSeriesList(seriesList);

    // Automatically load the first series of this study into viewport 0
    if (seriesList.length > 0) {
      const firstSeries = seriesList[0];
      viewportSeries[0] = firstSeries;

      const slot = document.getElementById('viewport-slot-0');
      const titleEl = slot.querySelector('.viewport-title');
      titleEl.textContent = `Series ${firstSeries.MainDicomTags.SeriesNumber || ''} - ${firstSeries.MainDicomTags.SeriesDescription || 'No Desc'}`;

      document.querySelectorAll('.series-card').forEach(card => {
        if (card.getAttribute('data-series-id') === firstSeries.ID) {
          card.classList.add('active');
        } else {
          card.classList.remove('active');
        }
      });

      await viewers[0].setSeries(firstSeries.Instances);
    }
  } catch (err) {
    console.error(err);
    seriesContainer.replaceChildren();
    const error = document.createElement('div');
    error.className = 'empty-state';
    error.textContent = 'Failed to load study series.';
    seriesContainer.appendChild(error);
  }
}

// Render series explorer list
function renderSeriesList(seriesList) {
  const seriesContainer = document.getElementById('series-list-container');
  seriesContainer.replaceChildren();

  if (seriesList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No series found in this patient';
    seriesContainer.appendChild(empty);
    return;
  }

  activeSeriesList = seriesList; // Save globally

  seriesList.forEach(series => {
    const card = document.createElement('div');
    card.className = 'series-card';
    card.setAttribute('data-series-id', series.ID); // Add data attribute for lookup

    // Image Thumbnail (middle instance preview)
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'series-thumbnail';
    
    if (series.Instances && series.Instances.length > 0) {
      const midIndex = Math.floor(series.Instances.length / 2);
      const midInstanceId = series.Instances[midIndex];
      const img = document.createElement('img');
      img.src = `${bffUrl}${apiPrefix}/instances/${midInstanceId}/preview`;
      img.alt = 'Series Thumbnail';
      thumbContainer.appendChild(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'placeholder';
      placeholder.textContent = 'NO IMG';
      thumbContainer.appendChild(placeholder);
    }
    card.appendChild(thumbContainer);

    // Info details
    const info = document.createElement('div');
    info.className = 'series-info';

    const headerRow = document.createElement('div');
    headerRow.className = 'series-header-row';

    const modality = document.createElement('span');
    modality.className = 'modality-badge';
    modality.textContent = series.MainDicomTags.Modality || 'OT';
    headerRow.appendChild(modality);

    const number = document.createElement('span');
    number.className = 'patient-id';
    number.textContent = `Series: ${series.MainDicomTags.SeriesNumber || '?'}`;
    headerRow.appendChild(number);

    info.appendChild(headerRow);

    const desc = document.createElement('div');
    desc.className = 'series-desc';
    desc.textContent = series.MainDicomTags.SeriesDescription || series.studyDescription;
    info.appendChild(desc);

    const meta = document.createElement('div');
    meta.className = 'series-meta';
    meta.textContent = `${series.Instances.length} Slices | ${series.MainDicomTags.BodyPartExamined || 'Whole Body'}`;
    info.appendChild(meta);

    card.appendChild(info);

    // Click series card: Loads in ACTIVE viewport!
    card.addEventListener('click', () => {
      // Highlight active series
      document.querySelectorAll('.series-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      // Update viewport tracker
      viewportSeries[activeViewportIndex] = series;

      const activeViewer = viewers[activeViewportIndex];
      if (activeViewer) {
        // Update Viewport Title header
        const slot = document.getElementById(`viewport-slot-${activeViewportIndex}`);
        const titleEl = slot.querySelector('.viewport-title');
        titleEl.textContent = `Series ${series.MainDicomTags.SeriesNumber || ''} - ${series.MainDicomTags.SeriesDescription || 'No Desc'}`;
        
        // Pass instance ids to active viewer
        activeViewer.setSeries(series.Instances);
      }
    });

    seriesContainer.appendChild(card);
  });
}

// Update text overlays inside each viewport
function updateOverlayText(index, state) {
  const slot = document.getElementById(`viewport-slot-${index}`);
  if (!slot) return;

  // Top Left Overlay (Patient Metadata)
  const topLeft = slot.querySelector('.overlay-top-left');
  topLeft.replaceChildren();
  const pName = document.createElement('div');
  pName.textContent = state.patientName;
  pName.style.fontSize = '12px';
  pName.style.fontWeight = 'bold';
  topLeft.appendChild(pName);
  const pId = document.createElement('div');
  pId.textContent = `ID: ${state.patientId}`;
  topLeft.appendChild(pId);
  const pBio = document.createElement('div');
  pBio.textContent = `DOB: ${formatDate(state.patientBirthDate)} [${state.patientSex}]`;
  topLeft.appendChild(pBio);

  // Top Right Overlay (Study/Modality)
  const topRight = slot.querySelector('.overlay-top-right');
  topRight.replaceChildren();
  const sDesc = document.createElement('div');
  sDesc.textContent = state.studyDesc;
  sDesc.style.fontWeight = 'bold';
  topRight.appendChild(sDesc);
  const sDate = document.createElement('div');
  sDate.textContent = `Date: ${formatDate(state.studyDate)}`;
  topRight.appendChild(sDate);
  const modality = document.createElement('div');
  modality.textContent = `Modality: ${state.modality}`;
  topRight.appendChild(modality);

  // Bottom Left Overlay (Series)
  const bottomLeft = slot.querySelector('.overlay-bottom-left');
  bottomLeft.replaceChildren();
  const serDesc = document.createElement('div');
  serDesc.textContent = state.seriesDesc;
  bottomLeft.appendChild(serDesc);
  const serNum = document.createElement('div');
  serNum.textContent = `Series #: ${state.seriesNumber}`;
  bottomLeft.appendChild(serNum);

  // Bottom Right Overlay (Slice & Window Center/Width)
  const bottomRight = slot.querySelector('.overlay-bottom-right');
  bottomRight.replaceChildren();
  const sliceInfo = document.createElement('div');
  sliceInfo.textContent = `Slice: ${state.sliceIndex + 1} / ${state.sliceCount}`;
  bottomRight.appendChild(sliceInfo);
  const wlInfo = document.createElement('div');
  wlInfo.textContent = `W: ${state.windowWidth} L: ${state.windowCenter}`;
  bottomRight.appendChild(wlInfo);
  if (state.invert) {
    const inverted = document.createElement('div');
    inverted.textContent = 'INVERTED';
    inverted.style.color = '#ef4444';
    inverted.style.fontWeight = 'bold';
    bottomRight.appendChild(inverted);
  }

  // Update Slice Slider range
  const slider = slot.querySelector('.slice-slider');
  slider.max = state.sliceCount - 1;
  slider.value = state.sliceIndex;
}

// DICOM Tags Editor Logic
let activeViewerForTags = null;
let rawTagsJson = {};
let editedValues = {};

const EDITABLE_TAGS = {
  '0010,0010': 'PatientName',
  '0010,0020': 'PatientID',
  '0010,0030': 'PatientBirthDate',
  '0010,0040': 'PatientSex',
  '0008,0050': 'AccessionNumber',
  '0008,1030': 'StudyDescription',
  '0008,103e': 'SeriesDescription',
  '0008,0060': 'Modality',
  '0008,0090': 'ReferringPhysicianName',
  '0008,0020': 'StudyDate'
};

function initModalEvents() {
  const modal = document.getElementById('tags-modal');
  const closeBtn = document.getElementById('btn-close-tags');
  const searchInput = document.getElementById('tags-search');
  const btnDownloadDcm = document.getElementById('btn-download-dcm');
  const btnSavePacs = document.getElementById('btn-save-pacs');

  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
    activeViewerForTags = null;
    rawTagsJson = {};
    editedValues = {};
  });

  searchInput.addEventListener('input', () => {
    renderTagsTable(searchInput.value);
  });

  btnDownloadDcm.addEventListener('click', async () => {
    if (!activeViewerForTags) return;
    const currentInstanceId = activeViewerForTags.instanceIds[activeViewerForTags.currentSliceIndex];
    
    // Build Replace payload
    const replacePayload = {};
    for (const tagId in editedValues) {
      const dicomTagName = EDITABLE_TAGS[tagId];
      if (dicomTagName) {
        replacePayload[dicomTagName] = editedValues[tagId];
      }
    }
    
    if (Object.keys(replacePayload).length === 0) {
      alert('No changes to save.');
      return;
    }

    btnDownloadDcm.disabled = true;
    btnDownloadDcm.textContent = 'Generating .dcm...';

    try {
      const res = await fetch(`${bffUrl}${apiPrefix}/instances/${currentInstanceId}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Replace: replacePayload,
          Force: true
        })
      });

      if (!res.ok) throw new Error('Failed to modify DICOM');
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Determine file name
      const pName = (replacePayload.PatientName || activeViewerForTags.patientName || 'Patient').replace(/[^a-zA-Z0-9]/g, '_');
      const studyDateStr = (replacePayload.StudyDate || activeViewerForTags.studyDate || 'Date').replace(/[^a-zA-Z0-9]/g, '');
      a.download = `${pName}_${studyDateStr}.dcm`;
      
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Error downloading modified DICOM: ' + err.message);
    } finally {
      btnDownloadDcm.disabled = false;
      btnDownloadDcm.textContent = 'Save & Download .dcm';
    }
  });

  btnSavePacs.addEventListener('click', async () => {
    if (!activeViewerForTags) return;
    const currentInstanceId = activeViewerForTags.instanceIds[activeViewerForTags.currentSliceIndex];
    
    const replacePayload = {};
    for (const tagId in editedValues) {
      const dicomTagName = EDITABLE_TAGS[tagId];
      if (dicomTagName) {
        replacePayload[dicomTagName] = editedValues[tagId];
      }
    }

    if (Object.keys(replacePayload).length === 0) {
      alert('No changes to save.');
      return;
    }

    if (!confirm('Are you sure you want to save modifications to PACS? This will update the instance permanently.')) {
      return;
    }

    btnSavePacs.disabled = true;
    btnSavePacs.textContent = 'Saving to PACS...';

    try {
      // 1. Get modified DICOM binary
      const modifyRes = await fetch(`${bffUrl}${apiPrefix}/instances/${currentInstanceId}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Replace: replacePayload,
          Force: true
        })
      });

      if (!modifyRes.ok) throw new Error('Failed to get modified DICOM binary');
      const dicomBlob = await modifyRes.blob();

      // 2. Upload modified DICOM to Orthanc
      const uploadRes = await fetch(`${bffUrl}${apiPrefix}/instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: dicomBlob
      });

      if (!uploadRes.ok) throw new Error('Failed to upload modified DICOM to PACS');
      const uploadJson = await uploadRes.json();
      console.log('Modified DICOM uploaded successfully:', uploadJson);

      // 3. Delete old instance from Orthanc
      const deleteRes = await fetch(`${bffUrl}${apiPrefix}/instances/${currentInstanceId}`, {
        method: 'DELETE'
      });
      if (!deleteRes.ok) {
        console.warn('Failed to delete old instance from PACS (it may have been replaced already)');
      }

      alert('Metadata successfully saved to PACS!');
      modal.classList.add('hidden');
      
      // 4. Reload the study to reflect changes
      const newStudyId = uploadJson.ParentStudy || activeStudyId;
      
      // Update browser URL query parameter with new study ID
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('study', newStudyId);
      window.history.pushState({}, '', newUrl);

      // Reload page to refresh sidebar, series list, patient info, etc.
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert('Error saving modifications to PACS: ' + err.message);
    } finally {
      btnSavePacs.disabled = false;
      btnSavePacs.textContent = 'Save to PACS';
    }
  });
}

async function showTagsExplorer(viewer) {
  if (!viewer || viewer.instanceIds.length === 0) return;
  
  activeViewerForTags = viewer;
  editedValues = {}; // Reset edited values on open
  const currentInstanceId = viewer.instanceIds[viewer.currentSliceIndex];
  const modal = document.getElementById('tags-modal');
  const tableBody = document.getElementById('tags-table-body');
  
  // Show modal and loading state
  document.getElementById('tags-search').value = '';
  modal.classList.remove('hidden');
  tableBody.replaceChildren();
  const loading = document.createElement('tr');
  const loadingTd = document.createElement('td');
  loadingTd.colSpan = 4;
  loadingTd.textContent = 'Loading DICOM Header tags...';
  loadingTd.style.textAlign = 'center';
  loading.appendChild(loadingTd);
  tableBody.appendChild(loading);

  try {
    const res = await fetch(`${bffUrl}${apiPrefix}/instances/${currentInstanceId}/tags`);
    if (!res.ok) throw new Error('Failed to load DICOM tags');
    rawTagsJson = await res.json();
    renderTagsTable();
  } catch (err) {
    console.error(err);
    tableBody.replaceChildren();
    const errTr = document.createElement('tr');
    const errTd = document.createElement('td');
    errTd.colSpan = 4;
    errTd.textContent = 'Failed to fetch tags for this slice.';
    errTd.style.color = '#ef4444';
    errTd.style.textAlign = 'center';
    errTr.appendChild(errTd);
    tableBody.appendChild(errTr);
  }
}

function renderTagsTable(filterText = '') {
  const tableBody = document.getElementById('tags-table-body');
  tableBody.replaceChildren();

  const query = filterText.toLowerCase().trim();
  
  // Flatten tags dictionary into array of { tag, name, type, value }
  const tagsList = [];
  for (const tagId in rawTagsJson) {
    const tagInfo = rawTagsJson[tagId];
    tagsList.push({
      tagId: tagId,
      name: tagInfo.Name || 'Private Tag',
      type: tagInfo.Type || 'Unknown',
      value: tagInfo.Value !== undefined ? String(tagInfo.Value) : ''
    });
  }

  // Filter tags
  const filtered = tagsList.filter(tag => {
    return tag.tagId.toLowerCase().includes(query) ||
           tag.name.toLowerCase().includes(query) ||
           tag.value.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No tags match the search query';
    td.style.textAlign = 'center';
    td.style.color = '#71717a';
    tr.appendChild(td);
    tableBody.appendChild(tr);
    return;
  }

  // Render rows
  filtered.forEach(tag => {
    const tr = document.createElement('tr');

    const tdTag = document.createElement('td');
    tdTag.textContent = `(${tag.tagId})`;
    tr.appendChild(tdTag);

    const tdName = document.createElement('td');
    tdName.textContent = tag.name;
    tr.appendChild(tdName);

    const tdType = document.createElement('td');
    tdType.textContent = tag.type;
    tr.appendChild(tdType);

    const tdVal = document.createElement('td');
    
    // Check if the tag is editable
    const isEditable = tag.tagId in EDITABLE_TAGS;
    if (isEditable) {
      tr.classList.add('editable-row');
      
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tag-edit-input';
      
      // Get the value (from editedValues if changed, otherwise original value)
      input.value = editedValues[tag.tagId] !== undefined ? editedValues[tag.tagId] : tag.value;
      
      // Add edit marker to tag name
      const marker = document.createElement('span');
      marker.className = 'editable-tag-marker';
      marker.textContent = ' ✏️';
      tdName.appendChild(marker);

      input.addEventListener('input', (e) => {
        editedValues[tag.tagId] = e.target.value;
      });
      tdVal.appendChild(input);
    } else {
      // Truncate long value strings for read-only values
      tdVal.textContent = tag.value.length > 80 ? tag.value.slice(0, 80) + '...' : tag.value;
      tdVal.title = tag.value;
    }
    
    tr.appendChild(tdVal);
    tableBody.appendChild(tr);
  });
}

// Handle scrolling transition between different series
async function handleSeriesBoundary(viewportIndex, direction) {
  const currentSeries = viewportSeries[viewportIndex];
  if (!currentSeries || activeSeriesList.length <= 1) return;

  const currentIndex = activeSeriesList.findIndex(s => s.ID === currentSeries.ID);
  if (currentIndex === -1) return;

  const targetIndex = currentIndex + direction;
  if (targetIndex >= 0 && targetIndex < activeSeriesList.length) {
    const targetSeries = activeSeriesList[targetIndex];
    viewportSeries[viewportIndex] = targetSeries;

    // Update Viewport Title header
    const slot = document.getElementById(`viewport-slot-${viewportIndex}`);
    const titleEl = slot.querySelector('.viewport-title');
    titleEl.textContent = `Series ${targetSeries.MainDicomTags.SeriesNumber || ''} - ${targetSeries.MainDicomTags.SeriesDescription || 'No Desc'}`;

    // Update active class in sidebar if this viewport is active
    if (viewportIndex === activeViewportIndex) {
      document.querySelectorAll('.series-card').forEach(card => {
        if (card.getAttribute('data-series-id') === targetSeries.ID) {
          card.classList.add('active');
        } else {
          card.classList.remove('active');
        }
      });
    }

    // Load target series. direction=1 -> start at slice 0, direction=-1 -> start at last slice
    const startSlice = direction === 1 ? 0 : targetSeries.Instances.length - 1;
    await viewers[viewportIndex].setSeries(targetSeries.Instances, startSlice);
  }
}

// Utility Helpers
function formatDate(dicomDate) {
  if (!dicomDate || dicomDate.length !== 8) return dicomDate || 'N/A';
  const y = dicomDate.slice(0, 4);
  const m = dicomDate.slice(4, 6);
  const d = dicomDate.slice(6, 8);
  return `${d}/${m}/${y}`;
}
