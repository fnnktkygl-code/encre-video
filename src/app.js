"use strict";

import {
  getCanvasPoint,
  drawInteractiveShape,
  getHandleAtPoint,
  triggerHaptic
} from './canvas.js';
import { setupGestures } from './gestures.js';
import {
  initFaceDetectionModel,
  maybeRunDetection,
  smoothTracks,
  paddedBox
} from './faceTracker.js';
import {
  upsertKeyframe,
  interpolateTrack,
  autoTrackForward
} from './manualTracker.js';
import {
  formatTime,
  renderVideoFrame,
  exportVideo
} from './videoEngine.js';
import { initPWA } from './pwa.js';

(function () {
  "use strict";

  const state = {
    tool: 'rect',          // 'pan' | 'rect' | 'oval'
    mode: 'blur',          // 'redact' | 'blur' | 'pixelate'
    color: '#0a0a0a',
    blurRadius: 20,
    pixelSize: 16,
    facePadding: 20,
    minConfidence: 0.25,
    modelType: 'full',     // 'full' (crowds/distance) | 'short' (selfie/closeup)
    faceDetectionEnabled: false,
    faceModelLoaded: false,
    faceModelLoading: false,
    editMode: 'lecture',   // 'lecture' | 'marker'
    showRawPreview: false,
    scrubbing: false,
    exporting: false,
    hasVideo: false,
    zoom: 1
  };

  let faceTracks = [];
  let manualTracks = [];
  let selectedManualTrackId = null;
  let currentFileBaseName = 'video';
  let lastObjectUrl = null;
  let rafId = null;
  let gestureHandler = null;

  // Manual interactive shape state
  let markerStart = null;
  let panStartPt = null;
  let panScrollStart = null;

  // DOM Refs
  const sidePanel = document.getElementById('side-panel');
  const toolbar = document.getElementById('toolbar');
  const timeline = document.getElementById('timeline');
  const statusbar = document.getElementById('statusbar');
  const emptyState = document.getElementById('empty-state');
  const canvasStage = document.getElementById('canvas-stage');
  const canvasInner = document.getElementById('canvas-inner');
  const workCanvas = document.getElementById('work-canvas');
  const overlay = document.getElementById('overlay-canvas');
  const originalBadge = document.getElementById('original-badge');
  const fileInput = document.getElementById('file-input');
  const videoEl = document.getElementById('src-video');
  const seekRange = document.getElementById('seek-range');
  const timeLabel = document.getElementById('time-label');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const faceToggleBtn = document.getElementById('face-toggle-btn');
  const aiControls = document.getElementById('ai-controls');
  const aiModelSelect = document.getElementById('ai-model-select');
  const confRange = document.getElementById('conf-range');
  const confVal = document.getElementById('conf-val');
  const paddingRange = document.getElementById('padding-range');
  const paddingVal = document.getElementById('padding-val');
  const markerModeBtn = document.getElementById('marker-mode-btn');
  const newTrackBtn = document.getElementById('new-track-btn');
  const manualTrackListEl = document.getElementById('manual-track-list');
  const trackActionBox = document.getElementById('track-action-box');
  const selectedTrackName = document.getElementById('selected-track-name');
  const autoTrackBtn = document.getElementById('auto-track-btn');
  const autoTrackAllBtn = document.getElementById('auto-track-all-btn');
  const stampEl = document.getElementById('stamp');
  const faceStatusLabel = document.getElementById('face-status-label');
  const exportProgress = document.getElementById('export-progress');
  const exportProgressBar = document.getElementById('export-progress-bar');
  const exportBanner = document.getElementById('export-banner');
  const zoomLabel = document.getElementById('zoom-label');

  const workCtx = workCanvas.getContext('2d');
  const overlayCtx = overlay.getContext('2d');

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function clearOverlay() {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Zoom & Display scaling
  function setZoom(z) {
    state.zoom = Math.min(5, Math.max(0.01, z));
    if (state.hasVideo) {
      const displayW = Math.max(1, Math.round(videoEl.videoWidth * state.zoom));
      const displayH = Math.max(1, Math.round(videoEl.videoHeight * state.zoom));
      workCanvas.style.width = displayW + 'px';
      workCanvas.style.height = displayH + 'px';
      overlay.style.width = displayW + 'px';
      overlay.style.height = displayH + 'px';
      canvasInner.style.width = displayW + 'px';
      canvasInner.style.height = displayH + 'px';
    }
    zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  }
  function zoomBy(delta) { setZoom(state.zoom + delta); }
  function fitToScreen() {
    if (!state.hasVideo) return;
    const stageRect = canvasStage.getBoundingClientRect();
    const pad = 32;
    const scaleX = Math.max(0.01, (stageRect.width - pad) / videoEl.videoWidth);
    const scaleY = Math.max(0.01, (stageRect.height - pad) / videoEl.videoHeight);
    const s = Math.min(scaleX, scaleY);
    setZoom(Math.max(0.01, Math.min(3, s)));
  }

  // Stamp and Face Status UI
  function updateStamp() {
    if (state.faceModelLoaded) {
      stampEl.innerHTML = '<span class="dot"></span>MediaPipe IA Vision — Détection active';
    } else {
      stampEl.innerHTML = '<span class="dot"></span>100% local — aucun réseau';
    }
  }

  function updateFaceUI() {
    if (state.faceModelLoading) {
      faceToggleBtn.textContent = 'Chargement de l\'IA MediaPipe…';
      faceToggleBtn.disabled = true;
    } else if (state.faceModelLoaded) {
      faceToggleBtn.disabled = false;
      faceToggleBtn.textContent = state.faceDetectionEnabled ? 'Détection active — désactiver' : 'Activer la détection automatique';
      faceToggleBtn.classList.toggle('on', state.faceDetectionEnabled);
      if (aiControls) aiControls.style.display = state.faceDetectionEnabled ? '' : 'none';
    } else {
      faceToggleBtn.disabled = false;
      faceToggleBtn.textContent = 'Activer la détection automatique';
      if (aiControls) aiControls.style.display = 'none';
    }
    faceStatusLabel.textContent = state.faceDetectionEnabled
      ? `${faceTracks.length} visage(s) détecté(s)`
      : '';
    updateStamp();
  }

  async function enableFaceDetection() {
    if (state.faceModelLoaded) {
      state.faceDetectionEnabled = !state.faceDetectionEnabled;
      if (!state.faceDetectionEnabled) faceTracks = [];
      updateFaceUI();
      return;
    }
    if (state.faceModelLoading) return;
    state.faceModelLoading = true;
    updateFaceUI();
    try {
      await initFaceDetectionModel(state.modelType, state.minConfidence);
      state.faceModelLoaded = true;
      state.faceDetectionEnabled = true;
    } catch (err) {
      console.error(err);
      window.alert("Impossible de charger le modèle MediaPipe Vision. Vérifiez votre connexion internet pour le chargement initial.");
    } finally {
      state.faceModelLoading = false;
      updateFaceUI();
    }
  }

  faceToggleBtn.addEventListener('click', enableFaceDetection);

  if (aiModelSelect) {
    aiModelSelect.addEventListener('change', async (e) => {
      state.modelType = e.target.value;
      if (state.faceModelLoaded) {
        state.faceModelLoading = true;
        updateFaceUI();
        await initFaceDetectionModel(state.modelType, state.minConfidence);
        state.faceModelLoading = false;
        updateFaceUI();
      }
    });
  }

  if (confRange) {
    confRange.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.minConfidence = val / 100;
      if (confVal) confVal.textContent = val + '%';
    });
  }

  if (paddingRange) {
    paddingRange.addEventListener('input', (e) => {
      state.facePadding = parseInt(e.target.value, 10);
      if (paddingVal) paddingVal.textContent = state.facePadding + '%';
    });
  }

  // Manual Tracks UI
  function getManualTrack(id) {
    return manualTracks.find(t => t.id === id) || null;
  }

  function renderManualTrackList() {
    manualTrackListEl.innerHTML = '';
    const currentTrack = selectedManualTrackId ? getManualTrack(selectedManualTrackId) : null;

    if (trackActionBox) {
      trackActionBox.style.display = currentTrack ? '' : 'none';
      if (currentTrack && selectedTrackName) {
        selectedTrackName.textContent = `Repère sélectionné : ${currentTrack.name}`;
      }
    }

    if (manualTracks.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Aucun repère manuel. Cliquez sur "+ Nouveau" ou dessinez directement sur la vidéo.';
      manualTrackListEl.appendChild(p);
      return;
    }

    manualTracks.forEach((track, idx) => {
      const item = document.createElement('div');
      item.className = 'track-item' + (track.id === selectedManualTrackId ? ' selected' : '');

      const label = document.createElement('button');
      label.className = 'track-label';
      const n = track.keyframes.length;
      label.textContent = `${track.name} (${n} clé${n > 1 ? 's' : ''})`;
      label.addEventListener('click', () => {
        selectedManualTrackId = (selectedManualTrackId === track.id) ? null : track.id;
        renderManualTrackList();
      });

      const del = document.createElement('button');
      del.className = 'track-del';
      del.setAttribute('aria-label', `Supprimer ${track.name}`);
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        manualTracks = manualTracks.filter(t2 => t2.id !== track.id);
        if (selectedManualTrackId === track.id) selectedManualTrackId = null;
        renderManualTrackList();
      });

      item.appendChild(label);
      item.appendChild(del);
      manualTrackListEl.appendChild(item);
    });
  }

  if (newTrackBtn) {
    newTrackBtn.addEventListener('click', () => {
      state.editMode = 'marker';
      markerModeBtn.classList.add('on');
      markerModeBtn.textContent = 'Mode « Repère » (actif)';
      overlay.classList.add('marker-mode');
      if (!videoEl.paused) videoEl.pause();

      const newTrack = {
        id: uuid(),
        name: `Visage ${manualTracks.length + 1}`,
        keyframes: []
      };
      manualTracks.push(newTrack);
      selectedManualTrackId = newTrack.id;
      renderManualTrackList();
    });
  }

  if (autoTrackBtn) {
    autoTrackBtn.addEventListener('click', async () => {
      const track = selectedManualTrackId ? getManualTrack(selectedManualTrackId) : null;
      if (!track || track.keyframes.length === 0) {
        window.alert("Veuillez d'abord dessiner un repère sur la personne pour initialiser son suivi.");
        return;
      }
      autoTrackBtn.disabled = true;
      autoTrackBtn.textContent = 'Suivi en cours…';
      await autoTrackForward(videoEl, track, videoEl.currentTime, 5, (pct) => {
        autoTrackBtn.textContent = `Suivi en cours (${pct}%)…`;
      });
      autoTrackBtn.disabled = false;
      autoTrackBtn.textContent = '⚡ Suivre le mouvement (5s)';
      renderManualTrackList();
    });
  }

  if (autoTrackAllBtn) {
    autoTrackAllBtn.addEventListener('click', async () => {
      const track = selectedManualTrackId ? getManualTrack(selectedManualTrackId) : null;
      if (!track || track.keyframes.length === 0) {
        window.alert("Veuillez d'abord dessiner un repère sur la personne pour initialiser son suivi.");
        return;
      }
      autoTrackAllBtn.disabled = true;
      autoTrackAllBtn.textContent = 'Suivi complet…';
      const remaining = Math.max(1, (videoEl.duration || 10) - videoEl.currentTime);
      await autoTrackForward(videoEl, track, videoEl.currentTime, remaining, (pct) => {
        autoTrackAllBtn.textContent = `Suivi complet (${pct}%)…`;
      });
      autoTrackAllBtn.disabled = false;
      autoTrackAllBtn.textContent = '⚡ Suivre toute la vidéo';
      renderManualTrackList();
    });
  }

  markerModeBtn.addEventListener('click', () => {
    state.editMode = state.editMode === 'marker' ? 'lecture' : 'marker';
    markerModeBtn.classList.toggle('on', state.editMode === 'marker');
    markerModeBtn.textContent = state.editMode === 'marker' ? 'Mode « Repère manuel » (actif)' : 'Mode « Repère manuel »';
    overlay.classList.toggle('marker-mode', state.editMode === 'marker');
    if (state.editMode === 'marker' && !videoEl.paused) videoEl.pause();
  });

  // Tools & Modes UI
  function setTool(name) {
    state.tool = name;
    document.querySelectorAll('[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === name);
    });
    overlay.style.cursor = name === 'pan' ? 'grab' : 'crosshair';
    clearOverlay();
  }
  function setMode(name) {
    state.mode = name;
    document.querySelectorAll('[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === name);
    });
    document.getElementById('color-field').style.display = name === 'redact' ? '' : 'none';
    document.getElementById('blur-field').style.display = name === 'blur' ? '' : 'none';
    document.getElementById('pixel-field').style.display = name === 'pixelate' ? '' : 'none';
  }

  document.querySelectorAll('[data-tool]').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  document.getElementById('color-input').addEventListener('input', (e) => { state.color = e.target.value; });
  document.getElementById('blur-range').addEventListener('input', (e) => {
    state.blurRadius = parseInt(e.target.value, 10);
    document.getElementById('blur-val').textContent = state.blurRadius;
  });
  document.getElementById('pixel-range').addEventListener('input', (e) => {
    state.pixelSize = parseInt(e.target.value, 10);
    document.getElementById('pixel-val').textContent = state.pixelSize;
  });

  // Before / After Preview
  const beforeAfterBtn = document.getElementById('before-after');
  beforeAfterBtn.addEventListener('pointerdown', () => {
    state.showRawPreview = true;
    originalBadge.classList.add('show');
  });
  function endRawPreview() {
    state.showRawPreview = false;
    originalBadge.classList.remove('show');
  }
  beforeAfterBtn.addEventListener('pointerup', endRawPreview);
  beforeAfterBtn.addEventListener('pointerleave', endRawPreview);
  beforeAfterBtn.addEventListener('touchend', endRawPreview);

  // Chrome visibility
  function updateChromeVisibility() {
    emptyState.classList.toggle('hidden', state.hasVideo);
    canvasInner.style.display = state.hasVideo ? '' : 'none';
    sidePanel.classList.toggle('hidden', !state.hasVideo);
    toolbar.classList.toggle('hidden', !state.hasVideo);
    timeline.classList.toggle('hidden', !state.hasVideo);
    statusbar.classList.toggle('hidden', !state.hasVideo);
  }

  // Pointer interactions on Overlay (Drawing manual markers / Panning)
  overlay.addEventListener('pointerdown', (e) => {
    if (!state.hasVideo) return;
    if (gestureHandler && gestureHandler.isMultiTouch()) return;

    if (state.tool === 'pan') {
      overlay.setPointerCapture(e.pointerId);
      panStartPt = { x: e.clientX, y: e.clientY };
      panScrollStart = { left: canvasStage.scrollLeft, top: canvasStage.scrollTop };
      overlay.style.cursor = 'grabbing';
      return;
    }

    if (state.editMode === 'marker') {
      overlay.setPointerCapture(e.pointerId);
      markerStart = getCanvasPoint(e, overlay);
    }
  });

  overlay.addEventListener('pointermove', (e) => {
    if (gestureHandler && gestureHandler.isMultiTouch()) return;

    if (state.tool === 'pan' && panStartPt && panScrollStart) {
      const dx = e.clientX - panStartPt.x;
      const dy = e.clientY - panStartPt.y;
      canvasStage.scrollLeft = panScrollStart.left - dx;
      canvasStage.scrollTop = panScrollStart.top - dy;
      return;
    }

    if (state.editMode === 'marker' && markerStart) {
      clearOverlay();
      const p = getCanvasPoint(e, overlay);
      const x = Math.min(markerStart.x, p.x), y = Math.min(markerStart.y, p.y);
      const w = Math.abs(p.x - markerStart.x), h = Math.abs(p.y - markerStart.y);
      overlayCtx.save();
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.95)';
      overlayCtx.lineWidth = 2;
      overlayCtx.setLineDash([6, 4]);
      overlayCtx.strokeRect(x, y, w, h);
      overlayCtx.restore();
    }
  });

  overlay.addEventListener('pointerup', (e) => {
    if (state.tool === 'pan') {
      panStartPt = null;
      panScrollStart = null;
      overlay.style.cursor = 'grab';
    }

    if (state.editMode === 'marker' && markerStart) {
      const p = getCanvasPoint(e, overlay);
      const x = Math.min(markerStart.x, p.x), y = Math.min(markerStart.y, p.y);
      const w = Math.abs(p.x - markerStart.x), h = Math.abs(p.y - markerStart.y);
      clearOverlay();
      markerStart = null;
      if (w < 4 || h < 4) return;

      const t = videoEl.currentTime;
      let track = selectedManualTrackId ? getManualTrack(selectedManualTrackId) : null;
      if (track) {
        upsertKeyframe(track, t, x, y, w, h);
      } else {
        track = {
          id: uuid(),
          name: `Repère ${manualTracks.length + 1}`,
          keyframes: [{ t, x, y, w, h }]
        };
        manualTracks.push(track);
        selectedManualTrackId = track.id;
      }
      renderManualTrackList();
      triggerHaptic();
    }
  });

  overlay.addEventListener('pointercancel', () => {
    markerStart = null;
    panStartPt = null;
    clearOverlay();
  });

  // Video Render Loop
  let faceDetecting = false;

  function loop() {
    if (state.hasVideo && videoEl.readyState >= 2) {
      if (state.faceDetectionEnabled && state.faceModelLoaded && !faceDetecting) {
        faceDetecting = true;
        maybeRunDetection(videoEl, videoEl.currentTime, faceTracks, uuid, state.minConfidence)
          .then((newTracks) => {
            faceTracks = newTracks;
            smoothTracks(faceTracks);
            faceDetecting = false;
            if (faceStatusLabel) {
              faceStatusLabel.textContent = `${faceTracks.length} visage(s) détecté(s)`;
            }
          })
          .catch(() => {
            faceDetecting = false;
          });
      } else if (state.faceDetectionEnabled && faceTracks.length > 0) {
        smoothTracks(faceTracks);
      }

      renderVideoFrame(
        videoEl,
        workCanvas,
        workCtx,
        state,
        faceTracks,
        manualTracks,
        paddedBox,
        interpolateTrack
      );

      // Render interactive manual tracks on overlay when in marker mode
      if (state.editMode === 'marker' && !markerStart) {
        clearOverlay();
        manualTracks.forEach((track) => {
          const box = interpolateTrack(track, videoEl.currentTime);
          if (box) {
            const isSelected = track.id === selectedManualTrackId;
            overlayCtx.save();
            overlayCtx.strokeStyle = isSelected ? 'rgba(0, 245, 212, 0.95)' : 'rgba(255, 255, 255, 0.55)';
            overlayCtx.lineWidth = isSelected ? 2.5 : 1.5;
            overlayCtx.setLineDash(isSelected ? [6, 4] : [4, 4]);
            overlayCtx.strokeRect(box.x, box.y, box.w, box.h);

            // Track name tag
            const tagW = Math.min(box.w, 90);
            overlayCtx.fillStyle = isSelected ? 'rgba(0, 245, 212, 0.9)' : 'rgba(0, 0, 0, 0.65)';
            overlayCtx.fillRect(box.x, Math.max(0, box.y - 18), tagW, 18);
            overlayCtx.fillStyle = isSelected ? '#000000' : '#FFFFFF';
            overlayCtx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
            overlayCtx.fillText(track.name, box.x + 4, Math.max(12, box.y - 5));
            overlayCtx.restore();
          }
        });
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  // File loading
  function loadVideoFile(file) {
    if (!file || !file.type || !file.type.startsWith('video/')) return;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    const url = URL.createObjectURL(file);
    lastObjectUrl = url;
    currentFileBaseName = (file.name || 'video').replace(/\.[^.]+$/, '');
    faceTracks = [];
    manualTracks = [];
    selectedManualTrackId = null;
    renderManualTrackList();
    videoEl.src = url;
    videoEl.load();
    state.hasVideo = true;
    updateChromeVisibility();
  }

  videoEl.addEventListener('loadedmetadata', () => {
    workCanvas.width = videoEl.videoWidth;
    workCanvas.height = videoEl.videoHeight;
    overlay.width = videoEl.videoWidth;
    overlay.height = videoEl.videoHeight;

    seekRange.min = 0;
    seekRange.max = videoEl.duration || 0;
    seekRange.step = 0.01;
    seekRange.value = 0;
    updateTimeLabel();
    fitToScreen();
    startLoop();
  });

  videoEl.addEventListener('timeupdate', () => {
    if (!state.scrubbing) seekRange.value = videoEl.currentTime;
    updateTimeLabel();
  });
  videoEl.addEventListener('play', () => {
    playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  });
  videoEl.addEventListener('pause', () => {
    playIcon.innerHTML = '<path d="M7 5v14l12-7z"/>';
  });

  function updateTimeLabel() {
    timeLabel.textContent = `${formatTime(videoEl.currentTime)} / ${formatTime(videoEl.duration || 0)}`;
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadVideoFile(fileInput.files[0]);
    fileInput.value = '';
  });
  document.getElementById('browse-btn').addEventListener('click', () => fileInput.click());

  let dragCounter = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      loadVideoFile(e.dataTransfer.files[0]);
    }
  });

  // Playback Controls
  playBtn.addEventListener('click', () => {
    if (!state.hasVideo || state.exporting) return;
    if (videoEl.paused) videoEl.play(); else videoEl.pause();
  });
  seekRange.addEventListener('pointerdown', () => { state.scrubbing = true; });
  seekRange.addEventListener('input', () => {
    if (!state.hasVideo) return;
    videoEl.currentTime = parseFloat(seekRange.value);
  });
  seekRange.addEventListener('pointerup', () => { state.scrubbing = false; });
  seekRange.addEventListener('change', () => { state.scrubbing = false; });

  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.15));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(-0.15));
  document.getElementById('zoom-fit').addEventListener('click', fitToScreen);

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!state.hasVideo) return;
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); if (videoEl.paused) videoEl.play(); else videoEl.pause(); }
    else if (k === 'm') { setTool('pan'); }
    else if (k === 'r') { setTool('rect'); }
    else if (k === 'o') { setTool('oval'); }
    else if (k === 'k') { markerModeBtn.click(); }
    else if (k === '+' || k === '=') { zoomBy(0.15); }
    else if (k === '-' || k === '_') { zoomBy(-0.15); }
  });

  window.addEventListener('resize', () => {
    if (state.hasVideo) fitToScreen();
  });

  // Export
  function setExportUI(on, progress) {
    exportProgress.classList.toggle('show', on);
    exportBanner.classList.toggle('show', on);
    if (on) exportProgressBar.style.width = (progress || 0) + '%';
    document.getElementById('export-btn').disabled = on;
    playBtn.disabled = on;
    seekRange.disabled = on;
    markerModeBtn.disabled = on;
    faceToggleBtn.disabled = on || state.faceModelLoading;
    beforeAfterBtn.disabled = on;
  }

  document.getElementById('export-btn').addEventListener('click', async () => {
    if (!state.hasVideo || state.exporting) return;
    if (state.editMode === 'marker') markerModeBtn.click();
    state.exporting = true;
    setExportUI(true, 0);

    await exportVideo(
      videoEl,
      workCanvas,
      currentFileBaseName,
      (progressPct) => setExportUI(true, progressPct),
      () => {
        state.exporting = false;
        setExportUI(false, 100);
      }
    );
  });

  // Theme Toggle
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');
  const SUN = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>';
  const MOON = '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>';

  themeToggle.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') !== 'light';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    themeIcon.innerHTML = isDark ? MOON : SUN;
  });

  // Gestures setup
  gestureHandler = setupGestures(canvasStage, canvasInner, () => state.zoom, setZoom);

  // Initialize PWA and Web Share Target
  initPWA((sharedFiles) => {
    if (Array.isArray(sharedFiles) && sharedFiles.length > 0) {
      loadVideoFile(sharedFiles[0]);
    }
  });

  // Init defaults
  setMode('blur');
  setTool('rect');
  renderManualTrackList();
  updateChromeVisibility();
  updateFaceUI();

})();
