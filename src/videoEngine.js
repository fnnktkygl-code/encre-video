"use strict";

import { applyToClippedRect, cloneCanvas } from './canvas.js';

export function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
}

export function renderVideoFrame(
  videoEl,
  workCanvas,
  workCtx,
  state,
  faceTracks,
  manualTracks,
  paddedBoxFn,
  interpolateTrackFn
) {
  if (!state.hasVideo || videoEl.readyState < 2) return;

  workCtx.drawImage(videoEl, 0, 0, workCanvas.width, workCanvas.height);

  if (!state.showRawPreview || state.exporting) {
    const rawFrame = cloneCanvas(workCanvas);
    const t = videoEl.currentTime;

    // Apply auto face detection masks
    if (state.faceDetectionEnabled && faceTracks.length > 0) {
      faceTracks.forEach((track) => {
        const box = paddedBoxFn(track, state.facePadding);
        applyToClippedRect(
          workCtx,
          rawFrame,
          box.x,
          box.y,
          box.w,
          box.h,
          state.mode,
          { color: state.color, blurRadius: state.blurRadius, pixelSize: state.pixelSize }
        );
      });
    }

    // Apply manual keyframe track masks
    if (manualTracks && manualTracks.length > 0) {
      manualTracks.forEach((track) => {
        const box = interpolateTrackFn(track, t);
        if (box) {
          applyToClippedRect(
            workCtx,
            rawFrame,
            box.x,
            box.y,
            box.w,
            box.h,
            state.mode,
            { color: state.color, blurRadius: state.blurRadius, pixelSize: state.pixelSize }
          );
        }
      });
    }
  }
}

export async function exportVideo(videoEl, workCanvas, currentFileBaseName, onProgress, onFinish) {
  if (!('MediaRecorder' in window)) {
    window.alert("Ce navigateur ne prend pas en charge l'exportation vidéo (MediaRecorder).");
    return;
  }

  videoEl.pause();
  onProgress(0);

  // Seek to 0
  await new Promise((resolve) => {
    if (videoEl.currentTime === 0) { resolve(); return; }
    videoEl.onseeked = () => {
      videoEl.onseeked = null;
      resolve();
    };
    videoEl.currentTime = 0;
  });

  const canvasStream = workCanvas.captureStream ? workCanvas.captureStream(30) : null;
  if (!canvasStream) {
    window.alert("Capture stream non supportée sur ce navigateur.");
    onFinish(false);
    return;
  }

  const combined = new MediaStream();
  canvasStream.getVideoTracks().forEach(tr => combined.addTrack(tr));

  try {
    const mediaSource = videoEl.captureStream ? videoEl.captureStream() : (videoEl.mozCaptureStream ? videoEl.mozCaptureStream() : null);
    if (mediaSource) {
      mediaSource.getAudioTracks().forEach(tr => combined.addTrack(tr));
    }
  } catch (e) {
    // Continue without audio if audio stream capture fails
  }

  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  let mimeType = '';
  for (let i = 0; i < mimeCandidates.length; i++) {
    if (window.MediaRecorder.isTypeSupported(mimeCandidates[i])) {
      mimeType = mimeCandidates[i];
      break;
    }
  }

  const recorder = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  function onTimeUpdateProgress() {
    const pct = videoEl.duration ? (videoEl.currentTime / videoEl.duration) * 100 : 0;
    onProgress(pct);
  }

  videoEl.addEventListener('timeupdate', onTimeUpdateProgress);

  recorder.start();
  videoEl.play();

  await new Promise((resolve) => {
    videoEl.onended = () => {
      videoEl.onended = null;
      resolve();
    };
  });

  recorder.stop();
  await stopped;
  videoEl.removeEventListener('timeupdate', onTimeUpdateProgress);

  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentFileBaseName}-encre.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);

  videoEl.pause();
  onFinish(true);
}
