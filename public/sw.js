// ==================== Service Worker - 金价监控 ====================
const CACHE_NAME = 'gold-monitor-v8';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json'
];

// 安装事件 - 缓存资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// 网络请求拦截 - 网络优先策略
self.addEventListener('fetch', (event) => {
  // 只缓存 GET 请求的页面资源
  if (event.request.method !== 'GET') return;
  // 不缓存 API 请求
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// ==================== 推送通知处理 ====================
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = {
      title: '💰 金价更新',
      body: event.data ? event.data.text() : '有新的金价信息',
      tag: 'gold-fallback',
      renotify: true,
      silent: false,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      actions: []
    };
  }

  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    tag: data.tag || 'gold-price',
    renotify: data.renotify ?? true,
    silent: data.silent ?? false,
    requireInteraction: data.requireInteraction ?? false,
    vibrate: data.vibrate || [200, 100, 200],
    actions: data.actions || [],
    data: data.data || {}
  };

  // 对常驻通知做特殊处理：先关闭旧的，再创建新的
  // 这样确保内容100%更新，不会被浏览器"优化"掉
  if (data.persistent || data.tag === 'gold-persistent') {
    event.waitUntil(
      self.registration.getNotifications({ tag: 'gold-persistent' })
        .then(existingNotifications => {
          // 关闭所有旧的常驻通知
          existingNotifications.forEach(n => n.close());
          // 创建新的常驻通知
          return self.registration.showNotification(data.title, options);
        })
    );
  } else {
    // 普通告警通知，直接显示
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

// 通知点击处理
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  // 打开或聚焦应用窗口
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(event.notification.data?.url || '/');
        }
      })
  );
});

// 通知关闭
self.addEventListener('notificationclose', (event) => {
  // 可选: 记录用户关闭通知的行为
});
