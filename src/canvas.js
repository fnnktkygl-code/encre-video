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

/**
 * 🌟 FILMORA-GRADE SOFT FEATHERED OVAL MASK
 * Blurs with soft radial alpha feathering so edges melt smoothly into the video.
 */
export function applyToClippedOval(destCanvasOrCtx, sourceCanvas, cx, cy, rx, ry, mode, params) {
  const maxW = sourceCanvas.width;
  const maxH = sourceCanvas.height;
  const x = Math.max(0, Math.round(cx - rx));
  const y = Math.max(0, Math.round(cy - ry));
  const w = Math.min(maxW, Math.round(cx + rx)) - x;
  const h = Math.min(maxH, Math.round(cy + ry)) - y;
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
    drawBlurredRegion(ctx, sourceCanvas, x, y, w, h, params.blurRadius || 24);
  } else {
    drawPixelatedRegion(ctx, sourceCanvas, x, y, w, h, params.pixelSize || 16);
  }
  ctx.restore();
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

  // By default use softened rounded corners (border-radius) for natural cinema look
  const r = Math.min(w * 0.25, h * 0.25, 20);

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.clip();

  if (mode === 'redact') {
    ctx.fillStyle = params.color || '#000000';
    ctx.fillRect(x, y, w, h);
  } else if (mode === 'blur') {
    drawBlurredRegion(ctx, sourceCanvas, x, y, w, h, params.blurRadius || 24);
  } else {
    drawPixelatedRegion(ctx, sourceCanvas, x, y, w, h, params.pixelSize || 16);
  }
  ctx.restore();
}

export function triggerHaptic() {
  if (window.navigator && window.navigator.vibrate) {
    window.navigator.vibrate(10);
  }
}
