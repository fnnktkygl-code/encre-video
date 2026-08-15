"use strict";

import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';

let blazefaceModel = null;
let detecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 180;

export async function initFaceDetectionModel() {
  if (blazefaceModel) return blazefaceModel;
  await tf.ready();
  try {
    // 1. Try loading 100% local model files first
    blazefaceModel = await blazeface.load({
      modelUrl: '/model/blazeface/model.json',
      scoreThreshold: 0.5,
      iouThreshold: 0.3
    });
  } catch (localErr) {
    console.warn('[Encre Vidéo] Local model load failed, falling back to default TFHub:', localErr);
    // 2. Fallback to default TFHub model load if local path fails
    blazefaceModel = await blazeface.load({
      scoreThreshold: 0.5,
      iouThreshold: 0.3
    });
  }
  return blazefaceModel;
}

export function paddedBox(track, paddingPercent) {
  const p = (paddingPercent || 30) / 100;
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
    console.warn('[Encre Vidéo] Face detection error:', err);
    return faceTracks;
  } finally {
    detecting = false;
  }
}

export function matchTracks(preds, videoTime, faceTracks, uuidFn) {
  const used = new Array(faceTracks.length).fill(false);
  const updatedTracks = [...faceTracks];

  if (Array.isArray(preds)) {
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

      const threshold = Math.max(w, h) * 1.5;
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
  }

  return updatedTracks.filter((t) => Math.abs(videoTime - t.lastSeen) < 1.5);
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
