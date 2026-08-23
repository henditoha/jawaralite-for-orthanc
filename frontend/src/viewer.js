// JawaraLite Viewer - HTML5 Canvas DICOM Engine
// Tools: browse, zoom, wl, measure, magnify, annotate, ctr, cobb, ellipse, circle

import {
  projectPointToMidline,
  calculateCobbGeometry,
  renderLine,
  renderEllipse,
  renderCircle,
  renderText,
  renderCtr,
  renderCtrDragPreview,
  renderCobb,
  renderCobbDragPreview
} from './tools.js';

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
    this.presetActive = false;
    this.serverWindowWidth = null;
    this.serverWindowCenter = null;

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
    this.hasPixelSpacing = false;
    this.pixelSpacingSource = 'uncalibrated';
    this.currentLoadedInstanceId = null;

    // CTR Drag State
    this.ctrMidTop = null;
    this.ctrMidBot = null;
    this.ctrHeartRight = null;
    this.ctrHeartLeft = null;
    this.ctrProjA = null;
    this.ctrProjB = null;
    this.ctrDistA = 0;
    this.ctrDistB = 0;

    // Cobb Drag State
    this.cobbLine1Start = null;
    this.cobbLine1End = null;

    // W/L Custom State & Drag tracking
    this.isCustomWl = false;
    this.wlStartPos = null;
    this.wlStartWidth = 400;
    this.wlStartCenter = 40;

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
    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) this.handleMouseUp(e);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.showMagnifier = false;
      if (this.isDragging) {
        this.handleMouseUp({});
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stopCine(); // Stop auto-play if user interacts
      if (this.activeTool === 'zoom' || e.ctrlKey) {
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
    this.isCustomWl = false;
    this.wlStartPos = null;

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

      if (!this.isCustomWl) {
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
        this.originalWindowWidth  = this.windowWidth;
        this.originalWindowCenter = this.windowCenter;
      }

      const parsedSpacing = this.parsePixelSpacing(tags);
      this.pixelSpacing = parsedSpacing.spacing;
      this.hasPixelSpacing = parsedSpacing.hasSpacing;
      this.pixelSpacingSource = parsedSpacing.source;

      this.triggerStateChange();
    } catch (err) {
      console.error('Error fetching tags:', err);
    }
  }

  parsePixelSpacing(tags) {
    if (!tags) return { spacing: { x: 1.0, y: 1.0 }, hasSpacing: false, source: 'uncalibrated' };

    // Hierarchical list of DICOM tags to check for Pixel Spacing:
    // 1. (0028,0030) Pixel Spacing (Row Spacing \ Column Spacing)
    // 2. (0018,1164) Imager Pixel Spacing (common in CR/DX X-rays)
    // 3. (0028,0901) Reconstructed Pixel Spacing
    // 4. (0018,7022) Detector Element Spacing
    const candidates = [
      { key: '0028,0030', name: 'PixelSpacing' },
      { key: 'PixelSpacing', name: 'PixelSpacing' },
      { key: '0018,1164', name: 'ImagerPixelSpacing' },
      { key: 'ImagerPixelSpacing', name: 'ImagerPixelSpacing' },
      { key: '0028,0901', name: 'ReconstructedPixelSpacing' },
      { key: 'ReconstructedPixelSpacing', name: 'ReconstructedPixelSpacing' },
      { key: '0018,7022', name: 'DetectorElementSpacing' },
      { key: 'DetectorElementSpacing', name: 'DetectorElementSpacing' },
    ];

    for (const cand of candidates) {
      const tagObj = tags[cand.key];
      if (!tagObj) continue;

      let rawVal = typeof tagObj === 'object' && tagObj !== null && 'Value' in tagObj ? tagObj.Value : tagObj;
      if (!rawVal) continue;

      let row = null; // Y spacing (Row Spacing in DICOM standard)
      let col = null; // X spacing (Column Spacing in DICOM standard)

      if (Array.isArray(rawVal)) {
        if (rawVal.length >= 2) {
          row = parseFloat(rawVal[0]);
          col = parseFloat(rawVal[1]);
        } else if (rawVal.length === 1 && rawVal[0] !== undefined) {
          const parts = String(rawVal[0]).split(/[\\\/,]/);
          if (parts.length >= 2) {
            row = parseFloat(parts[0]);
            col = parseFloat(parts[1]);
          }
        }
      } else if (typeof rawVal === 'number') {
        row = rawVal;
        col = rawVal;
      } else if (typeof rawVal === 'string') {
        const parts = rawVal.trim().split(/[\\\/,]/);
        if (parts.length >= 2) {
          row = parseFloat(parts[0]);
          col = parseFloat(parts[1]);
        } else if (parts.length === 1) {
          const val = parseFloat(parts[0]);
          if (!isNaN(val)) {
            row = val;
            col = val;
          }
        }
      }

      if (row !== null && col !== null && !isNaN(row) && !isNaN(col) && row > 0 && col > 0) {
        return {
          spacing: { x: col, y: row }, // DICOM standard: [0] = Row Spacing (Y), [1] = Column Spacing (X)
          hasSpacing: true,
          source: cand.name
        };
      }
    }

    // Fallback: Check Pixel Aspect Ratio (0028,0034) for non-square pixel aspect ratio if physical spacing is absent
    const aspectRatioObj = tags['0028,0034'] || tags['PixelAspectRatio'];
    if (aspectRatioObj) {
      let rawAspect = typeof aspectRatioObj === 'object' && aspectRatioObj !== null && 'Value' in aspectRatioObj ? aspectRatioObj.Value : aspectRatioObj;
      let rY = null, rX = null;
      if (Array.isArray(rawAspect) && rawAspect.length >= 2) {
        rY = parseFloat(rawAspect[0]);
        rX = parseFloat(rawAspect[1]);
      } else if (typeof rawAspect === 'string') {
        const parts = rawAspect.trim().split(/[\\\/,]/);
        if (parts.length >= 2) {
          rY = parseFloat(parts[0]);
          rX = parseFloat(parts[1]);
        }
      }
      if (rY !== null && rX !== null && !isNaN(rY) && !isNaN(rX) && rY > 0 && rX > 0) {
        return {
          spacing: { x: rX / rY, y: 1.0 },
          hasSpacing: false,
          source: 'PixelAspectRatio'
        };
      }
    }

    return { spacing: { x: 1.0, y: 1.0 }, hasSpacing: false, source: 'uncalibrated' };
  }

  async loadSlice(instanceIndex, frameIndex = 0) {
    if (!this.instanceIds || this.instanceIds.length === 0) return;
    const instanceId = this.instanceIds[instanceIndex];

    // Ensure DICOM tags and pixel spacing are updated if slice/instance changed
    if (this.currentLoadedInstanceId !== instanceId) {
      this.currentLoadedInstanceId = instanceId;
      await this.fetchDicomTags(instanceId);
    }

    let url = (this.numberOfFrames > 1)
      ? `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/frames/${frameIndex}/rendered`
      : `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/rendered`;

    if (this.presetActive && this.serverWindowWidth && this.serverWindowCenter !== null) {
      url += `?window-center=${this.serverWindowCenter}&window-width=${this.serverWindowWidth}`;
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
      
      let url = `${this.bffUrl}${this.apiPrefix}/instances/${instanceId}/frames/${i}/rendered`;
      if (this.presetActive && this.serverWindowWidth && this.serverWindowCenter !== null) {
        url += `?window-center=${this.serverWindowCenter}&window-width=${this.serverWindowWidth}`;
      }
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
    if (e.button !== 0) return; // Only Left Click triggers tool drag
    this.stopCine(); // Stop auto-play if user interacts
    this.isDragging = true;
    this.didDrag    = false;
    this.dragStart  = { x: e.offsetX, y: e.offsetY };
    if (this.activeTool === 'wl') {
      this.wlStartPos = { x: e.offsetX, y: e.offsetY };
      this.wlStartWidth = this.windowWidth;
      this.wlStartCenter = this.windowCenter;
      this.canvas.style.cursor = 'grabbing';
    }

    if (!this.imgLoaded) return;
    const imgCoord = this.canvasToImage(e.offsetX, e.offsetY);

    if (this.activeTool === 'measure') {
      this.currentShape = { type: 'line', start: imgCoord, end: imgCoord };
    } else if (this.activeTool === 'ellipse') {
      this.currentShape = { type: 'ellipse', center: imgCoord, rx: 0, ry: 0 };
    } else if (this.activeTool === 'circle') {
      this.currentShape = { type: 'circle', center: imgCoord, r: 0 };
    } else if (this.activeTool === 'ctr') {
      if (this.interactionStep === 0) {
        this.currentShape = { type: 'ctr-midline', start: imgCoord, end: imgCoord };
      } else if (this.interactionStep === 1) {
        this.currentShape = { type: 'ctr-lineA', start: imgCoord, end: imgCoord };
      } else if (this.interactionStep === 2) {
        this.currentShape = { type: 'ctr-lineB', start: imgCoord, end: imgCoord };
      } else if (this.interactionStep === 3) {
        this.currentShape = { type: 'ctr-lineC', start: imgCoord, end: imgCoord };
      }
    } else if (this.activeTool === 'cobb') {
      if (this.interactionStep === 0) {
        this.currentShape = { type: 'cobb-line1', start: imgCoord, end: imgCoord };
      } else if (this.interactionStep === 1) {
        this.currentShape = { type: 'cobb-line2', start: imgCoord, end: imgCoord };
      }
    }
  }

  handleMouseMove(e) {
    this.mousePos = { x: e.offsetX, y: e.offsetY };

    // Ensure Left Click is still held down during drag
    if (this.isDragging && (e.buttons & 1) === 0) {
      this.isDragging = false;
      this.wlStartPos = null;
      this.updateCanvasCursor();
      return;
    }

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
    } else if (this.activeTool === 'wl' && this.wlStartPos) {
      const dxWl = e.offsetX - this.wlStartPos.x;
      const dyWl = e.offsetY - this.wlStartPos.y;

      const factor = Math.max(0.5, this.wlStartWidth / 300);
      const newWidth  = Math.max(1, Math.round(this.wlStartWidth + dxWl * factor * 2.0));
      const newCenter = Math.round(this.wlStartCenter - dyWl * factor * 1.5);

      this.windowWidth = newWidth;
      this.windowCenter = newCenter;
      this.clientWindowWidth = newWidth;
      this.clientWindowCenter = newCenter;
      this.isCustomWl = true;

      this.render();
      this.triggerStateChange();
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
    } else if ((this.activeTool === 'ctr' || this.activeTool === 'cobb') && this.currentShape) {
      const imgPt = this.canvasToImage(e.offsetX, e.offsetY);
      this.currentShape.end = imgPt;
      this.render();
    }
  }

  handleMouseUp(e) {
    const wasClick  = !this.didDrag;
    const wasWlDrag = this.activeTool === 'wl' && this.wlStartPos;

    this.isDragging = false;
    this.wlStartPos = null;
    this.updateCanvasCursor();

    if (wasWlDrag) {
      this.windowWidth  = this.clientWindowWidth;
      this.windowCenter = this.clientWindowCenter;
      this.isCustomWl   = true;
    }

    this.render();
    this.triggerStateChange();

    if (this.activeTool === 'measure' && this.currentShape) {
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

    } else if (this.activeTool === 'ctr' && this.currentShape) {
      this.finishCtrDragStep();

    } else if (this.activeTool === 'annotate' && wasClick && this.imgLoaded) {
      const imgCoord = this.canvasToImage(e.offsetX, e.offsetY);
      const text = prompt('Masukkan teks anotasi:');
      if (text && text.trim()) {
        this.annotations.push({ type: 'text', pos: imgCoord, text: text.trim() });
        this.render();
      }

    } else if (this.activeTool === 'cobb' && this.currentShape) {
      this.finishCobbDragStep();
    }
  }

  projectPointToMidline(pt, midTop, midBot) {
    const sx = this.pixelSpacing.x;
    const sy = this.pixelSpacing.y;

    const p1 = { x: midTop.x * sx, y: midTop.y * sy };
    const p2 = { x: midBot.x * sx, y: midBot.y * sy };
    const vMid = { x: p2.x - p1.x, y: p2.y - p1.y };
    const lMid = Math.sqrt(vMid.x * vMid.x + vMid.y * vMid.y);
    const uMid = lMid > 0 ? { x: vMid.x / lMid, y: vMid.y / lMid } : { x: 0, y: 1 };
    const uNorm = { x: -uMid.y, y: uMid.x };

    const pMm = { x: pt.x * sx, y: pt.y * sy };
    const w = { x: pMm.x - p1.x, y: pMm.y - p1.y };
    const t = w.x * uMid.x + w.y * uMid.y;
    const d = Math.abs(w.x * uNorm.x + w.y * uNorm.y);
    const projMm = { x: p1.x + t * uMid.x, y: p1.y + t * uMid.y };
    const projPx = { x: projMm.x / sx, y: projMm.y / sy };

    return { dist: d, projPx };
  }

  finishCtrDragStep() {
    if (!this.currentShape) return;
    const { start, end } = this.currentShape;

    if (this.interactionStep === 0) {
      if (this.calculateDistance(start, end) > 2) {
        this.ctrMidTop = start;
        this.ctrMidBot = end;
        this.interactionStep = 1;
      }
    } else if (this.interactionStep === 1) {
      const resA = this.projectPointToMidline(end, this.ctrMidTop, this.ctrMidBot);
      this.ctrHeartRight = end;
      this.ctrProjA = resA.projPx;
      this.ctrDistA = resA.dist;
      this.interactionStep = 2;
    } else if (this.interactionStep === 2) {
      const resB = this.projectPointToMidline(end, this.ctrMidTop, this.ctrMidBot);
      this.ctrHeartLeft = end;
      this.ctrProjB = resB.projPx;
      this.ctrDistB = resB.dist;
      this.interactionStep = 3;
    } else if (this.interactionStep === 3) {
      const distC = this.calculateDistance(start, end);
      if (distC > 2) {
        const distCardiac = this.ctrDistA + this.ctrDistB;
        const ctr = distC > 0 ? distCardiac / distC : 0;

        this.annotations.push({
          type: 'ctr',
          midTop: this.ctrMidTop,
          midBot: this.ctrMidBot,
          heartRight: this.ctrHeartRight,
          heartLeft: this.ctrHeartLeft,
          projA: this.ctrProjA,
          projB: this.ctrProjB,
          chestLeft: start,
          chestRight: end,
          distA: this.ctrDistA,
          distB: this.ctrDistB,
          distC: distC,
          distCardiac: distCardiac,
          ctr: ctr
        });

        this.interactionStep = 0;
        this.ctrMidTop = null;
        this.ctrMidBot = null;
        this.ctrHeartRight = null;
        this.ctrHeartLeft = null;
        this.ctrProjA = null;
        this.ctrProjB = null;
        this.ctrDistA = 0;
        this.ctrDistB = 0;
      }
    }

    this.currentShape = null;
    this.render();
  }

  calculateCobbGeometry(p0, p1, p2, p3) {
    const sx = this.pixelSpacing.x;
    const sy = this.pixelSpacing.y;

    const P0 = { x: p0.x * sx, y: p0.y * sy };
    const P1 = { x: p1.x * sx, y: p1.y * sy };
    const P2 = { x: p2.x * sx, y: p2.y * sy };
    const P3 = { x: p3.x * sx, y: p3.y * sy };

    const M1 = { x: (P0.x + P1.x) / 2, y: (P0.y + P1.y) / 2 };
    const M2 = { x: (P2.x + P3.x) / 2, y: (P2.y + P3.y) / 2 };

    const v1 = { x: P1.x - P0.x, y: P1.y - P0.y };
    const v2 = { x: P3.x - P2.x, y: P3.y - P2.y };

    const l1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const l2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);

    const u1 = l1 > 0 ? { x: v1.x / l1, y: v1.y / l1 } : { x: 1, y: 0 };
    const u2 = l2 > 0 ? { x: v2.x / l2, y: v2.y / l2 } : { x: 1, y: 0 };

    const dot = u1.x * u2.x + u1.y * u2.y;
    const thetaRad = Math.acos(Math.max(-1, Math.min(1, dot)));
    let thetaDeg = thetaRad * (180 / Math.PI);
    if (thetaDeg > 90) thetaDeg = 180 - thetaDeg;

    let n1 = { x: -u1.y, y: u1.x };
    let n2 = { x: -u2.y, y: u2.x };

    const D = { x: M2.x - M1.x, y: M2.y - M1.y };
    if (D.x * n1.x + D.y * n1.y < 0) n1 = { x: -n1.x, y: -n1.y };
    if ((-D.x) * n2.x + (-D.y) * n2.y < 0) n2 = { x: -n2.x, y: -n2.y };

    const det = n1.x * n2.y - n1.y * n2.x;
    let I_mm;
    if (Math.abs(det) > 1e-5) {
      const t1 = ((M2.x - M1.x) * n2.y - (M2.y - M1.y) * n2.x) / det;
      I_mm = { x: M1.x + t1 * n1.x, y: M1.y + t1 * n1.y };
    } else {
      I_mm = { x: (M1.x + M2.x) / 2, y: (M1.y + M2.y) / 2 };
    }

    const m1_px = { x: M1.x / sx, y: M1.y / sy };
    const m2_px = { x: M2.x / sx, y: M2.y / sy };
    const I_px  = { x: I_mm.x / sx, y: I_mm.y / sy };

    return {
      angle: thetaDeg,
      mid1: m1_px,
      mid2: m2_px,
      intersection: I_px
    };
  }

  finishCobbDragStep() {
    if (!this.currentShape) return;
    const { start, end } = this.currentShape;

    if (this.interactionStep === 0) {
      if (this.calculateDistance(start, end) > 2) {
        this.cobbLine1Start = start;
        this.cobbLine1End = end;
        this.interactionStep = 1;
      }
    } else if (this.interactionStep === 1) {
      if (this.calculateDistance(start, end) > 2) {
        const geom = this.calculateCobbGeometry(this.cobbLine1Start, this.cobbLine1End, start, end);

        this.annotations.push({
          type: 'cobb',
          line1Start: this.cobbLine1Start,
          line1End: this.cobbLine1End,
          line2Start: start,
          line2End: end,
          mid1: geom.mid1,
          mid2: geom.mid2,
          intersection: geom.intersection,
          angle: geom.angle
        });

        this.interactionStep = 0;
        this.cobbLine1Start = null;
        this.cobbLine1End = null;
      }
    }

    this.currentShape = null;
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

  formatDistance(dist) {
    if (!this.hasPixelSpacing) {
      return `${dist.toFixed(1)} px`;
    }
    if (dist >= 10) {
      const cm = dist / 10;
      return `${dist.toFixed(2)} mm (${cm.toFixed(2)} cm)`;
    }
    return `${dist.toFixed(2)} mm`;
  }

  formatArea(areaMm2) {
    if (!this.hasPixelSpacing) {
      return `Area: ${areaMm2.toFixed(1)} px²`;
    }
    if (areaMm2 >= 100) {
      const cm2 = areaMm2 / 100;
      return `Area: ${areaMm2.toFixed(1)} mm² (${cm2.toFixed(2)} cm²)`;
    }
    return `Area: ${areaMm2.toFixed(1)} mm²`;
  }

  calculateCobbAngle(p0, p1, p2, p3) {
    const v1 = { x: (p1.x - p0.x) * this.pixelSpacing.x, y: (p1.y - p0.y) * this.pixelSpacing.y };
    const v2 = { x: (p3.x - p2.x) * this.pixelSpacing.x, y: (p3.y - p2.y) * this.pixelSpacing.y };
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
    this.ctrMidTop = null;
    this.ctrMidBot = null;
    this.ctrHeartRight = null;
    this.ctrHeartLeft = null;
    this.ctrProjA = null;
    this.ctrProjB = null;
    this.ctrDistA = 0;
    this.ctrDistB = 0;
    this.cobbLine1Start = null;
    this.cobbLine1End = null;
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

    this.serverWindowWidth = this.windowWidth;
    this.serverWindowCenter = this.windowCenter;
    this.isCustomWl = false;
    this.presetActive = true;
    this.clientWindowWidth  = this.windowWidth;
    this.clientWindowCenter = this.windowCenter;
    this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
    this.triggerStateChange();
  }

  reset() {
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.isCustomWl = false;
    this.presetActive = false;
    this.wlStartPos = null;
    // Restore original DICOM WW/WC
    this.windowWidth  = this.originalWindowWidth;
    this.windowCenter = this.originalWindowCenter;
    this.clientWindowWidth  = this.originalWindowWidth;
    this.clientWindowCenter = this.originalWindowCenter;
    this.invert = false;
    this.clearAnnotations();
    this.fitToScreen();
    this.loadSlice(this.currentSliceIndex, this.currentFrameIndex);
    this.triggerStateChange();
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
    if (this.isCustomWl) {
      const baseWW = this.presetActive ? this.serverWindowWidth : (this.originalWindowWidth || 400);
      const baseWC = this.presetActive ? this.serverWindowCenter : (this.originalWindowCenter || 40);
      const cr = baseWW / Math.max(1, this.windowWidth);
      const bo = (baseWC - this.windowCenter) / baseWW;
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
    const img2Canvas = (x, y) => this.imageToCanvas(x, y);
    const fmtDist   = (d) => this.formatDistance(d);
    const fmtArea   = (a) => this.formatArea(a);
    const calcDist  = (p1, p2) => this.calculateDistance(p1, p2);

    for (const ann of this.annotations) {
      switch (ann.type) {
        case 'line':    renderLine(this.ctx, ann, img2Canvas, fmtDist, calcDist); break;
        case 'ellipse': renderEllipse(this.ctx, ann, this.zoom, this.pixelSpacing, img2Canvas, fmtArea); break;
        case 'circle':  renderCircle(this.ctx, ann, this.zoom, this.pixelSpacing, img2Canvas, fmtArea);  break;
        case 'text':    renderText(this.ctx, ann, img2Canvas); break;
        case 'ctr':     renderCtr(this.ctx, ann, img2Canvas, fmtDist); break;
        case 'cobb':    renderCobb(this.ctx, ann, img2Canvas); break;
      }
    }

    // In-progress CTR & Cobb previews
    const ctrState = {
      ctrMidTop: this.ctrMidTop,
      ctrMidBot: this.ctrMidBot,
      ctrProjA: this.ctrProjA,
      ctrHeartRight: this.ctrHeartRight,
      ctrProjB: this.ctrProjB,
      ctrHeartLeft: this.ctrHeartLeft,
      pixelSpacing: this.pixelSpacing
    };

    const cobbState = {
      cobbLine1Start: this.cobbLine1Start,
      cobbLine1End: this.cobbLine1End,
      pixelSpacing: this.pixelSpacing
    };

    if (this.activeTool === 'ctr' && (this.interactionStep > 0 || (this.currentShape && this.currentShape.type.startsWith('ctr-')))) {
      renderCtrDragPreview(this.ctx, this.currentShape, this.interactionStep, ctrState, img2Canvas, fmtDist, calcDist);
    } else if (this.activeTool === 'cobb' && (this.interactionStep > 0 || (this.currentShape && this.currentShape.type.startsWith('cobb-')))) {
      renderCobbDragPreview(this.ctx, this.currentShape, this.interactionStep, cobbState, img2Canvas);
    } else if (this.currentShape) {
      switch (this.currentShape.type) {
        case 'line':    renderLine(this.ctx, this.currentShape, img2Canvas, fmtDist, calcDist); break;
        case 'ellipse': renderEllipse(this.ctx, this.currentShape, this.zoom, this.pixelSpacing, img2Canvas, fmtArea); break;
        case 'circle':  renderCircle(this.ctx, this.currentShape, this.zoom, this.pixelSpacing, img2Canvas, fmtArea);  break;
      }
    }

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
    const label = this.formatDistance(dist);
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
    const label   = this.formatArea(area);

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
    const areaX = ann.r * this.pixelSpacing.x;
    const areaY = ann.r * this.pixelSpacing.y;
    const area  = Math.PI * areaX * areaY;
    const label = this.formatArea(area);

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

  renderCtrDragPreview(shape) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 11px monospace';

    // Draw completed Midline if step >= 1
    if (this.interactionStep >= 1 && this.ctrMidTop && this.ctrMidBot) {
      const cMT = this.imageToCanvas(this.ctrMidTop.x, this.ctrMidTop.y);
      const cMB = this.imageToCanvas(this.ctrMidBot.x, this.ctrMidBot.y);
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(cMT.x, cMT.y); ctx.lineTo(cMB.x, cMB.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw completed Line A if step >= 2
    if (this.interactionStep >= 2 && this.ctrProjA && this.ctrHeartRight) {
      const cPA = this.imageToCanvas(this.ctrProjA.x, this.ctrProjA.y);
      const cHR = this.imageToCanvas(this.ctrHeartRight.x, this.ctrHeartRight.y);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cPA.x, cPA.y); ctx.lineTo(cHR.x, cHR.y); ctx.stroke();
    }

    // Draw completed Line B if step >= 3
    if (this.interactionStep >= 3 && this.ctrProjB && this.ctrHeartLeft) {
      const cPB = this.imageToCanvas(this.ctrProjB.x, this.ctrProjB.y);
      const cHL = this.imageToCanvas(this.ctrHeartLeft.x, this.ctrHeartLeft.y);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cPB.x, cPB.y); ctx.lineTo(cHL.x, cHL.y); ctx.stroke();
    }

    // Draw current dragging line
    const cS = this.imageToCanvas(shape.start.x, shape.start.y);
    const cE = this.imageToCanvas(shape.end.x, shape.end.y);

    if (shape.type === 'ctr-midline') {
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (shape.type === 'ctr-lineA' || shape.type === 'ctr-lineB') {
      const res = this.projectPointToMidline(shape.end, this.ctrMidTop, this.ctrMidBot);
      const cP = this.imageToCanvas(res.projPx.x, res.projPx.y);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cP.x, cP.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();

      const label = shape.type === 'ctr-lineA' ? `A: ${this.formatDistance(res.dist)}` : `B: ${this.formatDistance(res.dist)}`;
      ctx.fillStyle = '#ef4444';
      ctx.textAlign = 'center';
      ctx.fillText(label, (cP.x + cE.x) / 2, (cP.y + cE.y) / 2 - 4);
    } else if (shape.type === 'ctr-lineC') {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
      const dist = this.calculateDistance(shape.start, shape.end);
      const label = `C: ${this.formatDistance(dist)}`;
      ctx.fillStyle = '#facc15';
      ctx.textAlign = 'center';
      ctx.fillText(label, (cS.x + cE.x) / 2, (cS.y + cE.y) / 2 - 4);
    }

    ctx.restore();
  }

  renderCtr(ann) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = 'bold 11px monospace';

    const cMT = this.imageToCanvas(ann.midTop.x, ann.midTop.y);
    const cMB = this.imageToCanvas(ann.midBot.x, ann.midBot.y);

    // 1. Midline (Purple #c084fc)
    const dxM = cMB.x - cMT.x;
    const dyM = cMB.y - cMT.y;
    const lenM = Math.sqrt(dxM * dxM + dyM * dyM);
    const ext = 40;
    const uX = lenM > 0 ? dxM / lenM : 0;
    const uY = lenM > 0 ? dyM / lenM : 1;

    const cMT_ext = { x: cMT.x - uX * ext, y: cMT.y - uY * ext };
    const cMB_ext = { x: cMB.x + uX * ext, y: cMB.y + uY * ext };

    ctx.strokeStyle = '#c084fc';
    ctx.fillStyle = '#c084fc';
    ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(cMT_ext.x, cMT_ext.y); ctx.lineTo(cMB_ext.x, cMB_ext.y); ctx.stroke();
    ctx.setLineDash([]);
    [cMT, cMB].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
    });

    // 2. Line A (Red #ef4444)
    const cPA = this.imageToCanvas(ann.projA.x, ann.projA.y);
    const cHR = this.imageToCanvas(ann.heartRight.x, ann.heartRight.y);
    ctx.strokeStyle = '#ef4444';
    ctx.fillStyle = '#ef4444';
    ctx.beginPath(); ctx.moveTo(cPA.x, cPA.y); ctx.lineTo(cHR.x, cHR.y); ctx.stroke();
    [cPA, cHR].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
    });
    const labelA = `A: ${this.formatDistance(ann.distA)}`;
    const midAX = (cPA.x + cHR.x) / 2;
    const midAY = (cPA.y + cHR.y) / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const twA = ctx.measureText(labelA).width;
    ctx.fillRect(midAX - twA / 2 - 4, midAY - 14, twA + 8, 14);
    ctx.fillStyle = '#ef4444';
    ctx.fillText(labelA, midAX, midAY - 3);

    // 3. Line B (Red #ef4444)
    const cPB = this.imageToCanvas(ann.projB.x, ann.projB.y);
    const cHL = this.imageToCanvas(ann.heartLeft.x, ann.heartLeft.y);
    ctx.strokeStyle = '#ef4444';
    ctx.fillStyle = '#ef4444';
    ctx.beginPath(); ctx.moveTo(cPB.x, cPB.y); ctx.lineTo(cHL.x, cHL.y); ctx.stroke();
    [cPB, cHL].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
    });
    const labelB = `B: ${this.formatDistance(ann.distB)}`;
    const midBX = (cPB.x + cHL.x) / 2;
    const midBY = (cPB.y + cHL.y) / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const twB = ctx.measureText(labelB).width;
    ctx.fillRect(midBX - twB / 2 - 4, midBY - 14, twB + 8, 14);
    ctx.fillStyle = '#ef4444';
    ctx.fillText(labelB, midBX, midBY - 3);

    // 4. Line C (Yellow #facc15)
    const cCL = this.imageToCanvas(ann.chestLeft.x, ann.chestLeft.y);
    const cCR = this.imageToCanvas(ann.chestRight.x, ann.chestRight.y);
    ctx.strokeStyle = '#facc15';
    ctx.fillStyle = '#facc15';
    ctx.beginPath(); ctx.moveTo(cCL.x, cCL.y); ctx.lineTo(cCR.x, cCR.y); ctx.stroke();
    [cCL, cCR].forEach(p => {
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
    });
    const labelC = `C: ${this.formatDistance(ann.distC)}`;
    const midCX = (cCL.x + cCR.x) / 2;
    const midCY = (cCL.y + cCR.y) / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const twC = ctx.measureText(labelC).width;
    ctx.fillRect(midCX - twC / 2 - 4, midCY + 4, twC + 8, 14);
    ctx.fillStyle = '#facc15';
    ctx.fillText(labelC, midCX, midCY + 15);

    // 5. CTR Concise Result Summary Badge
    const isNormal = ann.ctr <= 0.50;
    const color = isNormal ? '#22c55e' : '#ef4444';
    const statusText = isNormal ? 'Normal' : 'Kardiomegali';

    const line1 = `CTR: ${(ann.ctr * 100).toFixed(1)}% — ${statusText}`;
    const line2 = `A: ${this.formatDistance(ann.distA)} | B: ${this.formatDistance(ann.distB)} | C: ${this.formatDistance(ann.distC)}`;

    ctx.font = 'bold 12px monospace';
    const tw1 = ctx.measureText(line1).width;
    ctx.font = '11px monospace';
    const tw2 = ctx.measureText(line2).width;
    const boxW = Math.max(tw1, tw2) + 24;
    const boxH = 42;

    const midX = (cCL.x + cCR.x) / 2;
    const boxY = Math.max(16, Math.min(cMT.y, cMB.y) - 50);

    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(midX - boxW / 2, boxY, boxW, boxH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(midX - boxW / 2, boxY, boxW, boxH);

    ctx.textAlign = 'center';
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = color;
    ctx.fillText(line1, midX, boxY + 17);

    ctx.font = '11px monospace';
    ctx.fillStyle = '#e4e4e7';
    ctx.fillText(line2, midX, boxY + 33);

    ctx.restore();
  }

  renderCobb(ann) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = 'bold 12px monospace';

    const cL1S = this.imageToCanvas(ann.line1Start.x, ann.line1Start.y);
    const cL1E = this.imageToCanvas(ann.line1End.x,   ann.line1End.y);
    const cL2S = this.imageToCanvas(ann.line2Start.x, ann.line2Start.y);
    const cL2E = this.imageToCanvas(ann.line2End.x,   ann.line2End.y);
    const cM1  = this.imageToCanvas(ann.mid1.x,         ann.mid1.y);
    const cM2  = this.imageToCanvas(ann.mid2.x,         ann.mid2.y);
    const cI   = this.imageToCanvas(ann.intersection.x, ann.intersection.y);

    // 1. Line 1 (Superior Endplate) — Solid Orange #fb923c
    ctx.strokeStyle = '#fb923c';
    ctx.fillStyle = '#fb923c';
    ctx.beginPath(); ctx.moveTo(cL1S.x, cL1S.y); ctx.lineTo(cL1E.x, cL1E.y); ctx.stroke();

    // 2. Line 2 (Inferior Endplate) — Solid Orange #fdba74
    ctx.strokeStyle = '#fdba74';
    ctx.fillStyle = '#fdba74';
    ctx.beginPath(); ctx.moveTo(cL2S.x, cL2S.y); ctx.lineTo(cL2E.x, cL2E.y); ctx.stroke();

    // Endpoint dots
    [cL1S, cL1E, cL2S, cL2E].forEach(p => {
      ctx.fillStyle = '#fb923c';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
    });

    // 3. Perpendicular Dashed Extension Lines to Intersection
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);

    ctx.beginPath(); ctx.moveTo(cM1.x, cM1.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cM2.x, cM2.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
    ctx.setLineDash([]);

    // Intersection vertex dot
    ctx.fillStyle = '#fb923c';
    ctx.beginPath(); ctx.arc(cI.x, cI.y, 4, 0, 2 * Math.PI); ctx.fill();

    // 4. Cobb Angle Badge right at the intersection vertex
    const label = `Cobb: ${ann.angle.toFixed(1)}°`;
    const tw = ctx.measureText(label).width;

    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(cI.x - tw / 2 - 6, cI.y - 24, tw + 12, 18);
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 1;
    ctx.strokeRect(cI.x - tw / 2 - 6, cI.y - 24, tw + 12, 18);

    ctx.fillStyle = '#fb923c';
    ctx.textAlign = 'center';
    ctx.fillText(label, cI.x, cI.y - 11);

    ctx.restore();
  }

  renderCobbDragPreview(shape) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = 'bold 12px monospace';

    // Draw completed Line 1 if step >= 1
    if (this.interactionStep >= 1 && this.cobbLine1Start && this.cobbLine1End) {
      const cL1S = this.imageToCanvas(this.cobbLine1Start.x, this.cobbLine1Start.y);
      const cL1E = this.imageToCanvas(this.cobbLine1End.x,   this.cobbLine1End.y);
      ctx.strokeStyle = '#fb923c';
      ctx.fillStyle = '#fb923c';
      ctx.beginPath(); ctx.moveTo(cL1S.x, cL1S.y); ctx.lineTo(cL1E.x, cL1E.y); ctx.stroke();
      [cL1S, cL1E].forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
      });
    }

    // Draw current dragging shape
    if (shape) {
      const cS = this.imageToCanvas(shape.start.x, shape.start.y);
      const cE = this.imageToCanvas(shape.end.x, shape.end.y);

      if (shape.type === 'cobb-line1') {
        ctx.strokeStyle = '#fb923c';
        ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
      } else if (shape.type === 'cobb-line2' && this.cobbLine1Start && this.cobbLine1End) {
        ctx.strokeStyle = '#fdba74';
        ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();

        // Calculate live Cobb geometry
        const geom = this.calculateCobbGeometry(this.cobbLine1Start, this.cobbLine1End, shape.start, shape.end);
        const cM1 = this.imageToCanvas(geom.mid1.x, geom.mid1.y);
        const cM2 = this.imageToCanvas(geom.mid2.x, geom.mid2.y);
        const cI  = this.imageToCanvas(geom.intersection.x, geom.intersection.y);

        ctx.strokeStyle = '#fb923c';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(cM1.x, cM1.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cM2.x, cM2.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#fb923c';
        ctx.beginPath(); ctx.arc(cI.x, cI.y, 4, 0, 2 * Math.PI); ctx.fill();

        const label = `Cobb: ${geom.angle.toFixed(1)}°`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(cI.x - tw / 2 - 6, cI.y - 24, tw + 12, 18);
        ctx.fillStyle = '#fb923c';
        ctx.textAlign = 'center';
        ctx.fillText(label, cI.x, cI.y - 11);
      }
    }

    ctx.restore();
  }

  renderInteractionPoints() {
    const ctx    = this.ctx;
    const colors = this.activeTool === 'ctr'
      ? ['#c084fc', '#c084fc', '#ef4444', '#ef4444', '#facc15', '#facc15']
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

      // Connect pairs (0→1 for Midline, 4→5 for Thorax)
      if ((i === 1 || i === 5) && this.activeTool === 'ctr') {
        const cpPrev = this.imageToCanvas(this.interactionPoints[i - 1].x, this.interactionPoints[i - 1].y);
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(cpPrev.x, cpPrev.y); ctx.lineTo(cp.x, cp.y); ctx.stroke();
        ctx.setLineDash([]);
      } else if (i % 2 === 1 && this.activeTool !== 'ctr') {
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
        'Langkah 1: Klik & tahan tarik vertikal Midline sepanjang sternum/spine',
        'Langkah 2: Tarik Garis A dari tengah ke batas kanan jantung',
        'Langkah 3: Tarik Garis B dari tengah ke batas kiri jantung',
        'Langkah 4: Tarik Garis C dari iga kanan ke iga kiri',
      ],
      cobb: [
        'Langkah 1: Klik & tahan tarik Garis 1 (endplate superior)',
        'Langkah 2: Klik & tahan tarik Garis 2 (endplate inferior)',
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
        pixelSpacing:   this.pixelSpacing,
        hasPixelSpacing: this.hasPixelSpacing,
        pixelSpacingSource: this.pixelSpacingSource,
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
