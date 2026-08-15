"use strict";

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

let faceDetector = null;
let currentModelType = 'full'; // 'full' | 'short'
let detecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 100; // 10 FPS detection rate for smooth video tracking

export async function initFaceDetectionModel(modelType = 'full', minConfidence = 0.25) {
  if (faceDetector && currentModelType === modelType) {
    return faceDetector;
  }

  currentModelType = modelType;
  const modelFile = modelType === 'short'
    ? 'blaze_face_short_range.tflite'
    : 'blaze_face_full_range.tflite';

  let vision = null;
  try {
    vision = await FilesetResolver.forVisionTasks('/wasm/mediapipe');
  } catch (localWasmErr) {
    console.warn('[Encre Vidéo] Local wasm load failed, trying CDN fallback:', localWasmErr);
    vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm');
  }

  try {
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `/model/mediapipe/${modelFile}`,
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: minConfidence,
      minSuppressionThreshold: 0.3
    });
  } catch (gpuErr) {
    console.warn('[Encre Vidéo] GPU delegate failed, falling back to CPU:', gpuErr);
    try {
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `/model/mediapipe/${modelFile}`,
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: minConfidence,
        minSuppressionThreshold: 0.3
      });
    } catch (cdnModelErr) {
      console.warn('[Encre Vidéo] Local model failed, loading from Google CDN:', cdnModelErr);
      const cdnUrl = modelType === 'short'
        ? 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
        : 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite';

      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: cdnUrl
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: minConfidence,
        minSuppressionThreshold: 0.3
      });
    }
  }

  return faceDetector;
}

export function paddedBox(track, paddingPercent) {
  const p = (paddingPercent !== undefined ? paddingPercent : 20) / 100;
  const w = Math.max(10, track.dispW * (1 + p));
  const h = Math.max(10, track.dispH * (1 + p * 1.15));
  const x = track.dispX - w / 2;
  const y = track.dispY - h / 2;
  return { x, y, w, h };
}

export async function maybeRunDetection(videoEl, videoTime, faceTracks, uuidFn, minConfidence = 0.25) {
  if (!faceDetector || detecting || !videoEl || videoEl.readyState < 2) {
    return faceTracks;
  }

  const now = performance.now();
  if (now - lastDetectionTime < DETECTION_INTERVAL_MS) {
    return faceTracks;
  }
  lastDetectionTime = now;
  detecting = true;

  try {
    const timestampMs = Math.round(videoTime * 1000) || Math.round(now);
    const result = faceDetector.detectForVideo(videoEl, timestampMs);

    if (!result || !result.detections) {
      return faceTracks;
    }

    const preds = result.detections.map(d => {
      const bbox = d.boundingBox;
      return {
        x: bbox.originX,
        y: bbox.originY,
        w: bbox.width,
        h: bbox.height,
        score: d.categories && d.categories[0] ? d.categories[0].score : 1.0
      };
    });

    return matchTracks(preds, videoTime, faceTracks, uuidFn);
  } catch (err) {
    console.warn('[Encre Vidéo] MediaPipe detection error:', err);
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
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const w = p.w;
      const h = p.h;

      let bestIdx = -1;
      let bestDist = Infinity;

      updatedTracks.forEach((t, i) => {
        if (used[i]) return;
        // Predicted position based on previous velocity
        const dt = Math.max(0, videoTime - t.lastSeen);
        const predX = t.targetX + (t.vx || 0) * dt;
        const predY = t.targetY + (t.vy || 0) * dt;
        const d = Math.hypot(predX - cx, predY - cy);

        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });

      const threshold = Math.max(w, h, 60) * 1.5;
      if (bestIdx !== -1 && bestDist < threshold) {
        const t = updatedTracks[bestIdx];
        const dt = Math.max(0.01, videoTime - t.lastSeen);
        t.vx = (cx - t.targetX) / dt;
        t.vy = (cy - t.targetY) / dt;
        t.targetX = cx;
        t.targetY = cy;
        t.targetW = w;
        t.targetH = h;
        t.lastSeen = videoTime;
        t.misses = 0;
        used[bestIdx] = true;
      } else {
        updatedTracks.push({
          id: uuidFn ? uuidFn() : 'face-' + Date.now() + '-' + Math.random().toString(16).slice(2),
          targetX: cx,
          targetY: cy,
          targetW: w,
          targetH: h,
          dispX: cx,
          dispY: cy,
          dispW: w,
          dispH: h,
          vx: 0,
          vy: 0,
          lastSeen: videoTime,
          misses: 0
        });
      }
    });
  }

  // Coast forward briefly if missed, keep track for up to 1.8 seconds
  return updatedTracks.filter((t) => Math.abs(videoTime - t.lastSeen) < 1.8);
}

export function smoothTracks(faceTracks) {
  const ease = 0.45;
  faceTracks.forEach((t) => {
    t.dispX += (t.targetX - t.dispX) * ease;
    t.dispY += (t.targetY - t.dispY) * ease;
    t.dispW += (t.targetW - t.dispW) * ease;
    t.dispH += (t.targetH - t.dispH) * ease;
  });
}
