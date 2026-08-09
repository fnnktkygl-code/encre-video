const CACHE_NAME = 'encre-video-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Handle Web Share Target POST requests
  if (event.request.method === 'POST' && url.pathname === '/') {
    event.respondWith((async () => {
      const formData = await event.request.formData();
      const mediaFiles = formData.getAll('media');
      
      // Store in Cache Storage temporarily for main page to retrieve
      const cache = await caches.open('encre-video-shared-files');
      for (let i = 0; i < mediaFiles.length; i++) {
        const file = mediaFiles[i];
        if (file && file.size > 0) {
          const fileUrl = `/shared-video-${Date.now()}-${i}`;
          await cache.put(fileUrl, new Response(file, {
            headers: {
              'content-type': file.type || 'video/mp4',
              'x-file-name': encodeURIComponent(file.name || 'shared-video')
            }
          }));
        }
      }
      return Response.redirect('/?shared=true', 303);
    })());
    return;
  }

  // Handle GET requests (Cache First with Network Fallback for app shell, Network first for models/external scripts)
  if (event.request.method === 'GET') {
    if (url.origin !== location.origin) {
      // External scripts / models (e.g. TensorFlow cdn)
      event.respondWith(
        caches.match(event.request).then((cached) => {
          return cached || fetch(event.request).then((res) => {
            if (res && res.status === 200) {
              const resClone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
            }
            return res;
          });
        })
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }

        return fetch(event.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return networkResponse;
        }).catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
        });
      })
    );
  }
});
