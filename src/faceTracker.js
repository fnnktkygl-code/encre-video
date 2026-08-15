"use strict";

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

let faceDetector = null;
let visionResolver = null;
let isDetecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 50; // ~20 FPS

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

/**
 * Filter out false positives on lamps, ceilings, patterns, and walls
 */
export function isValidFaceBox(bbox, videoW, videoH) {
  const { originX: x, originY: y, width: w, height: h } = bbox;

  // 1. Minimum and maximum physical size constraints
  if (w < 16 || h < 16) return false;
  if (w > videoW * 0.65 || h > videoH * 0.65) return false;

  // 2. Human face aspect ratio constraint (human faces are roughly 1 : 1.2)
  const ratio = w / Math.max(1, h);
  if (ratio < 0.5 || ratio > 1.6) return false;

  // 3. Coordinate bounds
  if (x < -w * 0.3 || y < -h * 0.3 || x + w > videoW + w * 0.3 || y + h > videoH + h * 0.3) {
    return false;
  }

  return true;
}

/**
 * Detects actual human faces with geometric plausibility verification
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
 * Real-time Multi-Face Tracking with Temporal Confirmation (Anti-Ghosting)
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
    return matchAndFilterTracks(preds, videoTime, existingTracks, uuidFn);
  } catch (err) {
    console.warn('[Encre Vidéo] Real-time tracking error:', err);
    return existingTracks;
  } finally {
    isDetecting = false;
  }
}

export function matchAndFilterTracks(preds, videoTime, existingTracks, uuidFn) {
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

    const threshold = Math.max(w, h, 40) * 1.6;
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
      t.hits = (t.hits || 1) + 1; // Increase confirmation count
      used[bestIdx] = true;
    } else {
      const id = updatedTracks.length + 1;
      updatedTracks.push({
        id: id,
        name: `Visage ${id}`,
        enabled: true,
        deleted: false,
        hits: 1, // Start with 1 hit
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

  // Keep tracks alive for up to 1.0s of head turn/brief occlusion
  return updatedTracks.filter(t => !t.deleted && Math.abs(videoTime - t.lastSeen) < 1.0);
}

export function smoothTracks(tracks) {
  const ease = 0.6;
  tracks.forEach(t => {
    t.dispX += (t.targetX - t.dispX) * ease;
    t.dispY += (t.targetY - t.dispY) * ease;
    t.dispW += (t.targetW - t.dispW) * ease;
    t.dispH += (t.targetH - t.dispH) * ease;
  });
}

export function getTrackBox(track, paddingPercent = 20) {
  // Require at least 2 hits (temporal confirmation) to eliminate 1-frame wall/lamp glitches
  if (!track || track.enabled === false || track.deleted || (track.hits < 2 && track.score < 0.6)) {
    return null;
  }
  const p = (paddingPercent !== undefined ? paddingPercent : 20) / 100;
  const w = Math.max(10, track.dispW * (1 + p));
  const h = Math.max(10, track.dispH * (1 + p * 1.15));
  const x = track.dispX - w / 2;
  const y = track.dispY - h / 2;
  return { x, y, w, h };
}
