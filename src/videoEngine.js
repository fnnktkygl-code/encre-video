"use strict";

import { applyToClippedRect, applyToClippedOval, cloneCanvas } from './canvas.js';

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
  getFaceBoxFn,
  interpolateManualTrackFn
) {
  if (!state.hasVideo || videoEl.readyState < 2) return;

  workCtx.drawImage(videoEl, 0, 0, workCanvas.width, workCanvas.height);

  if (!state.showRawPreview || state.exporting) {
    const rawFrame = cloneCanvas(workCanvas);
    const t = videoEl.currentTime;

    // Apply auto face detection masks (Soft Feathered Ovals)
    if (state.faceDetectionEnabled && faceTracks && faceTracks.length > 0) {
      faceTracks.forEach((track) => {
        if (track.enabled === false || track.deleted) return;
        const box = getFaceBoxFn(track, t, state.facePadding);
        if (box) {
          if (box.cx !== undefined) {
            applyToClippedOval(
              workCtx,
              rawFrame,
              box.cx,
              box.cy,
              box.rx,
              box.ry,
              state.mode,
              { color: state.color, blurRadius: state.blurRadius, pixelSize: state.pixelSize }
            );
          } else {
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
        }
      });
    }

    // Apply manual keyframe track masks
    if (manualTracks && manualTracks.length > 0) {
      manualTracks.forEach((track) => {
        if (track.enabled === false) return;
        const box = interpolateManualTrackFn(track, t);
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

let audioCtx = null;
let audioSourceNode = null;
let audioDestNode = null;

export function getAudioTrackFromVideo(videoEl) {
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
        audioSourceNode = audioCtx.createMediaElementSource(videoEl);
        audioDestNode = audioCtx.createMediaStreamDestination();
        audioSourceNode.connect(audioDestNode);
        audioSourceNode.connect(audioCtx.destination);
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (audioDestNode && audioDestNode.stream) {
      const tracks = audioDestNode.stream.getAudioTracks();
      if (tracks.length > 0) return tracks[0];
    }
  } catch (e) {
    console.warn('[Encre Vidéo] Web Audio capture fallback:', e);
  }

  // Fallback to captureStream
  try {
    const stream = videoEl.captureStream ? videoEl.captureStream() : (videoEl.mozCaptureStream ? videoEl.mozCaptureStream() : null);
    if (stream) {
      const tracks = stream.getAudioTracks();
      if (tracks.length > 0) return tracks[0];
    }
  } catch (e) {}

  return null;
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

  const audioTrack = getAudioTrackFromVideo(videoEl);
  if (audioTrack) {
    combined.addTrack(audioTrack);
  }

  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  let mimeType = '';
  for (let i = 0; i < mimeCandidates.length; i++) {
    if (window.MediaRecorder.isTypeSupported(mimeCandidates[i])) {
      mimeType = mimeCandidates[i];
      break;
    }
  }

  const recorderOptions = mimeType
    ? { mimeType, videoBitsPerSecond: 3500000 }
    : { videoBitsPerSecond: 3500000 };

  let recorder;
  try {
    recorder = new MediaRecorder(combined, recorderOptions);
  } catch (e) {
    recorder = new MediaRecorder(combined);
  }

  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  function onTimeUpdateProgress() {
    const pct = videoEl.duration ? (videoEl.currentTime / videoEl.duration) * 100 : 0;
    onProgress(pct);
  }

  videoEl.addEventListener('timeupdate', onTimeUpdateProgress);

  recorder.start(200); // 200ms timeslice to flush chunks continuously
  videoEl.play();

  await new Promise((resolve) => {
    videoEl.onended = () => {
      videoEl.onended = null;
      resolve();
    };
  });

  if (recorder.state !== 'inactive') {
    try { recorder.requestData(); } catch (e) {}
    recorder.stop();
  }
  await stopped;

  videoEl.removeEventListener('timeupdate', onTimeUpdateProgress);

  const ext = (mimeType && mimeType.includes('mp4')) ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });

  if (blob.size === 0) {
    window.alert("L'exportation a échoué. Veuillez réessayer.");
    videoEl.pause();
    onFinish(false);
    return;
  }

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
