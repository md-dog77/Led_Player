const STATIC_CACHE = 'ledmusic-static-v3';
const AUDIO_CACHE = 'ledmusic-offline-audio-v1';
const APP_SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== STATIC_CACHE && k !== AUDIO_CACHE)
                    .map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

async function serveCachedAudio(request, cachedResponse) {
    const rangeHeader = request.headers.get('range');
    if (!rangeHeader) return cachedResponse;

    const buf = await cachedResponse.arrayBuffer();
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) return cachedResponse;

    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), buf.byteLength - 1) : buf.byteLength - 1;
    return new Response(buf.slice(start, end + 1), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
            'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes'
        }
    });
}

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = e.request.url;

    if (url.includes('cloudinary.com')) {
        e.respondWith(
            caches.open(AUDIO_CACHE).then(async (cache) => {
                const cached = await cache.match(e.request.url);
                if (cached) return serveCachedAudio(e.request, cached);
                return fetch(e.request);
            })
        );
        return;
    }

    if (
        url.includes('firestore') ||
        url.includes('googleapis') ||
        url.includes('lrclib.net') ||
        url.includes('manifest.json') ||
        url.includes('/assets/')
    ) return;

    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok && e.request.mode === 'navigate') {
                    const clone = res.clone();
                    caches.open(STATIC_CACHE).then((c) => c.put('./index.html', clone)).catch(() => {});
                }
                return res;
            })
            .catch(async () => {
                const matched = await caches.match(e.request);
                if (matched) return matched;
                if (e.request.mode === 'navigate') return caches.match('./index.html');
                return Response.error();
            })
    );
});
