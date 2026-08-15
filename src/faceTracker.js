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

export async function initFaceDetectionModel(minConfidence = 0.35) {
  if (faceDetector) return faceDetector;
  const vision = await getVisionResolver();

  try {
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/model/mediapipe/blaze_face_full_range.tflite',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: minConfidence,
      minSuppressionThreshold: 0.35
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
      minSuppressionThreshold: 0.35
    });
  }
  return faceDetector;
}

export function isValidFaceBox(bbox, videoW, videoH) {
  const { originX: x, originY: y, width: w, height: h } = bbox;
  if (w < 16 || h < 16) return false;
  if (w > videoW * 0.65 || h > videoH * 0.65) return false;
  const ratio = w / Math.max(1, h);
  if (ratio < 0.5 || ratio > 1.6) return false;
  return true;
}

export function detectFrameBboxes(videoEl, minConfidence = 0.35) {
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
          detections.push({
            x: Math.max(0, bbox.originX),
            y: Math.max(0, bbox.originY),
            w: bbox.width,
            h: bbox.height,
            score: score
          });
        }
      });
    }
  } catch (e) {
    console.warn('[Encre Vidéo] Face detection error:', e);
  }

  return detections;
}

/**
 * 🌟 FILMORA 14 STYLE: FULL VIDEO PRE-ANALYSIS SCANNER
 * Scans video, tracks each face trajectory, and extracts visual thumbnail avatar crops!
 */
export async function scanAndTrackFaces(videoEl, onProgress = () => {}, minConfidence = 0.35) {
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

      // Seek video to frame
      await new Promise(resolve => {
        let done = false;
        const cleanup = () => {
          if (!done) {
            done = true;
            videoEl.removeEventListener('seeked', onSeeked);
            resolve();
          }
        };
        const onSeeked = () => setTimeout(cleanup, 25);
        videoEl.addEventListener('seeked', onSeeked, { once: true });
        videoEl.currentTime = currentTime;
        setTimeout(cleanup, 200);
      });

      // Capture frame & run detection
      offCtx.drawImage(videoEl, 0, 0, offCanvas.width, offCanvas.height);
      const frameDets = detectFrameBboxes(videoEl, minConfidence);

      // Match detections to existing tracks
      const usedDets = new Set();
      tracks.forEach(track => {
        if (track.keyframes.length === 0) return;
        const lastKf = track.keyframes[track.keyframes.length - 1];
        if (Math.abs(currentTime - lastKf.t) > 1.4) return; // lost too long

        const lcx = lastKf.x + lastKf.w / 2;
        const lcy = lastKf.y + lastKf.h / 2;

        let bestIdx = -1;
        let bestDist = Infinity;

        frameDets.forEach((d, i) => {
          if (usedDets.has(i)) return;
          const dcx = d.x + d.w / 2;
          const dcy = d.y + d.h / 2;
          const dist = Math.hypot(dcx - lcx, dcy - lcy);
          const maxDist = Math.max(lastKf.w, lastKf.h, 50) * 1.6;

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

          // If this detection is clearer, update avatar crop
          if (matched.score > track.bestScore) {
            track.bestScore = matched.score;
            track.bestTimestamp = currentTime;
            track.avatarUrl = createAvatarCrop(offCtx, matched);
          }
        }
      });

      // Unmatched detections become new tracks
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
      onProgress(pct, tracks.filter(t => t.keyframes.length >= 2).length);
      currentTime += stepSec;
    }

    // Filter out spurious 1-frame glitches (only keep confirmed tracks with >= 2 keyframes)
    const validTracks = tracks.filter(t => t.keyframes.length >= 2);
    validTracks.forEach((t, idx) => {
      t.id = idx + 1;
      t.name = `Visage ${idx + 1}`;
    });

    // Restore video state
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

    // Circular crop for beautiful Filmora-style avatar
    cctx.beginPath();
    cctx.arc(32, 32, 32, 0, Math.PI * 2);
    cctx.clip();
    cctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, 64, 64);

    return cropCanvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return null;
  }
}

export function getInterpolatedFaceBox(track, time, paddingPercent = 20) {
  if (!track || track.enabled === false || track.deleted || !track.keyframes || track.keyframes.length === 0) {
    return null;
  }

  const kfs = track.keyframes;
  if (time < kfs[0].t - 0.2 || time > kfs[kfs.length - 1].t + 0.2) {
    return null;
  }

  let box = null;
  if (time <= kfs[0].t) {
    box = kfs[0];
  } else if (time >= kfs[kfs.length - 1].t) {
    box = kfs[kfs.length - 1];
  } else {
    // Binary search
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
