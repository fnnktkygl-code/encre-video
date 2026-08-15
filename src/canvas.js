"use strict";

export function cloneCanvas(source) {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  c.getContext('2d').drawImage(source, 0, 0);
  return c;
}

export function getCanvasPoint(evt, overlayCanvas) {
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY
  };
}

export function drawBlurredRegion(destCtx, sourceCanvas, x, y, w, h, radius) {
  const pad = Math.ceil(radius * 1.5);
  const sx = Math.max(0, x - pad);
  const sy = Math.max(0, y - pad);
  const ex = Math.min(sourceCanvas.width, x + w + pad);
  const ey = Math.min(sourceCanvas.height, y + h + pad);
  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);

  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.filter = `blur(${radius}px)`;
  tctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  destCtx.drawImage(tmp, x - sx, y - sy, w, h, x, y, w, h);
}

export function drawPixelatedRegion(destCtx, sourceCanvas, x, y, w, h, blockSize) {
  const cols = Math.max(1, Math.round(w / blockSize));
  const rows = Math.max(1, Math.round(h / blockSize));

  const tmp = document.createElement('canvas');
  tmp.width = cols;
  tmp.height = rows;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, cols, rows);

  const prevSmoothing = destCtx.imageSmoothingEnabled;
  destCtx.imageSmoothingEnabled = false;
  destCtx.drawImage(tmp, 0, 0, cols, rows, x, y, w, h);
  destCtx.imageSmoothingEnabled = prevSmoothing;
}

export function applyToClippedRect(destCanvasOrCtx, sourceCanvas, x, y, w, h, mode, params) {
  let x2 = x + w;
  let y2 = y + h;
  x = Math.max(0, x);
  y = Math.max(0, y);
  x2 = Math.min(sourceCanvas.width, x2);
  y2 = Math.min(sourceCanvas.height, y2);
  w = x2 - x;
  h = y2 - y;
  if (w <= 0 || h <= 0) return;

  const ctx = (destCanvasOrCtx && typeof destCanvasOrCtx.getContext === 'function')
    ? destCanvasOrCtx.getContext('2d')
    : destCanvasOrCtx;

  if (!ctx) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (mode === 'redact') {
    ctx.fillStyle = params.color || '#000000';
    ctx.fillRect(x, y, w, h);
  } else if (mode === 'blur') {
    drawBlurredRegion(ctx, sourceCanvas, x, y, w, h, params.blurRadius || 20);
  } else {
    drawPixelatedRegion(ctx, sourceCanvas, x, y, w, h, params.pixelSize || 16);
  }
  ctx.restore();
}

export function applyToClippedOval(destCanvasOrCtx, sourceCanvas, cx, cy, rx, ry, mode, params) {
  const maxW = sourceCanvas.width;
  const maxH = sourceCanvas.height;
  const x = Math.max(0, cx - rx);
  const y = Math.max(0, cy - ry);
  const w = Math.min(maxW, cx + rx) - x;
  const h = Math.min(maxH, cy + ry) - y;
  if (w <= 0 || h <= 0) return;

  const ctx = (destCanvasOrCtx && typeof destCanvasOrCtx.getContext === 'function')
    ? destCanvasOrCtx.getContext('2d')
    : destCanvasOrCtx;

  if (!ctx) return;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();

  if (mode === 'redact') {
    ctx.fillStyle = params.color || '#000000';
    ctx.fillRect(x, y, w, h);
  } else if (mode === 'blur') {
    drawBlurredRegion(ctx, sourceCanvas, x, y, w, h, params.blurRadius || 20);
  } else {
    drawPixelatedRegion(ctx, sourceCanvas, x, y, w, h, params.pixelSize || 16);
  }
  ctx.restore();
}

export function getHandleCoordinates(shape) {
  const { x, y, w, h } = shape;
  const midX = x + w / 2;
  const midY = y + h / 2;
  return {
    nw: { x: x, y: y },
    n:  { x: midX, y: y },
    ne: { x: x + w, y: y },
    e:  { x: x + w, y: midY },
    se: { x: x + w, y: y + h },
    s:  { x: midX, y: y + h },
    sw: { x: x, y: y + h },
    w:  { x: x, y: midY }
  };
}

export function getHandleAtPoint(pt, shape, zoom) {
  if (!shape) return null;
  const handles = getHandleCoordinates(shape);
  const hitRadius = Math.max(14, 20 / zoom);

  for (const [key, hPt] of Object.entries(handles)) {
    if (Math.hypot(pt.x - hPt.x, pt.y - hPt.y) <= hitRadius) {
      return key;
    }
  }

  if (pt.x >= shape.x && pt.x <= shape.x + shape.w && pt.y >= shape.y && pt.y <= shape.y + shape.h) {
    return 'body';
  }

  return null;
}

export function drawInteractiveShape(overlayCtx, sourceCanvas, shape, zoom) {
  if (!shape || shape.w <= 0 || shape.h <= 0) return;
  const { type, x, y, w, h, mode } = shape;

  if (type === 'rect') {
    applyToClippedRect(overlayCtx.canvas, sourceCanvas, x, y, w, h, mode, shape);
  } else if (type === 'oval') {
    applyToClippedOval(overlayCtx.canvas, sourceCanvas, x + w / 2, y + h / 2, w / 2, h / 2, mode, shape);
  }

  overlayCtx.save();
  const lineWidth = Math.max(1.5, 2.5 / zoom);
  const dashLength = Math.max(4, 7 / zoom);

  overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  overlayCtx.lineWidth = lineWidth;
  overlayCtx.setLineDash([dashLength, dashLength * 0.7]);

  if (type === 'rect') {
    overlayCtx.strokeRect(x, y, w, h);
  } else if (type === 'oval') {
    overlayCtx.beginPath();
    overlayCtx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    overlayCtx.stroke();
  }

  overlayCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  overlayCtx.setLineDash([]);
  overlayCtx.lineWidth = Math.max(0.5, lineWidth / 2);
  if (type === 'rect') {
    overlayCtx.strokeRect(x, y, w, h);
  } else if (type === 'oval') {
    overlayCtx.stroke();
  }

  const handles = getHandleCoordinates(shape);
  const handleRadius = Math.max(5, 8 / zoom);

  for (const hPt of Object.values(handles)) {
    overlayCtx.beginPath();
    overlayCtx.arc(hPt.x, hPt.y, handleRadius, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#FFFFFF';
    overlayCtx.fill();
    overlayCtx.lineWidth = Math.max(1, 2 / zoom);
    overlayCtx.strokeStyle = '#C1443B';
    overlayCtx.stroke();
  }

  overlayCtx.restore();
}

export function triggerHaptic() {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(10); } catch (e) {}
  }
}
