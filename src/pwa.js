"use strict";

let deferredPrompt = null;

export function initPWA(onSharedFilesReceived) {
  // 1. Service Worker Registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then((reg) => {
          console.log('[Encre Vidéo] Service Worker registered:', reg.scope);
          reg.update();
        })
        .catch((err) => {
          console.warn('[Encre Vidéo] Service Worker registration failed:', err);
        });
    });
  }

  // 2. Android / Chrome Install Prompt
  const installBtn = document.getElementById('pwa-install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) {
      installBtn.classList.remove('hidden');
    }
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log('[Encre Vidéo] Install prompt outcome:', outcome);
      deferredPrompt = null;
      installBtn.classList.add('hidden');
    });
  }

  window.addEventListener('appinstalled', () => {
    console.log('[Encre Vidéo] PWA successfully installed!');
    if (installBtn) installBtn.classList.add('hidden');
  });

  // 3. iOS Safari Banner & Modal
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

  const iosBtn = document.getElementById('ios-install-btn');
  const iosModal = document.getElementById('ios-modal');
  const iosClose = document.getElementById('ios-modal-close');
  const iosOk = document.getElementById('ios-modal-ok');

  if (isIOS && !isStandalone && iosBtn) {
    iosBtn.classList.remove('hidden');
    iosBtn.addEventListener('click', () => {
      if (iosModal) iosModal.classList.remove('hidden');
    });
  }

  if (iosClose) {
    iosClose.addEventListener('click', () => {
      if (iosModal) iosModal.classList.add('hidden');
    });
  }
  if (iosOk) {
    iosOk.addEventListener('click', () => {
      if (iosModal) iosModal.classList.add('hidden');
    });
  }
  if (iosModal) {
    iosModal.addEventListener('click', (e) => {
      if (e.target === iosModal) iosModal.classList.add('hidden');
    });
  }

  // 4. Web Share Target Handler
  checkSharedFiles(onSharedFilesReceived);
}

async function checkSharedFiles(onSharedFilesReceived) {
  const urlParams = new URLSearchParams(window.location.search);
  if (!urlParams.has('shared') || !('caches' in window)) return;

  try {
    const cache = await caches.open('encre-video-shared-files');
    const requests = await cache.keys();
    const loadedFiles = [];

    for (const req of requests) {
      const response = await cache.match(req);
      if (response) {
        const blob = await response.blob();
        const rawName = response.headers.get('x-file-name') || 'shared-video';
        const fileName = decodeURIComponent(rawName);
        const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });
        loadedFiles.push(file);
        await cache.delete(req);
      }
    }

    if (loadedFiles.length > 0 && typeof onSharedFilesReceived === 'function') {
      onSharedFilesReceived(loadedFiles);
    }
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (err) {
    console.warn('[Encre Vidéo] Error reading shared files:', err);
  }
}
