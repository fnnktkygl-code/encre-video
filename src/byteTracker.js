"use strict";

/**
 * ByteTrack: Multi-Object Tracking by Associating Every Detection Box
 * Implements two-stage Kalman association and bidirectional trajectory interpolation.
 */

export class KalmanBoxTracker {
  constructor(bbox, id, time) {
    this.id = id;
    this.name = `Personne ${id}`;
    this.enabled = true; // allow user to toggle blur on/off per person
    this.keyframes = []; // [{ t, x, y, w, h, score }]
    
    // State: [cx, cy, w, h, vx, vy, vw, vh]
    this.cx = bbox.x + bbox.w / 2;
    this.cy = bbox.y + bbox.h / 2;
    this.w = bbox.w;
    this.h = bbox.h;
    this.vx = 0;
    this.vy = 0;
    this.vw = 0;
    this.vh = 0;
    
    this.lastSeen = time;
    this.age = 1;
    this.timeSinceUpdate = 0;
    this.hitStreak = 1;
    this.score = bbox.score || 1.0;

    this.addKeyframe(time, bbox.x, bbox.y, bbox.w, bbox.h, this.score);
  }

  predict(dt = 0.1) {
    this.cx += this.vx * dt;
    this.cy += this.vy * dt;
    this.w += this.vw * dt;
    this.h += this.vh * dt;
    this.age += 1;
    this.timeSinceUpdate += dt;
    return this.getBbox();
  }

  update(bbox, time) {
    const dt = Math.max(0.01, time - this.lastSeen);
    const newCx = bbox.x + bbox.w / 2;
    const newCy = bbox.y + bbox.h / 2;

    // Exponential moving average for velocity
    const vx = (newCx - this.cx) / dt;
    const vy = (newCy - this.cy) / dt;
    const vw = (bbox.w - this.w) / dt;
    const vh = (bbox.h - this.h) / dt;

    const alpha = 0.6;
    this.vx = this.vx * (1 - alpha) + vx * alpha;
    this.vy = this.vy * (1 - alpha) + vy * alpha;
    this.vw = this.vw * (1 - alpha) + vw * alpha;
    this.vh = this.vh * (1 - alpha) + vh * alpha;

    // Update position with smoothing
    const posAlpha = 0.75;
    this.cx = this.cx * (1 - posAlpha) + newCx * posAlpha;
    this.cy = this.cy * (1 - posAlpha) + newCy * posAlpha;
    this.w = this.w * (1 - posAlpha) + bbox.w * posAlpha;
    this.h = this.h * (1 - posAlpha) + bbox.h * posAlpha;

    this.lastSeen = time;
    this.timeSinceUpdate = 0;
    this.hitStreak += 1;
    this.score = bbox.score || this.score;

    this.addKeyframe(time, this.cx - this.w / 2, this.cy - this.h / 2, this.w, this.h, this.score);
  }

  addKeyframe(t, x, y, w, h, score) {
    const eps = 0.04;
    const last = this.keyframes[this.keyframes.length - 1];
    if (last && Math.abs(last.t - t) < eps) {
      last.x = x;
      last.y = y;
      last.w = w;
      last.h = h;
      last.score = score;
    } else {
      this.keyframes.push({ t, x, y, w, h, score });
    }
  }

  getBbox() {
    return {
      x: this.cx - this.w / 2,
      y: this.cy - this.h / 2,
      w: Math.max(10, this.w),
      h: Math.max(10, this.h)
    };
  }
}

export function computeIoU(b1, b2) {
  const x1 = Math.max(b1.x, b2.x);
  const y1 = Math.max(b1.y, b2.y);
  const x2 = Math.min(b1.x + b1.w, b2.x + b2.w);
  const y2 = Math.min(b1.y + b1.h, b2.y + b2.h);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (b1.w * b1.h) + (b2.w * b2.h) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

export function computeDistanceCost(b1, b2) {
  const c1x = b1.x + b1.w / 2;
  const c1y = b1.y + b1.h / 2;
  const c2x = b2.x + b2.w / 2;
  const c2y = b2.y + b2.h / 2;
  const dist = Math.hypot(c1x - c2x, c1y - c2y);
  const maxDim = Math.max(b1.w, b1.h, b2.w, b2.h, 40);
  return dist / maxDim;
}

export class ByteTracker {
  constructor(highThresh = 0.45, lowThresh = 0.15, maxMissTime = 2.0) {
    this.highThresh = highThresh;
    this.lowThresh = lowThresh;
    this.maxMissTime = maxMissTime;
    this.tracks = [];
    this.nextId = 1;
  }

  update(detections, time) {
    // 1. Predict new positions for existing active tracks
    this.tracks.forEach(t => t.predict(0.1));

    // 2. Separate detections into High and Low score groups
    const highDets = [];
    const lowDets = [];
    detections.forEach(d => {
      if ((d.score || 1.0) >= this.highThresh) {
        highDets.push(d);
      } else if ((d.score || 1.0) >= this.lowThresh) {
        lowDets.push(d);
      }
    });

    // 3. Stage 1 Association: Match High Score Detections with Active Tracks
    const unmatchedTracks = [];
    const matchedTrackIndices = new Set();
    const unmatchedHighDets = [];

    highDets.forEach(det => {
      let bestIdx = -1;
      let bestScore = -Infinity;

      this.tracks.forEach((track, i) => {
        if (matchedTrackIndices.has(i)) return;
        const trackBbox = track.getBbox();
        const iou = computeIoU(trackBbox, det);
        const distCost = computeDistanceCost(trackBbox, det);
        const matchMetric = iou - distCost * 0.35;

        if (matchMetric > bestScore && (iou > 0.15 || distCost < 1.2)) {
          bestScore = matchMetric;
          bestIdx = i;
        }
      });

      if (bestIdx !== -1) {
        this.tracks[bestIdx].update(det, time);
        matchedTrackIndices.add(bestIdx);
      } else {
        unmatchedHighDets.push(det);
      }
    });

    this.tracks.forEach((track, i) => {
      if (!matchedTrackIndices.has(i)) {
        unmatchedTracks.push(track);
      }
    });

    // 4. Stage 2 Association: Match Low Score Detections with Remaining Unmatched Tracks
    const remainingTracks = [];
    unmatchedTracks.forEach(track => {
      let bestIdx = -1;
      let bestScore = -Infinity;

      lowDets.forEach((det, i) => {
        const trackBbox = track.getBbox();
        const iou = computeIoU(trackBbox, det);
        const distCost = computeDistanceCost(trackBbox, det);
        const matchMetric = iou - distCost * 0.4;

        if (matchMetric > bestScore && (iou > 0.1 || distCost < 1.4)) {
          bestScore = matchMetric;
          bestIdx = i;
        }
      });

      if (bestIdx !== -1) {
        track.update(lowDets[bestIdx], time);
        lowDets.splice(bestIdx, 1);
      } else {
        remainingTracks.push(track);
      }
    });

    // 5. Initialize New Tracks from Unmatched High Detections
    unmatchedHighDets.forEach(det => {
      const newTrack = new KalmanBoxTracker(det, this.nextId++, time);
      this.tracks.push(newTrack);
    });

    // 6. Clean up dead tracks that have been lost for too long
    this.tracks = this.tracks.filter(t => (time - t.lastSeen) <= this.maxMissTime);

    return this.tracks;
  }

  /**
   * Post-Processing: Smooth and Bidirectionally Interpolate all tracks across time
   */
  finalizeTrajectories() {
    this.tracks.forEach(track => {
      if (track.keyframes.length < 2) return;
      track.keyframes.sort((a, b) => a.t - b.t);

      const smoothed = [];
      const kfs = track.keyframes;

      // Fill micro-gaps with interpolated frames
      for (let i = 0; i < kfs.length - 1; i++) {
        smoothed.push(kfs[i]);
        const cur = kfs[i];
        const next = kfs[i + 1];
        const dt = next.t - cur.t;

        if (dt > 0.08 && dt < 1.5) {
          const numSteps = Math.floor(dt / 0.08);
          for (let step = 1; step < numSteps; step++) {
            const f = step / numSteps;
            // Smooth ease in-out
            const ease = f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
            smoothed.push({
              t: cur.t + dt * f,
              x: cur.x + (next.x - cur.x) * ease,
              y: cur.y + (next.y - cur.y) * ease,
              w: cur.w + (next.w - cur.w) * ease,
              h: cur.h + (next.h - cur.h) * ease,
              score: cur.score * (1 - f) + next.score * f
            });
          }
        }
      }
      smoothed.push(kfs[kfs.length - 1]);
      track.keyframes = smoothed;
    });

    return this.tracks;
  }
}
