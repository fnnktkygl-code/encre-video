"use strict";

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

export function interpolateTrack(track, t) {
  const kfs = track.keyframes;
  if (!kfs || kfs.length === 0) return null;
  if (t < kfs[0].t) {
    // If before first keyframe, allow slight window or start from first
    if (kfs[0].t - t < 1.0) {
      return { x: kfs[0].x, y: kfs[0].y, w: kfs[0].w, h: kfs[0].h };
    }
    return null;
  }

  const last = kfs[kfs.length - 1];
  if (t >= last.t) {
    // Hold last position for up to 2 seconds or continuous if only 1 keyframe
    if (kfs.length === 1 || (t - last.t) < 4.0) {
      return { x: last.x, y: last.y, w: last.w, h: last.h };
    }
    return null;
  }

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / Math.max(0.0001, (b.t - a.t));
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        w: a.w + (b.w - a.w) * f,
        h: a.h + (b.h - a.h) * f
      };
    }
  }

  return null;
}

/**
 * Optical / Template Matching Automatic Tracker
 * Automatically follows an object/face forward across video frames.
 */
export async function autoTrackForward(videoEl, track, startT, durationSec = 5, onProgress = () => {}) {
  if (!track || track.keyframes.length === 0) return;

  const initialBox = interpolateTrack(track, startT);
  if (!initialBox) return;

  const originalTime = videoEl.currentTime;
  const originalPaused = videoEl.paused;
  videoEl.pause();

  const step = 0.15; // sample every 150ms
  const endT = Math.min(videoEl.duration || Infinity, startT + durationSec);
  const totalSteps = Math.ceil((endT - startT) / step);

  const offCanvas = document.createElement('canvas');
  offCanvas.width = videoEl.videoWidth;
  offCanvas.height = videoEl.videoHeight;
  const offCtx = offCanvas.getContext('2d');

  let currentBox = { ...initialBox };
  let currentT = startT;
  let stepIdx = 0;

  try {
    while (currentT < endT) {
      currentT = Math.min(endT, currentT + step);
      stepIdx++;

      // Seek video
      await new Promise((resolve) => {
        const handler = () => {
          videoEl.removeEventListener('seeked', handler);
          resolve();
        };
        videoEl.addEventListener('seeked', handler);
        videoEl.currentTime = currentT;
      });

      // Capture frame
      offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);

      // Search best match around currentBox in a neighborhood window
      const searchMargin = Math.max(30, currentBox.w * 0.6);
      const matchedBox = findBestTemplateMatch(
        offCtx,
        currentBox,
        searchMargin,
        offCanvas.width,
        offCanvas.height
      );

      if (matchedBox) {
        currentBox = matchedBox;
        upsertKeyframe(track, currentT, currentBox.x, currentBox.y, currentBox.w, currentBox.h);
      }

      onProgress(Math.min(100, Math.round((stepIdx / totalSteps) * 100)));
    }
  } catch (e) {
    console.warn('[Encre Vidéo] Auto-tracking interrupted:', e);
  } finally {
    videoEl.currentTime = originalTime;
    if (!originalPaused) videoEl.play();
    onProgress(100);
  }
}

function findBestTemplateMatch(ctx, box, margin, maxW, maxH) {
  const sx = Math.max(0, Math.round(box.x - margin));
  const sy = Math.max(0, Math.round(box.y - margin));
  const ex = Math.min(maxW, Math.round(box.x + box.w + margin));
  const ey = Math.min(maxH, Math.round(box.y + box.h + margin));
  const sw = ex - sx;
  const sh = ey - sy;

  if (sw < box.w || sh < box.h) return box;

  // Simple and fast centroid / intensity tracking
  try {
    const imgData = ctx.getImageData(sx, sy, sw, sh);
    const d = imgData.data;

    let totalLum = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let py = 0; py < sh; py += 2) {
      for (let px = 0; px < sw; px += 2) {
        const idx = (py * sw + px) * 4;
        const lum = (d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114);
        totalLum += lum;
        weightedX += px * lum;
        weightedY += py * lum;
      }
    }

    if (totalLum > 0) {
      const avgX = sx + (weightedX / totalLum) - box.w / 2;
      const avgY = sy + (weightedY / totalLum) - box.h / 2;

      // Smooth step towards center of mass
      const nextX = Math.max(0, Math.min(maxW - box.w, box.x * 0.6 + avgX * 0.4));
      const nextY = Math.max(0, Math.min(maxH - box.h, box.y * 0.6 + avgY * 0.4));
      return { x: nextX, y: nextY, w: box.w, h: box.h };
    }
  } catch (e) {}

  return box;
}
