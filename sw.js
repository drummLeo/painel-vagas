// Service worker do Painel: guarda o app para abrir sem rede e mostra as notificações push.
const CACHE = 'painel-v27';
const SHARE = 'painel-compartilhado';  // texto recebido pelo "Compartilhar" do Android, até o app ler
const LIVRO = 'painel-livro';          // o livro de estudo, gravado pelo app para abrir sem rede
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE && k !== LIVRO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Arquivos do próprio app: rede primeiro (para receber atualizações), cache se estiver sem rede.
// "no-cache" revalida com o servidor: o GitHub Pages manda guardar por 10 min, o que mostrava a versão velha.
// Os dados vêm da API do GitHub e nunca são guardados aqui.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // "Compartilhar → Painel" no Android (share_target do manifest): o texto fica só neste aparelho, num
  // cache que o app lê ao abrir; nada vai para a rede.
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/compartilhar')) {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const dado = Object.fromEntries(['title', 'text', 'url'].map(k => [k, String(form.get(k) || '')]));
      await (await caches.open(SHARE)).put('compartilhado', new Response(JSON.stringify(dado)));
      return Response.redirect(new URL('./#vagas', self.registration.scope).href, 303);
    })());
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    .then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
      return res;
    })
    .catch(() => caches.match(event.request, { ignoreSearch: true }).then(r => r || caches.match('./'))));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',            // ícone roxo-branco na barra de status do Android
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),            // a mesma tag substitui o aviso anterior e avisa de novo
    requireInteraction: Boolean(data.important),  // retorno de candidatura: fica até ser tocado
    vibrate: data.important ? [300, 120, 300, 120, 300] : [150],
    timestamp: Date.now(),
    data: { url: data.url || '#inicio' },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'Painel', options),
    self.clients.matchAll({ type: 'window' }).then(list => list.forEach(c => c.postMessage({ type: 'push' }))),
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#inicio';
  const target = new URL(hash, self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ type: 'open', hash });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
