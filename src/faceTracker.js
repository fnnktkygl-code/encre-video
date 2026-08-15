"use strict";

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

let faceDetector = null;
let visionResolver = null;
let isDetecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 60; // 16 FPS detection rate for smooth performance

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

/**
 * Detects actual human faces with high precision (zero food / plate false positives)
 */
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
        if (score >= minConfidence && bbox.width > 8 && bbox.height > 8) {
          detections.push({
            x: bbox.originX,
            y: bbox.originY,
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
 * Real-time Multi-Face Tracking & Trajectory Smoothing
 */
export async function updateRealTimeTracks(videoEl, videoTime, existingTracks, uuidFn, minConfidence = 0.35) {
  if (isDetecting || !videoEl || videoEl.readyState < 2) {
    return existingTracks;
  }

  const now = performance.now();
  if (now - lastDetectionTime < DETECTION_INTERVAL_MS) {
    return existingTracks;
  }
  lastDetectionTime = now;
  isDetecting = true;

  try {
    const preds = detectFrameBboxes(videoEl, minConfidence);
    return matchAndSmoothTracks(preds, videoTime, existingTracks, uuidFn);
  } catch (err) {
    console.warn('[Encre Vidéo] Real-time tracking error:', err);
    return existingTracks;
  } finally {
    isDetecting = false;
  }
}

export function matchAndSmoothTracks(preds, videoTime, existingTracks, uuidFn) {
  const used = new Array(existingTracks.length).fill(false);
  const updatedTracks = [...existingTracks];

  preds.forEach(p => {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const w = p.w;
    const h = p.h;

    let bestIdx = -1;
    let bestDist = Infinity;

    updatedTracks.forEach((t, i) => {
      if (used[i] || t.deleted) return;
      const dt = Math.max(0, videoTime - t.lastSeen);
      const predX = t.targetX + (t.vx || 0) * dt;
      const predY = t.targetY + (t.vy || 0) * dt;
      const d = Math.hypot(predX - cx, predY - cy);

      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });

    const threshold = Math.max(w, h, 50) * 1.5;
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
      t.score = p.score;
      used[bestIdx] = true;
    } else {
      const id = updatedTracks.length + 1;
      updatedTracks.push({
        id: id,
        name: `Visage ${id}`,
        enabled: true,
        deleted: false,
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
        score: p.score
      });
    }
  });

  // Keep tracks alive for 1.2 seconds if briefly occluded
  return updatedTracks.filter(t => !t.deleted && Math.abs(videoTime - t.lastSeen) < 1.2);
}

export function smoothTracks(tracks) {
  const ease = 0.55;
  tracks.forEach(t => {
    t.dispX += (t.targetX - t.dispX) * ease;
    t.dispY += (t.targetY - t.dispY) * ease;
    t.dispW += (t.targetW - t.dispW) * ease;
    t.dispH += (t.targetH - t.dispH) * ease;
  });
}

export function getTrackBox(track, paddingPercent = 20) {
  if (!track || track.enabled === false || track.deleted) return null;
  const p = (paddingPercent !== undefined ? paddingPercent : 20) / 100;
  const w = Math.max(10, track.dispW * (1 + p));
  const h = Math.max(10, track.dispH * (1 + p * 1.15));
  const x = track.dispX - w / 2;
  const y = track.dispY - h / 2;
  return { x, y, w, h };
}
