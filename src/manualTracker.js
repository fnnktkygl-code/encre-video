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

export function interpolateTrack(track, t) {
  const kfs = track.keyframes;
  if (!kfs || kfs.length === 0) return null;
  if (t < kfs[0].t) return null;

  const last = kfs[kfs.length - 1];
  if (t >= last.t) {
    return { x: last.x, y: last.y, w: last.w, h: last.h };
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
