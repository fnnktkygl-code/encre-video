"use strict";

import { FaceDetector, PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { ByteTracker } from './byteTracker.js';

let faceDetector = null;
let poseLandmarker = null;
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

export async function initFaceDetectionModel(minConfidence = 0.2) {
  if (faceDetector) return faceDetector;
  const vision = await getVisionResolver();

  try {
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/model/mediapipe/blaze_face_full_range.tflite',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
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
      runningMode: 'VIDEO',
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
      runningMode: 'VIDEO',
      numPoses: 6,
      minPoseDetectionConfidence: 0.3,
      minPosePresenceConfidence: 0.3,
      minTrackingConfidence: 0.3
    });
  } catch (err) {
    console.warn('[Encre Vidéo] Pose Landmarker GPU init error, using CPU:', err);
    try {
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: '/model/mediapipe/pose_landmarker.task',
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numPoses: 6,
        minPoseDetectionConfidence: 0.3,
        minPosePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3
      });
    } catch (e2) {
      console.warn('[Encre Vidéo] Pose Landmarker unavailable, using pure Face detection:', e2);
    }
  }
  return poseLandmarker;
}

/**
 * Extracts candidate head/face bounding boxes from a single video frame
 */
export async function detectFrameBboxes(videoEl, timeMs, minConfidence = 0.2) {
  const detections = [];
  const width = videoEl.videoWidth;
  const height = videoEl.videoHeight;

  // 1. Face Detector Pass (High Precision for visible faces)
  if (faceDetector) {
    try {
      const faceResult = faceDetector.detectForVideo(videoEl, timeMs);
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
    } catch (e) {}
  }

  // 2. Pose Landmarker Pass (Extracts head boxes even for turned/occluded heads)
  if (poseLandmarker) {
    try {
      const poseResult = poseLandmarker.detectForVideo(videoEl, timeMs);
      if (poseResult && poseResult.landmarks) {
        poseResult.landmarks.forEach(landmarks => {
          if (!landmarks || landmarks.length < 13) return;

          // Keypoints: 0=Nose, 7=Left Ear, 8=Right Ear, 11=Left Shoulder, 12=Right Shoulder
          const nose = landmarks[0];
          const leftEar = landmarks[7];
          const rightEar = landmarks[8];
          const leftShoulder = landmarks[11];
          const rightShoulder = landmarks[12];

          // Compute head center & dimensions from pose
          const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
          const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
          const shoulderDist = Math.hypot(
            (leftShoulder.x - rightShoulder.x) * width,
            (leftShoulder.y - rightShoulder.y) * height
          );

          // Head width is typically ~50% of shoulder width
          const headW = Math.max(25, shoulderDist * 0.55);
          const headH = headW * 1.2;

          let headCenterX = (nose.visibility > 0.4 ? nose.x : shoulderMidX) * width;
          let headCenterY = (nose.visibility > 0.4 ? nose.y : (shoulderMidY - (headH / height) * 0.7)) * height;

          const candidate = {
            x: headCenterX - headW / 2,
            y: headCenterY - headH / 2,
            w: headW,
            h: headH,
            score: 0.65,
            source: 'pose_head'
          };

          // Check if this head is already covered by a high-confidence face detection
          const alreadyCovered = detections.some(d => {
            const overlapX = Math.abs((d.x + d.w / 2) - headCenterX);
            const overlapY = Math.abs((d.y + d.h / 2) - headCenterY);
            return overlapX < Math.max(d.w, headW) * 0.8 && overlapY < Math.max(d.h, headH) * 0.8;
          });

          if (!alreadyCovered) {
            detections.push(candidate);
          }
        });
      }
    } catch (e) {}
  }

  return detections;
}

/**
 * 🚀 CAPCUT-GRADE OFFLINE VIDEO SCANNER
 * Performs a complete temporal analysis pass across the whole video with ByteTrack.
 */
export async function scanAndTrackVideo(videoEl, onProgress = () => {}) {
  if (isScanning) return [];
  isScanning = true;

  try {
    await initFaceDetectionModel(0.2);
    await initPoseLandmarker();

    const originalTime = videoEl.currentTime;
    const originalPaused = videoEl.paused;
    videoEl.pause();

    const duration = videoEl.duration || 10;
    const stepSec = 0.08; // Sample at 12.5 FPS for accurate temporal resolution
    const totalSteps = Math.ceil(duration / stepSec);

    const tracker = new ByteTracker(0.4, 0.15, 2.2);
    let currentTime = 0;
    let step = 0;

    while (currentTime <= duration) {
      step++;
      const timeMs = Math.round(currentTime * 1000);

      // Seek video to exact frame
      await new Promise(resolve => {
        const onSeeked = () => {
          videoEl.removeEventListener('seeked', onSeeked);
          resolve();
        };
        videoEl.addEventListener('seeked', onSeeked);
        videoEl.currentTime = currentTime;
      });

      // Detect in frame
      const frameDets = await detectFrameBboxes(videoEl, timeMs, 0.2);

      // Associate with ByteTrack
      tracker.update(frameDets, currentTime);

      const pct = Math.min(99, Math.round((step / totalSteps) * 100));
      onProgress(pct, tracker.tracks.length);

      currentTime += stepSec;
    }

    // Bidirectional smoothing & interpolation
    const finalizedTracks = tracker.finalizeTrajectories();

    // Filter out micro-false positives (tracks that only appeared for < 0.2s)
    const validTracks = finalizedTracks.filter(t => t.keyframes.length >= 3);

    // Restore original video state
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
 * Get interpolated bounding box for a track at any video timestamp
 */
export function getInterpolatedBoxAt(track, time, paddingPercent = 20) {
  if (!track || !track.enabled || !track.keyframes || track.keyframes.length === 0) {
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
    // Binary search for closest keyframe interval
    let low = 0;
    let high = kfs.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (kfs[mid].t <= time && (mid === kfs.length - 1 || kfs[mid + 1].t >= time)) {
        const a = kfs[mid];
        const b = kfs[mid + 1] || a;
        const dt = Math.max(0.0001, b.t - a.t);
        const f = (time - a.t) / dt;
        box = {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          w: a.w + (b.w - a.w) * f,
          h: a.h + (b.h - a.h) * f
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

  return { x, y, w, h };
}
