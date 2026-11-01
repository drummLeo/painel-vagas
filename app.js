'use strict';
// Painel: lê os dados do bot (repositório privado) pela API do GitHub com o token salvo neste
// aparelho, e grava as marcações (vagas, retornos lidos, respostas do treino) em app/marcacoes.json.
// O código não contém nenhum dado: repositório e token ficam só no armazenamento local do navegador.

const $ = (sel, el = document) => el.querySelector(sel);
const PREFIX = 'painel:';
const store = {
  get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* armazenamento cheio ou bloqueado */ } },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch { /* idem */ } },
};
const MARKS_PATH = 'app/marcacoes.json';
const TREINO_KEEP_DAYS = 14;

const S = {
  cfg: store.get('cfg', null),            // {repo, token, branch}
  data: store.get('data', {}),            // últimos dados lidos (servem também sem rede)
  marks: normMarks(store.get('marks', null)),
  dirty: store.get('dirty', false),       // marcações locais ainda não gravadas no repositório
  loading: false,
  error: '',
  reveal: false,
  vagasFiltro: store.get('vagasFiltro', 'novas'),
  vagasNivel: store.get('vagasNivel', []),       // níveis/cargos marcados no filtro (nenhum = todas)
  retornosFiltro: store.get('retornosFiltro', 'avancos'),
  vagasVisto: store.get('vagasVisto', ''),        // encontrada_em mais recente já vista
  vagasVistoAntes: store.get('vagasVisto', ''),   // o de antes desta visita: marca as novas
  pushState: 'checking',
  pushId: '',                              // hash da inscrição de push deste aparelho
  route: '',
  studyOpen: new Set(),                    // baralhos e cartões abertos no Material de estudo (sobrevive ao redesenho)
};

// ---------- utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ALLOWED = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', CODE: 'code' };
function richText(s) {
  // os cartões usam <b>, <i> e <code>; qualquer outra marcação vira texto
  const doc = new DOMParser().parseFromString(`<body>${s ?? ''}</body>`, 'text/html');
  const walk = node => [...node.childNodes].map(n => {
    if (n.nodeType === 3) return esc(n.textContent);
    if (n.nodeType !== 1) return '';
    const tag = ALLOWED[n.tagName];
    return tag ? `<${tag}>${walk(n)}</${tag}>` : walk(n);
  }).join('');
  return walk(doc.body);
}
function todayBRT() { return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); }
function addDays(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function rel(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  if (min < 48 * 60) return 'ontem';
  const d = new Date(t - 3 * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function domain(email) { return (email || '').split('@')[1] || ''; }
function normMarks(m) {
  m = m && typeof m === 'object' ? m : {};
  return { vagas: m.vagas || {}, retornos_lidos: m.retornos_lidos || {}, treino: m.treino || {} };
}
function deepMerge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k], v) : v;
  return out;
}
function b64decode(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function urlB64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- API do GitHub ----------
async function gh(path, { method = 'GET', body, raw = false, blob = false } = {}) {
  const url = `https://api.github.com/repos/${S.cfg.repo}${path ? '/' + path : ''}`;
  const headers = {
    Authorization: `Bearer ${S.cfg.token}`,
    Accept: raw || blob ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const err = new Error(`GitHub respondeu ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  if (blob) return res.blob();
  return raw ? res.text() : res.json();
}
async function readJson(path, fallback) {
  try { return JSON.parse(await gh(`contents/${encodeURI(path)}`, { raw: true })); }
  catch (e) { if (e.status === 404) return fallback; throw e; }
}
async function getFile(path) {
  try {
    const j = await gh(`contents/${encodeURI(path)}`);
    return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
  } catch (e) { if (e.status === 404) return null; throw e; }
}
// PDFs de explicação: cartoes/pdf/<id>_<assunto>.pdf no repositório do bot
async function listPdfs() {
  try {
    const out = {};
    for (const f of await gh('contents/cartoes/pdf')) {
      if (f.type === 'file' && /\.pdf$/i.test(f.name)) out[f.name.replace(/\.pdf$/i, '').split('_')[0]] = { name: f.name, path: f.path };
    }
    return out;
  } catch (e) { if (e.status === 404) return {}; throw e; }
}
function putFile(path, data, sha, message) {
  const body = { message, content: b64encode(JSON.stringify(data, null, 1) + '\n') };
  if (sha) body.sha = sha;
  if (S.cfg.branch) body.branch = S.cfg.branch;
  return gh(`contents/${encodeURI(path)}`, { method: 'PUT', body });
}
function errText(e) {
  if (e instanceof TypeError) return 'Sem conexão. Mostrando os últimos dados.';
  if (e.status === 401) return 'Token inválido ou expirado. Crie outro e cole em Ajustes.';
  if (e.status === 403) return 'O token não tem permissão para isso (ou a API limitou os pedidos).';
  if (e.status === 404) return 'Repositório não encontrado, ou o token não tem acesso a ele.';
  return e.message || 'Erro inesperado.';
}

// ---------- dados ----------
async function loadAll() {
  if (!S.cfg || S.loading) return;
  S.loading = true;
  S.error = '';
  renderSync();
  try {
    const cardsFresh = S.data.cards && Date.now() - (S.data.cardsAt || 0) < 6 * 3600e3;
    const [vagas, retornos, treino, status, push, appcfg, cards, pdfs, marks] = await Promise.all([
      readJson('data/vagas.json', []), readJson('data/retornos.json', []), readJson('data/treino.json', null),
      readJson('data/status.json', null), readJson('data/push.json', null), readJson('data/app-config.json', {}),
      cardsFresh ? S.data.cards : readJson('cartoes/entrevista.json', null),
      cardsFresh && S.data.pdfs ? S.data.pdfs : listPdfs(), getFile(MARKS_PATH),
    ]);
    Object.assign(S.data, { vagas, retornos, treino, status, push, appcfg, at: Date.now() });
    if (!cardsFresh || !S.data.pdfs) Object.assign(S.data, { cards, pdfs, cardsAt: Date.now() });
    const remote = marks ? marks.data : {};
    S.marks = normMarks(S.dirty ? deepMerge(remote, S.marks) : remote);
    store.set('data', S.data);
    store.set('marks', S.marks);
    if (S.dirty) scheduleSave(500);
    autoRun();
  } catch (e) {
    S.error = errText(e);
  }
  S.loading = false;
  render();
}

let saveTimer;
function scheduleSave(ms = 2500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMarks, ms);
}
function pruneMarks(m) {
  const cutoff = addDays(todayBRT(), -TREINO_KEEP_DAYS);
  for (const day of Object.keys(m.treino)) if (day < cutoff) delete m.treino[day];
  const vagas = new Set((S.data.vagas || []).map(v => v.id));
  if (vagas.size) for (const id of Object.keys(m.vagas)) if (!vagas.has(id)) delete m.vagas[id];
  const retornos = new Set((S.data.retornos || []).map(r => r.id));
  if (retornos.size) for (const id of Object.keys(m.retornos_lidos)) if (!retornos.has(id)) delete m.retornos_lidos[id];
  return m;
}
async function saveMarks() {
  if (!S.cfg || !S.dirty) return;
  // relê antes de gravar: outro aparelho pode ter gravado; 409/422 = alguém gravou no meio, tenta de novo
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const remote = await getFile(MARKS_PATH);
      const merged = pruneMarks(normMarks(deepMerge(remote ? remote.data : {}, S.marks)));
      await putFile(MARKS_PATH, merged, remote && remote.sha, 'painel: marcações');
      S.marks = merged;
      S.dirty = false;
      store.set('marks', S.marks);
      store.set('dirty', false);
      renderSync();
      return;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      S.error = errText(e);
      renderSync();
      return;
    }
  }
}
function setMarks(fn) {
  fn(S.marks);
  S.dirty = true;
  store.set('marks', S.marks);
  store.set('dirty', true);
  scheduleSave();
  render();
}

// ---------- derivados ----------
// Tipos de e-mail de candidatura. Só os de avanço contam como "novo" e ganham destaque.
const TIPOS = {
  aprovado: { label: '🎉 Avançou', cls: 'ok', avanco: true },
  avancou: { label: '🎉 Avançou', cls: 'ok', avanco: true },  // nome antigo de "aprovado"
  entrevista: { label: '🗓 Entrevista', cls: 'ok', avanco: true },
  teste: { label: '📝 Teste', cls: 'ok', avanco: true },
  pendente: { label: '⏳ Inscrição incompleta', cls: 'warn', destaque: true },
  inscricao: { label: '✅ Inscrição confirmada', cls: 'brand' },
  reprovado: { label: 'Não seguiu', cls: 'bad' },
};
const tipoDe = r => TIPOS[r.tipo] || { label: 'Candidatura', cls: 'brand' };
const quando = r => r.data_email || r.recebido_em;
const isUnread = r => !r.antigo && !S.marks.retornos_lidos[r.id];  // os do histórico já entram como lidos
function unreadRetornos() { return (S.data.retornos || []).filter(isUnread); }
// Último e-mail de candidatura de cada vaga (o bot liga o e-mail à vaga pelo título e pela empresa).
function retornoPorVaga() {
  const map = {};
  for (const r of S.data.retornos || []) {
    for (const id of r.vaga_ids || (r.vaga_id ? [r.vaga_id] : [])) {  // a mesma vaga pode ter vindo em vários alertas
      if (!map[id] || quando(r) > quando(map[id])) map[id] = r;
    }
  }
  return map;
}
// Status da vaga: o que você marcou; senão "candidatei" se chegou e-mail da candidatura.
// "nenhuma" é você desmarcando uma vaga que o bot tinha marcado sozinho.
function vagaStatus(id, links = retornoPorVaga()) {
  const m = S.marks.vagas[id];
  if (m === 'nenhuma') return '';
  return m || (links[id] ? 'candidatei' : '');
}
function newVagas() {
  const links = retornoPorVaga();
  return (S.data.vagas || []).filter(v => !vagaStatus(v.id, links) && v.encontrada_em > S.vagasVisto);
}
function treinoInfo() {
  const t = S.data.treino, deck = S.data.cards;
  if (!t || !deck || !Array.isArray(t.cartoes)) return null;
  const byId = Object.fromEntries(deck.cartoes.map(c => [c.id, c]));
  const answers = { ...(S.marks.treino[t.dia] || {}), ...(t.respondidos || {}) };  // o que o bot já leu prevalece
  const ids = t.cartoes.filter(id => byId[id]);
  const done = ids.filter(id => id in answers).length;
  const meta = t.meta || ids.length;
  const isToday = t.dia === todayBRT();
  const serverMet = (t.feitos_hoje || 0) >= meta;
  const met = serverMet || done >= meta;
  return {
    t, byId, ids, answers, done, meta, isToday, met, labels: deck.baralhos || {},
    next: ids.find(id => !(id in answers)),
    left: Math.max(0, meta - Math.max(done, t.feitos_hoje || 0)),
    sequencia: (t.sequencia || 0) + (met && !serverMet && isToday ? 1 : 0),
  };
}

// ---------- telas ----------
const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 23c-4.4 0-8-3.1-8-7.5 0-3.4 2.2-5.6 3.9-7.4.4 1.9 1.4 3.2 2.6 3.9C10 7.6 11.6 4 15 1c-.3 3.4 1 5.6 2.6 7.6 1.4 1.8 2.4 3.6 2.4 6.4 0 4.4-3.6 8-8 8z"/></svg>';
const WEEKDAY = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function todayPanel(info) {
  const days = (info.t.ultimos7 || []).map((d, i, arr) => {
    const wd = WEEKDAY[new Date(d.dia + 'T12:00:00Z').getUTCDay()];
    if (i === arr.length - 1) {
      const p = Math.min(1, Math.max(info.done, d.n) / info.meta);
      return `<div class="day"><span class="dot ${p >= 1 ? 'done' : 'now'}" style="--p:${p}"></span>${wd}</div>`;
    }
    return `<div class="day"><span class="dot ${d.n >= info.meta ? 'done' : ''}"></span>${wd}</div>`;
  }).join('');
  const pct = Math.round(Math.min(1, Math.max(info.done, info.t.feitos_hoje || 0) / info.meta) * 100);
  return `<div class="today">
    <div class="streak ${info.sequencia ? '' : 'cold'}">${FLAME}<div><b>${info.sequencia}</b><span>${info.sequencia === 1 ? 'dia seguido' : 'dias seguidos'}</span></div></div>
    <div class="week" aria-label="Últimos 7 dias">${days}</div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
  </div>`;
}

function retornoCard(r) {
  const tipo = tipoDe(r);
  const ok = tipo.avanco;
  const unread = isUnread(r);
  const quem = r.nome ? `${r.nome}${r.email ? ` (${domain(r.email)})` : ''}` : r.email;
  return `<article class="panel ${unread && ok ? 'hl' : ''} ${unread && tipo.destaque ? 'hl-warn' : ''}">
    <div class="row"><span class="pill ${tipo.cls}">${tipo.label}</span>
      <span class="meta">${unread ? '<span class="newdot"></span>' : ''}${esc(rel(quando(r)))}</span></div>
    <h2>${esc(r.assunto || '(sem assunto)')}</h2>
    <div class="meta">${esc(quem)}</div>
    ${r.trecho ? `<p class="quote ${ok ? '' : 'neutral'}">“${esc(r.trecho)}”</p>` : ''}
    ${mailDetails(r)}
    <div class="btns">
      ${gmailButton(r, 'btn primary')}
      ${unread ? `<button class="btn" data-act="read" data-id="${esc(r.id)}">Marcar como lido</button>` : ''}
    </div>
  </article>`;
}

function viewWelcome() {
  return `<h1>Bem-vindo ao Painel</h1>
  <p class="lede">Para começar, conecte o repositório do bot em Ajustes.</p>
  <a class="btn primary" href="#ajustes">Ir para Ajustes</a>`;
}

function viewInicio() {
  const parts = [];
  const unread = unreadRetornos();
  if (myPush() && myPush().expirado) {
    parts.push(`<div class="panel alert"><h2>As notificações pararam</h2><p class="lede">O Android cancelou a inscrição. Reative em Ajustes.</p><a class="btn" href="#ajustes">Reativar</a></div>`);
  } else if (S.pushState === 'off' || S.pushState === 'denied') {
    parts.push(`<div class="panel alert"><h2>Notificações desligadas</h2><p class="lede">Ative para o celular avisar retornos, vagas e o treino.</p><a class="btn" href="#ajustes">Ativar</a></div>`);
  }
  if (unread.length) {
    parts.push(`<p class="eyebrow">${plural(unread.length, 'retorno novo', 'retornos novos')}</p>`);
    parts.push(...unread.slice(0, 3).map(retornoCard));
    if (unread.length > 3) parts.push(`<a class="btn" href="#retornos">Ver todos os retornos</a>`);
  }
  const info = treinoInfo();
  if (info) {
    const cta = info.met ? '<p class="lede">Treino de hoje completo. 🔥</p>'
      : `<a class="btn primary" href="#treino">Treinar agora · ${plural(info.left, 'cartão', 'cartões')}</a>`;
    parts.push(`<section class="panel"><div class="row"><h2>Treino de entrevista</h2><span class="meta">${Math.max(info.done, info.t.feitos_hoje || 0)} de ${info.meta} hoje</span></div>${todayPanel(info)}${cta}</section>`);
  }
  const novas = newVagas();
  const titles = novas.slice(0, 3).map(v => `<li>${esc(v.titulo)}${v.empresa ? ` · <span class="meta">${esc(v.empresa)}</span>` : ''}</li>`).join('');
  parts.push(`<section class="panel"><div class="row"><h2>Vagas</h2>${novas.length ? `<span class="pill brand">${novas.length} novas</span>` : ''}</div>
    ${novas.length ? `<ul class="list" style="margin:0;padding-left:18px;gap:4px">${titles}</ul>` : '<p class="lede">Nenhuma vaga nova desde a última visita.</p>'}
    <a class="btn" href="#vagas">Ver vagas</a></section>`);
  const quebradas = Object.values((S.data.status && S.data.status.fontes) || {}).filter(f => f.falhas >= 2);
  if (quebradas.length) {
    parts.push(`<div class="panel alert"><h2>Fonte com problema</h2>${quebradas.map(f => `<p class="lede">${esc(f.rotulo)} falhou nas últimas ${f.falhas} execuções.</p>`).join('')}</div>`);
  }
  const inscricoes = (S.data.retornos || []).filter(r => r.tipo === 'inscricao').length;
  if (!unread.length && (S.data.retornos || []).length) {
    parts.push(`<p class="meta">Retornos anteriores${inscricoes ? ` e ${plural(inscricoes, 'inscrição confirmada', 'inscrições confirmadas')}` : ''} em <a href="#retornos">Retornos</a>.</p>`);
  }
  const bot = S.data.status && S.data.status.atualizado_em;
  parts.push(`<div class="row"><span class="meta">${bot ? `Bot rodou ${esc(rel(bot))}` : ''}</span>
    <button class="btn" data-act="refresh">Atualizar agora</button></div>`);
  return `<h1>Início</h1>${S.error ? `<div class="panel alert"><p class="lede">${esc(S.error)}</p></div>` : ''}${parts.join('')}`;
}

// No computador, o link abre a conversa no Gmail. No celular o Gmail ignora o link e abre só a
// caixa de entrada, então o botão copia o assunto para colar na busca do app do Gmail.
const IS_MOBILE = /Android|iPhone|iPad/.test(navigator.userAgent);
function gmailButton(r, cls) {
  if (IS_MOBILE) {
    return r.assunto ? `<button class="${cls}" data-act="copy" data-text="${esc(r.assunto)}" data-id="${esc(r.id)}">Copiar assunto</button>` : '';
  }
  return r.link ? `<a class="${cls}" href="${esc(r.link)}" target="_blank" rel="noopener" data-act="read" data-id="${esc(r.id)}">Abrir no Gmail</a>` : '';
}

// Texto do e-mail guardado pelo bot: abre aqui mesmo, sem depender do Gmail achar a mensagem.
function mailDetails(r) {
  if (!r.texto) return '';
  return `<details class="mail"><summary>Ver e-mail</summary><div class="mailtext">${esc(r.texto)}</div></details>`;
}

function inscricaoRow(r) {
  return `<article class="panel">
    <div class="row"><span class="pill ${tipoDe(r).cls}">${tipoDe(r).label}</span>
      <span class="meta">${isUnread(r) ? '<span class="newdot"></span>' : ''}${esc(rel(quando(r)))}</span></div>
    <h2>${esc(r.assunto || '(sem assunto)')}</h2>
    <div class="row"><span class="meta">${esc(r.nome || r.email)}</span>
      ${gmailButton(r, 'btn')}</div>
    ${mailDetails(r)}
  </article>`;
}

// Confirmações e rejeições contam como lidas depois de aparecerem na tela; avanços e inscrições
// incompletas só quando você abre ou marca, porque pedem alguma ação.
let autoReadTimer;
function autoRead(items) {
  const ids = items.filter(r => (r.tipo === 'inscricao' || r.tipo === 'reprovado') && isUnread(r)).map(r => r.id);
  clearTimeout(autoReadTimer);
  if (ids.length) autoReadTimer = setTimeout(() => setMarks(m => { for (const id of ids) m.retornos_lidos[id] = todayBRT(); }), 2000);
}

function viewRetornos() {
  const all = (S.data.retornos || []).slice().sort((a, b) => (quando(b) || '').localeCompare(quando(a) || ''));
  const groups = {
    avancos: all.filter(r => tipoDe(r).avanco),
    inscricoes: all.filter(r => r.tipo === 'inscricao' || r.tipo === 'pendente'),
    rejeicoes: all.filter(r => r.tipo === 'reprovado'),
  };
  const f = groups[S.retornosFiltro] ? S.retornosFiltro : 'avancos';
  const seg = [['avancos', 'Avanços'], ['inscricoes', 'Inscrições'], ['rejeicoes', 'Rejeições']].map(([k, label]) => {
    const novos = groups[k].filter(isUnread).length;
    return `<button data-act="rfiltro" data-f="${k}" aria-pressed="${f === k}">${novos ? '<span class="newdot"></span>' : ''}${label} <span class="n">${groups[k].length}</span></button>`;
  }).join('');
  const lede = {
    avancos: 'Aprovações, convites para entrevista e testes.',
    inscricoes: 'Inscrições confirmadas e as que ficaram por terminar.',
    rejeicoes: 'Processos que não seguiram.',
  }[f];
  const empty = {
    avancos: 'Nenhum avanço ainda. Quando um e-mail indicar aprovação, entrevista ou teste, ele aparece aqui e o celular avisa.',
    inscricoes: 'Nenhuma inscrição registrada nos últimos 90 dias.',
    rejeicoes: 'Nenhuma rejeição registrada.',
  }[f];
  const items = groups[f].map(r => (r.tipo === 'inscricao' ? inscricaoRow(r) : retornoCard(r))).join('');
  autoRead(groups[f]);
  return `<h1>Retornos</h1><div class="seg" role="group" aria-label="Tipo">${seg}</div>
  <p class="lede">${lede}</p>
  ${items ? `<div class="list">${items}</div>` : `<p class="empty">${empty}</p>`}`;
}

// Candidaturas feitas fora do bot (LinkedIn, Gupy, sites das empresas...), montadas pelos e-mails:
// o bot põe em cada e-mail a chave "candidatura" (empresa + cargo), que junta os e-mails do mesmo processo.
function candidaturasPorEmail() {
  const groups = {};
  for (const r of S.data.retornos || []) (groups[r.candidatura || r.id] ||= []).push(r);
  return Object.values(groups)
    .map(items => items.slice().sort((a, b) => (quando(b) || '').localeCompare(quando(a) || '')))
    .sort((a, b) => (quando(b[0]) || '').localeCompare(quando(a[0]) || ''));
}

function candidaturaCard(items) {
  const last = items[0];
  const vagaId = items.map(r => r.vaga_id).find(Boolean);
  const vaga = vagaId && (S.data.vagas || []).find(v => v.id === vagaId);
  const tipo = tipoDe(last);
  const empresa = items.map(r => r.empresa).find(Boolean) || last.nome || '';
  const titulo = items.map(r => r.cargo).find(Boolean) || (empresa ? `Candidatura na ${empresa}` : last.assunto) || '(sem assunto)';
  const history = items.map(r => `<li><div class="row"><span class="pill ${tipoDe(r).cls}">${tipoDe(r).label}</span>
      <span class="meta">${esc(rel(quando(r)))}</span></div>
      <div class="meta">${esc(r.assunto || '')}</div>${mailDetails(r)}<div class="btns">${gmailButton(r, 'btn')}</div></li>`).join('');
  return `<article class="panel">
    <div class="row"><span class="pill ${tipo.cls}">${tipo.label}</span><span class="meta">${esc(rel(quando(last)))}</span></div>
    <h2>${esc(titulo)}</h2>
    ${empresa ? `<div class="meta">${esc(empresa)}</div>` : ''}
    ${vaga && vaga.url ? `<div class="btns"><a class="btn" href="${esc(vaga.url)}" target="_blank" rel="noopener">Ver vaga</a></div>` : ''}
    <details class="mail"><summary>${items.length === 1 ? 'Ver e-mail' : `Ver os ${items.length} e-mails`}</summary>
      <ul class="list history">${history}</ul></details>
  </article>`;
}

// nível e cargo saem do título (sem acento e em minúsculas); uma vaga pode ter mais de um, como "Técnico de Suporte Jr"
const NIVEIS = [
  ['estagio', 'Estágio', /\b(estagi\w*|intern|interns|internship)\b/],
  ['trainee', 'Trainee', /\btrainee\b/],
  ['junior', 'Júnior', /\b(junior|jr|nivel (i|1)|n1)\b/],
  ['pleno', 'Pleno', /\b(pleno|mid-level)\b/],
  ['senior', 'Sênior', /\b(senior|sr)\b/],
  ['analista', 'Analista', /\b(analista|analyst)\b/],
  ['tecnico', 'Técnico', /\b(tecnic[oa]|technician)\b/],
  ['auxiliar', 'Auxiliar / assistente', /\b(auxiliar|assistente|assistant)\b/],
  ['dev', 'Desenvolvedor', /\b(desenvolvedor\w*|developer|programador\w*|engenheir[oa]\w*|engineer\w*)\b/],
  ['especialista', 'Especialista', /\b(especialista|specialist)\b/],
];
function niveisDe(titulo) {
  const t = String(titulo || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = NIVEIS.filter(([, , re]) => re.test(t)).map(([k]) => k);
  return out.length ? out : ['outras'];
}

function viewVagas() {
  const all = S.data.vagas || [];
  const links = retornoPorVaga();
  const porEmail = candidaturasPorEmail();
  const groups = {
    novas: all.filter(v => !vagaStatus(v.id, links)),
    // ligadas a um e-mail de candidatura aparecem uma vez só, no cartão da candidatura (com "Ver vaga")
    candidatei: all.filter(v => vagaStatus(v.id, links) === 'candidatei' && !links[v.id]),
    descartada: all.filter(v => vagaStatus(v.id, links) === 'descartada'),
  };
  const counts = { ...Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) };
  counts.candidatei += porEmail.length;
  const f = groups[S.vagasFiltro] ? S.vagasFiltro : 'novas';
  const seg = [['novas', 'Novas'], ['candidatei', 'Candidatei'], ['descartada', 'Descartadas']].map(([k, label]) =>
    `<button data-act="filtro" data-f="${k}" aria-pressed="${f === k}">${label} <span class="n">${counts[k]}</span></button>`).join('');
  // filtro de nível/cargo, dentro da aba escolhida; vale também para as candidaturas vindas do e-mail
  const tituloCand = items => items.map(r => r.cargo).find(Boolean)
    || ((S.data.vagas || []).find(v => v.id === items.map(r => r.vaga_id).find(Boolean)) || {}).titulo || '';
  const sel = S.vagasNivel.filter(k => k === 'outras' || NIVEIS.some(([n]) => n === k));
  const nivelCount = {};
  const doGrupo = [...groups[f].map(v => niveisDe(v.titulo)), ...(f === 'candidatei' ? porEmail.map(c => niveisDe(tituloCand(c))) : [])];
  for (const ks of doGrupo) for (const k of ks) nivelCount[k] = (nivelCount[k] || 0) + 1;
  const passa = titulo => !sel.length || niveisDe(titulo).some(k => sel.includes(k));
  const opcoes = [...NIVEIS.map(([k, label]) => [k, label]), ['outras', 'Outras']].filter(([k]) => nivelCount[k] || sel.includes(k));
  const niveis = opcoes.length > 1 || sel.length ? `<div class="niveis" role="group" aria-label="Nível e cargo">
      <button data-act="nivel" data-f="" aria-pressed="${!sel.length}">Todas</button>
      ${opcoes.map(([k, label]) => `<button data-act="nivel" data-f="${k}" aria-pressed="${sel.includes(k)}">${label} <span class="n">${nivelCount[k] || 0}</span></button>`).join('')}
    </div>` : '';
  const extra = f === 'candidatei' ? porEmail.filter(c => passa(tituloCand(c))).map(candidaturaCard).join('') : '';
  const items = extra + groups[f].filter(v => passa(v.titulo)).slice(0, 150).map(v => {
    const st = vagaStatus(v.id, links);
    const isNew = v.encontrada_em > S.vagasVistoAntes && !st;
    const where = [v.empresa, v.local, v.modelo_texto].filter(Boolean).join(' · ');
    const r = links[v.id];
    return `<article class="panel job ${st === 'descartada' ? 'done' : ''}">
      ${r ? `<div class="row"><a class="pill ${tipoDe(r).cls}" href="#retornos" style="text-decoration:none">${tipoDe(r).label}</a><span class="meta">${esc(rel(quando(r)))}</span></div>` : ''}
      <h2>${isNew ? '<span class="newdot" title="Nova"></span>' : ''}${esc(v.titulo)}</h2>
      ${where ? `<div class="meta">${esc(where)}</div>` : ''}
      <div class="meta">${esc(v.fonte)} · encontrada ${esc(rel(v.encontrada_em))}</div>
      <div class="btns">
        ${v.url ? `<a class="btn primary" href="${esc(v.url)}" target="_blank" rel="noopener">Ver vaga</a>` : ''}
        <button class="btn ok" data-act="vaga" data-id="${esc(v.id)}" data-v="candidatei" aria-pressed="${st === 'candidatei'}">Candidatei</button>
        <button class="btn warn" data-act="vaga" data-id="${esc(v.id)}" data-v="descartada" aria-pressed="${st === 'descartada'}">Descartar</button>
      </div></article>`;
  }).join('');
  const emptyAba = { novas: 'Nenhuma vaga sem marcação. As novas aparecem aqui a cada 2 horas.',
    candidatei: 'Nenhuma candidatura ainda. Elas aparecem aqui quando chega o e-mail de inscrição, ou quando você marca "Candidatei" numa vaga.',
    descartada: 'Nenhuma vaga descartada.' }[f];
  const empty = sel.length && doGrupo.length ?'Nenhuma vaga desta aba com os níveis escolhidos. Toque em "Todas" para ver todas.' : emptyAba;
  return `<h1>Vagas</h1><div class="seg" role="group" aria-label="Filtro">${seg}</div>
    ${niveis}
    ${items ?`<div class="list">${items}</div>` : `<p class="empty">${empty}</p>`}
    <p class="meta">As vagas ficam aqui por 30 dias depois de encontradas.</p>`;
}

function pdfButton(id) {
  if (!(S.data.pdfs || {})[id]) return '';
  return `<button class="btn" data-act="pdf" data-id="${esc(id)}">📄 Explicação completa (PDF)</button>`;
}

// todos os cartões, por baralho: a resposta resumida abre no próprio app e o PDF traz a explicação completa
function studyLibrary() {
  const deck = S.data.cards;
  if (!deck || !Array.isArray(deck.cartoes)) return '';
  const labels = deck.baralhos || {};
  const groups = {};
  for (const c of deck.cartoes) (groups[c.deck] ||= []).push(c);
  const decks = Object.keys(labels).filter(k => groups[k]).concat(Object.keys(groups).filter(k => !(k in labels)));
  const nPdf = deck.cartoes.filter(c => (S.data.pdfs || {})[c.id]).length;
  const body = decks.map(k => {
    const items = groups[k].map(c => `<details class="study" data-open="${esc(c.id)}"${S.studyOpen.has(c.id) ? ' open' : ''}>
        <summary>${richText(c.q)}</summary>
        <ul class="answer">${(c.a || []).map(x => `<li>${richText(x)}</li>`).join('')}</ul>
        ${c.extra ? `<div class="note"><strong>Se aprofundarem</strong>${richText(c.extra)}</div>` : ''}
        ${pdfButton(c.id)}
      </details>`).join('');
    return `<details class="deck" data-open="deck:${esc(k)}"${S.studyOpen.has('deck:' + k) ? ' open' : ''}>
      <summary>${esc(labels[k] || k)} <span class="meta">${plural(groups[k].length, 'cartão', 'cartões')}</span></summary>
      <div class="study-list">${items}</div></details>`;
  }).join('');
  return `<section class="panel"><div class="row"><h2>Material de estudo</h2><span class="meta">${nPdf ? `${plural(nPdf, 'PDF', 'PDFs')}` : ''}</span></div>
    <p class="lede">Todos os cartões: toque na pergunta para ver a resposta resumida e, quando houver, abra o PDF com a explicação completa.</p>
    ${body}</section>`;
}

function viewTreino() {
  const info = treinoInfo();
  if (!info) return `<h1>Treino</h1><p class="empty">Os cartões aparecem depois da próxima execução do bot.</p>${studyLibrary()}`;
  const parts = [`<h1>Treino</h1>`, `<section class="panel">${todayPanel(info)}</section>`];
  if (!info.isToday) {
    parts.push(`<div class="panel alert"><p class="lede">Estes são os cartões de ${esc(info.t.dia.split('-').reverse().slice(0, 2).join('/'))}. Os de hoje chegam na próxima execução do bot.</p><button class="btn" data-act="refresh">Atualizar agora</button></div>`);
  }
  if (info.next) {
    const c = info.byId[info.next];
    const pos = info.ids.indexOf(info.next) + 1;
    const answer = S.reveal ? `<ul class="answer anim">${c.a.map(x => `<li>${richText(x)}</li>`).join('')}</ul>` : '';
    const notes = S.reveal ? [
      c.extra ? `<div class="note"><strong>Se aprofundarem</strong>${richText(c.extra)}</div>` : '',
      c.check ? `<div class="note check"><strong>Confira antes</strong>${richText(c.check)}</div>` : '',
      pdfButton(c.id),
    ].join('') : '';
    const foot = S.reveal
      ? `${notes}<div class="btns two"><button class="btn warn" data-act="answer" data-id="${esc(c.id)}" data-knew="0">🔁 Preciso revisar</button><button class="btn ok" data-act="answer" data-id="${esc(c.id)}" data-knew="1">✅ Já sei</button></div>`
      : `<p class="meta" style="margin:0">Responda em voz alta e só depois veja a resposta.</p><button class="btn primary" data-act="reveal">Mostrar resposta</button>`;
    parts.push(`<article class="flash">
      <div class="flash-head"><span><span class="tag">${esc(info.labels[c.deck] || c.deck)}</span> · ${pos}/${info.ids.length}</span><span>alvo ${esc(c.tempo || '1 min')}</span></div>
      <div class="flash-body"><p class="q">${richText(c.q)}</p>${answer}</div>
      <div class="flash-foot">${foot}</div></article>`);
  } else {
    parts.push(`<div class="panel hl"><h2>🎉 Treino de hoje completo</h2><p class="lede">${info.sequencia ? `Sequência de ${plural(info.sequencia, 'dia', 'dias')}.` : ''} Os próximos cartões chegam amanhã; os que você marcou para revisar voltam antes.</p></div>`);
  }
  const chips = info.ids.map(id => {
    const a = info.answers[id];
    const cls = a === true ? 'ok' : a === false ? 'warn' : 'brand';
    const mark = a === true ? '✓' : a === false ? '↻' : '·';
    return `<span class="pill ${cls}" title="${esc(info.byId[id].q.replace(/<[^>]+>/g, ''))}">${mark} ${esc(info.labels[info.byId[id].deck] || '')}</span>`;
  }).join('');
  parts.push(`<div class="chips" aria-label="Cartões de hoje">${chips}</div>`);
  parts.push(studyLibrary());
  return parts.join('');
}

const pdfBlobs = new Map();  // path → Blob, para não baixar de novo na mesma sessão
async function openPdf(btn) {
  const f = (S.data.pdfs || {})[btn.dataset.id];
  if (!f) return;
  // no PC abre numa aba nova; ela precisa nascer no clique, senão o navegador bloqueia o pop-up depois da espera.
  // No celular o Chrome não mostra PDF dentro do app: baixa o arquivo e o Android abre no leitor de PDF.
  const tab = IS_MOBILE ? null : window.open('', '_blank');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Abrindo…';
  try {
    let blob = pdfBlobs.get(f.path);
    if (!blob) {
      blob = new Blob([await gh(`contents/${encodeURI(f.path)}`, { blob: true })], { type: 'application/pdf' });
      pdfBlobs.set(f.path, blob);
    }
    const url = URL.createObjectURL(blob);
    if (tab) {
      tab.location.href = url;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.append(a);
      a.click();
      a.remove();
      toast('PDF baixado. Toque na notificação de download para abrir.', 4000);
    }
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60e3);
  } catch (e) {
    if (tab) tab.close();
    toast(e.status === 404 ? 'PDF não encontrado. Toque em ↻ para atualizar a lista.' : errText(e), 4000);
    if (e.status === 404) S.data.cardsAt = 0;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function devicesList() {
  const subs = Object.entries((S.data.push && S.data.push.inscricoes) || {});
  if (!subs.length) return '';
  const rows = subs.map(([id, st]) => {
    const name = st.dispositivo || 'Aparelho ativado na versão anterior';
    const state = st.expirado ? '<span class="pill bad">expirada</span>'
      : st.ultimo_envio ? `<span class="meta">último aviso ${esc(rel(st.ultimo_envio))}</span>` : '<span class="meta">aguardando o bot</span>';
    return `<li class="row"><span>${esc(name)}${id === S.pushId ? ' <b>(este)</b>' : ''}</span>${state}</li>`;
  }).join('');
  return `<p class="eyebrow" style="margin-top:6px">Aparelhos que recebem</p><ul class="list" style="margin:0;padding:0;list-style:none;gap:6px">${rows}</ul>`;
}

function viewAjustes() {
  const c = S.cfg || {};
  const pushText = {
    on: 'Ativadas neste aparelho.', off: 'Desligadas.', denied: 'Bloqueadas nas configurações do Android.',
    unsupported: 'Este navegador não aceita notificações push. Use o Chrome no Android.', checking: 'Verificando…',
  }[S.pushState] || '';
  const theme = store.get('theme', 'auto');
  return `<h1>Ajustes</h1>
  <form class="panel" id="cfg-form" autocomplete="off">
    <h2>Conexão com o bot</h2>
    <label>Repositório<input type="text" name="repo" placeholder="usuário/repositório" value="${esc(c.repo || '')}" autocapitalize="off" spellcheck="false"></label>
    <label>Token do GitHub<input type="password" name="token" placeholder="${c.token ? 'salvo neste aparelho (cole outro para trocar)' : 'github_pat_…'}"></label>
    <div class="help">Crie em github.com → Settings → Developer settings → Fine-grained tokens:
      <ol><li>Repository access: <b>Only select repositories</b> → o repositório do bot.</li>
      <li>Permissions: <b>Contents</b> e <b>Actions</b> em Read and write.</li></ol>
      O token fica só neste aparelho.</div>
    <button class="btn primary" type="submit">Salvar e testar</button>
    ${c.repo ? `<p class="meta" style="margin:0">Conectado a <b>${esc(c.repo)}</b>.</p>` : ''}
  </form>
  <section class="panel">
    <h2>Notificações</h2>
    <p class="lede">${esc(pushText)}${myPush() && myPush().expirado ? ' O bot avisou que a inscrição deste aparelho expirou: reative.' : ''}</p>
    <div class="btns">
      <button class="btn primary" data-act="push-on" ${S.cfg ? '' : 'disabled'}>${S.pushState === 'on' ? 'Reativar' : 'Ativar notificações'}</button>
      <button class="btn" data-act="push-test" ${S.pushState === 'on' ? '' : 'disabled'}>Testar</button>
      ${S.pushState === 'on' ? '<button class="btn" data-act="push-off">Desligar neste aparelho</button>' : ''}
    </div>
    ${devicesList()}
    <p class="help">Para destacar ainda mais no Android: segure o ícone do Painel → Informações do app → Notificações,
      e ligue "Mostrar como pop-up" e "Ignorar Não perturbe" (os nomes mudam um pouco entre marcas).</p>
  </section>
  <section class="panel">
    <h2>Aparência</h2>
    <div class="seg" role="group" aria-label="Tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([k, l]) =>
      `<button data-act="theme" data-t="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
  </section>
  ${S.cfg ? `<button class="btn" data-act="logout">Desconectar este aparelho</button>` : ''}`;
}

// ---------- renderização ----------
function renderSync() {
  let text = '';
  if (S.loading) text = 'Atualizando…';
  else if (S.error) text = 'Sem atualizar';
  else if (S.dirty) text = 'Salvando…';
  else if (S.data.at) text = `Dados ${rel(new Date(S.data.at).toISOString())}`;
  $('#sync').textContent = text;
}
function renderBadges() {
  const set = (id, n, soft) => { const el = $(id); el.hidden = !n; el.textContent = n > 99 ? '99+' : n; el.classList.toggle('soft', !!soft); };
  const r = unreadRetornos().length, v = newVagas().length;
  const info = treinoInfo();
  const t = info && info.isToday && !info.met ? info.left : 0;
  set('#n-retornos', r);
  set('#n-vagas', v, true);
  set('#n-treino', t, true);
  if (navigator.setAppBadge) (r + t ? navigator.setAppBadge(r + t) : navigator.clearAppBadge()).catch(() => {});
}
function render() {
  const route = (location.hash.slice(1) || 'inicio').split('?')[0];
  const views = { inicio: viewInicio, retornos: viewRetornos, vagas: viewVagas, treino: viewTreino, ajustes: viewAjustes };
  const name = views[route] ? route : 'inicio';
  if (name !== 'retornos') clearTimeout(autoReadTimer);
  if (name !== S.route) {
    if (S.route === 'vagas') S.vagasVistoAntes = S.vagasVisto;  // saiu de Vagas: as vistas deixam de ser "novas"
    if (name === 'vagas') {
      const latest = (S.data.vagas || []).reduce((m, v) => (v.encontrada_em > m ? v.encontrada_em : m), S.vagasVisto);
      S.vagasVistoAntes = S.vagasVisto;
      S.vagasVisto = latest;
      store.set('vagasVisto', latest);
    }
    S.reveal = false;
    S.route = name;
    window.scrollTo(0, 0);
  }
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#view').innerHTML = !S.cfg && name !== 'ajustes' ? viewWelcome() : views[name]();
  renderSync();
  renderBadges();
}

// ---------- ações ----------
async function saveSettings(form) {
  const repo = form.repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/+$/g, '');
  const token = form.token.value.trim() || (S.cfg && S.cfg.token);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('Repositório no formato usuário/nome.');
  if (!token) return toast('Cole o token do GitHub.');
  const previous = S.cfg;
  S.cfg = { repo, token };
  try {
    const info = await gh('');
    S.cfg.branch = info.default_branch;
    store.set('cfg', S.cfg);
    toast('Conectado!');
    await loadAll();
    location.hash = '#inicio';
  } catch (e) {
    S.cfg = previous;
    toast(errText(e), 6000);
  }
}

// ---------- notificações: uma inscrição por aparelho, em app/inscricoes.json ----------
const SUBS_PATH = 'app/inscricoes.json';
const LEGACY_SUB_PATH = 'app/inscricao.json';  // versão antiga: um aparelho só

async function endpointId(endpoint) {
  // o mesmo hash que o bot usa (SHA-256, 16 primeiros dígitos) para casar o aparelho com data/push.json
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'aparelho';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${browser} no ${os}` : os;
}
const myPush = () => (S.pushId && S.data.push && (S.data.push.inscricoes || {})[S.pushId]) || null;

// Lê, altera e grava app/inscricoes.json; traz junto a inscrição do formato antigo e apaga o arquivo antigo.
async function updateSubs(change, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [remote, legacy] = await Promise.all([getFile(SUBS_PATH), getFile(LEGACY_SUB_PATH)]);
      const subs = (remote && remote.data) || {};
      if (legacy && legacy.data && legacy.data.endpoint) {
        const id = await endpointId(legacy.data.endpoint);
        if (!subs[id]) subs[id] = legacy.data;
      }
      change(subs);
      await putFile(SUBS_PATH, subs, remote && remote.sha, message);
      if (legacy) {
        const body = { message: 'painel: migra inscrição antiga', sha: legacy.sha };
        if (S.cfg.branch) body.branch = S.cfg.branch;
        await gh(`contents/${LEGACY_SUB_PATH}`, { method: 'DELETE', body }).catch(() => {});
      }
      return;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw new Error('outro aparelho gravou ao mesmo tempo; tente de novo');
}

async function checkPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { S.pushState = 'unsupported'; return; }
  if (Notification.permission === 'denied') { S.pushState = 'denied'; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    S.pushId = sub ? await endpointId(sub.endpoint) : '';
    S.pushState = sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch { S.pushState = 'off'; }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const id = sub ? await endpointId(sub.endpoint) : S.pushId;
    if (sub) await sub.unsubscribe();
    if (id) await updateSubs(subs => { delete subs[id]; }, 'painel: desativa notificações');
    S.pushState = 'off';
    S.pushId = '';
    toast('Notificações desligadas neste aparelho. Os outros continuam recebendo.');
  } catch (e) {
    toast(e.status ? errText(e) : `Não deu para desligar: ${e.message}`, 6000);
  }
  render();
}

async function enablePush() {
  if (S.pushState === 'unsupported') return toast('Este navegador não aceita notificações push.');
  const key = S.data.appcfg && S.data.appcfg.vapid_public_key;
  if (!key) return toast('Chave de notificação não encontrada no repositório (data/app-config.json).', 6000);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    S.pushState = perm === 'denied' ? 'denied' : 'off';
    render();
    return toast('Permissão negada. Libere nas configurações do Android para o app Painel.', 6000);
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    const oldId = old ? await endpointId(old.endpoint) : '';
    if (old) await old.unsubscribe();  // sempre uma inscrição nova: resolve as expiradas
    const sub = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) })).toJSON();
    const id = await endpointId(sub.endpoint);
    // só troca a inscrição deste aparelho; as dos outros aparelhos ficam
    await updateSubs(subs => {
      if (oldId) delete subs[oldId];
      subs[id] = { endpoint: sub.endpoint, keys: sub.keys, criado_em: new Date().toISOString(), dispositivo: deviceName() };
    }, 'painel: ativa notificações');
    S.pushState = 'on';
    S.pushId = id;
    toast('Notificações ativadas neste aparelho. Na próxima execução do bot chega "Painel conectado".', 6000);
  } catch (e) {
    toast(e.status ? errText(e) : `Não deu para ativar: ${e.message}`, 6000);
  }
  render();
}

async function testPush() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('🎉 Teste do Painel', {
    body: 'É assim que os avisos vão aparecer.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    tag: 'teste', vibrate: [150], data: { url: '#inicio' },
  });
}

// o agendamento do GitHub atrasa e pula execuções; se o bot está parado há mais de 2h15, o app pede uma
// (no máximo uma a cada 30 min, para não disparar de novo a cada abertura enquanto ela roda)
function autoRun() {
  const bot = S.data.status && Date.parse(S.data.status.atualizado_em);
  if (!bot || Date.now() - bot < 2.25 * 3600e3 || Date.now() - store.get('autoRunAt', 0) < 30 * 60e3) return;
  store.set('autoRunAt', Date.now());
  gh('actions/workflows/vagas.yml/dispatches', { method: 'POST', body: { ref: S.cfg.branch || 'main', inputs: { auto: '1' } } })
    .then(() => setTimeout(loadAll, 100e3), () => { /* sem permissão de Actions: fica só o agendamento */ });
}

async function refreshNow() {
  store.set('autoRunAt', Date.now());
  try {
    await gh('actions/workflows/vagas.yml/dispatches', { method: 'POST', body: { ref: S.cfg.branch || 'main' } });
    toast('Execução do bot pedida. Os dados novos chegam em 1 a 2 minutos.', 5000);
    setTimeout(loadAll, 100e3);
  } catch (e) {
    toast(e.status === 403 || e.status === 404 ? 'O token não tem permissão de Actions. Recarregando os dados atuais.' : errText(e), 5000);
  }
  loadAll();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'read') {
    // no link do Gmail, marca depois do clique: redesenhar agora tiraria o link da página e cancelaria a abertura
    const mark = () => setMarks(m => { m.retornos_lidos[el.dataset.id] = todayBRT(); });
    if (el.tagName === 'A') setTimeout(mark, 0); else mark();
  } else if (act === 'vaga') {
    const { id, v } = el.dataset;
    const links = retornoPorVaga();
    if (vagaStatus(id, links) === v) {
      // desmarcar: se o bot marcou sozinho (e-mail da candidatura), guarda "nenhuma" para não voltar
      setMarks(m => { if (links[id]) m.vagas[id] = 'nenhuma'; else delete m.vagas[id]; });
    } else {
      setMarks(m => { m.vagas[id] = v; });
    }
  } else if (act === 'filtro') {
    S.vagasFiltro = el.dataset.f;
    store.set('vagasFiltro', S.vagasFiltro);
    render();
  } else if (act === 'nivel') {
    const k = el.dataset.f;
    S.vagasNivel = !k ? [] : S.vagasNivel.includes(k) ? S.vagasNivel.filter(x => x !== k) : [...S.vagasNivel, k];
    store.set('vagasNivel', S.vagasNivel);
    render();
  } else if (act === 'rfiltro') {
    S.retornosFiltro = el.dataset.f;
    store.set('retornosFiltro', S.retornosFiltro);
    render();
  } else if (act === 'reveal') {
    S.reveal = true;
    render();
  } else if (act === 'answer') {
    const info = treinoInfo();
    if (!info) return;
    setMarks(m => { (m.treino[info.t.dia] ||= {})[el.dataset.id] = el.dataset.knew === '1'; });
    S.reveal = false;
    const after = treinoInfo();
    if (after && after.done >= after.meta && !info.met) toast('Meta de hoje cumprida! 🔥');
    render();
    window.scrollTo(0, 0);
  } else if (act === 'pdf') {
    openPdf(el);
  } else if (act === 'refresh') {
    refreshNow();
  } else if (act === 'push-on') {
    enablePush();
  } else if (act === 'copy') {
    const text = el.dataset.text;
    const done = () => toast('Assunto copiado. Cole na busca do app do Gmail.');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(done, () => toast(text, 6000));  // sem acesso à área de transferência: mostra para copiar à mão
    if (isUnread((S.data.retornos || []).find(r => r.id === el.dataset.id) || {})) {
      setMarks(m => { m.retornos_lidos[el.dataset.id] = todayBRT(); });
    }
  } else if (act === 'push-off') {
    disablePush();
  } else if (act === 'push-test') {
    testPush();
  } else if (act === 'theme') {
    const t = el.dataset.t;
    store.set('theme', t);
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    render();
  } else if (act === 'logout') {
    for (const k of ['cfg', 'data', 'marks', 'dirty', 'vagasVisto']) store.del(k);
    Object.assign(S, { cfg: null, data: {}, marks: normMarks(null), dirty: false });
    location.hash = '#ajustes';
    render();
  }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'cfg-form') return;
  e.preventDefault();
  saveSettings(e.target);
});

// "toggle" não sobe pela árvore: escuta na captura para lembrar o que está aberto no Material de estudo
document.addEventListener('toggle', e => {
  const key = e.target.dataset && e.target.dataset.open;
  if (!key) return;
  if (e.target.open) S.studyOpen.add(key); else S.studyOpen.delete(key);
}, true);

$('#sync').addEventListener('click', () => loadAll());
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (S.dirty) { clearTimeout(saveTimer); saveMarks(); } return; }
  if (!S.data.at || Date.now() - S.data.at > 60e3) loadAll();
});

// ---------- início ----------
(function init() {
  const theme = store.get('theme', 'auto');
  if (theme !== 'auto') document.documentElement.dataset.theme = theme;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // versão nova do app instalada: recarrega uma vez para usá-la já (sem esperar fechar e abrir)
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.type === 'push') loadAll();
      if (ev.data && ev.data.type === 'open') { location.hash = ev.data.hash; loadAll(); }
    });
  }
  render();
  checkPush().then(render);
  loadAll();
})();
