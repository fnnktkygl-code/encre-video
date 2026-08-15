"use strict";

import { detectFrameBboxes } from './faceTracker.js';

export function upsertKeyframe(track, t, x, y, w, h) {
  const eps = 0.08;
  const existing = track.keyframes.find(kf => Math.abs(kf.t - t) < eps);
  if (existing) {
    existing.x = x;
    existing.y = y;
    existing.w = w;
    existing.h = h;
  } else {
    track.keyframes.push({ t, x, y, w, h });
    track.keyframes.sort((a, b) => a.t - b.t);
  }
}

export function deleteKeyframe(track, t) {
  const eps = 0.1;
  track.keyframes = track.keyframes.filter(kf => Math.abs(kf.t - t) >= eps);
}

/**
 * 🌟 STRICT TEMPORAL INTERPOLATION
 * If the target has left the screen (t > last keyframe or t < first keyframe),
 * the blur IMMEDIATELY DISAPPEARS!
 */
export function interpolateTrack(track, t) {
  const kfs = track.keyframes;
  if (!kfs || kfs.length === 0) return null;

  // If outside track lifespan, DO NOT show the blur
  if (t < kfs[0].t - 0.25 || t > kfs[kfs.length - 1].t + 0.25) {
    return null;
  }

  if (t <= kfs[0].t) {
    return { x: kfs[0].x, y: kfs[0].y, w: kfs[0].w, h: kfs[0].h };
  }

  const last = kfs[kfs.length - 1];
  if (t >= last.t) {
    return { x: last.x, y: last.y, w: last.w, h: last.h };
  }

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const dt = Math.max(0.0001, b.t - a.t);
      const f = (t - a.t) / dt;
      const ease = f * f * (3 - 2 * f);
      return {
        x: a.x + (b.x - a.x) * ease,
        y: a.y + (b.y - a.y) * ease,
        w: a.w + (b.w - a.w) * ease,
        h: a.h + (b.h - a.h) * ease
      };
    }
  }

  return null;
}

/**
 * 🌟 High-Precision Optical Tracker with Auto-Disappearance Detection
 * Stops automatically when target leaves the frame or is occluded.
 */
export async function autoTrackForward(videoEl, track, startT, durationSec = 5, onProgress = () => {}) {
  if (!track || track.keyframes.length === 0) return;

  const initialBox = interpolateTrack(track, startT) || track.keyframes[track.keyframes.length - 1];
  if (!initialBox) return;

  const originalTime = videoEl.currentTime;
  const originalPaused = videoEl.paused;
  videoEl.pause();

  const offCanvas = document.createElement('canvas');
  offCanvas.width = videoEl.videoWidth;
  offCanvas.height = videoEl.videoHeight;
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

  await seekVideoFrame(videoEl, startT);
  offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);
  let template = captureTemplate(offCtx, initialBox);

  let currentBox = { ...initialBox };
  let currentT = startT;
  const step = 0.12; // 8.3 FPS sample rate
  const endT = Math.min(videoEl.duration || (startT + durationSec), startT + durationSec);
  const totalSteps = Math.max(1, Math.ceil((endT - startT) / step));
  let stepIdx = 0;
  let lostStreak = 0;

  try {
    while (currentT < endT) {
      currentT = Math.min(endT, currentT + step);
      stepIdx++;

      await seekVideoFrame(videoEl, currentT);
      offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);

      // 1. Try AI Face Matching in local neighborhood
      const aiMatchedBox = findLocalFaceMatch(videoEl, currentBox);

      if (aiMatchedBox) {
        currentBox = aiMatchedBox;
        lostStreak = 0;
        if (stepIdx % 3 === 0) {
          template = captureTemplate(offCtx, currentBox);
        }
      } else if (template) {
        // 2. Optical Correlation Template Match
        const margin = Math.max(40, currentBox.w * 0.75);
        const matchResult = matchTemplateWithQuality(offCtx, template, currentBox, margin, offCanvas.width, offCanvas.height);

        if (matchResult && matchResult.confidence > 0.45) {
          currentBox = matchResult.box;
          lostStreak = 0;
          if (stepIdx % 4 === 0) {
            template = captureTemplate(offCtx, currentBox);
          }
        } else {
          // Target lost or left the frame
          lostStreak++;
          // Check if at frame border
          const isAtBorder = currentBox.x <= 10 || (currentBox.x + currentBox.w >= offCanvas.width - 10) ||
                             currentBox.y <= 10 || (currentBox.y + currentBox.h >= offCanvas.height - 10);
          
          if (lostStreak >= 2 || isAtBorder) {
            // Target left the screen: STOP tracking!
            break;
          }
        }
      }

      // Save keyframe while target is visible
      upsertKeyframe(track, currentT, currentBox.x, currentBox.y, currentBox.w, currentBox.h);
      onProgress(Math.min(99, Math.round((stepIdx / totalSteps) * 100)));
    }
  } catch (e) {
    console.warn('[Encre Vidéo] Auto-tracking exception:', e);
  } finally {
    videoEl.currentTime = originalTime;
    if (!originalPaused) videoEl.play();
    onProgress(100);
  }
}

function seekVideoFrame(videoEl, time) {
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
      const maxAllowedDist = Math.max(currentBox.w, currentBox.h, 50) * 1.5;

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

function matchTemplateWithQuality(ctx, template, currentBox, margin, maxW, maxH) {
  const sx = Math.max(0, Math.round(currentBox.x - margin));
  const sy = Math.max(0, Math.round(currentBox.y - margin));
  const ex = Math.min(maxW, Math.round(currentBox.x + currentBox.w + margin));
  const ey = Math.min(maxH, Math.round(currentBox.y + currentBox.h + margin));
  const sw = ex - sx;
  const sh = ey - sy;

  if (sw <= currentBox.w || sh <= currentBox.h) return null;

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
    const sampleCount = (tw / 2) * (th / 2);

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

    const avgDiff = Math.sqrt(bestScore / sampleCount);
    // Normalized confidence (0 to 1)
    const confidence = Math.max(0, 1 - (avgDiff / 50));

    if (confidence < 0.35) {
      // Texture is completely different -> Target lost
      return null;
    }

    const matchedX = sx + bestDx;
    const matchedY = sy + bestDy;

    const smoothX = currentBox.x * 0.25 + matchedX * 0.75;
    const smoothY = currentBox.y * 0.25 + matchedY * 0.75;

    return {
      confidence,
      box: {
        x: Math.max(0, Math.min(maxW - currentBox.w, smoothX)),
        y: Math.max(0, Math.min(maxH - currentBox.h, smoothY)),
        w: currentBox.w,
        h: currentBox.h
      }
    };
  } catch (e) {
    return null;
  }
}
