// ====================================================
// sw.js — Service Worker للدعم دون اتصال (PWA)
//
// الاستراتيجية: Cache-First للملفات الثابتة
//               Network-First لطلبات API
// ====================================================

var CACHE_NAME = 'dop-v1';

// الملفات الثابتة التي نُخزّنها محلياً
var STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/api.js',
  './js/app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800&display=swap',
  'https://fonts.googleapis.com/icon?family=Material+Icons',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ── التثبيت: تخزين الملفات الثابتة ──
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    }).catch(function (err) {
      console.warn('[SW] فشل تخزين بعض الملفات:', err);
    })
  );
  self.skipWaiting();
});

// ── التنشيط: حذف الكاشات القديمة ──
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ── الاعتراض: Cache-First للأصول، Network-Only لـ API ──
self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // طلبات API تمر دائماً عبر الشبكة (لا تُخزَّن)
  if (event.request.method === 'POST') {
    return; // دع المتصفح يتولى طلبات POST
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;

      return fetch(event.request).then(function (response) {
        // خزّن فقط الردود الناجحة للملفات من نفس الأصل
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    }).catch(function () {
      // في حال فشل الشبكة وعدم وجود كاش، أعد index.html
      if (event.request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});
