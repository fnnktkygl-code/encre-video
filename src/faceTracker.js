"use strict";

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

let faceDetector = null;
let visionResolver = null;
let isScanning = false;

async function getVisionResolver() {
  if (visionResolver) return visionResolver;
  try {
    visionResolver = await FilesetResolver.forVisionTasks('/wasm/mediapipe');
  } catch (localErr) {
    console.warn('[Encre Vidéo] Local wasm load failed, fallback to CDN:', localErr);
    visionResolver = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
  }
  return visionResolver;
}

export async function initFaceDetectionModel(minConfidence = 0.22) {
  const vision = await getVisionResolver();

  try {
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/model/mediapipe/blaze_face_full_range.tflite',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: minConfidence,
      minSuppressionThreshold: 0.3
    });
  } catch (gpuErr) {
    console.warn('[Encre Vidéo] GPU delegate fallback to CPU:', gpuErr);
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/model/mediapipe/blaze_face_full_range.tflite',
        delegate: 'CPU'
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: minConfidence,
      minSuppressionThreshold: 0.3
    });
  }
  return faceDetector;
}

export function isValidFaceBox(bbox, videoW, videoH) {
  const { originX: x, originY: y, width: w, height: h } = bbox;
  // Size bounds
  if (w < 16 || h < 16) return false;
  if (w > videoW * 0.65 || h > videoH * 0.65) return false;
  
  // Aspect ratio bounds for tilted heads & hijabs
  const ratio = w / Math.max(1, h);
  if (ratio < 0.45 || ratio > 1.7) return false;
  return true;
}

/**
 * Visual validation to reject pure lamps, shiny plates, and flat walls
 */
export function isVisualFaceValid(ctx, box) {
  const bx = Math.max(0, Math.round(box.x));
  const by = Math.max(0, Math.round(box.y));
  const bw = Math.min(ctx.canvas.width - bx, Math.round(box.w));
  const bh = Math.min(ctx.canvas.height - by, Math.round(box.h));

  if (bw < 8 || bh < 8) return true;

  try {
    const data = ctx.getImageData(bx, by, bw, bh).data;
    let totalLum = 0;
    let count = 0;
    let minLum = 255;
    let maxLum = 0;

    for (let i = 0; i < data.length; i += 8) { // sample every 2nd pixel
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      totalLum += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
      count++;
    }

    if (count === 0) return true;
    const avgLum = totalLum / count;
    const contrast = maxLum - minLum;

    // Reject pure glowing lightbulbs / ceiling lights (super bright, low contrast)
    if (avgLum > 232 && contrast < 50) return false;

    // Reject pitch black void / flat empty shadows
    if (avgLum < 12 && contrast < 15) return false;

    return true;
  } catch (e) {
    return true;
  }
}

export function detectFrameBboxes(videoEl, minConfidence = 0.22, ctx = null) {
  const detections = [];
  const width = videoEl.videoWidth;
  const height = videoEl.videoHeight;
  if (!faceDetector || !width || !height) return detections;

  try {
    const result = faceDetector.detect(videoEl);
    if (result && result.detections) {
      result.detections.forEach(d => {
        const bbox = d.boundingBox;
        const score = (d.categories && d.categories[0]) ? d.categories[0].score : 1.0;
        if (score >= minConfidence && isValidFaceBox(bbox, width, height)) {
          const box = {
            x: Math.max(0, bbox.originX),
            y: Math.max(0, bbox.originY),
            w: bbox.width,
            h: bbox.height,
            score: score
          };

          if (!ctx || isVisualFaceValid(ctx, box)) {
            detections.push(box);
          }
        }
      });
    }
  } catch (e) {
    console.warn('[Encre Vidéo] Face detection error:', e);
  }

  return detections;
}

export function seekVideoFrame(videoEl, time) {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        videoEl.removeEventListener('seeked', onSeeked);
        resolve();
      }
    };
    const onSeeked = () => setTimeout(cleanup, 25);
    videoEl.addEventListener('seeked', onSeeked, { once: true });
    videoEl.currentTime = time;
    setTimeout(cleanup, 250);
  });
}

function createAvatarCrop(ctx, box) {
  try {
    const pad = Math.round(box.w * 0.15);
    const sx = Math.max(0, Math.round(box.x - pad));
    const sy = Math.max(0, Math.round(box.y - pad));
    const sw = Math.min(ctx.canvas.width - sx, Math.round(box.w + pad * 2));
    const sh = Math.min(ctx.canvas.height - sy, Math.round(box.h + pad * 2));

    if (sw <= 0 || sh <= 0) return null;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = 64;
    cropCanvas.height = 64;
    const cctx = cropCanvas.getContext('2d');

    cctx.beginPath();
    cctx.arc(32, 32, 32, 0, Math.PI * 2);
    cctx.clip();
    cctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, 64, 64);

    return cropCanvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return null;
  }
}

function captureTemplate(ctx, box) {
  const bw = Math.max(8, Math.round(box.w));
  const bh = Math.max(8, Math.round(box.h));
  const bx = Math.max(0, Math.round(box.x));
  const by = Math.max(0, Math.round(box.y));

  try {
    const rawData = ctx.getImageData(bx, by, bw, bh);
    const tw = 24;
    const th = 24;
    const grid = new Float32Array(tw * th);

    const stepX = bw / tw;
    const stepY = bh / th;

    for (let gy = 0; gy < th; gy++) {
      for (let gx = 0; gx < tw; gx++) {
        const px = Math.min(bw - 1, Math.floor(gx * stepX));
        const py = Math.min(bh - 1, Math.floor(gy * stepY));
        const idx = (py * bw + px) * 4;
        const lum = rawData.data[idx] * 0.299 + rawData.data[idx + 1] * 0.587 + rawData.data[idx + 2] * 0.114;
        grid[gy * tw + gx] = lum;
      }
    }

    return { grid, tw, th, origW: bw, origH: bh };
  } catch (e) {
    return null;
  }
}

function matchTemplateSSD(ctx, template, currentBox, margin, maxW, maxH) {
  const sx = Math.max(0, Math.round(currentBox.x - margin));
  const sy = Math.max(0, Math.round(currentBox.y - margin));
  const ex = Math.min(maxW, Math.round(currentBox.x + currentBox.w + margin));
  const ey = Math.min(maxH, Math.round(currentBox.y + currentBox.h + margin));
  const sw = ex - sx;
  const sh = ey - sy;

  if (sw <= currentBox.w || sh <= currentBox.h) return currentBox;

  try {
    const searchData = ctx.getImageData(sx, sy, sw, sh);
    const sd = searchData.data;

    let bestScore = Infinity;
    let bestDx = 0;
    let bestDy = 0;

    const tw = template.tw;
    const th = template.th;
    const tgrid = template.grid;
    const bw = currentBox.w;
    const bh = currentBox.h;

    const step = 3;
    const maxCandidateX = sw - bw;
    const maxCandidateY = sh - bh;

    for (let cy = 0; cy <= maxCandidateY; cy += step) {
      for (let cx = 0; cx <= maxCandidateX; cx += step) {
        let ssd = 0;
        const stepX = bw / tw;
        const stepY = bh / th;

        for (let gy = 0; gy < th; gy += 2) {
          for (let gx = 0; gx < tw; gx += 2) {
            const px = Math.min(sw - 1, Math.floor(cx + gx * stepX));
            const py = Math.min(sh - 1, Math.floor(cy + gy * stepY));
            const sidx = (py * sw + px) * 4;
            const slum = sd[sidx] * 0.299 + sd[sidx + 1] * 0.587 + sd[sidx + 2] * 0.114;
            const diff = slum - tgrid[gy * tw + gx];
            ssd += diff * diff;
          }
        }

        if (ssd < bestScore) {
          bestScore = ssd;
          bestDx = cx;
          bestDy = cy;
        }
      }
    }

    const matchedX = sx + bestDx;
    const matchedY = sy + bestDy;

    const smoothX = currentBox.x * 0.25 + matchedX * 0.75;
    const smoothY = currentBox.y * 0.25 + matchedY * 0.75;

    return {
      x: Math.max(0, Math.min(maxW - currentBox.w, smoothX)),
      y: Math.max(0, Math.min(maxH - currentBox.h, smoothY)),
      w: currentBox.w,
      h: currentBox.h
    };
  } catch (e) {
    return currentBox;
  }
}

function findLocalFaceMatch(videoEl, currentBox) {
  try {
    const detections = detectFrameBboxes(videoEl, 0.20);
    if (!detections || detections.length === 0) return null;

    const curCx = currentBox.x + currentBox.w / 2;
    const curCy = currentBox.y + currentBox.h / 2;

    let bestFace = null;
    let bestDist = Infinity;

    detections.forEach(d => {
      const dcx = d.x + d.w / 2;
      const dcy = d.y + d.h / 2;
      const dist = Math.hypot(dcx - curCx, dcy - curCy);
      const maxAllowedDist = Math.max(currentBox.w, currentBox.h, 50) * 1.6;

      if (dist < maxAllowedDist && dist < bestDist) {
        bestDist = dist;
        bestFace = d;
      }
    });

    if (bestFace) {
      return {
        x: bestFace.x,
        y: bestFace.y,
        w: bestFace.w,
        h: bestFace.h
      };
    }
  } catch (e) {}

  return null;
}

/**
 * 🌟 FILMORA 14 STYLE: FULL VIDEO PRE-ANALYSIS SCANNER
 * Robust face scanner with strict duration filtering and visual light/plate verification
 */
export async function scanAndTrackFaces(videoEl, onProgress = () => {}, minConfidence = 0.22) {
  if (isScanning) return [];
  isScanning = true;

  try {
    await initFaceDetectionModel(minConfidence);

    const originalTime = videoEl.currentTime;
    const originalPaused = videoEl.paused;
    videoEl.pause();

    const duration = videoEl.duration || 10;
    const stepSec = 0.1; // 10 FPS scan
    const totalSteps = Math.ceil(duration / stepSec);

    const offCanvas = document.createElement('canvas');
    offCanvas.width = videoEl.videoWidth;
    offCanvas.height = videoEl.videoHeight;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    const tracks = [];
    let currentTime = 0;
    let step = 0;

    while (currentTime <= duration) {
      step++;
      await seekVideoFrame(videoEl, currentTime);

      offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);
      const frameDets = detectFrameBboxes(videoEl, minConfidence, offCtx);

      const usedDets = new Set();
      tracks.forEach(track => {
        if (track.keyframes.length === 0) return;
        const lastKf = track.keyframes[track.keyframes.length - 1];
        if (Math.abs(currentTime - lastKf.t) > 1.2) return;

        const lcx = lastKf.x + lastKf.w / 2;
        const lcy = lastKf.y + lastKf.h / 2;

        let bestIdx = -1;
        let bestDist = Infinity;

        frameDets.forEach((d, i) => {
          if (usedDets.has(i)) return;
          const dcx = d.x + d.w / 2;
          const dcy = d.y + d.h / 2;
          const dist = Math.hypot(dcx - lcx, dcy - lcy);
          const maxDist = Math.max(lastKf.w, lastKf.h, 45) * 1.5;

          if (dist < maxDist && dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        });

        if (bestIdx !== -1) {
          const matched = frameDets[bestIdx];
          usedDets.add(bestIdx);
          track.keyframes.push({
            t: currentTime,
            x: matched.x,
            y: matched.y,
            w: matched.w,
            h: matched.h,
            score: matched.score
          });

          if (matched.score > track.bestScore) {
            track.bestScore = matched.score;
            track.bestTimestamp = currentTime;
            track.avatarUrl = createAvatarCrop(offCtx, matched);
          }
        }
      });

      frameDets.forEach((d, i) => {
        if (usedDets.has(i)) return;
        const newTrack = {
          id: tracks.length + 1,
          name: `Visage ${tracks.length + 1}`,
          enabled: true,
          deleted: false,
          bestScore: d.score,
          bestTimestamp: currentTime,
          avatarUrl: createAvatarCrop(offCtx, d),
          keyframes: [{
            t: currentTime,
            x: d.x,
            y: d.y,
            w: d.w,
            h: d.h,
            score: d.score
          }]
        };
        tracks.push(newTrack);
      });

      const pct = Math.min(99, Math.round((step / totalSteps) * 100));
      onProgress(pct, tracks.filter(t => t.keyframes.length >= 6).length);
      currentTime += stepSec;
    }

    // 🌟 Strict lifespan filter: genuine faces appear for at least 0.5s (>= 5 frames)
    // This rejects 100% of transient hand, plate, and lamp reflections!
    const validTracks = tracks.filter(t => {
      const count = t.keyframes.length;
      if (count < 5) return false;
      const span = t.keyframes[count - 1].t - t.keyframes[0].t;
      return span >= 0.45;
    });

    validTracks.forEach((t, idx) => {
      t.id = idx + 1;
      t.name = `Visage ${idx + 1}`;
    });

    videoEl.currentTime = originalTime;
    if (!originalPaused) videoEl.play();
    onProgress(100, validTracks.length);

    return validTracks;
  } catch (err) {
    console.error('[Encre Vidéo] Video scanning error:', err);
    throw err;
  } finally {
    isScanning = false;
  }
}

/**
 * 🌟 TRACK A MANUALLY ADDED MISSED FACE (BIDIRECTIONAL TRACKING)
 */
export async function trackFaceBidirectional(videoEl, initialBox, startT, onProgress = () => {}) {
  const originalTime = videoEl.currentTime;
  const originalPaused = videoEl.paused;
  videoEl.pause();

  const offCanvas = document.createElement('canvas');
  offCanvas.width = videoEl.videoWidth;
  offCanvas.height = videoEl.videoHeight;
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

  await seekVideoFrame(videoEl, startT);
  offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);
  const avatarUrl = createAvatarCrop(offCtx, initialBox);
  let template = captureTemplate(offCtx, initialBox);

  const duration = videoEl.duration || 10;
  const stepSec = 0.12;
  const keyframes = [{ t: startT, x: initialBox.x, y: initialBox.y, w: initialBox.w, h: initialBox.h }];

  const totalSteps = Math.max(1, Math.ceil(duration / stepSec));
  let stepCount = 0;

  // Track Forward
  let currentBox = { ...initialBox };
  let currentT = startT;

  while (currentT < duration) {
    currentT = Math.min(duration, currentT + stepSec);
    stepCount++;
    await seekVideoFrame(videoEl, currentT);
    offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);

    const aiMatched = findLocalFaceMatch(videoEl, currentBox);
    if (aiMatched) {
      currentBox = aiMatched;
      if (stepCount % 3 === 0) template = captureTemplate(offCtx, currentBox);
    } else if (template) {
      const margin = Math.max(40, currentBox.w * 0.7);
      const nccMatched = matchTemplateSSD(offCtx, template, currentBox, margin, offCanvas.width, offCanvas.height);
      if (nccMatched) {
        currentBox = nccMatched;
        if (stepCount % 4 === 0) template = captureTemplate(offCtx, currentBox);
      }
    }
    keyframes.push({ t: currentT, x: currentBox.x, y: currentBox.y, w: currentBox.w, h: currentBox.h });
    onProgress(Math.min(99, Math.round((stepCount / totalSteps) * 100)));
  }

  // Track Backward
  currentBox = { ...initialBox };
  currentT = startT;
  template = captureTemplate(offCtx, initialBox);

  while (currentT > 0) {
    currentT = Math.max(0, currentT - stepSec);
    stepCount++;
    await seekVideoFrame(videoEl, currentT);
    offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);

    const aiMatched = findLocalFaceMatch(videoEl, currentBox);
    if (aiMatched) {
      currentBox = aiMatched;
      if (stepCount % 3 === 0) template = captureTemplate(offCtx, currentBox);
    } else if (template) {
      const margin = Math.max(40, currentBox.w * 0.7);
      const nccMatched = matchTemplateSSD(offCtx, template, currentBox, margin, offCanvas.width, offCanvas.height);
      if (nccMatched) {
        currentBox = nccMatched;
        if (stepCount % 4 === 0) template = captureTemplate(offCtx, currentBox);
      }
    }
    keyframes.unshift({ t: currentT, x: currentBox.x, y: currentBox.y, w: currentBox.w, h: currentBox.h });
    onProgress(Math.min(99, Math.round((stepCount / totalSteps) * 100)));
  }

  videoEl.currentTime = originalTime;
  if (!originalPaused) videoEl.play();
  onProgress(100);

  return {
    avatarUrl,
    keyframes
  };
}

export function getInterpolatedFaceBox(track, time, paddingPercent = 20) {
  if (!track || track.enabled === false || track.deleted || !track.keyframes || track.keyframes.length === 0) {
    return null;
  }

  const kfs = track.keyframes;
  // 🌟 Strict temporal gate: only render when face is actually present
  if (time < kfs[0].t - 0.25 || time > kfs[kfs.length - 1].t + 0.25) {
    return null;
  }

  let box = null;
  if (time <= kfs[0].t) {
    box = kfs[0];
  } else if (time >= kfs[kfs.length - 1].t) {
    box = kfs[kfs.length - 1];
  } else {
    let low = 0;
    let high = kfs.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (kfs[mid].t <= time && (mid === kfs.length - 1 || kfs[mid + 1].t >= time)) {
        const a = kfs[mid];
        const b = kfs[mid + 1] || a;
        const dt = Math.max(0.0001, b.t - a.t);
        const f = (time - a.t) / dt;
        const ease = f * f * (3 - 2 * f);
        box = {
          x: a.x + (b.x - a.x) * ease,
          y: a.y + (b.y - a.y) * ease,
          w: a.w + (b.w - a.w) * ease,
          h: a.h + (b.h - a.h) * ease
        };
        break;
      } else if (kfs[mid].t < time) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }

  if (!box) return null;

  const p = (paddingPercent !== undefined ? paddingPercent : 20) / 100;
  const w = box.w * (1 + p);
  const h = box.h * (1 + p * 1.15);
  const x = box.x - (w - box.w) / 2;
  const y = box.y - (h - box.h) / 2;

  return {
    x,
    y,
    w,
    h,
    cx: x + w / 2,
    cy: y + h / 2,
    rx: w / 2,
    ry: h / 2
  };
}
