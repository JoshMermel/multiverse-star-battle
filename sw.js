// Service worker for offline play.
//
// Two kinds of content, two different update strategies:
//
//  - App shell (HTML/CSS/JS + Firebase SDK): served instantly from cache.
//    Whenever the app is opened with a connection, the ENTIRE shell is
//    re-fetched fresh in the background as one batch, and only written
//    into the cache if every single file in the batch succeeds. This is
//    deliberately NOT per-file stale-while-revalidate: these files call
//    into each other, so refreshing them independently could leave a
//    mismatched mix of old and new files cached (e.g. a new script.js
//    expecting a method an old cached history.js doesn't have yet). Doing
//    the whole batch together means you either get the fully-new set or
//    you keep the fully-old set — never a partial mix. No manual version
//    bump needed for routine deploys; SHELL_CACHE_NAME only needs bumping
//    for a rare hard reset (e.g. restructuring which files exist).
//
//  - Puzzle data (data/manifest.json, data/*.csv): each file is
//    independent (one book's CSV doesn't call into another's), so plain
//    per-file stale-while-revalidate is safe here — serve cached
//    immediately, refresh that one file in the background.
const SHELL_CACHE_NAME = 'msb-shell-v3';
const DATA_CACHE_NAME = 'msb-data-v1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './renderer.js',
  './input.js',
  './puzzle-loader.js',
  './rules.js',
  './history.js',
  './storage.js',
  './solver.js',
  './solver-core.js',
  './solver-rules-common.js',
  './solver-rules-single.js',
  './solver-rules-multi.js',
  './constants.js',
  './geometry.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js',
];

function isDataRequest(url) {
  return url.pathname.includes('/data/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME)
      .then((cache) => Promise.all(
        // Cache each file independently so one bad/renamed URL doesn't
        // block the whole app shell from precaching on first install.
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] precache failed:', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        // Only clean up old *shell* caches. Data caches are left alone on
        // purpose, so an app-code update never wipes out puzzle books
        // you've already cached for offline play.
        keys
          .filter((k) => k.startsWith('msb-shell-') && k !== SHELL_CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Refresh the entire app shell together, atomically: fetch every file
// fresh, and only commit any of them to the cache once ALL of them have
// succeeded. If anything fails (offline, one file 404s, etc.), the whole
// refresh is aborted and the existing cached shell is left completely
// untouched — never partially overwritten.
let shellUpdateInFlight = null;
function updateShellCacheAtomically() {
  if (shellUpdateInFlight) return shellUpdateInFlight; // de-dupe concurrent triggers
  shellUpdateInFlight = (async () => {
    try {
      const fetched = await Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'no-store' }).then((res) => {
            if (!res.ok) throw new Error(`Bad response (${res.status}) for ${url}`);
            return [url, res];
          })
        )
      );
      // Every file fetched successfully — now write them all in together.
      const cache = await caches.open(SHELL_CACHE_NAME);
      await Promise.all(fetched.map(([url, res]) => cache.put(url, res)));
    } catch (err) {
      console.warn('[sw] shell refresh skipped (staying on cached version):', err);
    } finally {
      shellUpdateInFlight = null;
    }
  })();
  return shellUpdateInFlight;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (isDataRequest(url)) {
    // Per-file stale-while-revalidate: safe here since each data file is
    // independent of the others.
    event.respondWith(
      caches.open(DATA_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);

        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null); // offline — nothing more to do here

        if (cached) {
          event.waitUntil(networkFetch);
          return cached;
        }

        const res = await networkFetch;
        if (res) return res;
        throw new Error('Offline and no cached copy of ' + req.url);
      })
    );
    return;
  }

  // App shell: serve from cache instantly. Once per navigation to the
  // page itself, also kick off the atomic whole-shell background refresh
  // described above, so routine deploys are picked up automatically
  // without ever needing a manual cache-name bump.
  if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
    event.waitUntil(updateShellCacheAtomically());

    // This is a single-page app: every URL, whatever its query string
    // (?book=..., ?puzzle=...), serves the exact same index.html, with
    // routing handled entirely client-side by script.js reading
    // location.search. So navigation always resolves against the ONE
    // cached document, ignoring the query string entirely -- caching each
    // visited URL as its own separate entry would both (a) grow the shell
    // cache unboundedly as new query-string combinations get visited, and
    // (b) mean a deep link with a never-before-seen query string (e.g. a
    // puzzle shared by a friend, opened for the first time with no
    // connection) fails outright with a bare network error instead of
    // loading the identical cached shell, which would run it just fine.
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      // Not in cache at all (shouldn't normally happen for shell files
      // after install, but cover it) — fetch from network and cache it.
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
