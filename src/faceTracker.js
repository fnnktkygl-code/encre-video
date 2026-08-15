"use strict";

import { FaceDetector, PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

let faceDetector = null;
let poseLandmarker = null;
let visionResolver = null;
let isDetecting = false;
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 50; // Run detection at ~20 FPS

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

export async function initFaceDetectionModel(minConfidence = 0.15) {
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

export async function initPoseLandmarker() {
  if (poseLandmarker) return poseLandmarker;
  const vision = await getVisionResolver();

  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/model/mediapipe/pose_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      numPoses: 8,
      minPoseDetectionConfidence: 0.2,
      minPosePresenceConfidence: 0.2,
      minTrackingConfidence: 0.2
    });
  } catch (err) {
    console.warn('[Encre Vidéo] Pose Landmarker GPU init error, using CPU:', err);
    try {
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: '/model/mediapipe/pose_landmarker.task',
          delegate: 'CPU'
        },
        runningMode: 'IMAGE',
        numPoses: 8,
        minPoseDetectionConfidence: 0.2,
        minPosePresenceConfidence: 0.2,
        minTrackingConfidence: 0.2
      });
    } catch (e2) {
      console.warn('[Encre Vidéo] Pose Landmarker unavailable, using pure Face detection:', e2);
    }
  }
  return poseLandmarker;
}

/**
 * Detects all faces and head keypoints in the current video frame
 */
export function detectFrameBboxes(videoEl, minConfidence = 0.15) {
  const detections = [];
  const width = videoEl.videoWidth;
  const height = videoEl.videoHeight;
  if (!width || !height) return detections;

  // 1. Face Detector Pass (Full-Range BlazeFace)
  if (faceDetector) {
    try {
      const faceResult = faceDetector.detect(videoEl);
      if (faceResult && faceResult.detections) {
        faceResult.detections.forEach(d => {
          const bbox = d.boundingBox;
          detections.push({
            x: bbox.originX,
            y: bbox.originY,
            w: bbox.width,
            h: bbox.height,
            score: (d.categories && d.categories[0]) ? d.categories[0].score : 0.85,
            source: 'face'
          });
        });
      }
    } catch (e) {
      console.warn('[Encre Vidéo] Face detection frame error:', e);
    }
  }

  // 2. Pose Landmarker Pass (Heads from Shoulder/Ear geometry)
  if (poseLandmarker) {
    try {
      const poseResult = poseLandmarker.detect(videoEl);
      if (poseResult && poseResult.landmarks) {
        poseResult.landmarks.forEach(landmarks => {
          if (!landmarks || landmarks.length < 13) return;

          const nose = landmarks[0];
          const leftEar = landmarks[7];
          const rightEar = landmarks[8];
          const leftShoulder = landmarks[11];
          const rightShoulder = landmarks[12];

          const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
          const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
          const shoulderDist = Math.hypot(
            (leftShoulder.x - rightShoulder.x) * width,
            (leftShoulder.y - rightShoulder.y) * height
          );

          const headW = Math.max(35, shoulderDist * 0.55);
          const headH = headW * 1.25;

          const headCenterX = (nose && nose.visibility > 0.25 ? nose.x : shoulderMidX) * width;
          const headCenterY = (nose && nose.visibility > 0.25 ? nose.y : (shoulderMidY - (headH / height) * 0.7)) * height;

          const candidate = {
            x: headCenterX - headW / 2,
            y: headCenterY - headH / 2,
            w: headW,
            h: headH,
            score: 0.6,
            source: 'pose_head'
          };

          const alreadyCovered = detections.some(d => {
            const overlapX = Math.abs((d.x + d.w / 2) - headCenterX);
            const overlapY = Math.abs((d.y + d.h / 2) - headCenterY);
            return overlapX < Math.max(d.w, headW) * 0.75 && overlapY < Math.max(d.h, headH) * 0.75;
          });

          if (!alreadyCovered) {
            detections.push(candidate);
          }
        });
      }
    } catch (e) {
      console.warn('[Encre Vidéo] Pose detection frame error:', e);
    }
  }

  return detections;
}

/**
 * Real-time continuous Multi-Person Tracker
 */
export async function updateRealTimeTracks(videoEl, videoTime, existingTracks, uuidFn, minConfidence = 0.15) {
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
      if (used[i]) return;
      const dt = Math.max(0, videoTime - t.lastSeen);
      const predX = t.targetX + (t.vx || 0) * dt;
      const predY = t.targetY + (t.vy || 0) * dt;
      const d = Math.hypot(predX - cx, predY - cy);

      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });

    const threshold = Math.max(w, h, 60) * 1.8;
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
        name: `Personne ${id}`,
        enabled: true,
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

  // Keep tracks alive for up to 1.8 seconds of occlusion/turning
  return updatedTracks.filter(t => Math.abs(videoTime - t.lastSeen) < 1.8);
}

export function smoothTracks(tracks) {
  const ease = 0.5;
  tracks.forEach(t => {
    t.dispX += (t.targetX - t.dispX) * ease;
    t.dispY += (t.targetY - t.dispY) * ease;
    t.dispW += (t.targetW - t.dispW) * ease;
    t.dispH += (t.targetH - t.dispH) * ease;
  });
}

export function getTrackBox(track, paddingPercent = 25) {
  if (!track || track.enabled === false) return null;
  const p = (paddingPercent !== undefined ? paddingPercent : 25) / 100;
  const w = Math.max(10, track.dispW * (1 + p));
  const h = Math.max(10, track.dispH * (1 + p * 1.15));
  const x = track.dispX - w / 2;
  const y = track.dispY - h / 2;
  return { x, y, w, h };
}
