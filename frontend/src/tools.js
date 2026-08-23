// AetherDICOM Viewer - Medical Measurement & Annotation Tools Module

/**
 * Projects a point onto a midline defined by midTop and midBot in physical space
 */
export function projectPointToMidline(pt, midTop, midBot, pixelSpacing) {
  const sx = pixelSpacing.x || 1.0;
  const sy = pixelSpacing.y || 1.0;

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

/**
 * Calculates physical 2D Cobb Angle geometry, midpoints, and perpendicular intersection vertex
 */
export function calculateCobbGeometry(p0, p1, p2, p3, pixelSpacing) {
  const sx = pixelSpacing.x || 1.0;
  const sy = pixelSpacing.y || 1.0;

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

// ─── Visual Renderers ──────────────────────────────────────────────────────────

export function renderLine(ctx, ann, imageToCanvas, formatDistance, calculateDistance) {
  const cS   = imageToCanvas(ann.start.x, ann.start.y);
  const cE   = imageToCanvas(ann.end.x,   ann.end.y);
  const dist = calculateDistance(ann.start, ann.end);
  const label = formatDistance(dist);

  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();

  [cS, cE].forEach(p => {
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fill();
  });

  const midX = (cS.x + cE.x) / 2;
  const midY = (cS.y + cE.y) / 2;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(midX - tw / 2 - 4, midY - 14, tw + 8, 14);
  ctx.fillStyle = '#22c55e';
  ctx.fillText(label, midX, midY - 3);
  ctx.restore();
}

export function renderEllipse(ctx, ann, zoom, pixelSpacing, imageToCanvas, formatArea) {
  const cC    = imageToCanvas(ann.center.x, ann.center.y);
  const rxC   = Math.max(1, ann.rx * zoom);
  const ryC   = Math.max(1, ann.ry * zoom);
  const areaX = ann.rx * pixelSpacing.x;
  const areaY = ann.ry * pixelSpacing.y;
  const area  = Math.PI * areaX * areaY;
  const label = formatArea(area);

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

export function renderCircle(ctx, ann, zoom, pixelSpacing, imageToCanvas, formatArea) {
  const cC    = imageToCanvas(ann.center.x, ann.center.y);
  const rC    = Math.max(1, ann.r * zoom);
  const areaX = ann.r * pixelSpacing.x;
  const areaY = ann.r * pixelSpacing.y;
  const area  = Math.PI * areaX * areaY;
  const label = formatArea(area);

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

export function renderText(ctx, ann, imageToCanvas) {
  const cPos = imageToCanvas(ann.pos.x, ann.pos.y);

  ctx.save();
  ctx.font = 'bold 13px sans-serif';
  const tw = ctx.measureText(ann.text).width;

  ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.arc(cPos.x, cPos.y, 4, 0, 2 * Math.PI); ctx.fill();

  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(cPos.x, cPos.y);
  ctx.lineTo(cPos.x + 16, cPos.y - 16);
  ctx.stroke();

  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(cPos.x + 12, cPos.y - 32, tw + 12, 20);

  ctx.fillStyle   = '#fbbf24';
  ctx.textAlign   = 'left';
  ctx.fillText(ann.text, cPos.x + 18, cPos.y - 16);
  ctx.restore();
}

export function renderCtr(ctx, ann, imageToCanvas, formatDistance) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = 'bold 11px monospace';

  const cMT = imageToCanvas(ann.midTop.x, ann.midTop.y);
  const cMB = imageToCanvas(ann.midBot.x, ann.midBot.y);

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

  // Line A
  const cPA = imageToCanvas(ann.projA.x, ann.projA.y);
  const cHR = imageToCanvas(ann.heartRight.x, ann.heartRight.y);
  ctx.strokeStyle = '#ef4444';
  ctx.fillStyle = '#ef4444';
  ctx.beginPath(); ctx.moveTo(cPA.x, cPA.y); ctx.lineTo(cHR.x, cHR.y); ctx.stroke();
  [cPA, cHR].forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
  });
  const labelA = `A: ${formatDistance(ann.distA)}`;
  const midAX = (cPA.x + cHR.x) / 2;
  const midAY = (cPA.y + cHR.y) / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  const twA = ctx.measureText(labelA).width;
  ctx.fillRect(midAX - twA / 2 - 4, midAY - 14, twA + 8, 14);
  ctx.fillStyle = '#ef4444';
  ctx.fillText(labelA, midAX, midAY - 3);

  // Line B
  const cPB = imageToCanvas(ann.projB.x, ann.projB.y);
  const cHL = imageToCanvas(ann.heartLeft.x, ann.heartLeft.y);
  ctx.strokeStyle = '#ef4444';
  ctx.fillStyle = '#ef4444';
  ctx.beginPath(); ctx.moveTo(cPB.x, cPB.y); ctx.lineTo(cHL.x, cHL.y); ctx.stroke();
  [cPB, cHL].forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
  });
  const labelB = `B: ${formatDistance(ann.distB)}`;
  const midBX = (cPB.x + cHL.x) / 2;
  const midBY = (cPB.y + cHL.y) / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  const twB = ctx.measureText(labelB).width;
  ctx.fillRect(midBX - twB / 2 - 4, midBY - 14, twB + 8, 14);
  ctx.fillStyle = '#ef4444';
  ctx.fillText(labelB, midBX, midBY - 3);

  // Line C
  const cCL = imageToCanvas(ann.chestLeft.x, ann.chestLeft.y);
  const cCR = imageToCanvas(ann.chestRight.x, ann.chestRight.y);
  ctx.strokeStyle = '#facc15';
  ctx.fillStyle = '#facc15';
  ctx.beginPath(); ctx.moveTo(cCL.x, cCL.y); ctx.lineTo(cCR.x, cCR.y); ctx.stroke();
  [cCL, cCR].forEach(p => {
    ctx.beginPath(); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI); ctx.fill();
  });
  const labelC = `C: ${formatDistance(ann.distC)}`;
  const midCX = (cCL.x + cCR.x) / 2;
  const midCY = (cCL.y + cCR.y) / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  const twC = ctx.measureText(labelC).width;
  ctx.fillRect(midCX - twC / 2 - 4, midCY + 4, twC + 8, 14);
  ctx.fillStyle = '#facc15';
  ctx.fillText(labelC, midCX, midCY + 15);

  // Summary Badge
  const isNormal = ann.ctr <= 0.50;
  const color = isNormal ? '#22c55e' : '#ef4444';
  const statusText = isNormal ? 'Normal' : 'Kardiomegali';

  const line1 = `CTR: ${(ann.ctr * 100).toFixed(1)}% — ${statusText}`;
  const line2 = `A: ${formatDistance(ann.distA)} | B: ${formatDistance(ann.distB)} | C: ${formatDistance(ann.distC)}`;

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

export function renderCtrDragPreview(ctx, shape, interactionStep, state, imageToCanvas, formatDistance, calculateDistance) {
  ctx.save();
  ctx.font = 'bold 11px monospace';

  if (interactionStep >= 1 && state.ctrMidTop && state.ctrMidBot) {
    const cMT = imageToCanvas(state.ctrMidTop.x, state.ctrMidTop.y);
    const cMB = imageToCanvas(state.ctrMidBot.x, state.ctrMidBot.y);
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath(); ctx.moveTo(cMT.x, cMT.y); ctx.lineTo(cMB.x, cMB.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (interactionStep >= 2 && state.ctrProjA && state.ctrHeartRight) {
    const cPA = imageToCanvas(state.ctrProjA.x, state.ctrProjA.y);
    const cHR = imageToCanvas(state.ctrHeartRight.x, state.ctrHeartRight.y);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cPA.x, cPA.y); ctx.lineTo(cHR.x, cHR.y); ctx.stroke();
  }

  if (interactionStep >= 3 && state.ctrProjB && state.ctrHeartLeft) {
    const cPB = imageToCanvas(state.ctrProjB.x, state.ctrProjB.y);
    const cHL = imageToCanvas(state.ctrHeartLeft.x, state.ctrHeartLeft.y);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cPB.x, cPB.y); ctx.lineTo(cHL.x, cHL.y); ctx.stroke();
  }

  if (shape) {
    const cS = imageToCanvas(shape.start.x, shape.start.y);
    const cE = imageToCanvas(shape.end.x, shape.end.y);

    if (shape.type === 'ctr-midline') {
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (shape.type === 'ctr-lineA' || shape.type === 'ctr-lineB') {
      const res = projectPointToMidline(shape.end, state.ctrMidTop, state.ctrMidBot, state.pixelSpacing);
      const cP = imageToCanvas(res.projPx.x, res.projPx.y);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cP.x, cP.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();

      const label = shape.type === 'ctr-lineA' ? `A: ${formatDistance(res.dist)}` : `B: ${formatDistance(res.dist)}`;
      ctx.fillStyle = '#ef4444';
      ctx.textAlign = 'center';
      ctx.fillText(label, (cP.x + cE.x) / 2, (cP.y + cE.y) / 2 - 4);
    } else if (shape.type === 'ctr-lineC') {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
      const dist = calculateDistance(shape.start, shape.end);
      const label = `C: ${formatDistance(dist)}`;
      ctx.fillStyle = '#facc15';
      ctx.textAlign = 'center';
      ctx.fillText(label, (cS.x + cE.x) / 2, (cS.y + cE.y) / 2 - 4);
    }
  }

  ctx.restore();
}

export function renderCobb(ctx, ann, imageToCanvas) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = 'bold 12px monospace';

  const cL1S = imageToCanvas(ann.line1Start.x, ann.line1Start.y);
  const cL1E = imageToCanvas(ann.line1End.x,   ann.line1End.y);
  const cL2S = imageToCanvas(ann.line2Start.x, ann.line2Start.y);
  const cL2E = imageToCanvas(ann.line2End.x,   ann.line2End.y);
  const cM1  = imageToCanvas(ann.mid1.x,         ann.mid1.y);
  const cM2  = imageToCanvas(ann.mid2.x,         ann.mid2.y);
  const cI   = imageToCanvas(ann.intersection.x, ann.intersection.y);

  // Line 1
  ctx.strokeStyle = '#fb923c';
  ctx.fillStyle = '#fb923c';
  ctx.beginPath(); ctx.moveTo(cL1S.x, cL1S.y); ctx.lineTo(cL1E.x, cL1E.y); ctx.stroke();

  // Line 2
  ctx.strokeStyle = '#fdba74';
  ctx.fillStyle = '#fdba74';
  ctx.beginPath(); ctx.moveTo(cL2S.x, cL2S.y); ctx.lineTo(cL2E.x, cL2E.y); ctx.stroke();

  // Endpoint dots
  [cL1S, cL1E, cL2S, cL2E].forEach(p => {
    ctx.fillStyle = '#fb923c';
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
  });

  // Perpendicular Dashed Extension Lines
  ctx.strokeStyle = '#fb923c';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);

  ctx.beginPath(); ctx.moveTo(cM1.x, cM1.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cM2.x, cM2.y); ctx.lineTo(cI.x, cI.y); ctx.stroke();
  ctx.setLineDash([]);

  // Intersection vertex dot
  ctx.fillStyle = '#fb923c';
  ctx.beginPath(); ctx.arc(cI.x, cI.y, 4, 0, 2 * Math.PI); ctx.fill();

  // Angle Badge at vertex
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

export function renderCobbDragPreview(ctx, shape, interactionStep, state, imageToCanvas) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = 'bold 12px monospace';

  if (interactionStep >= 1 && state.cobbLine1Start && state.cobbLine1End) {
    const cL1S = imageToCanvas(state.cobbLine1Start.x, state.cobbLine1Start.y);
    const cL1E = imageToCanvas(state.cobbLine1End.x,   state.cobbLine1End.y);
    ctx.strokeStyle = '#fb923c';
    ctx.fillStyle = '#fb923c';
    ctx.beginPath(); ctx.moveTo(cL1S.x, cL1S.y); ctx.lineTo(cL1E.x, cL1E.y); ctx.stroke();
    [cL1S, cL1E].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI); ctx.fill();
    });
  }

  if (shape) {
    const cS = imageToCanvas(shape.start.x, shape.start.y);
    const cE = imageToCanvas(shape.end.x, shape.end.y);

    if (shape.type === 'cobb-line1') {
      ctx.strokeStyle = '#fb923c';
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();
    } else if (shape.type === 'cobb-line2' && state.cobbLine1Start && state.cobbLine1End) {
      ctx.strokeStyle = '#fdba74';
      ctx.beginPath(); ctx.moveTo(cS.x, cS.y); ctx.lineTo(cE.x, cE.y); ctx.stroke();

      const geom = calculateCobbGeometry(state.cobbLine1Start, state.cobbLine1End, shape.start, shape.end, state.pixelSpacing);
      const cM1 = imageToCanvas(geom.mid1.x, geom.mid1.y);
      const cM2 = imageToCanvas(geom.mid2.x, geom.mid2.y);
      const cI  = imageToCanvas(geom.intersection.x, geom.intersection.y);

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
