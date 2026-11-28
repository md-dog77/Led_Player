const SHELL_CACHE = 'ledmusic-shell-v3.7';
const OFFLINE_AUDIO_CACHE = 'ledmusic-offline-audio-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/favicon.ico',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== OFFLINE_AUDIO_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Поддержка HTTP Range (206 Partial Content), чтобы офлайн-треки идеально перематывались на iOS и Android
async function serveRangeResponse(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;

  const buf = await cachedResponse.arrayBuffer();
  const total = buf.byteLength;
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return cachedResponse;

  const start = Math.min(Number(match[1]), total - 1);
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  const chunk = buf.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(chunk.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Никогда не кэшируем запросы к Firebase / внешним API
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('lrclib.net') ||
    url.hostname.includes('wikipedia.org') ||
    url.hostname.includes('theaudiodb.com')
  ) {
    return;
  }

  // 1. Сначала проверяем сохранённые офлайн-треки и их обложки (поддержка Range 206)
  event.respondWith((async () => {
    const audioCache = await caches.open(OFFLINE_AUDIO_CACHE);
    const cachedAudio = await audioCache.match(req.url, { ignoreVary: true });
    if (cachedAudio) {
      return serveRangeResponse(req, cachedAudio);
    }

    // 2. HTML-навигация: сначала свежая сеть, при отсутствии интернета — кэш оболочки
    if (req.mode === 'navigate') {
      try {
        const netRes = await fetch(req);
        if (netRes && netRes.ok) {
          const shell = await caches.open(SHELL_CACHE);
          shell.put('./index.html', netRes.clone()).catch(() => {});
        }
        return netRes;
      } catch {
        const shell = await caches.open(SHELL_CACHE);
        return (await shell.match('./index.html')) || (await shell.match('./')) || Response.error();
      }
    }

    // 3. Локальные файлы сайта (Stale-While-Revalidate)
    if (url.origin === self.location.origin) {
      const shell = await caches.open(SHELL_CACHE);
      const cached = await shell.match(req);
      const netFetch = fetch(req).then((res) => {
        if (res && res.ok) shell.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || netFetch;
    }

    // 4. Остальные внешние ресурсы (аудиопоток, обложки) — напрямую из сети
    return fetch(req);
  })());
});
