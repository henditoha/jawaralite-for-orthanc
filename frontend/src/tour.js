// AetherDICOM Viewer - Interactive Guided Tour Module

let tourCurrentStep = 0;
let tourActiveOverlay = null;
let tourActiveSpotlight = null;
let tourActivePopover = null;

const TOUR_STEPS = [
  {
    target: '.header-logo',
    title: '🔗 JawaraLite & HPII Banten',
    content: 'Logo JawaraLite terhubung langsung ke website resmi HPII Banten (https://hpiibanten.org). Klik logo ini kapan saja untuk membuka situs web resmi di tab baru.',
  },
  {
    target: '.patients-section',
    title: '👤 Riwayat & Identitas Pasien',
    content: 'Menampilkan data lengkap identitas pasien (Nama, ID, DOB, Sex) dan daftar studi pemeriksaan yang tersedia pada PACS.',
  },
  {
    target: '.series-section',
    title: '🎞️ Series Explorer',
    content: 'Daftar sekuen foto/slice DICOM (misal X-Ray PA/Lateral, CT Scan slice). Klik series untuk memuatnya di viewport aktif.',
  },
  {
    target: '.layout-selector',
    title: '📐 Tata Letak Viewport Grid',
    content: 'Atur tampilan grid viewport: Single (1x1), Dual Split (1x2), Quad Grid (2x2), atau 3x3 Grid (9 Viewports) untuk membandingkan foto/series.',
  },
  {
    target: '[data-tool="browse"]',
    title: '🔍 Navigasi Gambar (Browse, Zoom, W/L)',
    content: 'Gunakan Browse untuk scroll slice/frame, Zoom & Pan untuk memperbesar/menggeser, dan W/L untuk mengatur kecerahan & kontras.',
  },
  {
    target: '[data-tool="measure"]',
    title: '📏 Alat Ukur Panjang & Area (Ruler, Ellipse, Circle)',
    content: 'Ukur jarak garis (mm/px) serta luas area elips & lingkaran yang terkalibrasi presisi dengan DICOM Pixel Spacing.',
  },
  {
    target: '[data-tool="ctr"]',
    title: '🫀 Alat Ukur Medis Spesialis (CTR & Cobb)',
    content: 'Ukur Cardiothoracic Ratio (CTR) dengan mode drag-and-drop 4 langkah (Midline, Garis A, Garis B, Garis C) serta sudut skoliosis Cobb Angle.',
  },
  {
    target: '.preset-btn[data-preset="chest"]',
    title: '🎨 Preset Windowing Kontras Klinis',
    content: 'Tombol preset kontras cepat sesuai standar internasional: Brain, Chest, Lung (paru), Abdomen, dan Bone (tulang).',
  },
  {
    target: '[data-action="tags"]',
    title: '⚙️ Aksi Viewport & Header Tag DICOM',
    content: 'Fasilitas Invert warna, animasi Cine play, Reset viewport, serta eksplorasi & edit header DICOM tags secara langsung.',
  },
  {
    target: '#btn-start-tour',
    title: '🚀 Selesai & Ulang Panduan',
    content: 'Selamat! Seluruh fitur utama JawaraLite Viewer telah dipelajari. Anda bisa menekan tombol "Panduan" ini kapan saja untuk mengulang tur.',
  }
];

export function initGuidedTour() {
  const btnStartTour = document.getElementById('btn-start-tour');
  if (btnStartTour) {
    btnStartTour.addEventListener('click', () => startGuidedTour(true));
  }

  // Auto start on first visit after viewer finishes initial loading
  if (!localStorage.getItem('jawaralite_tour_completed')) {
    setTimeout(() => startGuidedTour(false), 1500);
  }
}

export function startGuidedTour(isManual = false) {
  tourCurrentStep = 0;
  createTourElements();
  renderTourStep();
}

function createTourElements() {
  closeGuidedTour(false);

  const overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  document.body.appendChild(overlay);
  tourActiveOverlay = overlay;

  const spotlight = document.createElement('div');
  spotlight.className = 'tour-spotlight';
  document.body.appendChild(spotlight);
  tourActiveSpotlight = spotlight;

  const popover = document.createElement('div');
  popover.className = 'tour-popover';
  document.body.appendChild(popover);
  tourActivePopover = popover;
}

function renderTourStep() {
  if (tourCurrentStep < 0 || tourCurrentStep >= TOUR_STEPS.length) {
    closeGuidedTour(true);
    return;
  }

  const step = TOUR_STEPS[tourCurrentStep];
  const targetEl = document.querySelector(step.target);

  if (!targetEl) {
    tourCurrentStep++;
    renderTourStep();
    return;
  }

  targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  setTimeout(() => {
    if (!tourActiveSpotlight || !tourActivePopover) return;
    const rect = targetEl.getBoundingClientRect();
    const pad = 6;

    tourActiveSpotlight.style.top = `${Math.max(0, rect.top - pad)}px`;
    tourActiveSpotlight.style.left = `${Math.max(0, rect.left - pad)}px`;
    tourActiveSpotlight.style.width = `${rect.width + pad * 2}px`;
    tourActiveSpotlight.style.height = `${rect.height + pad * 2}px`;

    tourActivePopover.replaceChildren();

    const headerDiv = document.createElement('div');
    headerDiv.className = 'tour-popover-header';

    const stepBadge = document.createElement('span');
    stepBadge.className = 'tour-step-badge';
    stepBadge.textContent = `Langkah ${tourCurrentStep + 1} dari ${TOUR_STEPS.length}`;
    headerDiv.appendChild(stepBadge);
    tourActivePopover.appendChild(headerDiv);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'tour-popover-title';
    titleDiv.textContent = step.title;
    tourActivePopover.appendChild(titleDiv);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'tour-popover-body';
    bodyDiv.textContent = step.content;
    tourActivePopover.appendChild(bodyDiv);

    const footerDiv = document.createElement('div');
    footerDiv.className = 'tour-popover-footer';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'tour-btn-skip';
    skipBtn.textContent = 'Lewati';
    skipBtn.onclick = () => closeGuidedTour(true);
    footerDiv.appendChild(skipBtn);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'tour-btn-group';

    if (tourCurrentStep > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'tour-btn-nav';
      prevBtn.textContent = 'Kembali';
      prevBtn.onclick = () => {
        tourCurrentStep--;
        renderTourStep();
      };
      btnGroup.appendChild(prevBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'tour-btn-nav primary';
    nextBtn.textContent = tourCurrentStep === TOUR_STEPS.length - 1 ? 'Selesai' : 'Lanjut →';
    nextBtn.onclick = () => {
      tourCurrentStep++;
      renderTourStep();
    };
    btnGroup.appendChild(nextBtn);

    footerDiv.appendChild(btnGroup);
    tourActivePopover.appendChild(footerDiv);

    positionPopover(rect);
  }, 60);
}

function positionPopover(rect) {
  const popW = 350;
  const popH = 220;
  const margin = 12;

  let top = rect.bottom + margin;
  let left = rect.left;

  if (top + popH > window.innerHeight) {
    top = Math.max(10, rect.top - popH - margin);
  }

  if (left + popW > window.innerWidth) {
    left = Math.max(10, window.innerWidth - popW - 20);
  }

  tourActivePopover.style.top = `${top}px`;
  tourActivePopover.style.left = `${left}px`;
}

function closeGuidedTour(markCompleted = true) {
  if (markCompleted) {
    localStorage.setItem('jawaralite_tour_completed', 'true');
  }
  if (tourActiveOverlay) {
    tourActiveOverlay.remove();
    tourActiveOverlay = null;
  }
  if (tourActiveSpotlight) {
    tourActiveSpotlight.remove();
    tourActiveSpotlight = null;
  }
  if (tourActivePopover) {
    tourActivePopover.remove();
    tourActivePopover = null;
  }
}
