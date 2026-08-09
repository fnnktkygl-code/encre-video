"use strict";

let blazefaceModel = null;
let detecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 180;

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export async function initFaceDetectionModel() {
  if (blazefaceModel) return blazefaceModel;
  if (!window.tf) {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  }
  if (!window.blazeface) {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.js');
  }
  blazefaceModel = await window.blazeface.load();
  return blazefaceModel;
}

export function paddedBox(track, paddingPercent) {
  const p = paddingPercent / 100;
  const w = track.dispW * (1 + p);
  const h = track.dispH * (1 + p * 1.3);
  const x = track.dispX - w / 2;
  const y = track.dispY - h / 2 - track.dispH * 0.08;
  return { x, y, w, h };
}

export async function maybeRunDetection(rawFrame, videoTime, faceTracks, uuidFn) {
  if (!blazefaceModel || detecting) return faceTracks;
  const now = performance.now();
  if (now - lastDetectionTime < DETECTION_INTERVAL_MS) return faceTracks;
  lastDetectionTime = now;
  detecting = true;
  try {
    const preds = await blazefaceModel.estimateFaces(rawFrame, false);
    return matchTracks(preds, videoTime, faceTracks, uuidFn);
  } catch (err) {
    return faceTracks;
  } finally {
    detecting = false;
  }
}

export function matchTracks(preds, videoTime, faceTracks, uuidFn) {
  const used = new Array(faceTracks.length).fill(false);
  const updatedTracks = [...faceTracks];

  preds.forEach((p) => {
    const x1 = p.topLeft[0], y1 = p.topLeft[1];
    const x2 = p.bottomRight[0], y2 = p.bottomRight[1];
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    let bestIdx = -1;
    let bestDist = Infinity;
    updatedTracks.forEach((t, i) => {
      if (used[i]) return;
      const d = Math.hypot(t.targetX - cx, t.targetY - cy);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });

    const threshold = Math.max(w, h) * 1.4;
    if (bestIdx !== -1 && bestDist < threshold) {
      const t = updatedTracks[bestIdx];
      t.targetX = cx;
      t.targetY = cy;
      t.targetW = w;
      t.targetH = h;
      t.lastSeen = videoTime;
      used[bestIdx] = true;
    } else {
      updatedTracks.push({
        id: uuidFn(),
        targetX: cx,
        targetY: cy,
        targetW: w,
        targetH: h,
        dispX: cx,
        dispY: cy,
        dispW: w,
        dispH: h,
        lastSeen: videoTime
      });
    }
  });

  return updatedTracks.filter((t) => (videoTime - t.lastSeen) < 1.2);
}

export function smoothTracks(faceTracks) {
  const ease = 0.35;
  faceTracks.forEach((t) => {
    t.dispX += (t.targetX - t.dispX) * ease;
    t.dispY += (t.targetY - t.dispY) * ease;
    t.dispW += (t.targetW - t.dispW) * ease;
    t.dispH += (t.targetH - t.dispH) * ease;
  });
}
