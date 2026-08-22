// JawaraLite Viewer - HTML5 Canvas DICOM Engine
// Tools: browse, zoom, wl, measure, magnify, annotate, ctr, cobb, ellipse, circle

export class DicomViewer {
  constructor(canvas, onStateChange = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStateChange = onStateChange;
    this.onSeriesBoundary = null;

    // Auto-detect if running on Orthanc directly or via BFF
    this.isLocalBff = window.location.port === '5173' || window.location.port === '3000';
    this.bffUrl = this.isLocalBff ? 'http://127.0.0.1:8000' : '';
    this.apiPrefix = this.isLocalBff ? '/api' : '';

    // Viewer State
    this.instanceIds = [];
    this.currentSliceIndex = 0;
    this.currentFrameIndex = 0;
    this.numberOfFrames = 1;
    this.imageCache = new Map();
    this.cineTimeout = null;
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.windowWidth = 400;
    this.windowCenter = 40;
    this.clientWindowWidth = 400;
    this.clientWindowCenter = 40;
    // Original DICOM values — saved on first load, used by reset()
    this.originalWindowWidth = 400;
    this.originalWindowCenter = 40;
    this.invert = false;
    this.activeTool = 'browse';

    // Cine Play state
    this.isCinePlaying = false;
    this.cineInterval = null;
    this.cineFps = 15;

    // Annotations storage (all tool outputs stored here)
    this.annotations = [];
    this.currentShape = null;   // Shape being drawn right now

    // Multi-click tool state machine (CTR = 4 clicks, Cobb = 4 clicks)
    this.interactionStep = 0;
    this.interactionPoints = [];

    // Magnify + mouse tracking
    this.mousePos = { x: 0, y: 0 };
    this.showMagnifier = false;

    // DICOM Metadata
    this.patientName = 'Unknown';
    this.patientId = 'Unknown';
    this.patientSex = 'Unknown';
    this.patientBirthDate = 'Unknown';
    this.studyDesc = 'Unknown';
    this.studyDate = 'Unknown';
    this.seriesDesc = 'Unknown';
    this.seriesNumber = 'Unknown';
    this.modality = 'Unknown';
    this.pixelSpacing = { x: 1.0, y: 1.0 };

    // Image Cache
    this.img = null;
    this.imgLoaded = false;

    // Drag tracking
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.panStart = { x: 0, y: 0 };
    this.didDrag = false; // Distinguish click vs drag

    this.initEvents();
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.render();
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup',   (e) => this.handleMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.showMagnifier = false;
      if (this.activeTool !== 'ctr' && this.activeTool !== 'cobb' && this.activeTool !== 'annotate') {
        this.currentShape = null;
      }
      this.render();
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stopCine(); // Stop auto-play if user interacts
      if (this.activeTool === 'zoom') {
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        this.applyZoom(zoomFactor, e.offsetX, e.offsetY);
      } else {
        const delta = e.deltaY < 0 ? -1 : 1;
        this.changeSlice(delta);
      }
    });
  }

  // ─── Series Loading ──────────────────────────────────────────────────────────

  async setSeries(instanceIds, startSlice = null) {
    if (!instanceIds || instanceIds.length === 0) return;

    this.stopCine(); // Ensure cine stops when new series is loaded
    this.isPreloading = false; // Stop any ongoing preloading
    this.instanceIds = instanceIds;
    this.currentSliceIndex = startSlice !== null
      ? startSlice
      : Math.floor(instanceIds.length / 2);
    this.currentFrameIndex = 0;
    this.numberOfFrames = 1;
    this.annotations = [];
    this.currentShape = null;
    this.interactionStep = 0;
    this.interactionPoints = [];
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.img = null;
    this.imgLoaded = false;

    await this.fetchDicomTags(this.instanceIds[this.currentSliceIndex]);
    await this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
    
    // Start background preloading for smooth cine
    if (this.numberOfFrames > 1) {
      this.preloadFrames(this.currentSliceIndex);
    }
  }

  async fetchDicomTags(instanceId) {
    try {
      const res = await fetch(`${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/tags`);
      if (!res.ok) throw new Error('Failed to load tags');
      const tags = await res.json();

      this.patientName    = tags['0010,0010']?.Value || 'Anonymous';
      this.patientId      = tags['0010,0020']?.Value || 'Unknown ID';
      this.patientSex     = tags['0010,0040']?.Value || 'U';
      this.patientBirthDate = tags['0010,0030']?.Value || '';
      this.studyDesc      = tags['0008,1030']?.Value || 'No Description';
      this.studyDate      = tags['0008,0020']?.Value || '';
      this.seriesDesc     = tags['0008,103e']?.Value || 'No Description';
      this.seriesNumber   = tags['0020,0011']?.Value || '';
      this.modality       = tags['0008,0060']?.Value || '';
      this.numberOfFrames = parseInt(tags['0028,0008']?.Value) || 1;

      if (tags['0028,1050']?.Value) {
        const centerStr = String(tags['0028,1050'].Value).split('\\')[0];
        this.windowCenter = parseFloat(centerStr) || 40;
      }
      if (tags['0028,1051']?.Value) {
        const widthStr = String(tags['0028,1051'].Value).split('\\')[0];
        this.windowWidth = parseFloat(widthStr) || 400;
      }
      this.clientWindowCenter = this.windowCenter;
      this.clientWindowWidth  = this.windowWidth;
      // Save originals for reset()
      this.originalWindowWidth  = this.windowWidth;
      this.originalWindowCenter = this.windowCenter;

      const spacing = tags['0028,0030']?.Value;
      if (spacing) {
        const parts = String(spacing).split('\\');
        this.pixelSpacing.y = parseFloat(parts[0]) || 1.0;
        this.pixelSpacing.x = parseFloat(parts[1]) || 1.0;
      } else {
        this.pixelSpacing = { x: 1.0, y: 1.0 };
      }

      this.triggerStateChange();
    } catch (err) {
      console.error('Error fetching tags:', err);
    }
  }

  async loadSlice(instanceIndex, frameIndex = 0, highFidelityWl = false) {
    if (!this.instanceIds || this.instanceIds.length === 0) return;
    const instanceId = this.instanceIds[instanceIndex];

    let url;
    if (this.numberOfFrames > 1) {
      url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/frames/${frameIndex}/preview`;
      if (highFidelityWl || (this.windowCenter !== 40 || this.windowWidth !== 400)) {
        url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/frames/${frameIndex}/rendered?window-center=${Math.round(this.windowCenter)}&window-width=${Math.round(this.windowWidth)}`;
      }
    } else {
      url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/preview`;
      if (highFidelityWl || (this.windowCenter !== 40 || this.windowWidth !== 400)) {
        url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/rendered?window-center=${Math.round(this.windowCenter)}&window-width=${Math.round(this.windowWidth)}`;
      }
    }

    if (this.imageCache && this.imageCache.has(url)) {
      this.img = this.imageCache.get(url);
      this.imgLoaded = true;
      if (this.zoom === 1.0 && this.panX === 0 && this.panY === 0) this.fitToScreen();
      this.render();
      this.triggerStateChange();
      return;
    }

    try {
      const img = new Image();
      if (this.isLocalBff) img.crossOrigin = 'anonymous';
      img.src = url;
      await new Promise((resolve, reject) => {
        img.onload  = () => resolve();
        img.onerror = () => reject(new Error('Failed to load DICOM image'));
      });

      this.img = img;
      this.imgLoaded = true;

      if (this.imageCache) {
        this.imageCache.set(url, img);
        if (this.imageCache.size > 200) {
          const firstKey = this.imageCache.keys().next().value;
          this.imageCache.delete(firstKey);
        }
      }

      if (this.zoom === 1.0 && this.panX === 0 && this.panY === 0) this.fitToScreen();
      this.render();
      this.triggerStateChange();
    } catch (err) {
      console.error(err);
    }
  }

  async preloadFrames(instanceIndex) {
    if (!this.instanceIds || this.instanceIds.length === 0) return;
    const instanceId = this.instanceIds[instanceIndex];
    if (!instanceId || this.numberOfFrames <= 1) return;

    this.isPreloading = true;
    for (let i = 0; i < this.numberOfFrames; i++) {
      // Abort if series changed or user navigated away
      if (!this.isPreloading || this.instanceIds[instanceIndex] !== instanceId) break;
      
      const url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/frames/${i}/preview`;
      if (this.imageCache && !this.imageCache.has(url)) {
        try {
          const img = new Image();
          if (this.isLocalBff) img.crossOrigin = 'anonymous';
          img.src = url;
          await new Promise((resolve) => {
            img.onload = () => {
              if (this.imageCache) this.imageCache.set(url, img);
              resolve();
            };
            img.onerror = () => resolve();
          });
        } catch(e) {}
      }
    }
    this.isPreloading = false;
  }

  fitToScreen() {
    if (!this.img) return;
    const scaleX = this.canvas.width  / this.img.width;
    const scaleY = this.canvas.height / this.img.height;
    this.zoom = Math.min(scaleX, scaleY) * 0.85;
    this.panX = (this.canvas.width  - this.img.width  * this.zoom) / 2;
    this.panY = (this.canvas.height - this.img.height * this.zoom) / 2;
  }

  jumpToSlice(idx) {
    if (this.numberOfFrames > 1) {
      this.currentFrameIndex = idx;
      this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
    } else {
      this.currentSliceIndex = idx;
      this.loadSlice(this.currentSliceIndex, 0);
    }
  }

  changeSlice(direction) {
    if (this.numberOfFrames > 1) {
      let newFrame = this.currentFrameIndex + direction;
      if (newFrame < 0) {
        if (this.onSeriesBoundary) this.onSeriesBoundary(-1);
        return;
      }
      if (newFrame >= this.numberOfFrames) {
        if (this.onSeriesBoundary) this.onSeriesBoundary(1);
        return;
      }
      if (newFrame !== this.currentFrameIndex) {
        this.currentFrameIndex = newFrame;
        this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
      }
    } else {
      let newIndex = this.currentSliceIndex + direction;
      if (newIndex < 0) {
        if (this.onSeriesBoundary) this.onSeriesBoundary(-1);
        return;
      }
      if (newIndex >= this.instanceIds.length) {
        if (this.onSeriesBoundary) this.onSeriesBoundary(1);
        return;
      }
      if (newIndex !== this.currentSliceIndex) {
        this.currentSliceIndex = newIndex;
        this.loadSlice(newIndex, 0);
      }
    }
  }

  applyZoom(factor, clientX, clientY) {
    const imageX = (clientX - this.panX) / this.zoom;
    const imageY = (clientY - this.panY) / this.zoom;
    this.zoom = Math.max(0.1, Math.min(20, this.zoom * factor));
    this.panX = clientX - imageX * this.zoom;
    this.panY = clientY - imageY * this.zoom;
    this.render();
  }

  // ─── Coordinate Helpers ──────────────────────────────────────────────────────

  canvasToImage(x, y) {
    return { x: (x - this.panX) / this.zoom, y: (y - this.panY) / this.zoom };
  }

  imageToCanvas(x, y) {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  // ─── Mouse Events ────────────────────────────────────────────────────────────

  handleMouseDown(e) {
    this.stopCine(); // Stop auto-play if user interacts
    this.isDragging = true;
    this.didDrag    = false;
    this.dragStart  = { x: e.offsetX, y: e.offsetY };
    this.panStart   = { x: this.panX, y: this.panY };

    if (!this.imgLoaded) return;
    const imgCoord = this.canvasToImage(e.offsetX, e.offsetY);

    if (this.activeTool === 'measure') {
      this.currentShape = { type: 'line', start: imgCoord, end: imgCoord };
    } else if (this.activeTool === 'ellipse') {
      this.currentShape = { type: 'ellipse', center: imgCoord, rx: 0, ry: 0 };
    } else if (this.activeTool === 'circle') {
      this.currentShape = { type: 'circle', center: imgCoord, r: 0 };
    }
  }

  handleMouseMove(e) {
    this.mousePos = { x: e.offsetX, y: e.offsetY };
    const dx = e.offsetX - this.dragStart.x;
    const dy = e.offsetY - this.dragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.didDrag = true;

    // Magnify: always re-render on mouse move
    if (this.activeTool === 'magnify') {
      this.showMagnifier = true;
      this.render();
      return;
    }

    if (!this.isDragging) return;

    if (this.activeTool === 'browse') {
      if (Math.abs(dy) > 15) {
        this.changeSlice(Math.round(dy / 15));
        this.dragStart = { x: e.offsetX, y: e.offsetY };
      }
    } else if (this.activeTool === 'zoom') {
      this.panX = this.panStart.x + dx;
      this.panY = this.panStart.y + dy;
      this.render();
    } else if (this.activeTool === 'wl') {
      this.clientWindowWidth  = Math.max(1, this.windowWidth  + dx * 2.0);
      this.clientWindowCenter = this.windowCenter - dy * 1.5;
      this.render();
    } else if (this.activeTool === 'measure' && this.currentShape) {
      this.currentShape.end = this.canvasToImage(e.offsetX, e.offsetY);
      this.render();
    } else if (this.activeTool === 'ellipse' && this.currentShape) {
      const imgPt = this.canvasToImage(e.offsetX, e.offsetY);
      this.currentShape.rx = Math.abs(imgPt.x - this.currentShape.center.x);
      this.currentShape.ry = Math.abs(imgPt.y - this.currentShape.center.y);
      this.render();
    } else if (this.activeTool === 'circle' && this.currentShape) {
      const imgPt = this.canvasToImage(e.offsetX, e.offsetY);
      const ddx = imgPt.x - this.currentShape.center.x;
      const ddy = imgPt.y - this.currentShape.center.y;
      this.currentShape.r = Math.sqrt(ddx * ddx + ddy * ddy);
      this.render();
    }
  }

  async handleMouseUp(e) {
    const wasClick = !this.didDrag;
    this.isDragging = false;

    if (this.activeTool === 'wl') {
      this.windowWidth  = this.clientWindowWidth;
      this.windowCenter = this.clientWindowCenter;
      await this.loadSlice(this.currentSliceIndex, this.currentFrameIndex, true);

    } else if (this.activeTool === 'measure' && this.currentShape) {
      const dist = this.calculateDistance(this.currentShape.start, this.currentShape.end);
      if (dist > 0.5) this.annotations.push(this.currentShape);
      this.currentShape = null;
      this.render();

    } else if (this.activeTool === 'ellipse' && this.currentShape) {
      if (this.currentShape.rx > 1 && this.currentShape.ry > 1)
        this.annotations.push(this.currentShape);
      this.currentShape = null;
      this.render();

    } else if (this.activeTool === 'circle' && this.currentShape) {
      if (this.currentShape.r > 1) this.annotations.push(this.currentShape);
      this.currentShape = null;
      this.render();

    } else if (this.activeTool === 'annotate' && wasClick && this.imgLoaded) {
      const imgCoord = this.canvasToImage(e.offsetX, e.offsetY);
      const text = prompt('Masukkan teks anotasi:');
      if (text && text.trim()) {
        this.annotations.push({ type: 'text', pos: imgCoord, text: text.trim() });
        this.render();
      }

    } else if (this.activeTool === 'ctr' && wasClick && this.imgLoaded) {
      this.handleCtrClick(e);

    } else if (this.activeTool === 'cobb' && wasClick && this.imgLoaded) {
      this.handleCobbClick(e);
    }
  }

  // ─── Multi-Click Tool Handlers ───────────────────────────────────────────────

  handleCtrClick(e) {
    this.interactionPoints.push(this.canvasToImage(e.offsetX, e.offsetY));
    this.interactionStep++;

    if (this.interactionStep === 4) {
      const [heartLeft, heartRight, chestLeft, chestRight] = this.interactionPoints;
      const hd  = Math.abs(heartRight.x - heartLeft.x) * this.pixelSpacing.x;
      const td  = Math.abs(chestRight.x - chestLeft.x) * this.pixelSpacing.x;
      const ctr = td > 0 ? hd / td : 0;
      this.annotations.push({ type: 'ctr', heartLeft, heartRight, chestLeft, chestRight, hd, td, ctr });
      this.interactionStep  = 0;
      this.interactionPoints = [];
    }
    this.render();
  }

  handleCobbClick(e) {
    this.interactionPoints.push(this.canvasToImage(e.offsetX, e.offsetY));
    this.interactionStep++;

    if (this.interactionStep === 4) {
      const [p0, p1, p2, p3] = this.interactionPoints;
      const angle = this.calculateCobbAngle(p0, p1, p2, p3);
      this.annotations.push({ type: 'cobb', line1Start: p0, line1End: p1, line2Start: p2, line2End: p3, angle });
      this.interactionStep  = 0;
      this.interactionPoints = [];
    }
    this.render();
  }

  // ─── Calculations ─────────────────────────────────────────────────────────────

  calculateDistance(p1, p2) {
    const dx = (p2.x - p1.x) * this.pixelSpacing.x;
    const dy = (p2.y - p1.y) * this.pixelSpacing.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  calculateCobbAngle(p0, p1, p2, p3) {
    const v1 = { x: p1.x - p0.x, y: p1.y - p0.y };
    const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
    const dot  = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
    if (mag1 === 0 || mag2 === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot / (mag1 * mag2)))) * (180 / Math.PI);
  }

  // ─── Tool Controls ────────────────────────────────────────────────────────────

  setTool(tool) {
    this.interactionStep  = 0;
    this.interactionPoints = [];
    this.currentShape     = null;
    this.showMagnifier    = false;
    this.activeTool       = tool;
    this.updateCanvasCursor();
    this.render();
  }

  updateCanvasCursor() {
    const cursorMap = {
      browse:   'grab',
      zoom:     'zoom-in',
      wl:       'ew-resize',
      measure:  'crosshair',
      magnify:  'none',
      annotate: 'crosshair',
      ctr:      'crosshair',
      cobb:     'crosshair',
      ellipse:  'crosshair',
      circle:   'crosshair',
    };
    this.canvas.style.cursor = cursorMap[this.activeTool] || 'default';
  }

  clearAnnotations() {
    this.annotations      = [];
    this.currentShape     = null;
    this.interactionStep  = 0;
    this.interactionPoints = [];
    this.render();
  }

  toggleInvert() {
    this.invert = !this.invert;
    this.render();
    this.triggerStateChange();
  }

  // ─── Presets ──────────────────────────────────────────────────────────────────

  // Standard W/L presets — nilai referensi klinis standar internasional
  // Sumber: RSNA, Radiopaedia, ASRT — valid untuk CT (Hounsfield Units)
  static get CT_PRESETS() {
    return {
      brain:   { ww: 80,   wc: 40,   note: 'Brain soft tissue (HU)' },
      chest:   { ww: 350,  wc: 40,   note: 'Chest / Mediastinum (HU)' },
      lung:    { ww: 1500, wc: -600, note: 'Lung parenchyma (HU)' },
      abdomen: { ww: 400,  wc: 50,   note: 'Abdomen soft tissue (HU)' },
      bone:    { ww: 2000, wc: 400,  note: 'Bone / cortex (HU)' },
    };
  }

  // Untuk non-CT (CR/DX): preset berdasarkan proporsi dari nilai DICOM asli
  // karena CR/DX tidak menggunakan Hounsfield Units — pixel value bersifat raw
  static get RELATIVE_RATIOS() {
    return {
      brain:   { wwRatio: 0.60, wcShift:  0.00 }, // Skull/Kepala (lebih sempit)
      chest:   { wwRatio: 1.00, wcShift:  0.00 }, // Standar (nilai asli DICOM)
      lung:    { wwRatio: 1.40, wcShift: -0.10 }, // Lebih lebar, geser ke bawah
      abdomen: { wwRatio: 0.85, wcShift:  0.00 }, // Sedikit lebih sempit
      bone:    { wwRatio: 0.50, wcShift:  0.15 }, // Sempit, geser ke atas
    };
  }

  applyPreset(name) {
    const modalityUpper = (this.modality || '').toUpperCase();
    const isCT = modalityUpper === 'CT';
    const isMR = modalityUpper === 'MR';

    if (isCT) {
      // ── CT: gunakan nilai HU standar klinis ──────────────────────────────
      const p = DicomViewer.CT_PRESETS[name];
      if (!p) return;
      this.windowWidth  = p.ww;
      this.windowCenter = p.wc;
    } else if (isMR) {
      // ── MR (MRI): Nilai pixel bersifat arbitrer tergantung sekuen (T1/T2/FLAIR/dll).
      // Nilai asli DICOM dari scanner adalah preset terbaik untuk masing-masing sekuen.
      // Kita gunakan rasio aman agar tidak merusak kualitas gambar MRI.
      const mrPresets = {
        brain:   { wwRatio: 1.00, wcShift:  0.00 }, // Standar/Asli (T1/T2/FLAIR optimal)
        chest:   { wwRatio: 1.00, wcShift:  0.00 }, // Standar/Asli
        lung:    { wwRatio: 1.40, wcShift:  0.00 }, // Lebih lebar (kontras lebih lembut)
        abdomen: { wwRatio: 0.80, wcShift:  0.00 }, // Sedikit lebih sempit (kontras lebih tinggi)
        bone:    { wwRatio: 0.50, wcShift:  0.00 }, // Sempit (kontras sangat tinggi)
      };
      const p = mrPresets[name];
      if (!p) return;
      const origWW = this.originalWindowWidth  || this.windowWidth;
      const origWC = this.originalWindowCenter || this.windowCenter;
      this.windowWidth  = Math.max(1, Math.round(origWW * p.wwRatio));
      this.windowCenter = Math.round(origWC + origWW * p.wcShift);
    } else {
      // ── CR/DX/dll: gunakan rasio relatif dari nilai asli DICOM ────────
      const p = DicomViewer.RELATIVE_RATIOS[name];
      if (!p) return;
      const origWW = this.originalWindowWidth  || this.windowWidth;
      const origWC = this.originalWindowCenter || this.windowCenter;
      this.windowWidth  = Math.max(1, Math.round(origWW * p.wwRatio));
      this.windowCenter = Math.round(origWC + origWW * p.wcShift);
    }

    this.clientWindowWidth  = this.windowWidth;
    this.clientWindowCenter = this.windowCenter;
    this.loadSlice(this.currentSliceIndex, this.currentFrameIndex, true);
    this.triggerStateChange();
  }

  reset() {
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    // Restore original DICOM WW/WC, not arbitrary defaults
    this.windowWidth  = this.originalWindowWidth;
    this.windowCenter = this.originalWindowCenter;
    this.clientWindowWidth  = this.originalWindowWidth;
    this.clientWindowCenter = this.originalWindowCenter;
    this.invert = false;
    this.clearAnnotations();
    this.fitToScreen();
    this.loadSlice(this.currentSliceIndex, this.currentFrameIndex, true);
  }

  // ─── Cine Play ────────────────────────────────────────────────────────────────

  toggleCine() {
    if (this.isCinePlaying) {
      this.stopCine();
    } else {
      this.startCine();
    }
  }

  startCine() {
    const totalCount = this.numberOfFrames > 1 ? this.numberOfFrames : this.instanceIds.length;
    if (totalCount <= 1) return;
    this.isCinePlaying = true;
    
    const playNextFrame = async () => {
      if (!this.isCinePlaying) return;
      const startTime = performance.now();

      if (this.numberOfFrames > 1) {
        if (this.currentFrameIndex >= this.numberOfFrames - 1) {
          this.currentFrameIndex = 0;
        } else {
          this.currentFrameIndex++;
        }
        await this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
      } else {
        if (this.currentSliceIndex >= this.instanceIds.length - 1) {
          this.currentSliceIndex = 0;
        } else {
          this.currentSliceIndex++;
        }
        await this.loadSlice(this.currentSliceIndex, 0);
      }

      const elapsed = performance.now() - startTime;
      const targetDelay = 1000 / this.cineFps;
      const nextDelay = Math.max(0, targetDelay - elapsed);

      this.cineTimeout = setTimeout(playNextFrame, nextDelay);
    };

    playNextFrame();
    this.triggerStateChange();
  }

  stopCine() {
    this.isCinePlaying = false;
    if (this.cineTimeout) {
      clearTimeout(this.cineTimeout);
      this.cineTimeout = null;
    }
    if (this.cineInterval) {
      clearInterval(this.cineInterval);
      this.cineInterval = null;
    }
    this.triggerStateChange();
  }

  // ─── Render Pipeline ──────────────────────────────────────────────────────────

  render() {
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.imgLoaded || !this.img) {
      ctx.fillStyle = '#71717a';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No Image Loaded', this.canvas.width / 2, this.canvas.height / 2);
      return;
    }

    // ── Draw base image ──
    ctx.save();
    let filters = [];
    if (this.invert) filters.push('invert(100%)');
    if (this.isDragging && this.activeTool === 'wl') {
      const cr = this.windowWidth / this.clientWindowWidth;
      const bo = (this.windowCenter - this.clientWindowCenter) / this.windowWidth;
      filters.push(`contrast(${Math.max(10, Math.round(cr * 100))}%)`);
      filters.push(`brightness(${Math.max(10, Math.round((1.0 + bo) * 100))}%)`);
    }
    if (filters.length) ctx.filter = filters.join(' ');
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    ctx.drawImage(this.img, 0, 0);
    ctx.restore();

    // ── Draw annotations overlay ──
    this.renderAnnotations();

    // ── Draw magnifier last (on top of everything) ──
    if (this.activeTool === 'magnify' && this.showMagnifier) {
      this.renderMagnifier();
    }

    // ── Draw step guide for multi-click tools ──
    this.renderInteractionGuide();
  }

  // ─── Annotation Rendering ────────────────────────────────────────────────────

  renderAnnotations() {
    if (!this.imgLoaded) return;

    for (const ann of this.annotations) {
      switch (ann.type) {
        case 'line':    this.renderLine(ann);    break;
        case 'ellipse': this.renderEllipse(ann); break;
        case 'circle':  this.renderCircle(ann);  break;
        case 'text':    this.renderText(ann);    break;
        case 'ctr':     this.renderCtr(ann);     break;
        case 'cobb':    this.renderCobb(ann);    break;
      }
    }

    // In-progress shape
    if (this.currentShape) {
      switch (this.currentShape.type) {
        case 'line':    this.renderLine(this.currentShape);    break;
        case 'ellipse': this.renderEllipse(this.currentShape); break;
        case 'circle':  this.renderCircle(this.currentShape);  break;
      }
    }

    // In-progress CTR/Cobb points
    if ((this.activeTool === 'ctr' || this.activeTool === 'cobb') && this.interactionPoints.length > 0) {
      this.renderInteractionPoints();
    }
  }

  renderLine(ann) {
    const ctx  = this.ctx;
    const cS   = this.imageToCanvas(ann.start.x, ann.start.y);
    const cE   = this.imageToCanvas(ann.end.x, ann.end.y);

    ctx.save();
    ctx.strokeStyle = '#00ffcc';
    ctx.fillStyle   = '#00ffcc';
    ctx.lineWidth   = 1.5;
    ctx.font        = 'bold 11px monospace';
    ctx.textAlign   = 'center';

    ctx.beginPath();
    ctx.moveTo(cS.x, cS.y);
    ctx.lineTo(cE.x, cE.y);
    ctx.stroke();

    [cS, cE].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
    });

    const dist  = this.calculateDistance(ann.start, ann.end);
    const midX  = (cS.x + cE.x) / 2;
    const midY  = (cS.y + cE.y) / 2;
    const label = `${dist.toFixed(2)} mm`;
    const tw    = ctx.measureText(label).width;

    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(midX - (tw + 8) / 2, midY - 11, tw + 8, 16);
    ctx.fillStyle = '#00ffcc';
    ctx.fillText(label, midX, midY + 2);
    ctx.restore();
  }

  renderEllipse(ann) {
    const ctx     = this.ctx;
    const cC      = this.imageToCanvas(ann.center.x, ann.center.y);
    const rxC     = Math.max(1, ann.rx * this.zoom);
    const ryC     = Math.max(1, ann.ry * this.zoom);
    const areaX   = ann.rx * this.pixelSpacing.x;
    const areaY   = ann.ry * this.pixelSpacing.y;
    const area    = Math.PI * areaX * areaY;
    const label   = `Area: ${area.toFixed(1)} mm²`;

    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.ellipse(cC.x, cC.y, rxC, ryC, 0, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font      = 'bold 11px monospace';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(cC.x - (tw + 8) / 2, cC.y - ryC - 22, tw + 8, 16);
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(label, cC.x, cC.y - ryC - 9);
    ctx.restore();
  }

  renderCircle(ann) {
    const ctx   = this.ctx;
    const cC    = this.imageToCanvas(ann.center.x, ann.center.y);
    const rC    = Math.max(1, ann.r * this.zoom);
    const rMm   = ann.r * this.pixelSpacing.x;
    const area  = Math.PI * rMm * rMm;
    const label = `Area: ${area.toFixed(1)} mm²`;

    ctx.save();
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.arc(cC.x, cC.y, rC, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font      = 'bold 11px monospace';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(cC.x - (tw + 8) / 2, cC.y - rC - 22, tw + 8, 16);
    ctx.fillStyle = '#a78bfa';
    ctx.fillText(label, cC.x, cC.y - rC - 9);
    ctx.restore();
  }

  renderText(ann) {
    const ctx  = this.ctx;
    const cPos = this.imageToCanvas(ann.pos.x, ann.pos.y);

    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    const tw = ctx.measureText(ann.text).width;

    // Anchor dot
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath(); ctx.arc(cPos.x, cPos.y, 4, 0, 2 * Math.PI); ctx.fill();

    // Leader line
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cPos.x, cPos.y);
    ctx.lineTo(cPos.x + 16, cPos.y - 16);
    ctx.stroke();

    // Label background
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(cPos.x + 12, cPos.y - 32, tw + 12, 20);

    // Label text
    ctx.fillStyle   = '#fbbf24';
    ctx.textAlign   = 'left';
    ctx.fillText(ann.text, cPos.x + 18, cPos.y - 16);
    ctx.restore();
  }

  renderCtr(ann) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font      = 'bold 12px monospace';

    // Heart width — blue
    const cHL = this.imageToCanvas(ann.heartLeft.x,  ann.heartLeft.y);
    const cHR = this.imageToCanvas(ann.heartRight.x, ann.heartRight.y);
    ctx.strokeStyle = '#60a5fa';
    ctx.fillStyle   = '#60a5fa';
    ctx.beginPath(); ctx.moveTo(cHL.x, cHL.y); ctx.lineTo(cHR.x, cHR.y); ctx.stroke();
    [cHL, cHR].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fill(); });

    // Chest width — green
    const cCL = this.imageToCanvas(ann.chestLeft.x,  ann.chestLeft.y);
    const cCR = this.imageToCanvas(ann.chestRight.x, ann.chestRight.y);
    ctx.strokeStyle = '#34d399';
    ctx.fillStyle   = '#34d399';
    ctx.beginPath(); ctx.moveTo(cCL.x, cCL.y); ctx.lineTo(cCR.x, cCR.y); ctx.stroke();
    [cCL, cCR].forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fill(); });

    // CTR result label
    const isNormal   = ann.ctr < 0.5;
    const color      = isNormal ? '#22c55e' : '#ef4444';
    const statusText = isNormal ? 'Normal' : 'Kardiomegali';
    const label      = `CTR: ${ann.ctr.toFixed(3)} — ${statusText}`;
    const midX       = (cHL.x + cHR.x) / 2;
    const midY       = Math.min(cHL.y, cHR.y) - 18;
    const tw         = ctx.measureText(label).width;

    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(midX - (tw + 16) / 2, midY - 16, tw + 16, 22);
    ctx.fillStyle   = color;
    ctx.textAlign   = 'center';
    ctx.fillText(label, midX, midY);
    ctx.restore();
  }

  renderCobb(ann) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#fb923c';
    ctx.fillStyle   = '#fb923c';
    ctx.lineWidth   = 2;

    const cL1S = this.imageToCanvas(ann.line1Start.x, ann.line1Start.y);
    const cL1E = this.imageToCanvas(ann.line1End.x,   ann.line1End.y);
    const cL2S = this.imageToCanvas(ann.line2Start.x, ann.line2Start.y);
    const cL2E = this.imageToCanvas(ann.line2End.x,   ann.line2End.y);

    // Line 1
    ctx.beginPath(); ctx.moveTo(cL1S.x, cL1S.y); ctx.lineTo(cL1E.x, cL1E.y); ctx.stroke();
    // Line 2
    ctx.strokeStyle = '#fdba74';
    ctx.beginPath(); ctx.moveTo(cL2S.x, cL2S.y); ctx.lineTo(cL2E.x, cL2E.y); ctx.stroke();

    // Endpoint dots
    [cL1S, cL1E, cL2S, cL2E].forEach(p => {
      ctx.fillStyle = '#fb923c';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fill();
    });

    // Angle label at midpoint of line 2
    const midX  = (cL2S.x + cL2E.x) / 2;
    const midY  = (cL2S.y + cL2E.y) / 2;
    const label = `Cobb: ${ann.angle.toFixed(1)}°`;
    ctx.font    = 'bold 13px monospace';
    const tw    = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(midX - (tw + 12) / 2, midY - 22, tw + 12, 20);
    ctx.fillStyle   = '#fb923c';
    ctx.textAlign   = 'center';
    ctx.fillText(label, midX, midY - 6);
    ctx.restore();
  }

  renderInteractionPoints() {
    const ctx    = this.ctx;
    const colors = this.activeTool === 'ctr'
      ? ['#60a5fa', '#60a5fa', '#34d399', '#34d399']
      : ['#fb923c', '#fb923c', '#fdba74', '#fdba74'];

    ctx.save();
    ctx.lineWidth = 1.5;

    for (let i = 0; i < this.interactionPoints.length; i++) {
      const cp = this.imageToCanvas(this.interactionPoints[i].x, this.interactionPoints[i].y);
      ctx.fillStyle   = colors[i] || '#00ffcc';
      ctx.strokeStyle = colors[i] || '#00ffcc';

      ctx.beginPath(); ctx.arc(cp.x, cp.y, 5, 0, 2 * Math.PI); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cp.x - 10, cp.y); ctx.lineTo(cp.x + 10, cp.y);
      ctx.moveTo(cp.x, cp.y - 10); ctx.lineTo(cp.x, cp.y + 10);
      ctx.stroke();

      // Connect pairs (0→1 and 2→3)
      if (i % 2 === 1) {
        const cpPrev = this.imageToCanvas(this.interactionPoints[i - 1].x, this.interactionPoints[i - 1].y);
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(cpPrev.x, cpPrev.y); ctx.lineTo(cp.x, cp.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  renderInteractionGuide() {
    if (this.activeTool !== 'ctr' && this.activeTool !== 'cobb') return;

    const guides = {
      ctr: [
        '1 / 4 — Klik tepi kiri jantung (heart)',
        '2 / 4 — Klik tepi kanan jantung',
        '3 / 4 — Klik tepi kiri dinding dada (thorax)',
        '4 / 4 — Klik tepi kanan dinding dada',
      ],
      cobb: [
        '1 / 4 — Klik awal garis atas (endplate superior)',
        '2 / 4 — Klik akhir garis atas',
        '3 / 4 — Klik awal garis bawah (endplate inferior)',
        '4 / 4 — Klik akhir garis bawah → selesai',
      ],
    };

    const guide = guides[this.activeTool]?.[this.interactionStep];
    if (!guide) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.font    = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    const x  = this.canvas.width / 2;
    const y  = this.canvas.height - 32;
    const tw = ctx.measureText(guide).width;

    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath();
    ctx.roundRect(x - tw / 2 - 14, y - 18, tw + 28, 26, 6);
    ctx.fill();

    ctx.fillStyle = '#fbbf24';
    ctx.fillText(guide, x, y);
    ctx.restore();
  }

  renderMagnifier() {
    if (!this.img) return;
    const ctx           = this.ctx;
    const mx            = this.mousePos.x;
    const my            = this.mousePos.y;
    const LENS_R        = 90;
    const MAGNIFY       = 3;

    const imgPt = this.canvasToImage(mx, my);
    const srcW  = (LENS_R * 2) / (this.zoom * MAGNIFY);
    const srcH  = (LENS_R * 2) / (this.zoom * MAGNIFY);
    const srcX  = imgPt.x - srcW / 2;
    const srcY  = imgPt.y - srcH / 2;

    // Clip to circular lens
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, LENS_R, 0, Math.PI * 2);
    ctx.clip();

    if (this.invert) ctx.filter = 'invert(100%)';
    ctx.drawImage(this.img, srcX, srcY, srcW, srcH, mx - LENS_R, my - LENS_R, LENS_R * 2, LENS_R * 2);
    ctx.restore();

    // Lens border
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, LENS_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Soft inner glow ring
    ctx.beginPath();
    ctx.arc(mx, my, LENS_R - 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,204,0.15)';
    ctx.lineWidth   = 6;
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = 'rgba(0,255,204,0.75)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(mx - 14, my); ctx.lineTo(mx + 14, my);
    ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my + 14);
    ctx.stroke();

    // Zoom label badge
    const badge = `${MAGNIFY}×`;
    ctx.font      = 'bold 11px monospace';
    ctx.textAlign = 'center';
    const bw = ctx.measureText(badge).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(mx - bw / 2 - 6, my + LENS_R + 4, bw + 12, 18);
    ctx.fillStyle = '#00ffcc';
    ctx.fillText(badge, mx, my + LENS_R + 17);
    ctx.restore();
  }

  // ─── State Broadcast ─────────────────────────────────────────────────────────

  triggerStateChange() {
    if (this.onStateChange) {
      this.onStateChange({
        patientName:    this.patientName,
        patientId:      this.patientId,
        patientSex:     this.patientSex,
        patientBirthDate: this.patientBirthDate,
        studyDesc:      this.studyDesc,
        studyDate:      this.studyDate,
        seriesDesc:     this.seriesDesc,
        seriesNumber:   this.seriesNumber,
        modality:       this.modality,
        sliceIndex:     this.numberOfFrames > 1 ? this.currentFrameIndex : this.currentSliceIndex,
        sliceCount:     this.numberOfFrames > 1 ? this.numberOfFrames : this.instanceIds.length,
        isMultiFrame:   this.numberOfFrames > 1,
        windowCenter:   Math.round(this.isDragging && this.activeTool === 'wl' ? this.clientWindowCenter : this.windowCenter),
        windowWidth:    Math.round(this.isDragging && this.activeTool === 'wl' ? this.clientWindowWidth  : this.windowWidth),
        invert:         this.invert,
        activeTool:     this.activeTool,
      });
    }
  }
}
