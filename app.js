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
const CARTAS_KEEP_DAYS = 60;

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
  treinoAtual: '',                         // cartão escolhido no treino (vazio: o primeiro da fila)
  treinoAba: store.get('treinoAba', 'diario'),  // aba do Treino: "diario" ou "entrevistas" (cartões por empresa)
  entAtual: store.get('entAtual', {}),     // cartão aberto em cada entrevista (vazio: o primeiro)
  buscaApp: null,                          // app/busca.json: as palavras-chave salvas no app ({data, sha})
  buscaRascunho: null,                     // palavras-chave alteradas e ainda não salvas, por lista (null = voltar ao padrão)
  cartaAberta: '',                         // vaga (ou carta avulsa "manual:…") com a carta aberta
  cartaForm: {},                           // rascunho do pedido de carta, por id (sobrevive ao redesenho)
  pergAberta: '',                          // vaga com as perguntas de formulário abertas
  pergForm: {},                            // rascunhos: nova pergunta por vaga, edição de resposta e do banco
  bancoAberto: false,
  voz: {},                                 // gravação pronta para enviar, por cartão ({blob, url})
  audiosEnviados: store.get('audiosEnviados', {}),  // áudios enviados ainda sem avaliação: aid -> {card, enviado_em}
  filaAudios: store.get('filaAudios', {}),  // gravações guardadas no aparelho esperando o GitHub: aid -> {card, ext, criado}
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
  return { vagas: m.vagas || {}, retornos_lidos: m.retornos_lidos || {}, treino: m.treino || {}, cartas: m.cartas || {},
    perguntas: m.perguntas || {}, banco: m.banco || {}, acoes_feitas: m.acoes_feitas || {},
    entrevistas: m.entrevistas || {} };  // cartões de entrevistas específicas: id -> {sei, em} (o bot não lê)
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
  // leituras com falha do GitHub (5xx, ou a resposta de erro sem CORS, que chega como falha de rede) tentam de novo
  // duas vezes: numa instabilidade da API (3/11), algumas leituras davam 500 e o app inteiro ficava sem atualizar
  let res;
  for (let tentativa = 0; ; tentativa++) {
    try {
      res = await fetch(url, { method, headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
      if (method !== 'GET' || res.status < 500 || tentativa >= 2) break;
    } catch (e) {
      if (method !== 'GET' || tentativa >= 2 || !navigator.onLine) throw e;
    }
    await new Promise(ok => setTimeout(ok, tentativa ? 4000 : 1500));
  }
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
    // os cartões mudam pouco: relidos a cada 30 min (o "empresas" entra na conta para quem tinha dados de antes dele)
    const cardsFresh = S.data.cards && S.data.modelos && 'empresas' in S.data && Date.now() - (S.data.cardsAt || 0) < 30 * 60e3;
    const [vagas, retornos, treino, status, push, appcfg, cartas, respostas, avaliacoes, ultimos, cards, modelos, pdfs, marks, busca, buscaApp, empresas] = await Promise.all([
      readJson('data/vagas.json', []), readJson('data/retornos.json', []), readJson('data/treino.json', null),
      readJson('data/status.json', null), readJson('data/push.json', null), readJson('data/app-config.json', {}),
      readJson('data/cartas.json', {}), readJson('data/respostas.json', {}), readJson('data/avaliacoes.json', {}),
      lerUltimos(),
      cardsFresh ? S.data.cards : readJson('cartoes/entrevista.json', null),
      cardsFresh ? S.data.modelos : readJson('cartoes/audio/indice.json', {}),
      cardsFresh && S.data.pdfs ? S.data.pdfs : listPdfs(), getFile(MARKS_PATH),
      readJson('data/busca.json', null), getFile(BUSCA_PATH),
      cardsFresh ? S.data.empresas : readJson('cartoes/empresas.json', null),
    ]);
    Object.assign(S.data, { vagas, retornos, treino, status, push, appcfg, cartas, respostas, avaliacoes, ultimos, busca, at: Date.now() });
    S.buscaApp = buscaApp;
    if (!cardsFresh || !S.data.pdfs) Object.assign(S.data, { cards, modelos, pdfs, empresas, cardsAt: Date.now() });
    const remote = marks ? marks.data : {};
    S.marks = normMarks(S.dirty ? deepMerge(remote, S.marks) : remote);
    store.set('data', S.data);
    store.set('marks', S.marks);
    if (S.dirty) scheduleSave(500);
    autoRun();
    renewPushIfKeyChanged();
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
  // "nenhuma" só precisa ficar para vaga que o bot liga a um e-mail de candidatura (senão ela voltaria a "Candidatei")
  const links = retornoPorVaga();
  for (const [id, st] of Object.entries(m.vagas)) if (st === 'nenhuma' && !links[id]) delete m.vagas[id];
  const retornos = new Set((S.data.retornos || []).map(r => r.id));
  if (retornos.size) for (const id of Object.keys(m.retornos_lidos)) if (!retornos.has(id)) delete m.retornos_lidos[id];
  const cartasCutoff = new Date(Date.now() - CARTAS_KEEP_DAYS * 86400e3).toISOString();
  for (const [id, p] of Object.entries(m.cartas)) if (!p || (p.pedido_em || '') < cartasCutoff) delete m.cartas[id];
  for (const [id, q] of Object.entries(m.perguntas)) if (!q || (q.pedido_em || '') < cartasCutoff) delete m.perguntas[id];
  for (const [id, b] of Object.entries(m.banco)) if (!b) delete m.banco[id];  // o banco não expira
  // "Feito" das ações: null é o "desfazer" (precisa vencer o valor antigo no merge e depois sumir)
  const processos = new Set((S.data.retornos || []).map(r => r.candidatura || r.id));
  for (const [k, v] of Object.entries(m.acoes_feitas)) if (!v || (processos.size && !processos.has(k))) delete m.acoes_feitas[k];
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
  const ids = t.cartoes.filter(id => byId[id]);  // as sugestões do dia
  // qualquer cartão respondido conta para a meta, como no bot (o mark() soma todas as respostas do dia)
  const done = Object.keys(answers).filter(id => byId[id]).length;
  const meta = t.meta || ids.length;
  const isToday = t.dia === todayBRT();
  const serverMet = (t.feitos_hoje || 0) >= meta;
  const met = serverMet || done >= meta;
  return {
    t, byId, ids, answers, done, meta, isToday, met, labels: deck.baralhos || {},
    left: Math.max(0, meta - Math.max(done, t.feitos_hoje || 0)),
    sequencia: (t.sequencia || 0) + (met && !serverMet && isToday ? 1 : 0),
  };
}

// Fila do treino: as sugestões do dia primeiro, depois todos os outros cartões, na ordem dos baralhos.
// Os pulados vão para o fim (na ordem em que foram pulados) e ficam à mão na lista "Pulados".
function treinoPulados(info) {
  const p = store.get('treinoPulados', null);
  return p && p.dia === info.t.dia ? p.ids.filter(id => info.byId[id] && !(id in info.answers)) : [];
}
function filaTreino(info) {
  const livre = id => !(id in info.answers);
  const pulados = treinoPulados(info);
  const resto = [...info.ids, ...Object.keys(info.byId).filter(id => !info.ids.includes(id))];
  return resto.filter(id => livre(id) && !pulados.includes(id)).concat(pulados);
}
function cartaoAtual(info) {
  const fila = filaTreino(info);
  // um cartão já respondido hoje também pode ser aberto de novo (pelos atalhos), para rever ou trocar a marcação
  if (S.treinoAtual && (fila.includes(S.treinoAtual) || (S.treinoAtual in info.answers && info.byId[S.treinoAtual]))) return S.treinoAtual;
  return fila[0];
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

// ---------- ações pendentes: processos que esperam algo de você ----------
const ACAO_TIPOS = new Set(['teste', 'entrevista', 'pendente', 'aprovado', 'avancou']);
const ACAO_TEXTO = { teste: 'Fazer o teste', entrevista: 'Marcar ou confirmar a entrevista', pendente: 'Terminar a inscrição',
  aprovado: 'Ver o próximo passo', avancou: 'Ver o próximo passo' };
// Um item por processo (a chave "candidatura" junta os e-mails): o pedido mais recente. Sai da lista quando você
// marca "Feito" (até chegar um pedido mais novo do mesmo processo) ou quando chega uma rejeição depois do pedido.
// Uma confirmação de inscrição depois do pedido não conta: o teste da TIVIT veio antes do "obrigada pelo interesse".
function acoesPendentes(feitas = false) {
  const out = [];
  for (const items of candidaturasPorEmail()) {  // cada processo vem do e-mail mais novo para o mais velho
    const pedido = items.find(r => ACAO_TIPOS.has(r.tipo));
    if (!pedido) continue;
    const t = Date.parse(quando(pedido)) || 0;
    if (items.some(r => r.tipo === 'reprovado' && (Date.parse(quando(r)) || 0) > t)) continue;
    const chave = pedido.candidatura || pedido.id;
    const marca = S.marks.acoes_feitas[chave];
    const feito = Boolean(marca) && (Date.parse(marca) || 0) >= t;
    if (feito === feitas) out.push({ chave, pedido, items });
  }
  return out;
}
function quemDoProcesso(r) {
  return [r.empresa, r.cargo].filter(Boolean).join(' · ') || r.nome || (r.email ? domain(r.email) : '') || 'Processo';
}
function acaoCard({ chave, pedido, items }) {
  const tipo = tipoDe(pedido);
  const novo = items.some(isUnread);
  return `<article class="panel ${novo ? 'hl-warn' : ''}">
    <div class="row"><span class="pill ${tipo.cls}">${tipo.label}</span>
      <span class="meta">${novo ? '<span class="newdot"></span>' : ''}${esc(rel(quando(pedido)))}</span></div>
    <h2>${esc(ACAO_TEXTO[pedido.tipo] || 'Responder')}: ${esc(quemDoProcesso(pedido))}</h2>
    <div class="meta">${esc(pedido.assunto || '(sem assunto)')}</div>
    ${pedido.trecho ? `<p class="quote">“${esc(pedido.trecho)}”</p>` : ''}
    ${mailDetails(pedido)}
    <div class="btns">${gmailButton(pedido, 'btn primary')}${feitoButton(chave, pedido)}</div>
  </article>`;
}
// botão neutro e com verbo: "✓ Feito" em verde parecia um selo dizendo que a tarefa já estava feita
function feitoButton(chave, pedido) {
  return `<button class="btn" data-act="acao-feita" data-chave="${esc(chave)}" data-quando="${esc(quando(pedido) || '')}">Marcar como feito</button>`;
}
// versão curta, para o topo do Início
function acaoLinha({ chave, pedido, items }) {
  const tipo = tipoDe(pedido);
  return `<div class="acao-linha">
    <div><span class="pill ${tipo.cls}">${tipo.label}</span> <b>${esc(quemDoProcesso(pedido))}</b>
      <div class="meta">${items.some(isUnread) ? '<span class="newdot"></span>' : ''}${esc(ACAO_TEXTO[pedido.tipo] || 'Responder')} · ${esc(rel(quando(pedido)))}</div></div>
    ${feitoButton(chave, pedido)}
  </div>`;
}

function viewWelcome() {
  return `<h1>Bem-vindo ao Painel</h1>
  <p class="lede">Para começar, conecte o repositório do bot em Ajustes.</p>
  <a class="btn primary" href="#ajustes">Ir para Ajustes</a>`;
}

function viewInicio() {
  const parts = [];
  // no topo: o que espera uma ação sua (teste, entrevista, inscrição por terminar)
  const acoes = acoesPendentes();
  if (acoes.length) {
    parts.push(`<section class="panel hl-warn acoes-topo"><div class="row"><h2>⚡ Precisa da sua ação</h2><span class="pill warn">${acoes.length}</span></div>
      ${acoes.slice(0, 3).map(acaoLinha).join('')}
      <button class="btn" data-act="ver-acoes">${acoes.length > 3 ? `Ver todas (${acoes.length})` : 'Ver detalhes'}</button></section>`);
  }
  // os e-mails dessas ações já estão no quadro acima: não repete na lista de retornos novos
  const emAcao = new Set(acoes.flatMap(a => a.items.filter(r => ACAO_TIPOS.has(r.tipo)).map(r => r.id)));
  const unread = unreadRetornos().filter(r => !emAcao.has(r.id));
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
  parts.push(entrevistaAviso());  // entrevista marcada para os próximos dias, com cartões próprios
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
  return `<details class="mail"${aberto(`mail:${r.id}`)}><summary>Ver e-mail</summary><div class="mailtext">${esc(r.texto)}</div></details>`;
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
  const acoes = acoesPendentes();
  const groups = {
    acoes: acoes.map(a => a.pedido),  // só para contar e marcar novidade; a lista própria vem de "acoes"
    avancos: all.filter(r => tipoDe(r).avanco),
    inscricoes: all.filter(r => r.tipo === 'inscricao' || r.tipo === 'pendente'),
    rejeicoes: all.filter(r => r.tipo === 'reprovado'),
  };
  const f = groups[S.retornosFiltro] ? S.retornosFiltro : 'avancos';
  const seg = [['acoes', 'Ações'], ['avancos', 'Avanços'], ['inscricoes', 'Inscrições'], ['rejeicoes', 'Rejeições']].map(([k, label]) => {
    const novos = k === 'acoes' ? acoes.filter(a => a.items.some(isUnread)).length : groups[k].filter(isUnread).length;
    return `<button data-act="rfiltro" data-f="${k}" aria-pressed="${f === k}">${novos ? '<span class="newdot"></span>' : ''}${label} <span class="n">${groups[k].length}</span></button>`;
  }).join('');
  const lede = {
    acoes: 'Processos que esperam algo de você: um teste, marcar uma entrevista, terminar uma inscrição. Quando resolver, toque em “Marcar como feito”.',
    avancos: 'Aprovações, convites para entrevista e testes.',
    inscricoes: 'Inscrições confirmadas e as que ficaram por terminar.',
    rejeicoes: 'Processos que não seguiram.',
  }[f];
  const empty = {
    acoes: 'Nada esperando por você. Quando um e-mail pedir um teste, uma entrevista ou para terminar uma inscrição, ele aparece aqui.',
    avancos: 'Nenhum avanço ainda. Quando um e-mail indicar aprovação, entrevista ou teste, ele aparece aqui e o celular avisa.',
    inscricoes: 'Nenhuma inscrição registrada nos últimos 90 dias.',
    rejeicoes: 'Nenhuma rejeição registrada.',
  }[f];
  const items = f === 'acoes' ? acoes.map(acaoCard).join('')
    : groups[f].map(r => (r.tipo === 'inscricao' ? inscricaoRow(r) : retornoCard(r))).join('');
  if (f !== 'acoes') autoRead(groups[f]);
  // nas ações, as resolvidas ficam guardadas, com "Desfazer" para o caso de ter marcado sem querer
  const feitas = f === 'acoes' ? acoesPendentes(true) : [];
  const resolvidas = feitas.length ? `<details class="feitas"${aberto('feitas')}><summary>Resolvidas · ${feitas.length}</summary><div class="list">${feitas.map(({ chave, pedido }) =>
    `<div class="acao-linha"><div><span class="pill ${tipoDe(pedido).cls}">${tipoDe(pedido).label}</span> <b>${esc(quemDoProcesso(pedido))}</b>
      <div class="meta">${esc(pedido.assunto || '')}</div></div>
      <button class="btn" data-act="acao-desfazer" data-chave="${esc(chave)}">Desfazer</button></div>`).join('')}</div></details>` : '';
  return `<h1>Retornos</h1><div class="seg" role="group" aria-label="Tipo">${seg}</div>
  <p class="lede">${lede}</p>
  ${items ? `<div class="list">${items}</div>` : `<p class="empty">${empty}</p>`}${resolvidas}`;
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
    <details class="mail"${aberto(`mail:${items[0].id}`)}><summary>${items.length === 1 ? 'Ver e-mail' : `Ver os ${items.length} e-mails`}</summary>
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

// ---------- cartas de apresentação ----------
// O pedido vai em marcacoes.cartas; o PC gera com uma LLM local (cartas.py) e grava em data/cartas.json.
function cartaEstado(id) {
  const pedido = S.marks.cartas[id];
  const feita = (S.data.cartas || {})[id];
  return { pedido, feita, pronta: !!(pedido && feita && feita.pedido_em === pedido.pedido_em) };
}

function cartaBlock(id) {
  const { pedido, feita, pronta } = cartaEstado(id);
  const draft = S.cartaForm[id] || {};
  const attr = `data-id="${esc(id)}"`;
  let body;
  if (pronta && !draft.editando) {
    const avisos = feita.avisos || [];
    body = `<div class="carta-texto">${esc(feita.texto)}</div>
      ${avisos.length ? `<div class="note check"><strong>Revise antes de enviar</strong><ul>${avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <div class="meta">Rascunho gerado ${esc(rel(feita.gerada_em))} por ${esc(feita.modelo || 'uma LLM local')}. Confira os fatos antes de enviar.</div>
      <div class="btns"><button class="btn primary" data-act="carta-copiar" ${attr}>Copiar</button>
        <button class="btn" data-act="carta-editar" ${attr}>Gerar de novo</button></div>`;
  } else if (pedido && !draft.editando) {
    body = `<p class="lede">⏳ Pedida ${esc(rel(pedido.pedido_em))}. O PC gera na próxima execução, em até 15 min, se estiver ligado. Chega uma notificação quando ficar pronta.</p>
      <div class="btns"><button class="btn" data-act="carta-editar" ${attr}>Editar o pedido</button></div>`;
  } else {
    const val = campo => esc(draft[campo] ?? (pedido && pedido[campo]) ?? '');
    body = `${id.startsWith('manual:') ? `<label>Empresa<input type="text" data-carta="${esc(id)}" data-campo="empresa" value="${val('empresa')}"></label>
        <label>Vaga<input type="text" data-carta="${esc(id)}" data-campo="titulo" value="${val('titulo')}"></label>` : ''}
      <label>Descrição da vaga <span class="meta">(recomendado: sem ela, a carta sai genérica)</span>
        <textarea rows="8" data-carta="${esc(id)}" data-campo="descricao" placeholder="Cole o texto do anúncio: atividades, requisitos e diferenciais.">${val('descricao')}</textarea></label>
      <div class="btns"><button class="btn primary" data-act="carta-gerar" ${attr}>Gerar carta</button>
        ${pedido || id.startsWith('manual:') ? `<button class="btn" data-act="carta-cancelar" ${attr}>Cancelar</button>` : ''}</div>`;
  }
  return `<div class="carta">${body}</div>`;
}

function cartaButton(id) {
  const { pedido, pronta } = cartaEstado(id);
  const mark = pronta ? ' ✓' : pedido ? ' ⏳' : '';
  return `<button class="btn" data-act="carta" data-id="${esc(id)}" aria-pressed="${S.cartaAberta === id}">✉️ Carta${mark}</button>`;
}

// ---------- perguntas de formulário e banco de respostas ----------
// Pedido em marcacoes.perguntas (id -> {vaga_id, pergunta, limite, pedido_em, final?}); o PC responde em
// data/respostas.json. O banco (marcacoes.banco) guarda respostas escritas por você e entra como fato.
const formVal = (key, campo, padrao = '') => (S.pergForm[key] || {})[campo] ?? padrao;

function perguntasDe(vid) {
  return Object.entries(S.marks.perguntas).filter(([, q]) => q && q.vaga_id === vid)
    .sort((a, b) => (a[1].pedido_em || '').localeCompare(b[1].pedido_em || ''));
}

function pergButton(vid) {
  const qs = perguntasDe(vid);
  const pend = qs.some(([qid, q]) => !q.final && ((S.data.respostas || {})[qid] || {}).pedido_em !== q.pedido_em);
  return `<button class="btn" data-act="perg" data-id="${esc(vid)}" aria-pressed="${S.pergAberta === vid}">❓ Perguntas${qs.length ? ` ${qs.length}${pend ? ' ⏳' : ''}` : ''}</button>`;
}

function avisosNote(avisos) {
  return avisos.length ? `<div class="note check"><strong>Revise antes de enviar</strong><ul>${avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '';
}

function pergBlock(vid) {
  const items = perguntasDe(vid).map(([qid, q]) => {
    const r = (S.data.respostas || {})[qid];
    const pronta = r && r.pedido_em === q.pedido_em;
    const ed = S.pergForm[`edit:${qid}`];
    const attr = `data-id="${esc(qid)}"`;
    const limite = q.limite || 1500;
    let corpo;
    if (ed && ed.editando) {
      corpo = `<textarea rows="5" data-form="${esc(`edit:${qid}`)}" data-campo="texto">${esc(ed.texto)}</textarea>
        <div class="meta">Limite: ${limite} caracteres</div>
        <div class="btns"><button class="btn primary" data-act="perg-salvar" ${attr}>Salvar no banco</button>
          <button class="btn" data-act="perg-cancelar" ${attr}>Cancelar</button></div>`;
    } else if (q.final || pronta) {
      const texto = q.final || r.texto;
      corpo = `<div class="carta-texto">${esc(texto)}</div>
        <div class="meta">${semMarcador(texto).length} / ${limite} caracteres${q.final ? ' · a sua versão, salva no banco' : ''}</div>
        ${q.final ? '' : avisosNote(r.avisos || [])}
        <div class="btns"><button class="btn primary" data-act="perg-copiar" ${attr}>Copiar</button>
          <button class="btn" data-act="perg-editar" ${attr}>Editar e salvar no banco</button>
          <button class="btn warn" data-act="perg-apagar" ${attr}>Apagar</button></div>`;
    } else {
      corpo = `<p class="lede">⏳ Pedida ${esc(rel(q.pedido_em))}. O PC responde em até 15 min, se estiver ligado.</p>
        <div class="btns"><button class="btn warn" data-act="perg-apagar" ${attr}>Apagar</button></div>`;
    }
    return `<li class="perg"><strong>${esc(q.pergunta)}</strong>${corpo}</li>`;
  }).join('');
  const nk = esc(`nova:${vid}`);
  return `<div class="carta">
    ${items ? `<ul class="list pergs">${items}</ul>` : ''}
    <label>Pergunta do formulário <span class="meta">(várias: separe com uma linha em branco)</span>
      <textarea rows="3" data-form="${nk}" data-campo="pergunta" placeholder="Ex.: Possui conhecimento em manutenção de computadores?">${esc(formVal(`nova:${vid}`, 'pergunta'))}</textarea></label>
    <label>Limite de caracteres<input type="text" inputmode="numeric" data-form="${nk}" data-campo="limite" value="${esc(formVal(`nova:${vid}`, 'limite', '1500'))}"></label>
    <div class="btns"><button class="btn primary" data-act="perg-gerar" data-id="${esc(vid)}">Gerar resposta</button></div>
    <p class="help">A resposta usa só os seus fatos e o banco. Se eles não cobrirem a pergunta, ela vem com [COMPLETE] para você escrever, e o que você salvar no banco vale para as próximas vagas.</p>
  </div>`;
}

function bancoView() {
  const itens = Object.entries(S.marks.banco).filter(([, b]) => b)
    .sort((a, b) => (b[1].salvo_em || '').localeCompare(a[1].salvo_em || ''));
  const linhas = itens.map(([bid, b]) => {
    const key = `banco:${bid}`;
    const ed = S.pergForm[key];
    const attr = `data-id="${esc(bid)}"`;
    if (ed && ed.editando) {
      return `<li class="perg"><label>Pergunta<input type="text" data-form="${esc(key)}" data-campo="pergunta" value="${esc(ed.pergunta)}"></label>
        <label>Resposta<textarea rows="4" data-form="${esc(key)}" data-campo="resposta">${esc(ed.resposta)}</textarea></label>
        <div class="btns"><button class="btn primary" data-act="banco-salvar" ${attr}>Salvar</button>
          <button class="btn" data-act="banco-cancelar" ${attr}>Cancelar</button></div></li>`;
    }
    return `<li class="perg"><strong>${esc(b.pergunta)}</strong><div class="carta-texto">${esc(b.resposta)}</div>
      <div class="btns"><button class="btn" data-act="banco-editar" ${attr}>Editar</button>
        <button class="btn warn" data-act="banco-apagar" ${attr}>Apagar</button></div></li>`;
  }).join('');
  return `<details class="panel banco" data-banco ${S.bancoAberto ? 'open' : ''}>
    <summary><h2>📚 Banco de respostas</h2><span class="meta">${itens.length}</span></summary>
    <p class="help">Respostas escritas por você. O PC usa como fatos nas cartas e nas perguntas.</p>
    ${linhas ? `<ul class="list pergs">${linhas}</ul>` : ''}
    <label>Nova pergunta<input type="text" data-form="banco:novo" data-campo="pergunta" value="${esc(formVal('banco:novo', 'pergunta'))}"></label>
    <label>Sua resposta<textarea rows="3" data-form="banco:novo" data-campo="resposta">${esc(formVal('banco:novo', 'resposta'))}</textarea></label>
    <div class="btns"><button class="btn" data-act="banco-adicionar">Adicionar ao banco</button></div>
    <h2>Perguntas sem vaga</h2>
    <p class="help">Para um formulário de vaga que não está na lista: a resposta sai sem o contexto da vaga.</p>
    <div class="btns">${pergButton('geral')}</div>
    ${S.pergAberta === 'geral' ? pergBlock('geral') : ''}
  </details>`;
}

// ---------- "Compartilhar → Painel" no Android ----------
// O sw.js guarda o texto num cache local (share_target do manifest); aqui ele vira a descrição de uma carta.
const SHARE_CACHE = 'painel-compartilhado';
const COMPART_MAX = 8000;  // caracteres guardados no pedido (uma página inteira selecionada pode ter mais)
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function lerCompartilhado() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match('compartilhado');
    if (!res) return;
    const d = await res.json();           // ler antes de apagar: apagar o item invalida a resposta
    await cache.delete('compartilhado');
    if (!d.text && !d.url && !d.title) return;
    S.compartilhado = { ...d, vaga: melhorVaga(d) };
    location.hash = '#vagas';
    render();
  } catch { /* sem cache disponível: nada a fazer */ }
}

// a vaga da lista cujo título mais aparece no texto compartilhado ('' = nenhuma: outra vaga)
function melhorVaga(d) {
  const alvo = semAcento(`${d.title} ${d.text} ${d.url}`).slice(0, 4000);
  let melhor = '', pontos = 1;
  for (const v of S.data.vagas || []) {
    const palavras = new Set(semAcento(v.titulo).split(/[^a-z0-9]+/).filter(w => w.length >= 4));
    const p = [...palavras].filter(w => alvo.includes(w)).length;
    if (p > pontos) { pontos = p; melhor = v.id; }
  }
  return melhor;
}

function compartilhadoView() {
  const c = S.compartilhado;
  if (!c) return '';
  const texto = (c.text || '').trim();
  const vagas = (S.data.vagas || []).slice().sort((a, b) => (b.encontrada_em || '').localeCompare(a.encontrada_em || ''));
  const opcoes = [`<option value="">Outra vaga (fora da lista)</option>`,
    ...vagas.map(v => `<option value="${esc(v.id)}"${c.vaga === v.id ? ' selected' : ''}>${esc(v.titulo.slice(0, 90))}</option>`)].join('');
  return `<section class="panel alert-soft"><h2>📥 Texto compartilhado</h2>
    ${texto ? `<p class="meta">${texto.length} caracteres: “${esc(texto.slice(0, 180))}${texto.length > 180 ? '…' : ''}”</p>`
      : `<p class="lede">Só veio o link. Para a descrição, selecione o texto da vaga antes de compartilhar. Em vagas da Gupy e de páginas de carreira, o PC busca a descrição pelo link.</p>`}
    <label>Para qual vaga?<select data-compart="vaga">${opcoes}</select></label>
    <div class="btns"><button class="btn primary" data-act="compart-carta">Usar na carta</button>
      <button class="btn" data-act="compart-descartar">Descartar</button></div></section>`;
}

function compartAction(act) {
  const c = S.compartilhado;
  S.compartilhado = null;
  if (act !== 'compart-carta' || !c) return render();
  const descricao = (c.text || '').trim().slice(0, COMPART_MAX);
  let id = c.vaga;
  if (id) {
    S.cartaForm[id] = { editando: true, descricao };
    const st = vagaStatus(id);
    S.vagasFiltro = st === 'candidatei' || st === 'descartada' ? st : 'novas';  // a aba em que a vaga aparece
    S.vagasNivel = [];
  } else {
    id = `manual:${new Date().toISOString()}`;
    S.cartaForm[id] = { editando: true, descricao, titulo: (c.title || '').trim(), url: c.url || '' };
  }
  S.cartaAberta = id;
  render();
  setTimeout(() => {
    const el = document.querySelector(`.carta [data-carta="${CSS.escape(id)}"]`);
    if (el) el.closest('article, .carta').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 50);
}

// cartas para vagas que não estão na lista do bot (achadas em outro lugar)
function cartasAvulsas() {
  const ids = Object.keys(S.marks.cartas).filter(id => id.startsWith('manual:') && S.marks.cartas[id]);
  if (S.cartaAberta.startsWith('manual:') && !ids.includes(S.cartaAberta)) ids.push(S.cartaAberta);
  const items = ids.sort().reverse().map(id => {
    const p = S.marks.cartas[id] || {};
    const nome = [p.titulo, p.empresa].filter(Boolean).join(' · ') || 'Nova carta';
    const open = S.cartaAberta === id;
    return `<article class="panel job"><h2>${esc(nome)}</h2>
      <div class="btns">${p.pedido_em ? cartaButton(id) + pergButton(id) : ''}
        ${p.pedido_em ? `<button class="btn warn" data-act="carta-apagar" data-id="${esc(id)}">Apagar</button>` : ''}</div>
      ${open ? cartaBlock(id) : ''}${S.pergAberta === id ? pergBlock(id) : ''}</article>`;
  }).join('');
  return `${compartilhadoView()}${bancoView()}<div class="btns"><button class="btn" data-act="carta-nova">✉️ Carta para outra vaga</button></div>
    ${items ? `<div class="list">${items}</div>` : ''}`;
}

// tags da vaga: a modalidade (sempre, "não informada" quando a fonte não diz) e o horário, quando o bot achou
const MODALIDADES = { remote: 'Remota', hybrid: 'Híbrida', 'on-site': 'Presencial' };
function vagaTags(v) {
  const modo = MODALIDADES[v.modelo]
    ? `<span class="pill modo-${v.modelo}">${MODALIDADES[v.modelo]}</span>`
    : '<span class="pill modo-x">Modalidade não informada</span>';
  const hora = v.horario ? `<span class="pill horario">🕒 ${esc(v.horario)}</span>` : '';
  return `<div class="tags">${modo}${hora}</div>`;
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
    // o bot preenche local vazio com "Não informado"; aqui ele só ocuparia a linha (a modalidade vai na tag)
    const where = [v.empresa, v.local].filter(x => x && x !== 'Não informado').join(' · ');
    const r = links[v.id];
    return `<article class="panel job ${st === 'descartada' ? 'done' : ''}">
      ${r ? `<div class="row"><a class="pill ${tipoDe(r).cls}" href="#retornos" style="text-decoration:none">${tipoDe(r).label}</a><span class="meta">${esc(rel(quando(r)))}</span></div>` : ''}
      <h2>${isNew ? '<span class="newdot" title="Nova"></span>' : ''}${esc(v.titulo)}</h2>
      ${vagaTags(v)}
      ${where ? `<div class="meta">${esc(where)}</div>` : ''}
      <div class="meta">${esc(v.fonte)} · encontrada ${esc(rel(v.encontrada_em))}</div>
      <div class="btns">
        ${v.url ? `<a class="btn primary" href="${esc(v.url)}" target="_blank" rel="noopener">Ver vaga</a>` : ''}
        ${st === 'descartada'
          ? `<button class="btn" data-act="vaga" data-id="${esc(v.id)}" data-v="descartada">Restaurar</button>`
          : `<button class="btn ok" data-act="vaga" data-id="${esc(v.id)}" data-v="candidatei" aria-pressed="${st === 'candidatei'}">Candidatei</button>
        <button class="btn warn" data-act="vaga" data-id="${esc(v.id)}" data-v="descartada">Descartar</button>
        ${cartaButton(v.id)}${pergButton(v.id)}`}
      </div>${S.cartaAberta === v.id ? cartaBlock(v.id) : ''}${S.pergAberta === v.id ? pergBlock(v.id) : ''}</article>`;
  }).join('');
  const emptyAba = { novas: 'Nenhuma vaga sem marcação. As novas aparecem aqui a cada 2 horas.',
    candidatei: 'Nenhuma candidatura ainda. Elas aparecem aqui quando chega o e-mail de inscrição, ou quando você marca "Candidatei" numa vaga.',
    descartada: 'Nenhuma vaga descartada.' }[f];
  const empty = sel.length && doGrupo.length ?'Nenhuma vaga desta aba com os níveis escolhidos. Toque em "Todas" para ver todas.' : emptyAba;
  return `<h1>Vagas</h1>${cartasAvulsas()}<div class="seg" role="group" aria-label="Filtro">${seg}</div>
    ${niveis}
    ${items ?`<div class="list">${items}</div>` : `<p class="empty">${empty}</p>`}
    <p class="meta">As vagas ficam aqui por 30 dias depois de encontradas.</p>`;
}

// ---------- palavras-chave da busca (em Ajustes): o app grava app/busca.json e o bot usa no lugar do config.toml ----------
// O bot publica em data/busca.json o que está valendo ("em_uso") e o padrão do config.toml ("padrao").
const BUSCA_PATH = 'app/busca.json';
const BUSCA_LISTAS = [
  ['termos', 'Termos de busca', 'Buscados na Gupy. O título da vaga precisa ter um destes termos ou um dos extras abaixo.'],
  ['termos_titulo_extra', 'Termos extras no título', 'Também valem no título, mas não são buscados na Gupy.'],
  ['excluir_no_titulo', 'Palavras que excluem a vaga', 'Se o título tiver uma destas, a vaga é ignorada.'],
  ['palavras_estagio', 'Palavras de estágio', 'Nas fontes que misturam tipos de vaga (Remotar e páginas de empresas), o título precisa ter uma destas.'],
];
// lista mostrada: o rascunho (se houver), senão o que o app salvou, senão o que o bot está usando
function buscaLista(k) {
  const r = S.buscaRascunho || {};
  if (k in r) return r[k] === null ? ((S.data.busca || {}).padrao || {})[k] || [] : r[k];
  const salvo = (S.buscaApp || {}).data || {};
  if (Array.isArray(salvo[k])) return salvo[k];
  return ((S.data.busca || {}).em_uso || {})[k] || [];
}
function buscaTrocada(k) {
  const r = S.buscaRascunho || {};
  if (k in r) return r[k] !== null;
  return Array.isArray(((S.buscaApp || {}).data || {})[k]);
}
function buscaView() {
  const b = S.data.busca;
  if (!b || !b.em_uso) {
    return `<details class="panel busca" data-open="busca"${S.studyOpen.has('busca') ? ' open' : ''}><summary><h2>🔎 Palavras-chave da busca</h2></summary>
      <p class="lede">As listas aparecem depois da próxima execução do bot.</p></details>`;
  }
  // salvo no app, mas o bot ainda não aplicou (a próxima execução usa)
  const salvo = (S.buscaApp || {}).data || {};
  const pendente = BUSCA_LISTAS.some(([k]) => {
    const app = Array.isArray(salvo[k]) ? salvo[k] : b.padrao[k];
    return JSON.stringify(app || []) !== JSON.stringify(b.em_uso[k] || []);
  });
  const listas = BUSCA_LISTAS.map(([k, titulo, ajuda]) => {
    const itens = buscaLista(k);
    const chips = itens.map(t => `<span class="pill brand termo">${esc(t)}<button data-act="busca-tirar" data-lista="${k}" data-termo="${esc(t)}" aria-label="Tirar ${esc(t)}">✕</button></span>`).join('');
    return `<div class="busca-lista">
      <h3>${titulo} <span class="meta">${itens.length}${buscaTrocada(k) ? ' · alterada' : ''}</span></h3>
      <p class="meta">${ajuda}</p>
      <div class="chips">${chips || '<span class="meta">Nenhuma.</span>'}</div>
      <form class="busca-add" data-lista="${k}"><input name="termo" placeholder="Nova palavra" autocomplete="off" enterkeyhint="done"><button class="btn">Adicionar</button></form>
      ${buscaTrocada(k) ? `<button class="btn link" data-act="busca-padrao" data-lista="${k}">Voltar ao padrão</button>` : ''}
    </div>`;
  }).join('');
  const total = buscaLista('termos').length, fora = buscaLista('excluir_no_titulo').length;
  const acoes = S.buscaRascunho
    ? `<div class="btns two busca-acoes"><button class="btn" data-act="busca-descartar">Descartar</button><button class="btn primary" data-act="busca-salvar">Salvar</button></div>`
    : pendente
      ? `<p class="note">⏳ Salvo. O bot usa as palavras novas na próxima execução (até 15 min), ou agora: <button class="btn link" data-act="refresh">Atualizar agora</button></p>`
      : '';
  return `<details class="panel busca" data-open="busca"${S.studyOpen.has('busca') || S.buscaRascunho ? ' open' : ''}>
    <summary><h2>🔎 Palavras-chave da busca</h2><span class="meta">${plural(total, 'termo', 'termos')} · ${plural(fora, 'exclusão', 'exclusões')}</span></summary>
    <p class="lede">O bot busca e filtra as vagas com estas listas. Maiúsculas e acentos não fazem diferença.</p>
    ${listas}${acoes}</details>`;
}
function buscaMudar(k, fn) {
  S.buscaRascunho = { ...(S.buscaRascunho || {}), [k]: fn(buscaLista(k).slice()) };
  render();
}
async function salvarBusca() {
  const r = S.buscaRascunho;
  if (!r) return;
  if (r.termos && !r.termos.length) return toast('Deixe pelo menos um termo de busca.');
  const btn = $('[data-act="busca-salvar"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const atual = await getFile(BUSCA_PATH);  // relê: o sha muda a cada gravação
      const dados = { ...(atual ? atual.data : {}) };
      for (const [k, v] of Object.entries(r)) { if (v === null) delete dados[k]; else dados[k] = v; }
      dados.atualizado_em = new Date().toISOString();
      await putFile(BUSCA_PATH, dados, atual && atual.sha, 'painel: palavras-chave da busca');
      S.buscaApp = { data: dados };
      S.buscaRascunho = null;
      toast('Salvo. A próxima execução do bot já usa as palavras novas.', 4000);
      render();
      return;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      toast(errText(e), 5000);
      break;
    }
  }
  render();
}

function pdfButton(id) {
  if (!(S.data.pdfs || {})[id]) return '';
  return `<button class="btn" data-act="pdf" data-id="${esc(id)}">📄 Explicação completa (PDF)</button>`;
}

// todos os cartões, por baralho: a resposta resumida abre no próprio app e o PDF traz a explicação completa
// ---------- resposta falada (o PC transcreve com o Whisper e avalia com o Ollama; audios.py) ----------
// O áudio vai para o ramo "audios" do repositório; o resultado volta em data/avaliacoes.json.
const VOZ_MAX_S = 180;
const vozRec = { card: '', rec: null, partes: [], inicio: 0, timer: 0 };

function avaliacaoDe(card, desde = '') {
  return Object.entries(S.data.avaliacoes || {}).filter(([, a]) => a.card === card && (a.avaliada_em || '') >= desde)
    .sort((a, b) => (b[1].avaliada_em || '').localeCompare(a[1].avaliada_em || ''))[0];
}

function vozPendente(card) {
  return Object.entries(S.audiosEnviados).find(([aid, a]) => a.card === card && !(S.data.avaliacoes || {})[aid]);
}

function vozBlock(card, desde = '') {
  const st = S.voz[card] || {};
  const attr = `data-id="${esc(card)}"`;
  if (vozRec.card === card) {
    return `<div class="voz"><button class="btn warn" data-act="voz-parar" ${attr}>⏹ Parar <span data-voz-timer>0:00</span></button>
      <span class="meta">Gravando… até ${VOZ_MAX_S / 60} min.</span></div>`;
  }
  if (st.enviando) return `<div class="voz"><p class="meta">Enviando o áudio…</p></div>`;
  const naFila = Object.entries(S.filaAudios).find(([, a]) => a.card === card);
  if (naFila) {
    const [aid] = naFila;
    return `<div class="voz"><p class="lede">📥 Gravação guardada no aparelho: o GitHub não respondeu. Ela sobe sozinha quando ele voltar, e aí o PC avalia.</p>
      ${filaUrls[aid] ? `<audio controls src="${filaUrls[aid]}"></audio>` : ''}
      <div class="btns"><button class="btn" data-act="fila-tentar">Tentar enviar agora</button></div></div>`;
  }
  if (st.url) {
    const u = (S.data.ultimos || {})[card];
    return `<div class="voz">
      ${u && u.ultimo ? `<div class="comparar-grid"><div>${audioPlayer(u.ultimo.arquivo, 'ultimos', `Seu último áudio (${rel(u.ultimo.em)})`)}
        <p class="meta">${esc(resumoAval((S.data.avaliacoes || {})[u.ultimo.aid]))}</p></div>
        <div class="player"><span class="meta">Novo</span><audio controls src="${st.url}"></audio></div></div>`
        : `<audio controls src="${st.url}"></audio>`}
      <div class="btns"><button class="btn primary" data-act="voz-enviar" ${attr}>Enviar para avaliar</button>
        <button class="btn" data-act="voz-gravar" ${attr}>Gravar de novo</button></div></div>`;
  }
  const pendente = vozPendente(card);
  if (pendente) {
    // dá para ouvir o que foi enviado enquanto espera: do aparelho logo após o envio; depois de reabrir o app,
    // do ramo "audios" do repositório, onde o arquivo fica até o PC avaliar
    const [aid, info] = pendente;
    return `<div class="voz"><p class="lede">⏳ Avaliando no PC: o Whisper transcreve e o Ollama compara com o cartão. Leva 1 a 3 min, com o PC ligado.</p>
      ${audioPlayer(`audios/${aid}.${info.ext || 'webm'}`, 'audios', 'Ouvir o que você enviou')}</div>`;
  }
  const av = avaliacaoDe(card, desde);
  const gravar = `<button class="btn" data-act="voz-gravar" ${attr}>🎤 ${av ? 'Responder de novo' : 'Responder em voz alta'}</button>`;
  return `<div class="voz">${av ? avaliacaoView(av[1], av[0]) + compararView(card) : ''}<div class="btns">${gravar}</div></div>`;
}

// ---------- áudios guardados: o modelo (voz do Windows) e as suas duas últimas tentativas ----------
// O modelo fica em cartoes/audio/ (modelo_audio.py); as tentativas, no ramo "ultimos" (rodar_pc.py).
async function lerUltimos() {
  try { return JSON.parse(await gh('contents/indice.json?ref=ultimos', { raw: true })); }
  catch (e) { if (e.status === 404) return {}; throw e; }
}

const audioUrls = {};  // "ref:caminho" -> URL do blob, baixado só quando você toca
let tocarAgora = '';

function audioPlayer(path, ref, rotulo) {
  const key = `${ref}:${path}`;
  if (audioUrls[key]) {
    return `<div class="player"><span class="meta">${esc(rotulo)}</span><audio controls preload="auto" data-key="${esc(key)}" src="${audioUrls[key]}"></audio></div>`;
  }
  return `<button class="btn" data-act="tocar" data-path="${esc(path)}" data-ref="${esc(ref)}">▶ ${esc(rotulo)}</button>`;
}

async function tocar(btn) {
  const { path, ref } = btn.dataset;
  const key = `${ref}:${path}`;
  btn.disabled = true;
  try {
    const blob = await gh(`contents/${encodeURI(path)}${ref ? `?ref=${ref}` : ''}`, { blob: true });
    audioUrls[key] = URL.createObjectURL(blob);
    tocarAgora = key;
    render();
    const el = document.querySelector(`audio[data-key="${CSS.escape(key)}"]`);
    if (el && tocarAgora === key) el.play().catch(() => { /* o navegador pode exigir outro toque */ });
    tocarAgora = '';
  } catch (e) {
    btn.disabled = false;
    toast(e.status === 404 ? 'Áudio ainda não disponível. O PC gera na próxima execução.' : errText(e), 5000);
  }
}

function modeloNote(c) {
  if (!c.fala) return '';
  const m = (S.data.modelos || {})[c.id];
  const player = m ? audioPlayer(`cartoes/audio/${m.arquivo}`, '', `Ouvir o modelo${m.segundos ? ` (${Math.round(m.segundos)} s)` : ''}`)
    : '<span class="meta">O áudio do modelo é gerado pelo PC na próxima execução.</span>';
  return `<div class="note modelo"><strong>Resposta falada (modelo)</strong>${player}<p class="fala">${esc(c.fala)}</p></div>`;
}

function resumoAval(a) {
  if (!a || a.erro) return 'sem avaliação';
  const p = a.pontos || [];
  const n = (a.erros || []).length;
  return `${typeof a.nota === 'number' ? `nota ${notaTexto(a.nota)} · ` : ''}${p.filter(x => x.status === 'coberto').length} de ${p.length} pontos · ${n === 1 ? '1 erro' : `${n} erros`}`;
}
const notaTexto = n => String(n).replace('.', ',');
// a nota que o modelo deu à resposta falada (avaliações antigas não têm)
function notaView(a) {
  if (typeof a.nota !== 'number') return '';
  const cls = a.nota >= 8 ? 'ok' : a.nota >= 5 ? 'warn' : 'bad';
  // nomes que o reconhecimento de voz não entendeu: cada um desconta 0,2 (fala pouco clara)
  const pc = a.pouco_claro || [];
  const clareza = pc.length ? `<p class="meta clareza">−${notaTexto(a.desconto_clareza)} por ${pc.length === 1 ? '1 nome pouco claro' : `${pc.length} nomes pouco claros`}:
    ${pc.map(c => `“${esc(c.ouvido)}” (era ${esc(c.certo)})`).join('; ')}</p>` : '';
  return `<div class="nota-aval"><span class="pill ${cls}">Nota ${notaTexto(a.nota)}<small>/10</small></span>${a.nota_motivo ? `<span class="meta">${esc(a.nota_motivo)}</span>` : ''}</div>${clareza}`;
}

// as seções que abrem e fecham lembram o estado: o app redesenha a tela (ao tocar um áudio, por exemplo)
// e, sem isso, elas fechavam sozinhas. O registro fica em S.studyOpen, pelo "toggle" (data-open).
const aberto = k => ` data-open="${esc(k)}"${S.studyOpen.has(k) ? ' open' : ''}`;

// a tentativa anterior ao lado da última (áudio e avaliação), quando houver
function compararView(card) {
  const u = (S.data.ultimos || {})[card];
  if (!u || !u.anterior) return '';
  const av = S.data.avaliacoes || {};
  return `<details class="comparar"${aberto(`comparar:${card}`)}><summary>Comparar com a tentativa anterior</summary>
    <div class="comparar-grid">
      <div><strong>Anterior</strong> <span class="meta">${esc(rel(u.anterior.em))}</span>
        <p class="meta">${esc(resumoAval(av[u.anterior.aid]))}</p>${audioPlayer(u.anterior.arquivo, 'ultimos', 'Ouvir')}</div>
      <div><strong>Última</strong> <span class="meta">${esc(rel(u.ultimo.em))}</span>
        <p class="meta">${esc(resumoAval(av[u.ultimo.aid]))}</p>${audioPlayer(u.ultimo.arquivo, 'ultimos', 'Ouvir')}</div>
    </div></details>`;
}

// o áudio guardado desta avaliação (o último ou o anterior do cartão), se ainda estiver guardado
function audioDaAvaliacao(aid, card) {
  const u = (S.data.ultimos || {})[card] || {};
  const guardado = [u.ultimo, u.anterior].find(x => x && x.aid === aid);
  return guardado ? audioPlayer(guardado.arquivo, 'ultimos', 'Ouvir sua resposta') : '';
}

function avaliacaoView(a, aid = '') {
  if (a.erro) return `<div class="note check"><strong>Não deu para avaliar</strong>${esc(a.erro)}</div>`;
  const icone = { coberto: '✅', parcial: '🟡', faltou: '❌' };
  const pontos = (a.pontos || []).map(p => `<li>${icone[p.status] || '•'} ${esc(p.ponto)}</li>`).join('');
  const erros = (a.erros || []).map(e => `<li>Você disse “${esc(e.disse)}”; o cartão diz “${esc(e.cartao)}”.</li>`).join('');
  const sug = a.sugestao === 'ja_sei' ? '✅ Já sei' : '🔁 Preciso revisar';
  return `<div class="avaliacao">
    ${notaView(a)}
    ${aid ? audioDaAvaliacao(aid, a.card) : ''}
    <details${aberto(`disse:${aid || a.avaliada_em}`)}><summary>O que você disse</summary><div class="carta-texto">${esc(a.transcricao || '')}</div></details>
    ${pontos ? `<ul class="pontos">${pontos}</ul>` : ''}
    ${erros ? `<div class="note check"><strong>Diferente do cartão</strong><ul>${erros}</ul></div>` : ''}
    ${a.comentario ? `<p class="lede">${esc(a.comentario)}</p>` : ''}
    <p class="meta">Sugestão: <strong>${sug}</strong>. Quem marca é você.</p></div>`;
}

async function vozGravar(card) {
  if (vozRec.rec) return toast('Já há uma gravação em andamento.');
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Este navegador não grava áudio.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Sem acesso ao microfone. Libere nas configurações do app.', 5000); }
  const tipo = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
  Object.assign(vozRec, { card, rec, partes: [], inicio: Date.now() });
  rec.ondataavailable = e => { if (e.data.size) vozRec.partes.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(vozRec.timer);
    const blob = new Blob(vozRec.partes, { type: rec.mimeType || 'audio/webm' });
    const antigo = S.voz[card] && S.voz[card].url;
    if (antigo) URL.revokeObjectURL(antigo);
    S.voz[card] = { blob, url: URL.createObjectURL(blob) };
    Object.assign(vozRec, { card: '', rec: null, partes: [] });
    render();
  };
  rec.start(1000);
  vozRec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - vozRec.inicio) / 1000);
    const el = document.querySelector('[data-voz-timer]');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= VOZ_MAX_S) rec.stop();
  }, 500);
  render();
}

// sobe a gravação para o ramo "audios" do repositório (o PC avalia de lá)
async function subirAudio(aid, ext, blob) {
  const content = await new Promise((ok, erro) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1]);
    fr.onerror = erro;
    fr.readAsDataURL(blob);
  });
  const put = () => gh(`contents/audios/${aid}.${ext}`, { method: 'PUT', body: { message: 'painel: resposta falada do treino', content, branch: 'audios' } });
  try { await put(); } catch (e) {
    if (e.status !== 404 && e.status !== 422) throw e;
    // o ramo "audios" ainda não existe (ou foi apagado): cria a partir do principal e tenta de novo
    const base = await gh(`git/ref/heads/${S.cfg.branch || 'main'}`);
    await gh('git/refs', { method: 'POST', body: { ref: 'refs/heads/audios', sha: base.object.sha } });
    await put();
  }
}

// o áudio chegou ao repositório: a partir daqui, é esperar a avaliação do PC
function audioEnviado(aid, card, ext, url) {
  // a gravação continua tocável enquanto o PC avalia: o mesmo endereço local serve ao player do envio
  audioUrls[`audios:audios/${aid}.${ext}`] = url;
  S.audiosEnviados[aid] = { card, enviado_em: new Date().toISOString(), ext };
  store.set('audiosEnviados', S.audiosEnviados);
  vozAcompanhar();
}

// falha do GitHub ou da rede (vale esperar e tentar de novo), e não do pedido em si (token, arquivo)
const falhaPassageira = e => !e.status || e.status >= 500 || e.status === 429;

async function vozEnviar(card) {
  const st = S.voz[card];
  if (!st || !st.blob) return;
  if (st.blob.size < 2000) return toast('A gravação ficou vazia. Tente de novo.');
  const ext = /ogg/.test(st.blob.type) ? 'ogg' : /mp4/.test(st.blob.type) ? 'm4a' : 'webm';
  const aid = `${card}__${new Date().toISOString().replace(/[:.]/g, '-')}`;
  S.voz[card] = { ...st, enviando: true };
  render();
  try {
    await subirAudio(aid, ext, st.blob);
    delete S.voz[card];
    audioEnviado(aid, card, ext, st.url);
    toast('Enviado. A avaliação chega em 1 a 3 min, com o PC ligado.', 5000);
  } catch (e) {
    if (falhaPassageira(e) && await filaGuardar({ aid, card, ext, blob: st.blob, criado: new Date().toISOString() })) {
      delete S.voz[card];
      filaUrls[aid] = st.url;
      toast('O GitHub não respondeu. A gravação ficou guardada no aparelho e sobe sozinha quando ele voltar.', 6000);
    } else {
      S.voz[card] = st;
      toast(e.status ? errText(e) : `Não deu para enviar: ${e.message}`, 6000);
    }
  }
  render();
}

// ---------- fila de envio: gravações que esperam no aparelho (IndexedDB) até o GitHub voltar ----------
// Numa instabilidade do GitHub (3/11), o envio falhava e a gravação só voltava a subir tocando em "Enviar" de novo.
const FILA_DB = 'painel-fila';
const filaUrls = {};  // aid -> URL do blob, para ouvir a gravação enquanto ela espera
let filaTimer = 0, filaRodando = false;
function filaOp(modo, fn) {
  return new Promise((ok, erro) => {
    const abrir = indexedDB.open(FILA_DB, 1);
    abrir.onupgradeneeded = () => abrir.result.createObjectStore('audios', { keyPath: 'aid' });
    abrir.onerror = () => erro(abrir.error);
    abrir.onsuccess = () => {
      const tx = abrir.result.transaction('audios', modo);
      const req = fn(tx.objectStore('audios'));
      tx.oncomplete = () => { abrir.result.close(); ok(req.result); };
      tx.onerror = () => { abrir.result.close(); erro(tx.error); };
    };
  });
}
async function filaGuardar(item) {
  try {
    await filaOp('readwrite', s => s.put(item));
    S.filaAudios = { ...S.filaAudios, [item.aid]: { card: item.card, ext: item.ext, criado: item.criado } };
    store.set('filaAudios', S.filaAudios);
    filaAgendar();
    return true;
  } catch { return false; }  // sem IndexedDB (navegação privada, por exemplo): fica o botão de enviar de novo
}
function filaAgendar(ms = 60e3) {
  clearTimeout(filaTimer);
  if (Object.keys(S.filaAudios).length) filaTimer = setTimeout(filaProcessar, ms);
}
async function filaProcessar() {
  if (filaRodando || !S.cfg) return;
  if (!navigator.onLine) return filaAgendar();
  filaRodando = true;
  let enviados = 0;
  try {
    const itens = (await filaOp('readonly', s => s.getAll())).sort((a, b) => a.criado.localeCompare(b.criado));
    // o índice segue o que está guardado de fato (outra aba pode ter enviado)
    S.filaAudios = Object.fromEntries(itens.map(x => [x.aid, { card: x.card, ext: x.ext, criado: x.criado }]));
    for (const x of itens) {
      filaUrls[x.aid] ||= URL.createObjectURL(x.blob);
      try { await subirAudio(x.aid, x.ext, x.blob); } catch (e) {
        // 422: o envio anterior chegou ao GitHub, só a resposta se perdeu (o arquivo já está lá)
        const chegou = e.status === 422 && await gh(`contents/audios/${x.aid}.${x.ext}?ref=audios`).then(() => true, () => false);
        if (!chegou) { if (falhaPassageira(e)) break; continue; }
      }
      await filaOp('readwrite', s => s.delete(x.aid));
      delete S.filaAudios[x.aid];
      audioEnviado(x.aid, x.card, x.ext, filaUrls[x.aid]);
      delete filaUrls[x.aid];
      enviados++;
    }
  } catch { /* sem IndexedDB */ }
  store.set('filaAudios', S.filaAudios);
  filaRodando = false;
  if (enviados) toast(enviados === 1 ? 'A gravação guardada foi enviada. A avaliação chega em 1 a 3 min.' : `${enviados} gravações guardadas foram enviadas.`, 5000);
  filaAgendar();
  render();
}

// enquanto houver áudio sem avaliação, relê os dados de vez em quando (por até 20 min)
let vozTimer = 0;
function vozAcompanhar() {
  clearTimeout(vozTimer);
  const limite = Date.now() - 20 * 60e3;
  for (const [aid, a] of Object.entries(S.audiosEnviados)) {
    if ((S.data.avaliacoes || {})[aid] || Date.parse(a.enviado_em) < limite) delete S.audiosEnviados[aid];
  }
  store.set('audiosEnviados', S.audiosEnviados);
  if (Object.keys(S.audiosEnviados).length) vozTimer = setTimeout(() => loadAll().then(vozAcompanhar), 40e3);
}

function studyLibrary() {
  const deck = S.data.cards;
  if (!deck || !Array.isArray(deck.cartoes)) return '';
  const labels = deck.baralhos || {};
  const groups = {};
  for (const c of deck.cartoes) (groups[c.deck] ||= []).push(c);
  const decks = Object.keys(labels).filter(k => groups[k]).concat(Object.keys(groups).filter(k => !(k in labels)));
  const nPdf = deck.cartoes.filter(c => (S.data.pdfs || {})[c.id]).length;
  // qualquer cartão pode ser respondido no treino; os já respondidos hoje mostram o resultado
  const info = treinoInfo();
  const acao = c => {
    if (!info) return '';
    const a = info.answers[c.id];
    if (a !== undefined) return ` <button class="pill ${a ? 'ok' : 'warn'}" data-act="treino-ir" data-id="${esc(c.id)}">${a ? '✓' : '↻'} hoje</button>`;
    return ` <button class="pill brand" data-act="treino-ir" data-id="${esc(c.id)}">🎯 Responder</button>`;
  };
  const body = decks.map(k => {
    const items = groups[k].map(c => `<details class="study" data-open="${esc(c.id)}"${S.studyOpen.has(c.id) ? ' open' : ''}>
        <summary>${richText(c.q)}${acao(c)}</summary>
        <ul class="answer">${(c.a || []).map(x => `<li>${richText(x)}</li>`).join('')}</ul>
        ${modeloNote(c)}
        ${c.extra ? `<div class="note"><strong>Se aprofundarem</strong>${richText(c.extra)}</div>` : ''}
        ${pdfButton(c.id)}
        ${vozBlock(c.id)}
      </details>`).join('');
    return `<details class="deck" data-open="deck:${esc(k)}"${S.studyOpen.has('deck:' + k) ? ' open' : ''}>
      <summary>${esc(labels[k] || k)} <span class="meta">${plural(groups[k].length, 'cartão', 'cartões')}</span></summary>
      <div class="study-list">${items}</div></details>`;
  }).join('');
  // o livro e o PDF dele são publicados juntos: o PDF na lista avisa que o livro existe
  const livro = (S.data.pdfs || {}).livro ? `<div class="livro-entrada"><div><strong>📘 Livro de estudo</strong>
      <p class="meta">A teoria por trás de todos os cartões, para ler antes de praticar.</p></div>
      <a class="btn primary" href="#livro">Ler</a></div>` : '';
  return `<section class="panel" id="estudo"><div class="row"><h2>Material de estudo</h2><span class="meta">${nPdf ? `${plural(nPdf, 'PDF', 'PDFs')}` : ''}</span></div>
    <p class="lede">Todos os cartões: toque na pergunta para ver a resposta resumida e, quando houver, abra o PDF com a explicação completa. Em 🎯 Responder, o cartão vai para o treino.</p>
    ${livro}${body}</section>`;
}

// ---------- livro de estudo: livro/livro.html no repositório do bot, lido dentro do app ----------
// Fica guardado no Cache Storage (abre sem rede); a cada sessão o app confere o sha e baixa de novo se mudou.
const LIVRO_DIR = 'livro';
const LIVRO_CACHE = 'painel-livro';
async function livroDoCache() {
  try {
    const r = await (await caches.open(LIVRO_CACHE)).match('./livro.html');
    return r ? { html: await r.text(), sha: r.headers.get('x-sha') || '' } : null;
  } catch { return null; }
}
async function livroParaCache(html, sha) {
  try {
    await (await caches.open(LIVRO_CACHE)).put('./livro.html', new Response(html, { headers: { 'content-type': 'text/html', 'x-sha': sha } }));
  } catch { /* sem Cache Storage: lê da rede da próxima vez */ }
}
function livroPartes(html, sha) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { css: [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n'), body: doc.body.innerHTML, sha };
}
async function carregarLivro() {
  if (S.livroCarregando) return;
  S.livroCarregando = true;
  try {
    if (!S.livro) {
      const c = await livroDoCache();
      if (c) { S.livro = livroPartes(c.html, c.sha); if (S.route === 'livro') render(); }
    }
    const f = (await gh(`contents/${LIVRO_DIR}`)).find(x => x.name === 'livro.html');
    if (!f) throw Object.assign(new Error('livro'), { status: 404 });
    if (!S.livro || S.livro.sha !== f.sha) {
      const html = await gh(`contents/${LIVRO_DIR}/livro.html`, { raw: true });
      S.livro = livroPartes(html, f.sha);
      livroParaCache(html, f.sha);
      if (S.route === 'livro') render();
    }
  } catch (e) {
    if (!S.livro) {
      S.livroErro = e.status === 404 ? 'O livro ainda não foi publicado.' : errText(e);
      if (S.route === 'livro') render();
    }
  } finally {
    S.livroCarregando = false;
  }
}
function viewLivro() {
  if (!S.livroConferido) { S.livroConferido = true; carregarLivro(); }  // uma conferência de versão por sessão
  if (!S.livro) {
    return `<h1>Livro de estudo</h1><p class="empty">${S.livroErro ? esc(S.livroErro) : 'Carregando o livro…'}</p>
      <a class="btn" href="#treino">← Treino</a>`;
  }
  let st = document.getElementById('livro-css');
  if (!st) { st = document.createElement('style'); st.id = 'livro-css'; document.head.append(st); }
  if (st.textContent !== S.livro.css) st.textContent = S.livro.css;
  return `<div class="livro-barra"><a class="btn" href="#treino">← Treino</a>
      ${pdfButton('livro').replace('📄 Explicação completa (PDF)', '📄 Baixar o PDF')}</div>
    <article class="livro">${S.livro.body}</article>
    <button class="btn livro-flutuante" data-act="livro-ir" data-alvo="sumario">☰ Sumário</button>`;
}
function irNoLivro(alvo) {
  const el = alvo && document.querySelector(`#view article.livro [id="${CSS.escape(alvo)}"]`);
  if (el) el.scrollIntoView({ block: 'start' });
}

// ---------- entrevistas específicas: cartoes/empresas.json no repositório do bot ----------
// Cartões preparados para uma entrevista marcada (a empresa, a vaga e as respostas). Ficam fora da revisão
// espaçada e do livro, mas têm áudio-modelo e avaliação da resposta falada, como os do treino.
function entrevistasOrdenadas() {
  const emp = S.data.empresas;
  if (!emp || !Array.isArray(emp.entrevistas)) return { proximas: [], anteriores: [] };
  const todas = emp.entrevistas.map(e => ({ ...e, cartoes: (emp.cartoes || []).filter(c => c.entrevista === e.id) }));
  // continua entre as próximas até 3 h depois do fim (para rever logo depois da conversa)
  const fim = e => Date.parse(e.fim || e.inicio || '') || 0;
  const proximas = todas.filter(e => !e.inicio || fim(e) + 3 * 3600e3 >= Date.now())
    .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));
  const anteriores = todas.filter(e => !proximas.includes(e)).sort((a, b) => (b.inicio || '').localeCompare(a.inicio || ''));
  return { proximas, anteriores };
}

// "hoje, 17h30", "amanhã, 9h", "ter., 10/11, 14h"
function quandoEntrevista(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h').replace(/h00$/, 'h')
    .replace(/^0/, '');
  const dia = x => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const dif = Math.round((dia(d) - dia(Date.now())) / 864e5);
  if (dif === 0) return `hoje, ${hora}`;
  if (dif === 1) return `amanhã, ${hora}`;
  if (dif === -1) return `ontem, ${hora}`;
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' })}, ${hora}`;
}

// o que ainda depende de uma decisão sua aparece marcado
const comLacunas = html => html.replace(/_{4,}/g, '<mark class="lacuna">____</mark>');

// o cartão aberto: o escolhido nos atalhos; sem escolha, o primeiro ainda não marcado (em ordem)
function entrevistaAtual(e) {
  const cs = e.cartoes;
  const i = cs.findIndex(c => c.id === S.entAtual[e.id]);
  if (i >= 0) return i;
  const livre = cs.findIndex(c => !S.marks.entrevistas[c.id]);
  return livre >= 0 ? livre : 0;
}

// o cartão da vez, no mesmo formato do treino diário: em ordem, mas qualquer cartão abre pelos atalhos.
// "Já sei" / "Preciso revisar" ficam em marks.entrevistas (fora da revisão espaçada, que o bot calcula só com o treino).
function entrevistaFlash(e) {
  const cs = e.cartoes;
  const i = entrevistaAtual(e);
  const c = cs[i];
  const ir = (k, rotulo) => `<button class="btn" data-act="ent-ir" data-ent="${esc(e.id)}" data-id="${esc(cs[k].id)}">${rotulo}</button>`;
  const anterior = i > 0 ? ir(i - 1, '← Anterior') : '';
  const proximo = i < cs.length - 1 ? ir(i + 1, 'Próximo →') : '';
  // como no treino diário, a avaliação falada mostrada é a de hoje (de outro dia seria outra tentativa)
  const voz = vozBlock(c.id, new Date(Date.now() - 18 * 3600e3).toISOString());
  const answer = S.reveal ? `<ul class="answer anim">${(c.a || []).map(x => `<li>${comLacunas(richText(x))}</li>`).join('')}</ul>` : '';
  const notes = S.reveal ? modeloNote(c) + (c.extra ? `<div class="note"><strong>Se aprofundarem</strong>${comLacunas(richText(c.extra))}</div>` : '') : '';
  const nav = anterior || proximo ? `<div class="btns${anterior && proximo ? ' two' : ''}">${anterior}${proximo}</div>` : '';
  // "Já sei" e "Preciso revisar" sempre à mão, como no treino diário; a marcação pode ser trocada quando quiser
  const m = S.marks.entrevistas[c.id];
  const marcar = (m ? `<p class="note marcado">Você marcou ${esc(rel(m.em))}: <strong>${m.sei ? '✅ Já sei' : '🔁 Preciso revisar'}</strong>. Dá para trocar quando quiser.</p>` : '')
    + `<div class="btns two"><button class="btn warn" data-act="answer" data-ent="${esc(e.id)}" data-id="${esc(c.id)}" data-knew="0">🔁 Preciso revisar</button><button class="btn ok" data-act="answer" data-ent="${esc(e.id)}" data-id="${esc(c.id)}" data-knew="1">✅ Já sei</button></div>`;
  const foot = S.reveal
    ? `<button class="btn" data-act="ocultar">Ocultar resposta</button>${voz}${notes}${marcar}${nav}`
    : `<p class="meta" style="margin:0">Responda em voz alta e só depois veja a resposta. Gravando, o PC confere a sua resposta com o cartão.</p>${voz}
      <div class="btns${proximo ? ' two' : ''}">${proximo ? ir(i + 1, '⏭ Pular') : ''}<button class="btn primary" data-act="reveal">Mostrar resposta</button></div>${marcar}`;
  return `<article class="flash">
    <div class="flash-head"><span><span class="tag">${esc(c.tema || e.empresa)}</span> · cartão ${i + 1} de ${cs.length}</span><span>alvo ${esc(c.tempo || '1 min')}</span></div>
    <div class="flash-body"><p class="q">${c.lingua === 'en' ? '<span class="pill brand">EN</span> ' : ''}${richText(c.q)}</p>${answer}</div>
    <div class="flash-foot">${foot}</div></article>`;
}

function entrevistaPanel(e, passada = false) {
  const li = xs => (xs || []).map(x => `<li>${richText(x)}</li>`).join('');
  const treino = Object.fromEntries(((S.data.cards || {}).cartoes || []).map(c => [c.id, c]));
  const revisar = (e.revisar || []).filter(id => treino[id]);
  const curto = q => { q = q.replace(/<[^>]+>/g, ''); return q.length > 30 ? q.slice(0, 29) + '…' : q; };
  const sabidos = e.cartoes.filter(c => (S.marks.entrevistas[c.id] || {}).sei).length;
  const atual = (e.cartoes[entrevistaAtual(e)] || {}).id;
  // atalhos para qualquer cartão: ✓ / ↻ pela marcação e, quando houver, a nota da última avaliação falada
  const atalho = (c, k) => {
    const m = S.marks.entrevistas[c.id];
    const av = avaliacaoDe(c.id);
    const nota = av && typeof av[1].nota === 'number' ? ` ${notaTexto(av[1].nota)}` : '';
    const cls = m ? (m.sei ? 'ok' : 'warn') : 'brand';
    return `<button class="pill ${cls}" data-act="ent-ir" data-ent="${esc(e.id)}" data-id="${esc(c.id)}" title="${esc(c.q.replace(/<[^>]+>/g, ''))}"${c.id === atual ? ' aria-current="true"' : ''}>${m ? (m.sei ? '✓' : '↻') : '·'}${nota} ${k + 1}. ${esc(curto(c.q))}</button>`;
  };
  return `<section class="panel entrevista">
    <div class="row"><h2>🗓 ${esc(e.empresa)}</h2>${e.inicio ? `<span class="pill ${passada ? 'brand' : 'warn'}">${esc(quandoEntrevista(e.inicio))}</span>` : ''}</div>
    <p class="meta">${esc(e.vaga || '')}${e.site ? ` · <a href="${esc(e.site)}" target="_blank" rel="noopener">site da empresa</a>` : ''}</p>
    ${e.formato ? `<p class="lede">${richText(e.formato)}</p>` : ''}
    ${(e.atencao || []).length ? `<div class="note check"><strong>Atenção</strong><ul>${li(e.atencao)}</ul></div>` : ''}
    <details class="study"${aberto(`ent:${e.id}:sobre`)}><summary>Sobre a empresa</summary><ul class="answer">${li(e.sobre)}</ul></details>
    <details class="study"${aberto(`ent:${e.id}:vaga`)}><summary>A vaga</summary><ul class="answer">${li(e.vaga_detalhes)}</ul></details>
  </section>
  ${e.cartoes.length ? entrevistaFlash(e) : ''}
  <section class="panel treino-nav">
    <div><p class="meta">Todos os cartões · ${sabidos} de ${e.cartoes.length} em “Já sei” · toque para abrir</p>
      <div class="chips">${e.cartoes.map(atalho).join('')}</div></div>
    ${revisar.length ? `<div class="revisar"><p class="meta">Revise também, no treino diário</p>
      <div class="chips">${revisar.map(id => `<button class="pill brand" data-act="treino-ir" data-id="${esc(id)}" title="${esc(treino[id].q.replace(/<[^>]+>/g, ''))}">${esc(curto(treino[id].q))}</button>`).join('')}</div></div>` : ''}
    ${e.fontes ? `<p class="meta">Fontes: ${esc(e.fontes)}</p>` : ''}
  </section>`;
}

function viewEntrevistas() {
  const { proximas, anteriores } = entrevistasOrdenadas();
  if (!proximas.length && !anteriores.length) {
    return '<p class="empty">Nenhuma entrevista com cartões próprios ainda. Quando uma entrevista for marcada, os cartões dela (a empresa, a vaga e as respostas) aparecem aqui.</p>';
  }
  return `<p class="lede">Cartões preparados para cada entrevista marcada. Ficam fora da revisão espaçada; responda em voz alta para o PC avaliar, como no treino.</p>
    ${proximas.map(e => entrevistaPanel(e)).join('')}
    ${anteriores.length ? `<details class="deck"${aberto('ent:anteriores')}><summary>Entrevistas anteriores <span class="meta">${anteriores.length}</span></summary>
      ${anteriores.map(e => entrevistaPanel(e, true)).join('')}</details>` : ''}`;
}

function treinoAbas() {
  const n = entrevistasOrdenadas().proximas.length;
  const aba = S.treinoAba === 'entrevistas' ? 'entrevistas' : 'diario';
  return `<div class="seg treino-abas" role="group" aria-label="Aba do treino">
    <button data-act="treino-aba" data-f="diario" aria-pressed="${aba === 'diario'}">Treino diário</button>
    <button data-act="treino-aba" data-f="entrevistas" aria-pressed="${aba === 'entrevistas'}">Entrevistas${n ? ` <span class="n">${n}</span>` : ''}</button></div>`;
}

// aviso no Início e no treino diário: entrevista com cartões próprios nos próximos 3 dias
function entrevistaAviso() {
  const e = entrevistasOrdenadas().proximas.find(x => x.inicio && Date.parse(x.inicio) - Date.now() < 3 * 864e5);
  if (!e) return '';
  return `<section class="panel hl"><h2>🗓 Entrevista ${esc(quandoEntrevista(e.inicio))}: ${esc(e.empresa)}</h2>
    <p class="lede">${esc(e.vaga || '')}. ${plural(e.cartoes.length, 'cartão preparado', 'cartões preparados')} para ela, com a empresa e a vaga resumidas.</p>
    <button class="btn primary" data-act="treino-aba" data-f="entrevistas">Ver os cartões</button></section>`;
}

function viewTreino() {
  if (S.treinoAba === 'entrevistas') return `<h1>Treino</h1>${treinoAbas()}${viewEntrevistas()}`;
  const info = treinoInfo();
  if (!info) return `<h1>Treino</h1>${treinoAbas()}<p class="empty">Os cartões aparecem depois da próxima execução do bot.</p>${studyLibrary()}`;
  const parts = [`<h1>Treino</h1>`, treinoAbas(), entrevistaAviso(), `<section class="panel">${todayPanel(info)}</section>`];
  if (!info.isToday) {
    parts.push(`<div class="panel alert"><p class="lede">Estes são os cartões de ${esc(info.t.dia.split('-').reverse().slice(0, 2).join('/'))}. Os de hoje chegam na próxima execução do bot.</p><button class="btn" data-act="refresh">Atualizar agora</button></div>`);
  }
  const fila = filaTreino(info);
  const pulados = treinoPulados(info);
  const atual = cartaoAtual(info);
  if (info.met) {
    parts.push(`<div class="panel hl"><h2>🎉 Meta de hoje cumprida</h2><p class="lede">${info.sequencia ? `Sequência de ${plural(info.sequencia, 'dia', 'dias')}. ` : ''}${fila.length
      ? 'Se quiser, continue com outros cartões: toda resposta conta para a revisão espaçada.'
      : 'Você respondeu todos os cartões hoje.'}</p></div>`);
  }
  if (atual) {
    const c = info.byId[atual];
    const sug = info.ids.indexOf(c.id);
    const resposta = info.answers[c.id];  // já marcado hoje?
    // o bot conta só a primeira resposta do dia: depois que ele registra (t.respondidos), não dá mais para trocar
    const registrada = resposta !== undefined && c.id in (info.t.respondidos || {});
    const origem = resposta !== undefined ? 'respondido hoje' : sug >= 0 ? `sugestão ${sug + 1} de ${info.ids.length}`
      : pulados.includes(c.id) ? 'pulado' : 'extra';
    // pular só faz sentido se houver outro cartão na fila para mostrar
    const pular = resposta === undefined && fila.length > 1 ? `<button class="btn" data-act="pular" data-id="${esc(c.id)}">⏭ Pular</button>` : '';
    const answer = S.reveal ? `<ul class="answer anim">${c.a.map(x => `<li>${richText(x)}</li>`).join('')}</ul>` : '';
    const notes = S.reveal ? [
      modeloNote(c),
      c.extra ? `<div class="note"><strong>Se aprofundarem</strong>${richText(c.extra)}</div>` : '',
      c.check ? `<div class="note check"><strong>Confira antes</strong>${richText(c.check)}</div>` : '',
      pdfButton(c.id),
    ].join('') : '';
    // a avaliação falada só conta se for de hoje (de outro dia seria outra tentativa)
    const voz = vozBlock(c.id, new Date(Date.now() - 18 * 3600e3).toISOString());
    // "Já sei" e "Preciso revisar" ficam sempre à mão, mesmo sem abrir a resposta
    const botoes = `<div class="btns two"><button class="btn warn" data-act="answer" data-id="${esc(c.id)}" data-knew="0">🔁 Preciso revisar</button><button class="btn ok" data-act="answer" data-id="${esc(c.id)}" data-knew="1">✅ Já sei</button></div>`;
    const marcado = resposta === undefined ? '' : `<p class="note marcado">Você marcou hoje: <strong>${resposta ? '✅ Já sei' : '🔁 Preciso revisar'}</strong>.
      ${registrada ? 'O bot já registrou essa resposta na revisão espaçada; este cartão fica aberto só para rever e praticar.' : 'Dá para trocar até a próxima execução do bot.'}</p>`;
    const marcar = marcado + (registrada ? '' : botoes);
    const foot = S.reveal
      ? `<button class="btn" data-act="ocultar">Ocultar resposta</button>${voz}${notes}${marcar}${pular.replace('⏭ Pular', '⏭ Pular e responder depois')}`
      : `<p class="meta" style="margin:0">Responda em voz alta e só depois veja a resposta. Gravando, o PC confere a sua resposta com o cartão.</p>${voz}<div class="btns${pular ? ' two' : ''}">${pular}<button class="btn primary" data-act="reveal">Mostrar resposta</button></div>${marcar}`;
    parts.push(`<article class="flash">
      <div class="flash-head"><span><span class="tag">${esc(info.labels[c.deck] || c.deck)}</span> · ${origem}</span><span>alvo ${esc(c.tempo || '1 min')}</span></div>
      <div class="flash-body"><p class="q">${richText(c.q)}</p>${answer}</div>
      <div class="flash-foot">${foot}</div></article>`);
  }
  // atalhos: as sugestões do dia e os pulados abrem o cartão (os já respondidos também, para rever)
  const titulo = id => esc(info.byId[id].q.replace(/<[^>]+>/g, ''));
  const chip = (id, rotulo) => {
    const a = info.answers[id];
    if (a !== undefined) return `<button class="pill ${a ? 'ok' : 'warn'}" data-act="treino-ir" data-id="${esc(id)}" title="${titulo(id)}"${id === atual ? ' aria-current="true"' : ''}>${a ? '✓' : '↻'} ${rotulo}</button>`;
    return `<button class="pill brand" data-act="treino-ir" data-id="${esc(id)}" title="${titulo(id)}"${id === atual ? ' aria-current="true"' : ''}>· ${rotulo}</button>`;
  };
  const curto = id => { const q = info.byId[id].q.replace(/<[^>]+>/g, ''); return esc(q.length > 34 ? q.slice(0, 33) + '…' : q); };
  parts.push(`<section class="panel treino-nav">
    <div><p class="meta">Sugestões de hoje</p><div class="chips">${info.ids.map(id => chip(id, esc(info.labels[info.byId[id].deck] || ''))).join('')}</div></div>
    ${pulados.length ? `<div><p class="meta">Pulados · toque para responder</p><div class="chips">${pulados.map(id => chip(id, curto(id))).join('')}</div></div>` : ''}
    <div class="row"><span class="meta">${plural(fila.length, 'cartão', 'cartões')} sem resposta hoje</span><button class="btn" data-act="ir-estudo">Escolher qualquer cartão ↓</button></div>
  </section>`);
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
  ${S.cfg ? buscaView() : ''}
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
  // retornos não lidos + ações pendentes cujos e-mails já foram lidos (elas continuam pedindo atenção até o "Feito")
  const acoesLidas = acoesPendentes().filter(a => !a.items.some(isUnread)).length;
  const r = unreadRetornos().length + acoesLidas, v = newVagas().length;
  const info = treinoInfo();
  const t = info && info.isToday && !info.met ? info.left : 0;
  set('#n-retornos', r);
  set('#n-vagas', v, true);
  set('#n-treino', t, true);
  if (navigator.setAppBadge) (r + t ? navigator.setAppBadge(r + t) : navigator.clearAppBadge()).catch(() => {});
}
function render() {
  const route = (location.hash.slice(1) || 'inicio').split('?')[0];
  const views = { inicio: viewInicio, retornos: viewRetornos, vagas: viewVagas, treino: viewTreino, ajustes: viewAjustes, livro: viewLivro };
  const name = views[route] ? route : 'inicio';
  // o livro é grande: redesenhar a cada sincronização perderia a leitura; só redesenha se mudou a versão
  if (name === 'livro' && S.route === 'livro' && S.livro && $('#view').dataset.livro === S.livro.sha) {
    renderSync();
    renderBadges();
    return;
  }
  const entrouNoLivro = name === 'livro' && S.route !== 'livro';
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
    if (a.dataset.tab === (name === 'livro' ? 'treino' : name)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  // players já usados (tocando ou com posição) sobrevivem ao redesenho: sem isso, uma atualização dos dados no
  // meio da reprodução trocava o player por um novo, que parava e voltava ao início
  const players = [...document.querySelectorAll('#view audio')].filter(a => !a.paused || a.currentTime > 0)
    .map(a => ({ el: a, src: a.getAttribute('src'), tocava: !a.paused }));
  $('#view').innerHTML = !S.cfg && name !== 'ajustes' ? viewWelcome() : views[name]();
  for (const p of players) {
    const novo = [...document.querySelectorAll('#view audio')].find(a => a.getAttribute('src') === p.src && a !== p.el && !a.dataset.mantido);
    if (!novo) continue;
    novo.replaceWith(p.el);  // o mesmo elemento, na mesma posição; sair da página o pausa, então volta a tocar
    p.el.dataset.mantido = '1';
    if (p.tocava) p.el.play().catch(() => {});
  }
  for (const a of document.querySelectorAll('#view audio[data-mantido]')) delete a.dataset.mantido;
  $('#view').dataset.livro = name === 'livro' && S.livro ? S.livro.sha : '';
  // volta ao ponto onde parou de ler: ao entrar no livro, ou quando ele termina de carregar
  if (name === 'livro' && S.livro && (entrouNoLivro || !S.livroPosto)) {
    S.livroPosto = true;
    requestAnimationFrame(() => window.scrollTo(0, store.get('livroY', 0)));
  }
  if (name !== 'livro') S.livroPosto = false;
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

// se a chave VAPID do repositório mudou, a inscrição antiga não recebe mais nada: refaz sozinho
// (a permissão já foi dada, então não aparece pergunta)
async function renewPushIfKeyChanged() {
  const key = S.data.appcfg && S.data.appcfg.vapid_public_key;
  if (!key || S.pushState !== 'on' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    const cur = sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    const want = urlB64ToUint8Array(key);
    if (cur && (cur.length !== want.length || cur.some((b, i) => b !== want[i]))) await enablePush();
  } catch { /* tenta de novo na próxima carga */ }
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

function copiar(texto, ok) {
  return (navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject())
    .then(() => toast(ok), () => toast('Não deu para copiar; selecione o texto e copie à mão.', 5000));
}

const semMarcador = t => (t || '').replace(/^\[COMPLETE\]\s*/, '');

function pergAction(act, id) {
  const agora = new Date().toISOString();
  const resposta = qid => semMarcador(S.marks.perguntas[qid].final || ((S.data.respostas || {})[qid] || {}).texto);
  if (act === 'perg') {
    S.pergAberta = S.pergAberta === id ? '' : id;
  } else if (act === 'perg-gerar') {
    const f = S.pergForm[`nova:${id}`] || {};
    const textos = (f.pergunta || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (!textos.length) return toast('Escreva a pergunta.');
    const limite = parseInt(f.limite, 10) || 1500;
    delete S.pergForm[`nova:${id}`];
    setMarks(m => textos.forEach((pergunta, i) => {
      m.perguntas[`${id}|${agora}|${i}`] = { vaga_id: id, pergunta, limite, pedido_em: agora };
    }));
    return toast(`${textos.length === 1 ? 'Pergunta enviada' : `${textos.length} perguntas enviadas`}. O PC responde em até 15 min, se estiver ligado.`, 5000);
  } else if (act === 'perg-copiar') {
    const incompleta = !S.marks.perguntas[id].final && /^\[COMPLETE\]/.test(((S.data.respostas || {})[id] || {}).texto || '');
    return copiar(resposta(id), incompleta ? 'Copiada, mas está incompleta: complete antes de enviar.' : 'Resposta copiada.');
  } else if (act === 'perg-editar') {
    S.pergForm[`edit:${id}`] = { editando: true, texto: resposta(id) };
  } else if (act === 'perg-cancelar') {
    delete S.pergForm[`edit:${id}`];
  } else if (act === 'perg-salvar') {
    const texto = (S.pergForm[`edit:${id}`].texto || '').trim();
    if (!texto) return toast('Escreva a resposta.');
    const q = S.marks.perguntas[id];
    delete S.pergForm[`edit:${id}`];
    setMarks(m => {
      m.perguntas[id] = { ...q, final: texto };
      m.banco[`b:${id}`] = { pergunta: q.pergunta, resposta: texto, salvo_em: agora };  // mesma pergunta: substitui
    });
    return toast('Salva no banco: vale para as próximas cartas e perguntas.');
  } else if (act === 'perg-apagar') {
    return setMarks(m => { m.perguntas[id] = null; });  // null sobrevive à mescla; pruneMarks apaga ao gravar
  } else if (act === 'banco-editar') {
    const b = S.marks.banco[id];
    S.pergForm[`banco:${id}`] = { editando: true, pergunta: b.pergunta, resposta: b.resposta };
  } else if (act === 'banco-cancelar') {
    delete S.pergForm[`banco:${id}`];
  } else if (act === 'banco-salvar' || act === 'banco-adicionar') {
    const key = act === 'banco-salvar' ? `banco:${id}` : 'banco:novo';
    const f = S.pergForm[key] || {};
    const pergunta = (f.pergunta || '').trim(), resp = (f.resposta || '').trim();
    if (!pergunta || !resp) return toast('Preencha a pergunta e a resposta.');
    delete S.pergForm[key];
    return setMarks(m => { m.banco[act === 'banco-salvar' ? id : `b:${agora}`] = { pergunta, resposta: resp, salvo_em: agora }; });
  } else if (act === 'banco-apagar') {
    if (!confirm('Apagar esta resposta do banco?')) return;
    return setMarks(m => { m.banco[id] = null; });
  }
  render();
}

function cartaAction(act, id) {
  if (act === 'carta') {
    S.cartaAberta = S.cartaAberta === id ? '' : id;
  } else if (act === 'carta-nova') {
    const novo = `manual:${new Date().toISOString()}`;
    S.cartaAberta = novo;
    S.cartaForm[novo] = { editando: true };
  } else if (act === 'carta-editar') {
    S.cartaForm[id] = { ...S.cartaForm[id], editando: true };
  } else if (act === 'carta-cancelar') {
    delete S.cartaForm[id];
    if (!S.marks.cartas[id]) S.cartaAberta = '';
  } else if (act === 'carta-gerar') {
    const draft = S.cartaForm[id] || {};
    const pedido = S.marks.cartas[id] || {};
    const vaga = (S.data.vagas || []).find(v => v.id === id) || {};
    const get = campo => (draft[campo] ?? pedido[campo] ?? vaga[campo] ?? '').trim();
    if (id.startsWith('manual:') && !get('titulo') && !get('empresa')) return toast('Preencha pelo menos a empresa ou a vaga.');
    const novo = { pedido_em: new Date().toISOString(), titulo: get('titulo'), empresa: get('empresa'),
      local: pedido.local || [vaga.local, vaga.modelo_texto].filter(x => x && x !== 'Não informado').join(' · '),
      url: draft.url || pedido.url || vaga.url || '', descricao: get('descricao') };
    delete S.cartaForm[id];
    setMarks(m => { m.cartas[id] = novo; });
    return toast('Pedido enviado. O PC gera a carta em até 15 min, se estiver ligado.', 5000);
  } else if (act === 'carta-copiar') {
    return copiar(((S.data.cartas || {})[id] || {}).texto || '', 'Carta copiada.');
  } else if (act === 'carta-apagar') {
    if (!confirm('Apagar esta carta?')) return;
    if (S.cartaAberta === id) S.cartaAberta = '';
    return setMarks(m => { m.cartas[id] = null; });  // null sobrevive à mescla com o remoto; pruneMarks apaga ao gravar
  }
  render();
}

// o rascunho do pedido fica no estado, para não se perder quando a tela é redesenhada
document.addEventListener('input', e => {
  const el = e.target.closest('[data-carta]');
  if (el) (S.cartaForm[el.dataset.carta] ||= { editando: true })[el.dataset.campo] = el.value;
  const f = e.target.closest('[data-form]');
  if (f) (S.pergForm[f.dataset.form] ||= {})[f.dataset.campo] = f.value;
});

// posição de leitura do livro, para voltar ao mesmo ponto
let livroYTimer = 0;
window.addEventListener('scroll', () => {
  if (S.route !== 'livro' || !S.livro) return;
  clearTimeout(livroYTimer);
  livroYTimer = setTimeout(() => store.set('livroY', Math.round(window.scrollY)), 400);
}, { passive: true });

document.addEventListener('click', e => {
  // links internos do livro (sumário, "veja o capítulo 12"): rolam até o ponto, sem mexer na rota do app
  const link = e.target.closest('article.livro a[href^="#"]');
  if (link) {
    e.preventDefault();
    irNoLivro(link.getAttribute('href').slice(1));
    return;
  }
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
      // desmarcar ("Restaurar" nas descartadas): grava "nenhuma" em vez de apagar a chave; apagada, ela
      // voltaria na mescla com o repositório ao salvar. O pruneMarks limpa o "nenhuma" depois de gravado.
      setMarks(m => { m.vagas[id] = 'nenhuma'; });
      if (v === 'descartada') toast('Vaga restaurada: voltou para Novas.');
    } else {
      setMarks(m => { m.vagas[id] = v; });
    }
  } else if (act.startsWith('carta')) {
    cartaAction(act, el.dataset.id);
  } else if (act.startsWith('perg') || act.startsWith('banco')) {
    pergAction(act, el.dataset.id);
  } else if (act.startsWith('compart')) {
    compartAction(act);
  } else if (act === 'tocar') {
    tocar(el);
  } else if (act === 'voz-gravar') {
    vozGravar(el.dataset.id);
  } else if (act === 'voz-parar') {
    if (vozRec.rec) vozRec.rec.stop();
  } else if (act === 'voz-enviar') {
    vozEnviar(el.dataset.id);
  } else if (act === 'fila-tentar') {
    filaProcessar();
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
  } else if (act === 'ocultar') {
    // esconde de novo a resposta (para tentar outra vez sem olhar), mantendo o cartão na tela
    S.reveal = false;
    render();
    const flash = $('#view .flash');
    if (flash) flash.scrollIntoView({ block: 'start' });
  } else if (act === 'answer' && el.dataset.ent) {
    // cartão de entrevista específica: marca e vai para o próximo ainda não marcado (em ordem, dando a volta)
    const e = entrevistasOrdenadas().proximas.concat(entrevistasOrdenadas().anteriores).find(x => x.id === el.dataset.ent);
    if (!e) return;
    const ids = e.cartoes.map(c => c.id);
    const i = ids.indexOf(el.dataset.id);
    const marcados = { ...S.marks.entrevistas, [el.dataset.id]: true };
    const prox = [...ids.slice(i + 1), ...ids.slice(0, i)].find(id => !marcados[id]);
    S.entAtual = { ...S.entAtual, [e.id]: prox || el.dataset.id };
    store.set('entAtual', S.entAtual);
    S.reveal = false;
    if (!prox) toast('Todos os cartões desta entrevista foram marcados.');
    setMarks(m => { m.entrevistas[el.dataset.id] = { sei: el.dataset.knew === '1', em: new Date().toISOString() }; });
    const flash = $('#view .flash');
    if (flash) flash.scrollIntoView({ block: 'start' });
  } else if (act === 'answer') {
    const info = treinoInfo();
    if (!info) return;
    setMarks(m => { (m.treino[info.t.dia] ||= {})[el.dataset.id] = el.dataset.knew === '1'; });
    S.reveal = false;
    S.treinoAtual = '';  // o próximo é o primeiro da fila
    const after = treinoInfo();
    if (after && after.done >= after.meta && !info.met) toast('Meta de hoje cumprida! 🔥');
    render();
    window.scrollTo(0, 0);
  } else if (act === 'pular' || act === 'treino-ir') {
    e.preventDefault();  // o 🎯 do Material de estudo fica dentro do <summary>: não abrir o cartão ali
    if (vozRec.rec) return toast('Pare a gravação antes de trocar de cartão.');
    const info = treinoInfo();
    if (!info) return;
    if (act === 'pular') {
      // o pulado vai para o fim da fila e fica na lista "Pulados" até ser respondido (vale só para o dia)
      const ids = treinoPulados(info).filter(id => id !== el.dataset.id).concat(el.dataset.id);
      store.set('treinoPulados', { dia: info.t.dia, ids });
      S.treinoAtual = '';
      toast('Pulado: ele volta no fim da fila.');
    } else {
      S.treinoAtual = el.dataset.id;
      // o cartão abre no treino diário (o "Revise também" da aba Entrevistas também vem para cá)
      S.treinoAba = 'diario';
      store.set('treinoAba', 'diario');
    }
    S.reveal = false;
    render();
    const flash = $('#view .flash');
    if (flash) flash.scrollIntoView({ block: 'start' });
  } else if (act === 'ent-ir') {
    if (vozRec.rec) return toast('Pare a gravação antes de trocar de cartão.');
    S.entAtual = { ...S.entAtual, [el.dataset.ent]: el.dataset.id };
    store.set('entAtual', S.entAtual);
    S.reveal = false;
    render();
    const flash = $('#view .flash');
    if (flash) flash.scrollIntoView({ block: 'start' });
  } else if (act === 'treino-aba') {
    if (vozRec.rec) return toast('Pare a gravação antes de trocar de aba.');
    S.treinoAba = el.dataset.f === 'entrevistas' ? 'entrevistas' : 'diario';
    store.set('treinoAba', S.treinoAba);
    S.reveal = false;  // a resposta aberta numa aba não abre o cartão da outra
    if (S.route !== 'treino') location.hash = '#treino';  // o aviso do Início leva direto à aba
    else render();
    window.scrollTo(0, 0);
  } else if (act === 'ir-estudo') {
    const est = $('#estudo');
    if (est) est.scrollIntoView({ block: 'start' });
  } else if (act === 'busca-tirar') {
    buscaMudar(el.dataset.lista, l => l.filter(t => t !== el.dataset.termo));
  } else if (act === 'busca-padrao') {
    S.buscaRascunho = { ...(S.buscaRascunho || {}), [el.dataset.lista]: null };
    render();
  } else if (act === 'busca-descartar') {
    S.buscaRascunho = null;
    render();
  } else if (act === 'busca-salvar') {
    salvarBusca();
  } else if (act === 'acao-feita') {
    // guarda a data do pedido resolvido: um pedido mais novo do mesmo processo volta a aparecer
    const { chave, quando: q } = el.dataset;
    const ids = (S.data.retornos || []).filter(r => (r.candidatura || r.id) === chave).map(r => r.id);
    setMarks(m => {
      m.acoes_feitas[chave] = q || new Date().toISOString();
      for (const id of ids) if (!m.retornos_lidos[id]) m.retornos_lidos[id] = todayBRT();
    });
    toast('Feito. Se chegar um pedido novo desse processo, ele volta para a lista.', 4000);
  } else if (act === 'acao-desfazer') {
    setMarks(m => { m.acoes_feitas[el.dataset.chave] = null; });
  } else if (act === 'ver-acoes') {
    S.retornosFiltro = 'acoes';
    store.set('retornosFiltro', 'acoes');
    location.hash = '#retornos';
  } else if (act === 'pdf') {
    openPdf(el);
  } else if (act === 'livro-ir') {
    irNoLivro(el.dataset.alvo);
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
  const add = e.target.closest('form.busca-add');
  if (add) {
    // nova palavra-chave: entra no rascunho, sem repetir (maiúsculas e acentos não contam)
    e.preventDefault();
    const termo = add.termo.value.trim().replace(/\s+/g, ' ');
    if (!termo) return;
    const k = add.dataset.lista;
    if (buscaLista(k).some(t => semAcento(t) === semAcento(termo))) return toast(`"${termo}" já está na lista.`);
    buscaMudar(k, l => l.concat(termo));
    const campo = $(`form.busca-add[data-lista="${k}"] input`);
    if (campo) campo.focus();
    return;
  }
  if (e.target.id !== 'cfg-form') return;
  e.preventDefault();
  saveSettings(e.target);
});

// O webm que o navegador grava vem sem a duração: o player fica sem saber o tamanho e a barra não acompanha.
// O Chrome só descobre a duração depois de pular para o fim; então pula e volta ao começo.
document.addEventListener('loadedmetadata', e => {
  const a = e.target;
  if (!(a instanceof HTMLAudioElement) || Number.isFinite(a.duration)) return;
  const volta = () => { a.removeEventListener('timeupdate', volta); a.currentTime = 0; };
  a.addEventListener('timeupdate', volta);
  a.currentTime = 1e101;
}, true);

// "toggle" não sobe pela árvore: escuta na captura para lembrar o que está aberto no Material de estudo
document.addEventListener('toggle', e => {
  if (e.target.matches && e.target.matches('[data-banco]')) S.bancoAberto = e.target.open;
  const key = e.target.dataset && e.target.dataset.open;
  if (!key) return;
  if (e.target.open) S.studyOpen.add(key); else S.studyOpen.delete(key);
}, true);

document.addEventListener('change', e => {
  if (e.target.matches('[data-compart="vaga"]') && S.compartilhado) S.compartilhado.vaga = e.target.value;
});

$('#sync').addEventListener('click', () => loadAll());
window.addEventListener('hashchange', render);
window.addEventListener('online', () => filaProcessar());  // a conexão voltou: sobe o que estava guardado
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
  loadAll().then(vozAcompanhar).then(filaProcessar);  // gravações guardadas de antes sobem ao abrir o app
  lerCompartilhado();
})();
