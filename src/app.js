"use strict";

import {
  getCanvasPoint,
  triggerHaptic
} from './canvas.js';
import { setupGestures } from './gestures.js';
import {
  initFaceDetectionModel,
  scanAndTrackFaces,
  trackFaceBidirectional,
  getInterpolatedFaceBox
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
    blurRadius: 24,
    pixelSize: 16,
    facePadding: 20,
    minConfidence: 0.35,
    faceDetectionEnabled: true,
    faceModelLoaded: false,
    faceModelLoading: false,
    editMode: 'lecture',   // 'lecture' | 'marker' | 'add-face'
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
  
  // Filmora 14 AI Face Mosaic Refs
  const scanMosaicBtn = document.getElementById('scan-mosaic-btn');
  const mosaicProgressBox = document.getElementById('mosaic-progress-box');
  const mosaicStatusText = document.getElementById('mosaic-status-text');
  const mosaicPctText = document.getElementById('mosaic-pct-text');
  const mosaicProgressBar = document.getElementById('mosaic-progress-bar');
  const filmoraFaceGallery = document.getElementById('filmora-face-gallery');
  const selectAllFacesBtn = document.getElementById('select-all-faces-btn');
  const deselectAllFacesBtn = document.getElementById('deselect-all-faces-btn');
  const addMissedFaceBtn = document.getElementById('add-missed-face-btn');

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

  function updateStamp() {
    if (state.faceDetectionEnabled && faceTracks.length > 0) {
      stampEl.innerHTML = '<span class="dot"></span>Filmora AI Face Mosaic — Actif';
    } else {
      stampEl.innerHTML = '<span class="dot"></span>100% local — aucun réseau';
    }
  }

  function updateFaceUI() {
    const activeCount = faceTracks.filter(t => !t.deleted && t.enabled !== false).length;
    faceStatusLabel.textContent = faceTracks.length > 0
      ? `${activeCount} visage(s) masqué(s) sur ${faceTracks.filter(t => !t.deleted).length}`
      : '';
    updateStamp();
    renderFilmoraGallery();
  }

  /**
   * 🌟 FILMORA 14 STYLE VISUAL FACE GALLERY
   */
  function renderFilmoraGallery() {
    if (!filmoraFaceGallery) return;
    const activeTracks = faceTracks.filter(t => !t.deleted);

    if (activeTracks.length === 0) {
      filmoraFaceGallery.innerHTML = `
        <div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 12px; border: 1px dashed var(--border); border-radius: 8px;">
          Aucun visage scanné pour l'instant.<br>Cliquez sur <strong>⚡ Analyser les visages</strong> ci-dessus.
        </div>
      `;
      return;
    }

    filmoraFaceGallery.innerHTML = '';
    activeTracks.forEach((track) => {
      const isEnabled = track.enabled !== false;
      const card = document.createElement('div');
      card.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 10px;
        background: ${isEnabled ? 'rgba(0, 245, 212, 0.08)' : 'var(--surface)'};
        border: 1px solid ${isEnabled ? 'var(--accent)' : 'var(--border)'};
        border-radius: 8px;
        transition: all 0.15s ease;
      `;

      // Avatar Thumbnail
      const avatar = document.createElement('img');
      avatar.src = track.avatarUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="%23666"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
      avatar.style.cssText = `
        width: 34px;
        height: 34px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid ${isEnabled ? 'var(--accent)' : '#444'};
        flex-shrink: 0;
        background: #000;
      `;

      // Label & Status
      const infoBox = document.createElement('div');
      infoBox.style.cssText = 'flex: 1; min-width: 0;';
      const name = document.createElement('div');
      name.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text);';
      name.textContent = track.name;
      const sub = document.createElement('div');
      sub.style.cssText = `font-size: 10px; color: ${isEnabled ? 'var(--accent)' : 'var(--text-muted)'};`;
      sub.textContent = isEnabled ? 'Floutage actif' : 'Visage visible (non masqué)';
      infoBox.appendChild(name);
      infoBox.appendChild(sub);

      // Checkbox / Toggle
      const toggle = document.createElement('button');
      toggle.className = isEnabled ? 'btn primary' : 'btn ghost';
      toggle.style.cssText = 'padding: 4px 8px; font-size: 11px; border-radius: 6px;';
      toggle.textContent = isEnabled ? 'Masqué' : 'Visible';
      toggle.addEventListener('click', () => {
        track.enabled = !isEnabled;
        updateFaceUI();
      });

      // Delete False Positive Button
      const del = document.createElement('button');
      del.className = 'btn ghost';
      del.style.cssText = 'padding: 4px 6px; font-size: 13px; color: #ff5555; opacity: 0.7;';
      del.innerHTML = '&times;';
      del.title = 'Supprimer ce visage (faux positif)';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        track.deleted = true;
        updateFaceUI();
      });

      card.appendChild(avatar);
      card.appendChild(infoBox);
      card.appendChild(toggle);
      card.appendChild(del);
      filmoraFaceGallery.appendChild(card);
    });
  }

  // Scan Action (Filmora 14 AI Face Mosaic)
  if (scanMosaicBtn) {
    scanMosaicBtn.addEventListener('click', async () => {
      if (!state.hasVideo) {
        window.alert("Veuillez d'abord ouvrir une vidéo.");
        return;
      }
      scanMosaicBtn.disabled = true;
      if (mosaicProgressBox) mosaicProgressBox.style.display = '';

      try {
        const validTracks = await scanAndTrackFaces(videoEl, (pct, count) => {
          if (mosaicProgressBar) mosaicProgressBar.style.width = pct + '%';
          if (mosaicPctText) mosaicPctText.textContent = pct + '%';
          if (mosaicStatusText) mosaicStatusText.textContent = `Analyse temporelle : ${count} visage(s) détecté(s)…`;
        }, state.minConfidence || 0.35);

        faceTracks = validTracks;
        state.faceDetectionEnabled = true;
        state.faceModelLoaded = true;
        updateFaceUI();

        if (mosaicStatusText) mosaicStatusText.textContent = `✅ Analyse terminée : ${validTracks.length} visage(s) trouvé(s) !`;
        setTimeout(() => {
          if (mosaicProgressBox) mosaicProgressBox.style.display = 'none';
        }, 3000);
      } catch (err) {
        console.error(err);
        window.alert("Erreur lors de l'analyse vidéo : " + (err.message || err));
        if (mosaicProgressBox) mosaicProgressBox.style.display = 'none';
      } finally {
        scanMosaicBtn.disabled = false;
      }
    });
  }

  // Add Missed Face Mode
  if (addMissedFaceBtn) {
    addMissedFaceBtn.addEventListener('click', () => {
      if (!state.hasVideo) {
        window.alert("Veuillez d'abord ouvrir une vidéo.");
        return;
      }
      state.editMode = (state.editMode === 'add-face') ? 'lecture' : 'add-face';
      if (state.editMode === 'add-face') {
        if (!videoEl.paused) videoEl.pause();
        addMissedFaceBtn.textContent = '✏️ Tracez le rectangle sur le visage…';
        addMissedFaceBtn.style.background = 'rgba(0, 245, 212, 0.2)';
        overlay.style.cursor = 'crosshair';
      } else {
        addMissedFaceBtn.textContent = '➕ Ajouter un visage manqué (Tracer & Suivre)';
        addMissedFaceBtn.style.background = '';
        overlay.style.cursor = '';
      }
    });
  }

  if (selectAllFacesBtn) {
    selectAllFacesBtn.addEventListener('click', () => {
      faceTracks.forEach(t => { t.enabled = true; });
      updateFaceUI();
    });
  }

  if (deselectAllFacesBtn) {
    deselectAllFacesBtn.addEventListener('click', () => {
      faceTracks.forEach(t => { t.enabled = false; });
      updateFaceUI();
    });
  }

  if (confRange) {
    confRange.addEventListener('input', (e) => {
      state.minConfidence = parseInt(e.target.value, 10) / 100;
      if (confVal) confVal.textContent = e.target.value + '%';
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

    manualTracks.forEach((track) => {
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
        name: `Repère ${manualTracks.length + 1}`,
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
    markerModeBtn.textContent = state.editMode === 'marker' ? 'Mode « Repère » (actif)' : 'Mode « Repère »';
    overlay.classList.toggle('marker-mode', state.editMode === 'marker');
    if (state.editMode === 'marker' && !videoEl.paused) videoEl.pause();
    renderManualTrackList();
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

  // Pointer interactions on Overlay (Drawing manual markers / Adding missed faces / Panning)
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

    if (state.editMode === 'marker' || state.editMode === 'add-face') {
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

    if ((state.editMode === 'marker' || state.editMode === 'add-face') && markerStart) {
      clearOverlay();
      const p = getCanvasPoint(e, overlay);
      const x = Math.min(markerStart.x, p.x), y = Math.min(markerStart.y, p.y);
      const w = Math.abs(p.x - markerStart.x), h = Math.abs(p.y - markerStart.y);
      overlayCtx.save();
      overlayCtx.strokeStyle = state.editMode === 'add-face' ? 'rgba(0, 245, 212, 0.95)' : 'rgba(255,255,255,0.95)';
      overlayCtx.lineWidth = 2;
      overlayCtx.setLineDash([6, 4]);
      if (state.editMode === 'add-face') {
        overlayCtx.beginPath();
        overlayCtx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        overlayCtx.stroke();
      } else {
        overlayCtx.strokeRect(x, y, w, h);
      }
      overlayCtx.restore();
    }
  });

  overlay.addEventListener('pointerup', (e) => {
    if (state.tool === 'pan') {
      panStartPt = null;
      panScrollStart = null;
      overlay.style.cursor = 'grab';
    }

    // 🌟 Adding a missed face directly into AI Face Gallery with Bidirectional Tracking
    if (state.editMode === 'add-face' && markerStart) {
      const p = getCanvasPoint(e, overlay);
      const x = Math.min(markerStart.x, p.x), y = Math.min(markerStart.y, p.y);
      const w = Math.abs(p.x - markerStart.x), h = Math.abs(p.y - markerStart.y);
      clearOverlay();
      markerStart = null;
      state.editMode = 'lecture';
      if (addMissedFaceBtn) {
        addMissedFaceBtn.textContent = '➕ Ajouter un visage manqué (Tracer & Suivre)';
        addMissedFaceBtn.style.background = '';
      }
      overlay.style.cursor = '';

      if (w < 8 || h < 8) return;

      if (mosaicProgressBox) mosaicProgressBox.style.display = '';
      if (mosaicStatusText) mosaicStatusText.textContent = '⚡ Traçage et suivi du visage sur la vidéo…';

      trackFaceBidirectional(videoEl, { x, y, w, h }, videoEl.currentTime, (pct) => {
        if (mosaicProgressBar) mosaicProgressBar.style.width = pct + '%';
        if (mosaicPctText) mosaicPctText.textContent = pct + '%';
      }).then(result => {
        const id = faceTracks.length + 1;
        const newTrack = {
          id: id,
          name: `Visage ${id} (Ajouté)`,
          enabled: true,
          deleted: false,
          avatarUrl: result.avatarUrl,
          keyframes: result.keyframes
        };
        faceTracks.push(newTrack);
        state.faceDetectionEnabled = true;
        updateFaceUI();
        triggerHaptic();
        if (mosaicStatusText) mosaicStatusText.textContent = `✅ Visage ajouté et suivi avec succès !`;
        setTimeout(() => {
          if (mosaicProgressBox) mosaicProgressBox.style.display = 'none';
        }, 2500);
      }).catch(err => {
        console.error(err);
        if (mosaicProgressBox) mosaicProgressBox.style.display = 'none';
      });
      return;
    }

    // Adding keyframe on manual track
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

  // Direct On-Canvas Click Eraser (Click any unwanted blur to delete it instantly)
  overlay.addEventListener('click', (e) => {
    if (!state.hasVideo || state.editMode !== 'lecture' || state.tool === 'pan') return;
    const pt = getCanvasPoint(e, overlay);
    const t = videoEl.currentTime;

    for (let i = faceTracks.length - 1; i >= 0; i--) {
      const track = faceTracks[i];
      if (track.deleted || track.enabled === false) continue;
      const box = getInterpolatedFaceBox(track, t, state.facePadding);
      if (box && pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h) {
        track.deleted = true;
        updateFaceUI();
        triggerHaptic();
        break;
      }
    }
  });

  // Video Render Loop (Silky 60 FPS playback with zero inference lag)
  function loop() {
    if (state.hasVideo && videoEl.readyState >= 2) {
      renderVideoFrame(
        videoEl,
        workCanvas,
        workCtx,
        state,
        faceTracks,
        manualTracks,
        getInterpolatedFaceBox,
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
  async function loadVideoFile(file) {
    if (!file) return;
    try {
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      const url = URL.createObjectURL(file);
      lastObjectUrl = url;
      currentFileBaseName = (file.name || 'video').replace(/\.[^.]+$/, '');
      faceTracks = [];
      manualTracks = [];
      selectedManualTrackId = null;
      renderManualTrackList();
      renderFilmoraGallery();
      videoEl.src = url;
      videoEl.load();
      state.hasVideo = true;
      updateChromeVisibility();
    } catch (err) {
      console.error('[Encre Vidéo] Error loading video file:', err);
    }
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

    // Auto-trigger Filmora AI Face Mosaic scan
    setTimeout(() => {
      if (scanMosaicBtn) scanMosaicBtn.click();
    }, 300);
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
    if (scanMosaicBtn) scanMosaicBtn.disabled = on;
    if (addMissedFaceBtn) addMissedFaceBtn.disabled = on;
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
