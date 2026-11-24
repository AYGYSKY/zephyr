/* 防风 Zephyr · 终端站 Service Worker
   策略：cache-first。这套东西内容不会变，每次打开都从缓存读；
   更新时改 CACHE 版本号，旧的会在 activate 里被清掉。 */

var CACHE = 'zephyr-term-v1';

var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './qin/index.html',
  './voice/index.html',
  './letter/index.html',
  './ticket/index.html',
  './crossroad/index.html',
  './sticker/index.html',
  './baocaiming/index.html',
  './daily/index.html',
  './card/index.html'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 逐个 add，单独失败不影响整体 */
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === 'basic') {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function () {
        /* 离线且没缓存：返回首页，至少不是浏览器默认错误页 */
        return caches.match('./index.html');
      });
    })
  );
});
