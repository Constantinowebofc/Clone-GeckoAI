// GeckoAI — lógica do painel lateral.

import { GitHub } from '../lib/github.js';
import { PROVIDERS, createPersonalProvider, pickDefaultModel } from '../lib/providers.js';
import * as ChatGPT from '../lib/chatgpt.js';
import { criarProvedorChatGPT } from '../lib/providers-chatgpt.js';
import { Supabase, isDestructiveSql } from '../lib/supabase.js';
import { renovarSupabase, precisaRenovar, OAuthError } from '../lib/oauth.js';
import { readAI, fieldsAI, renderAIFields, credentialForAI, requestAIOrigin } from '../lib/personal-ai.js';
import { requestServiceToken } from '../lib/personal-connections.js';
import { vozDisponivel, criarDitado, ditadoLocalDisponivel } from '../lib/voz.js';
import { ehAbaDaExtensao, enterEnvia, abreEmAba } from '../lib/plataforma.js';
import { estadoDaAtualizacao } from '../lib/versao.js';
import { blocosDoResumo } from '../lib/formatar.js';
import { projetoDaUrl, corSegura, furoValido, furoAlinhado } from '../lib/nativo.js';
import { MAX_FILA, cabeNaFila, depoisDoRun, resumoDaFila } from '../lib/fila.js';

function getProvider() {
  const config = state.settings?.personalAI;
  return createPersonalProvider({ getConfig: async () => config || await readAI() });
}

// Chat nativo (1.11.0): este MESMO painel, carregado num quadro dentro da
// página da Lovable (nativo/conteudo.js), com a cara do chat dela. A aba é a
// da própria Lovable onde o quadro está — nunca "a aba ativa".
const MODO_NATIVO = new URLSearchParams(location.search).get('nativo') === '1';

// Em tela de toque (celular) o Enter do teclado virtual quebra linha: não há
// Shift, e um envio acidental custa um prompt. Lá o envio é só o botão.
const ENTER_ENVIA = enterEnvia({ toque: Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches) });

// ---------- Conexões pessoais diretas (sem intermediário OAuth) ----------

const NOME_SERVICO = { github: 'GitHub', supabase: 'Supabase', vercel: 'Vercel' };
function nomeServico(provider) { return NOME_SERVICO[provider] || provider; }

// Abre a aba do serviço e espera o token voltar pelo servidor. Cancela se
// outra conexão começar (o sinal) — sem isso o poll continuaria no vazio.
let oauthAbort = null;
async function conectarServico(provider) {
  return requestServiceToken(provider);
}

// Grava o pacote do /poll nas MESMAS chaves de settings de sempre e instancia
// o cliente. Valida na hora (getUser/listProjects): token que não serve não
// entra como "conectado".
async function salvarConexao(provider, pacote) {
  const s = { ...(state.settings || {}) };
  if (provider === 'github') {
    const gh = new GitHub(pacote.token);
    state.user = await gh.getUser();
    state.github = gh;
    s.githubToken = pacote.token;
    allRepos = [];
  } else if (provider === 'supabase') {
    const sb = new Supabase(pacote.token);
    state.supabaseProjects = await sb.listProjects();
    state.supabase = sb;
    s.supabaseToken = pacote.token;
    s.supabaseRefresh = pacote.refresh || null;
    s.supabaseExpiresAt = pacote.expiraEm ? Date.now() + pacote.expiraEm * 1000 : null;
  } else if (provider === 'vercel') {
    const teamId = pacote.extra?.teamId || null;
    const v = new Vercel(pacote.token, teamId);
    await v.getUser();
    state.vercel = v;
    s.vercelToken = pacote.token;
    s.vercelTeamId = teamId;
  }
  state.settings = s;
  await storage.set({ settings: s });
}
import { Vercel, defaultSiteUrl } from '../lib/vercel.js';
import {
  codigoInjetado, mensagemDeErro, traduzFalha, tipoDoErro, sqlDeLeitura, sqlDeEnsaio, linhasDaResposta, abreAcesso,
} from '../lib/lovable.js';
import { templateFiles, normalizeProjectName } from '../lib/template.js';
import { runAgent, commitMigration, enviarTrabalhoGuardado, prefixarCommit, semPrefixo } from '../lib/agent.js';
import {
  SKILLS, GRUPOS, skillsInstaladas, lerArquivoDaSkill, mudancasParaInstalar, mudancasParaRemover, acessoAsSkills,
} from '../lib/skills.js';
import {
  trabalhoAberto, passouDoTeto, promptDeSeguimento, continuacoesAposFalha, recuperarInterrompidos,
  garantirIds, mesclarHistorico, integrarHistorico, idsDeLegado, alinharAoGravado,
} from '../lib/rodadas.js';
import { MARCA } from '../lib/marca.js';
import { INTROSPECT_SQL, INTROSPECT_SQL_COMPACTO, parseSchemaPaste } from '../lib/introspect.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  // Depois de "Desconectar e apagar tudo" (em qualquer janela), esta não grava
  // mais nada: devolveria ao storage a chave e o token que acabaram de sumir.
  set: (obj) => (state.desconectado ? Promise.resolve() : chrome.storage.local.set(obj)),
  remove: (keys) => chrome.storage.local.remove(keys),
  clear: () => chrome.storage.local.clear(),
};

const state = {
  atualizacao: null, // { versao, url, obrigatoria } — ver lib/versao.js
  desfazendo: false, // "Desfazer último prompt" em andamento (trava envio e clique duplo)
  // settings: { githubToken, provider, keys: {pid: key}, models: {pid: modelId} }
  settings: null,
  project: null, // { owner, name, fullName, branch }
  modelsCache: {}, // { pid: [{id, label}] }
  user: null,
  github: null,
  supabase: null, // cliente da Management API (quando há token)
  vercel: null, // cliente da Vercel (quando há token)
  supabaseProjects: null, // cache dos projetos da conta
  dbRef: null, // ref do projeto Supabase detectado para o repositório atual
  dbKeys: null, // { url, anonKey } do projeto conectado (públicas; vão no contexto da IA)
  vercelLink: null, // { projectId?, name?, url } do projeto da Vercel deste repositório
  vercelChecked: {}, // repositórios já consultados na API da Vercel nesta sessão
  dbBindDismissed: false, // usuário fechou o banner "Vincular banco" nesta sessão
  running: false,
  abort: null,
  history: [],
  attachments: [], // { id, kind:'image'|'text', ... } anexados no composer
  contextChecked: false, // já verificamos se docs/CONTEXTO.md existe neste projeto
  hasContext: false, // docs/CONTEXTO.md existe no repo
  projectContext: null, // conteúdo do docs/CONTEXTO.md (mapa do projeto p/ a IA)
  abaNativa: null, // chat nativo: a aba da Lovable onde este painel está
  fila: [], // pedidos esperando o atual terminar (lib/fila.js), só em memória
  filaParada: null, // texto do motivo, quando a fila espera o cliente
};

// ---------- Views ----------

const VIEWS = ['loading', 'setup', 'repos', 'chat', 'nativo-config'];
function showView(name) {
  for (const v of VIEWS) {
    $(`#view-${v}`).hidden = v !== name;
  }
  // Chat nativo: outra tela no lugar do chat fecha o furo do "+" na hora.
  if (MODO_NATIVO) conferirFuro();
}

let toastTimer = null;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function showError(sel, message) {
  const box = $(sel);
  // `com-acao` é do conflito de dispositivo (dá espaço ao botão). Um erro
  // comum depois dele deixaria a caixa com padding sobrando — tira sempre.
  box.classList.remove('com-acao');
  if (!message) {
    box.hidden = true;
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

// Mesmo conflito, mas dentro do chat (o erro de um pedido). Devolve o bloco
// pronto para o histórico do run, com o botão de transferência.
function buildDeviceConflictBlock(message) {
  const box = el('div', 'run-error com-acao');
  box.append(el('div', null, message));
  const btn = el('button', 'btn-transfer', 'Usar neste computador');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Transferindo…';
    try {
      const info = await getProvider('geckoai').validate(
        state.settings?.keys?.geckoai, undefined, { reset: true }
      );
      state.settings.licenseExpiresAt = info.expiresAt ?? null;
      state.settings.licenseRemaining = info.remaining ?? null;
      state.settings.licenseIlimitado = info.ilimitado === true;
      state.settings.imagensAtivas = info.imagens === true;
      state.settings.modelos = info.modelos ?? null;
      await storage.set({ settings: state.settings });
      updateLicenseUI();
      btn.replaceWith(
        el('div', 'run-summary', 'Pronto — este computador está liberado. Envie o pedido de novo.')
      );
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Usar neste computador';
      toast(e.message || 'Não consegui transferir.');
    }
  });
  box.append(btn);
  return box;
}

// Chave presa em outro computador: mostra o motivo E o caminho de saída, no
// mesmo lugar. Sem o botão a pessoa fica sem saída — ela não tem como
// "deslogar" a máquina que ficou no trabalho.
function showDeviceConflict(sel, message, onTransfer) {
  const box = $(sel);
  box.textContent = '';
  box.classList.add('com-acao');   // padding extra: o botão 3D vazava a borda
  box.append(el('div', null, message));
  const btn = el('button', 'btn-transfer', 'Usar neste computador');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Transferindo…';
    try {
      // Quem chama trata o próprio erro e REDESENHA esta caixa (ou a apaga,
      // se deu certo). Por isso aqui não se esconde nada no sucesso: fazer
      // isso apagaria um conflito novo que o chamador acabou de mostrar.
      await onTransfer();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Usar neste computador';
      showError(sel, err.message || 'Não consegui transferir.');
    }
  });
  box.append(btn);
  box.hidden = false;
}

// ---------- Configurações: formato e migração ----------

// Ajusta configurações salvas por versões anteriores ao formato atual.
// Chaves de provedores que não existem mais são DESCARTADAS — assim nada de
// versões antigas fica guardado no navegador do usuário.
function migrateSettings(s) {
  if (!s) return null;
  const known = new Set(PROVIDERS.map((p) => p.id));
  const pick = (obj) =>
    Object.fromEntries(Object.entries(obj || {}).filter(([id]) => known.has(id)));

  if (s.keys) {
    const keys = pick(s.keys);
    const provider = known.has(s.provider)
      ? s.provider
      : Object.keys(keys)[0] || PROVIDERS[0].id;
    return { ...s, provider, keys, models: pick(s.models), mode: s.mode || 'build' };
  }
  // Formato bem antigo (uma chave de API por provedor): não serve mais, pois o
  // acesso agora é por chave de licença. Preserva só o token do GitHub.
  return {
    githubToken: s.githubToken || '',
    provider: PROVIDERS[0].id,
    keys: {},
    models: {},
    mode: 'build',
  };
}

function hasAnyAIKey(settings) {
  return PROVIDERS.some((p) => settings?.keys?.[p.id]);
}

function currentModelsFor(providerId) {
  const provider = getProvider(providerId);
  const cached = state.modelsCache?.[providerId];
  if (cached?.length) return cached;
  return provider.preferredModels.map((id) => ({ id, label: id }));
}

// Atualiza a lista de modelos de cada IA conectada, em segundo plano.
async function refreshModelsCache() {
  let changed = false;
  for (const p of PROVIDERS) {
    const key = state.settings?.keys?.[p.id];
    if (!key) continue;
    try {
      const models = await getProvider(p.id).listModels(key);
      if (models.length) {
        state.modelsCache[p.id] = models.slice(0, 40);
        changed = true;
      }
    } catch {
      /* mantém cache/preferidos */
    }
  }
  if (changed) {
    await storage.set({ modelsCache: state.modelsCache });
    populateModelSelect();
  }
}

// ---------- Inicialização ----------

// ---------- Tema claro/escuro ----------
// Guardado em chave própria do storage (fora de settings, que é reconstruído
// no salvar das Configurações). Padrão: escuro.

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  document.body.classList.toggle('gecko', theme === 'gecko');
  // Os três temas dividem a mesma estrutura 3D (as regras `body.relevo` do
  // CSS); cada um só troca a paleta. A classe é constante hoje, mas continua
  // sendo o interruptor caso um tema plano volte a existir.
  document.body.classList.add('relevo');
}

async function loadTheme() {
  const { theme } = await storage.get(['theme']);
  // A pele Gecko é verde-GeckoAI: numa marca sem ela, tema salvo "gecko" vira o escuro.
  applyTheme(theme === 'gecko' && !MARCA.peleGecko ? 'dark' : theme);
}

$('#btn-theme').addEventListener('click', async () => {
  const light = !document.body.classList.contains('light');
  applyTheme(light ? 'light' : 'dark');
  await storage.set({ theme: light ? 'light' : 'dark' });
});

// Easter egg: clicar no gecko do logo liga/desliga o Modo Gecko (só visual).
// Só no GeckoAI: numa marca white label seria o verde errado aparecendo.
if (MARCA.peleGecko) $('.brand-mark').addEventListener('click', async () => {
  const gecko = !document.body.classList.contains('gecko');
  const theme = gecko ? 'gecko' : 'dark';
  applyTheme(theme);
  await storage.set({ theme });
  if (gecko) toast('🦎 Modo Gecko ativado');
});

// ---------- Marca (white label) ----------
// O HTML traz "GeckoAI" como texto estático (é o que fica se o JS falhar); a
// marca do pacote entra aqui. A marca vem de lib/marca.js, gerado pelo build.
function aplicarMarca() {
  document.title = MARCA.nome;
  document.querySelectorAll('[data-marca]').forEach((n) => { n.textContent = MARCA.nome; });
}

async function init() {
  aplicarMarca();
  renderAIFields($('#personal-setup-ai'), await readAI());
  if (MODO_NATIVO) prepararModoNativo();
  else loadTheme(); // sem await: aplica assim que o storage responder
  showView('loading');
  const data = await storage.get(['settings', 'project', 'modelsCache', 'chatgpt', 'nativo', 'lovableMap']);
  const migrated = migrateSettings(data.settings);
  if (migrated && JSON.stringify(migrated) !== JSON.stringify(data.settings)) {
    await storage.set({ settings: migrated });
  }
  state.settings = migrated;
  state.project = data.project || null;
  state.modelsCache = data.modelsCache || {};
  state.chatgpt = data.chatgpt || null; // conta do ChatGPT do cliente (v1.6.0)

  if (MODO_NATIVO) {
    // O projeto é o da aba onde o quadro está. O `project` guardado é o do
    // painel: só serve se for o mesmo repositório; senão a resolução da aba
    // (handleActiveTab) escolhe o certo logo abaixo.
    state.abaNativa = await chrome.tabs.getCurrent().catch(() => null);
    const pid = projetoDaUrl(state.abaNativa?.url);
    const doMapa = pid ? data.lovableMap?.[pid] : null;
    if (!doMapa || state.project?.fullName !== doMapa) state.project = null;
    pedirTemaAoContentScript();
    pedirFuroAoContentScript();
  } else if (data.nativo?.ligado) {
    // Painel aberto = chat nativo desligado (decisão do dono, 2026-09-30: um
    // chat por vez). As abas da Lovable tiram o quadro — o que estiver no
    // meio de um pedido termina primeiro.
    storage.set({ nativo: { ligado: false } });
  }

  applyModeUI();
  updateLicenseUI();

  if (!state.settings?.githubToken || !hasAnyAIKey(state.settings)) {
    if (MODO_NATIVO) {
      showView('nativo-config');
      return;
    }
    showView('setup');
    // Chave já ativada mas sem GitHub (ou GitHub desconectado): vai direto ao
    // passo 2 — a chave não precisa ser digitada de novo.
    if (state.settings && hasAnyAIKey(state.settings)) {
      $('#in-ai').value = state.settings.keys?.[state.settings.provider] || '';
      $('#in-ai').disabled = true;
      $('#btn-connect').hidden = true;
      $('#setup-github').hidden = false;
    }
    watchLovableTabs(); // já observa a aba: assim que conectar, sincroniza na hora
    return;
  }

  state.github = new GitHub(state.settings.githubToken);
  if (state.settings.supabaseToken) {
    state.supabase = new Supabase(state.settings.supabaseToken);
    renovarSupabaseSeNecessario(); // em segundo plano; troca o cliente se renovar
  }
  if (state.settings.vercelToken) {
    state.vercel = new Vercel(state.settings.vercelToken, state.settings.vercelTeamId || null);
  }
  populateModelSelect();
  refreshModelsCache();
  refreshLicenseInfo();
  atualizarCatalogoChatGPT(); // em segundo plano: só relê se tiver mais de um dia
  atualizarUsoChatGPT(); // o selo "ChatGPT N%" já ao abrir, sem gastar o limite

  if (!state.project) {
    // Chat nativo: a aba diz qual é o projeto (watchLovableTabs, logo abaixo);
    // se ela não provar, a resolução abre a escolha de repositório.
    if (!MODO_NATIVO) await openReposView();
  } else {
    await openChatView();
  }
  watchLovableTabs();
}

// ---------- Setup ----------
// A edição pessoal valida a API escolhida, depois conecta o GitHub por token.

const setupProvider = 'geckoai';

$('#btn-connect').addEventListener('click', async () => {
  let aiKey = $('#in-ai').value.trim();
  showError('#setup-error', null);
  try {
    const config = fieldsAI($('#personal-setup-ai'));
    aiKey = credentialForAI(aiKey, config);
    if (!(await requestAIOrigin(config))) throw new Error('Permita o acesso à API escolhida para conectar.');
    await conectarAPI(aiKey, $('#btn-connect'), config);
  } catch (error) { showError('#setup-error', error.message); }
});

async function conectarAPI(aiKey, btn, config) {
  btn.disabled = true;
  btn.textContent = 'Conectando…';
  showError('#setup-error', null);
  try {
    const provider = getProvider();
    const info = await provider.validate(aiKey, undefined, { config });
    const models = [{ id: config.model, label: config.model }];
    const settings = {
      ...(state.settings || {}), provider: provider.id, personalAI: config,
      keys: { [provider.id]: aiKey }, models: { [provider.id]: config.model },
      mode: state.settings?.mode || 'build', licenseExpiresAt: null,
      licenseRemaining: null, licenseIlimitado: false, imagensAtivas: false, modelos: null,
    };
    const modelsCache = { ...state.modelsCache, [provider.id]: models };
    await storage.set({ settings, modelsCache, personalAI: config });
    state.settings = settings; state.modelsCache = modelsCache;
    aplicarVersaoDoServidor(info.versao); populateModelSelect(); updateLicenseUI();
    if (settings.githubToken) {
      state.github = new GitHub(settings.githubToken);
      await openReposView(); syncWithActiveTab(true);
    } else {
      $('#in-ai').disabled = true; btn.hidden = true; $('#setup-github').hidden = false;
    }
  } catch (error) { showError('#setup-error', error.message || 'Não foi possível conectar à API.'); }
  finally { btn.disabled = false; btn.textContent = 'Conectar API'; }
}

// Conecta o token pessoal e lista apenas os repositórios acessíveis a ele.
$('#btn-oauth-github').addEventListener('click', async () => {
  const btn = $('#btn-oauth-github');
  const status = $('#setup-github-status');
  showError('#setup-error', null);
  btn.disabled = true;
  status.hidden = false;
  try {
    const pacote = await conectarServico('github', {
      onStatus: (s) => {
        status.textContent =
          s === 'aguardando'
            ? 'Aguardando você autorizar na outra aba…'
            : s === 'conectado'
              ? 'Conectado! Carregando seus projetos…'
              : 'Abrindo o GitHub…';
      },
    });
    await salvarConexao('github', pacote);
    await openReposView();
    // Se um projeto do Lovable está aberto, já resolve (ou bloqueia) agora.
    syncWithActiveTab(true);
    // O init parou antes de revalidar a chave (sem GitHub não há painel):
    // validade, prompts e o contador premium de hoje vêm atualizados agora.
    refreshLicenseInfo();
  } catch (err) {
    status.hidden = true;
    showError('#setup-error', err.message || 'Não foi possível conectar ao GitHub.');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Repositórios ----------

let allRepos = [];

async function openReposView() {
  // Veio do chat? Dá o caminho de volta (na 1ª configuração não há projeto).
  $('#btn-back-repos').hidden = !state.project;
  showView('loading');
  try {
    if (!state.user) state.user = await state.github.getUser();
    allRepos = await state.github.listRepos();
  } catch (err) {
    if (err.status === 401) {
      // GitHub revogou/expirou: em vez de voltar ao setup pedindo token, o
      // banner com o botão Conectar de novo.
      showView('chat');
      exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
      return;
    }
    showView('repos');
    $('#repo-list').replaceChildren(el('p', 'repo-empty', err.message));
    return;
  }

  const chip = $('#account-chip');
  chip.replaceChildren();
  const img = el('img');
  img.src = state.user.avatar_url;
  img.alt = '';
  chip.append(img);
  const span = el('span');
  span.append('Conectado como ');
  span.append(el('strong', null, state.user.login));
  chip.append(span);

  renderRepoList('');
  $('#repo-search').value = '';
  showView('repos');
}

function looksLovable(repo) {
  const hay = `${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  return hay.includes('lovable');
}

// Lista TOTAL vazia quase nunca é "não tem repositório": é o token que não os
// alcança. Visto em produção (2026-08-31): testador com o projeto conectado
// no Lovable, lista vazia — e a mensagem antiga o mandava criar projeto do
// zero, o caminho oposto do que ele precisava. O diagnóstico diz a causa:
// clássico sem escopo `repo` só vê repositório público; fine-grained precisa
// de "All repositories" e, em organização, da liberação da org.
function buildTokenDiagnostico() {
  // Com o escopo `repo` vindo do OAuth isso quase não acontece: a conta está
  // vazia mesmo, ou o projeto do Lovable ainda não foi conectado ao GitHub.
  const box = el('div', 'repo-empty');
  box.append(el('p', null, 'Nenhum repositório na sua conta do GitHub.'));
  box.append(
    el('p', null,
      'Conecte o projeto do Lovable ao GitHub primeiro (no Lovable: GitHub → Connect) e clique em Atualizar.')
  );
  const btn = el('button', 'btn-ghost', 'Atualizar');
  btn.addEventListener('click', () => openReposView());
  box.append(btn);
  return box;
}

function renderRepoList(query) {
  const list = $('#repo-list');
  list.replaceChildren();

  const q = query.trim().toLowerCase();
  let repos = allRepos.filter((r) => !q || r.full_name.toLowerCase().includes(q));

  // Projetos com cara de Lovable primeiro.
  repos = [...repos].sort((a, b) => Number(looksLovable(b)) - Number(looksLovable(a)));

  if (repos.length === 0) {
    // Filtro sem resultado é uma coisa; lista TOTAL vazia é outra — e essa
    // segunda é problema de token, não ausência de repositório.
    list.append(
      allRepos.length === 0
        ? buildTokenDiagnostico()
        : el('p', 'repo-empty', 'Nenhum repositório encontrado.')
    );
    return;
  }

  for (const repo of repos.slice(0, 60)) {
    const item = el('button', 'repo-item');
    item.setAttribute('role', 'listitem');

    const name = el('div', 'repo-name', repo.name);
    if (looksLovable(repo)) name.append(el('span', 'badge-lovable', 'Lovable'));
    if (repo.private) name.append(el('span', 'badge-private', 'privado'));
    item.append(name);

    if (repo.description) item.append(el('div', 'repo-desc', repo.description));
    item.append(
      el('div', 'repo-meta', `${repo.owner.login} · atualizado ${relativeDate(repo.pushed_at)}`)
    );

    item.addEventListener('click', () => selectRepo(repo));
    list.append(item);
  }
}

function relativeDate(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
  return `há ${Math.floor(months / 12)} ano(s)`;
}

$('#repo-search').addEventListener('input', (e) => renderRepoList(e.target.value));

async function selectRepo(repo) {
  state.project = {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    branch: repo.default_branch,
  };
  // O `project` guardado é o do painel lateral; o chat nativo segue a aba dele.
  if (!MODO_NATIVO) await storage.set({ project: state.project });
  // Escolha manual com um projeto do Lovable aberto: só libera se o
  // repositório escolhido realmente pertencer ao projeto que está na tela.
  // (Na troca automática, lovableResolving=true, a resolução já verificou.)
  if (state.lovable?.projectId && !lovableResolving) {
    const matches = await repoMatchesLovable(repo, state.lovable.projectId);
    if (matches) {
      await saveLovableMapping(state.lovable.projectId, repo.full_name);
      state.lovableLock = false;
      updateComposerLock();
      showLovableBanner(null);
    } else {
      state.lovableLock = true;
      updateComposerLock();
      showLovableBanner({ type: 'warn', info: state.lovable, mismatch: repo.full_name });
    }
  }
  await openChatView();
}

// O repositório pertence ao projeto do Lovable? (o README gerado pelo
// Lovable contém a URL do projeto com o id)
async function repoMatchesLovable(repo, projectId) {
  try {
    const readme = await state.github.readFile(
      repo.owner.login, repo.name, repo.default_branch, 'README.md'
    );
    return readme.toLowerCase().includes(projectId);
  } catch {
    return false;
  }
}

$('#btn-change-repo').addEventListener('click', () => {
  if (state.running) return;
  openReposView();
});

// Volta da escolha de projeto para o chat sem perder nada (as views só alternam
// o hidden — o estado do chat continua intacto).
$('#btn-back-repos').addEventListener('click', () => {
  if (state.project) showView('chat');
});

// Atualizar o contexto do projeto (docs/CONTEXTO.md) a qualquer momento.
$('#btn-context')?.addEventListener('click', () => {
  if (state.running) return;
  if (state.lovableLock) { toast('Conecte o projeto ao GitHub primeiro.'); return; }
  if (state.hasContext && !confirm('Regerar o contexto do projeto (docs/CONTEXTO.md)?')) return;
  generateContext();
});

// Remover o selo "Edit with Lovable" que o Lovable injeta no site publicado.
// Sem confirmação de propósito: clicou, envia — o rótulo aparece no hover.
$('#btn-remove-logo')?.addEventListener('click', () => {
  if (state.running) return;
  if (state.lovableLock) { toast('Conecte o projeto ao GitHub primeiro.'); return; }
  removeLovableLogo();
});

// ---------- Criar projeto do zero ----------
// Repositório novo no GitHub + template Vite/React/Tailwind commitado na hora
// (sem gastar IA). Banco e hospedagem são opcionais.

function abrirWizardNovoProjeto() {
  $('#new-name').value = '';
  $('#new-private').checked = true;
  showError('#new-error', null);
  $('#new-form').hidden = false;
  $('#new-steps').hidden = true;
  $('#new-done').hidden = true;
  document.querySelectorAll('#new-steps li').forEach((li) => {
    li.className = '';
    if (li.dataset.step === 'db' || li.dataset.step === 'vercel') li.hidden = true;
  });
  prepararCampoBanco();
  // Hospedagem: com a Vercel conectada, publica sozinho; senão, oferece
  // conectar aqui mesmo (opcional — no final sempre há o link de 1 clique).
  const hint = $('#new-vercel-hint');
  hint.replaceChildren();
  if (state.vercel) {
    hint.textContent = 'Hospedagem: o site será publicado na Vercel automaticamente.';
  } else {
    // Sem OAuth na Vercel, o caminho é o campo de token nas Configurações.
    hint.append('Hospedagem: ');
    const b = el('button', 'btn-ghost', 'Conectar Vercel');
    b.addEventListener('click', abrirConfiguracoes);
    hint.append(b, ' (opcional — sem isso você publica com 1 clique no final).');
  }
  $('#new-overlay').hidden = false;
  $('#new-name').focus();
}

$('#btn-new-project')?.addEventListener('click', abrirWizardNovoProjeto);
$('#btn-close-new')?.addEventListener('click', () => { $('#new-overlay').hidden = true; });

function marcarPasso(id, estado) { // 'run' | 'ok' | 'warn' | 'err'
  const li = document.querySelector(`#new-steps li[data-step="${id}"]`);
  if (li) { li.hidden = false; li.className = estado; }
}

// O ref do auto_init pode demorar um instante logo após criar o repositório.
async function commitTemplate(repo, tentativa = 0) {
  const changes = new Map(
    [...templateFiles(repo.name)].map(([p, c]) => [p, { content: c }])
  );
  try {
    await state.github.commitChanges(
      repo.owner.login, repo.name, repo.default_branch, changes,
      prefixarCommit('projeto inicial (Vite + React + Tailwind)')
    );
  } catch (e) {
    if (tentativa < 2 && (e.status === 404 || e.status === 409)) {
      await new Promise((r) => setTimeout(r, 1500));
      return commitTemplate(repo, tentativa + 1);
    }
    throw e;
  }
}

async function criarProjetoDoZero() {
  const name = normalizeProjectName($('#new-name').value);
  showError('#new-error', null);
  if (!name) {
    showError('#new-error', 'Dê um nome ao projeto (letras, números e hífens).');
    return;
  }
  const btn = $('#btn-create-project');
  btn.disabled = true;
  $('#new-form').hidden = true;
  $('#new-steps').hidden = false;

  let repo = null;
  try {
    marcarPasso('repo', 'run');
    repo = await state.github.createRepo(name, {
      isPrivate: $('#new-private').checked,
      description: `Criado com ${MARCA.nome}`,
    });
    marcarPasso('repo', 'ok');

    marcarPasso('files', 'run');
    await commitTemplate(repo);
    marcarPasso('files', 'ok');
  } catch (e) {
    marcarPasso(repo ? 'files' : 'repo', 'err');
    $('#new-form').hidden = false;
    $('#new-steps').hidden = true;
    btn.disabled = false;
    showError('#new-error', e.status === 422
      ? `Já existe um repositório chamado "${name}" na sua conta. Escolha outro nome.`
      : (e.message || 'Não consegui criar o projeto.'));
    return;
  }

  // Projeto criado: já entra no estado, para os passos opcionais usarem.
  state.project = {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    branch: repo.default_branch,
    kind: 'novo',
  };
  await storage.set({ project: state.project });
  allRepos = []; // a lista de repositórios ficou desatualizada

  const extras = { dbPass: null, vercelOk: false, importUrl: null };
  await passoBancoWizard(extras);
  await passoVercelWizard(extras);

  finalizarWizard(extras);
}

function finalizarWizard(extras) {
  const done = $('#new-done');
  done.replaceChildren();
  done.hidden = false;
  done.append(el('p', 'np-ready', '✓ Projeto criado!'));
  if (extras.dbPass) {
    const p = el('p', 'field-hint');
    p.append('Senha do banco (guarde se quiser — a extensão não precisa dela): ');
    p.append(el('span', 'mono', extras.dbPass));
    const cp = el('button', 'lb-btn', 'Copiar');
    cp.addEventListener('click', () => copyToClipboard(extras.dbPass));
    done.append(p, cp);
  }
  if (extras.importUrl) {
    const a = el('a', 'lb-btn', 'Publicar na Vercel (1 clique)');
    a.href = extras.importUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    done.append(a);
  }
  const go = el('button', 'btn-primary', 'Abrir o projeto');
  go.addEventListener('click', async () => {
    $('#new-overlay').hidden = true;
    $('#btn-create-project').disabled = false;
    await openChatView();
  });
  done.append(go);
}

// Preenche o select de banco do wizard: nenhum / projetos existentes / criar novo.
function prepararCampoBanco() {
  const field = $('#new-db-field');
  const select = $('#new-db');
  const orgSelect = $('#new-db-org');
  orgSelect.hidden = true;
  if (!state.supabase) {
    // Sem Supabase conectado: oferece conectar aqui mesmo, em 1 clique.
    field.hidden = false;
    select.replaceChildren(new Option('Sem banco por enquanto', ''));
    field.querySelector('.btn-ghost')?.remove();
    const btn = el('button', 'btn-ghost', 'Conectar Supabase para criar um banco');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await salvarConexao('supabase', await conectarServico('supabase'));
        btn.remove();
        prepararCampoBanco();
      } catch (err) {
        toast(err.message || 'Não deu certo.');
        btn.disabled = false;
      }
    });
    field.append(btn);
    return;
  }
  field.querySelector('.btn-ghost')?.remove();
  field.hidden = false;
  select.replaceChildren(new Option('Sem banco por enquanto', ''));
  select.append(new Option('➕ Criar um banco novo', '__nova'));
  (async () => {
    try {
      if (!state.supabaseProjects) {
        state.supabaseProjects = await state.supabase.listProjects();
      }
      for (const p of state.supabaseProjects) {
        select.append(new Option(`Usar: ${p.name || p.id}`, p.id));
      }
      const orgs = await state.supabase.listOrganizations();
      orgSelect.replaceChildren(...orgs.map((o) => new Option(`Conta: ${o.name}`, o.id)));
      select.onchange = () => {
        orgSelect.hidden = !(select.value === '__nova' && orgs.length > 1);
      };
    } catch {
      /* sem lista, ainda dá para criar sem banco */
    }
  })();
}

function gerarSenhaDb() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(28));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

async function esperarProjetoAtivo(ref) {
  const inicio = Date.now();
  while (Date.now() - inicio < 4 * 60_000) {
    const st = await state.supabase.getProjectStatus(ref).catch(() => null);
    if (st === 'ACTIVE_HEALTHY') return;
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('O banco demorou demais para ficar pronto. Vincule de novo pelo banner do chat em instantes.');
}

// Passo opcional do wizard: vincula um projeto existente ou cria um novo.
// Falha aqui NÃO derruba o wizard — o repositório já existe; marca 'warn' e segue.
async function passoBancoWizard(extras) {
  const escolha = state.supabase ? $('#new-db').value : '';
  if (!escolha) return;
  marcarPasso('db', 'run');
  try {
    let ref = escolha;
    if (escolha === '__nova') {
      const orgSelect = $('#new-db-org');
      const orgId = orgSelect.value || orgSelect.options[0]?.value;
      if (!orgId) throw new Error('Não achei uma organização na sua conta do Supabase.');
      extras.dbPass = gerarSenhaDb();
      const proj = await state.supabase.createProject({
        name: state.project.name,
        organizationId: orgId,
        dbPass: extras.dbPass,
      });
      ref = proj.id;
      await esperarProjetoAtivo(ref);
      state.supabaseProjects = null; // a lista mudou
    }
    await saveDbBind(state.project.fullName, ref);
    await scaffoldSupabaseClient(ref);
    marcarPasso('db', 'ok');
  } catch (e) {
    marcarPasso('db', 'warn');
    toast(e.message || 'Não consegui preparar o banco — dá para vincular depois pelo chat.');
  }
}

// Passo opcional do wizard: cria o projeto na Vercel ligado ao repositório.
// A API exige o app GitHub da Vercel instalado na conta; se recusar, cai no
// import manual em 1 clique (extras.importUrl) e o wizard segue normal.
async function passoVercelWizard(extras) {
  const repoUrl = `https://github.com/${state.project.fullName}`;
  if (!state.vercel) {
    extras.importUrl = `https://vercel.com/new/import?s=${encodeURIComponent(repoUrl)}`;
    return;
  }
  marcarPasso('vercel', 'run');
  try {
    const proj = await state.vercel.createProject(state.project.name, state.project.fullName);
    await saveVercelLink(state.project.fullName, {
      projectId: proj.id,
      name: proj.name,
      url: defaultSiteUrl(proj.name),
    });
    extras.vercelOk = true;
    marcarPasso('vercel', 'ok');
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      exigirReconexao('vercel', 'Sua conexão com a Vercel expirou ou a integração foi removida.');
    }
    marcarPasso('vercel', 'warn');
    extras.importUrl = `https://vercel.com/new/import?s=${encodeURIComponent(repoUrl)}`;
    toast('Não consegui criar na Vercel pela API — use o botão "Publicar na Vercel" no final.');
  }
}

$('#btn-create-project')?.addEventListener('click', criarProjetoDoZero);

// ---------- Chat ----------

function historyKey() {
  return `chat:${state.project.fullName}`;
}

async function openChatView() {
  showView('chat');
  // A folha de Skills mostra o que está instalado NO projeto em que foi
  // aberta: ao entrar no chat de outro, ela fecha.
  if ($('#skills-overlay')) $('#skills-overlay').hidden = true;
  $('#project-name').textContent = state.project.fullName;
  // O seletor de IA (premium/ChatGPT) é montado aqui, a cada entrada no chat:
  // pelo caminho "conectar o GitHub" (trocar de conta, 1ª configuração) o init
  // para antes de montá-lo, e a linha ficava escondida com o premium na chave.
  populateModelSelect();

  // Projeto criado do zero publica na Vercel; o de Lovable sincroniza no Lovable.
  const novo = state.project.kind === 'novo';
  const ultimoNo = document.querySelector('#pipeline .pipe-node:last-child');
  if (ultimoNo) ultimoNo.textContent = novo ? 'Vercel' : 'Lovable';
  $('#pipeline').title = novo ? 'Fluxo: GitHub → IA → Vercel' : 'Fluxo: GitHub → IA → Lovable';

  const data = await storage.get([historyKey()]);
  state.history = data[historyKey()] || [];
  // A foto vem ANTES dos ids: registro antigo que ganha id agora conta como
  // mudado por esta janela e é gravado com ele (sem isso a mescla o perderia).
  fotografarHistorico(state.history);
  idsGravados = new Set(state.history.filter((r) => r?.id).map((r) => r.id));
  // Registro antigo (sem id) ganha id DETERMINÍSTICO: duas abas abrindo juntas
  // o mesmo histórico antigo dão os mesmos ids, e a mescla não duplica.
  if (idsDeLegado(state.history)) await saveHistory();
  // Painel fechado no meio de um run: o trabalho que ele carregava volta a
  // ter botão (lib/rodadas.js). Só com nada rodando neste painel — e nem em
  // outro: com o chat nativo rodando este projeto (trava ocupada), o registro
  // "em andamento" é um pedido VIVO, não um interrompido.
  if (!state.running && (await travaLivre()) && recuperarInterrompidos(state.history)) await saveHistory();
  // Registro "em andamento" com a trava ocupada = pedido vivo em outra janela.
  // Se ela morrer no meio (F5 na aba da Lovable), a trava cai: aí esta janela
  // recupera o trabalho dele (antes ficava "rodando em outra janela" para
  // sempre, com as rodadas pagas presas — segunda revisão da 1.11).
  if (state.history.some((r) => r?.emAndamento)) esperarTravaParaRecuperar();
  renderHistory();

  // Mesmo furo do seletor acima: pelo caminho "conectar o GitHub" o init
  // para antes de criar os clientes do Supabase e da Vercel, e um projeto com
  // Supabase externo conectado rodava como Lovable Cloud (SQL manual).
  if (!state.supabase && state.settings?.supabaseToken) {
    state.supabase = new Supabase(state.settings.supabaseToken);
    renovarSupabaseSeNecessario();
  }
  if (!state.vercel && state.settings?.vercelToken) {
    state.vercel = new Vercel(state.settings.vercelToken, state.settings.vercelTeamId || null);
  }

  loadBranches();
  refreshDbConnection();
  refreshVercelLink();
  checkProjectContext();
  pintarFila();
}

// ---------- Banco de dados (Supabase) ----------

// Descobre o projeto Supabase do repositório lendo o próprio código.
async function detectSupabaseRef() {
  const { owner, name, branch } = state.project;
  const sources = [
    { path: 'supabase/config.toml', re: /project_id\s*=\s*"([a-z0-9]{15,25})"/i },
    { path: 'src/integrations/supabase/client.ts', re: /https:\/\/([a-z0-9]{15,25})\.supabase\.co/i },
    { path: '.env', re: /https:\/\/([a-z0-9]{15,25})\.supabase\.co/i },
  ];
  for (const s of sources) {
    try {
      const content = await state.github.readFile(owner, name, branch, s.path);
      const m = content.match(s.re);
      if (m) return m[1];
    } catch {
      /* arquivo não existe — tenta o próximo */
    }
  }
  return null;
}

// Token OAuth do Supabase expira. Renova com folga (5 min) antes de usar o
// banco; se a renovação falhar, pede para conectar de novo — nunca deixa o
// run começar com um token morto. Token colado antigo (sem validade) passa.
// Voo único: init, abrir o chat e o envio chamam isto sem esperar um pelo
// outro, e duas renovações com o MESMO refresh token podem invalidar a sessão.
let renovacaoSupabase = null;
function renovarSupabaseSeNecessario() {
  if (!renovacaoSupabase) {
    renovacaoSupabase = renovarSupabaseAgora().finally(() => { renovacaoSupabase = null; });
  }
  return renovacaoSupabase;
}

async function renovarSupabaseAgora() {
  if (!state.settings?.supabaseToken) return false;
  if (!precisaRenovar(state.settings.supabaseExpiresAt)) return true;
  // Várias janelas vivas (painel + chat nativo em cada aba da Lovable): a
  // renovação é uma só no navegador inteiro. Duas janelas renovando com o
  // MESMO refresh token — a segunda perdia ("Conectar de novo") ou, com
  // detecção de reuso no provedor, a sessão inteira caía (revisão da 1.11).
  const renovar = async () => {
    // Relê: outra janela pode ter renovado enquanto esta esperava a vez.
    const atual = (await storage.get(['settings'])).settings || state.settings || {};
    if (atual.supabaseToken && !precisaRenovar(atual.supabaseExpiresAt)) {
      state.settings = atual;
      state.supabase = new Supabase(atual.supabaseToken);
      return true;
    }
    if (!atual.supabaseRefresh) {
      exigirReconexao('supabase');
      return false;
    }
    try {
      const r = await renovarSupabase(atual.supabaseRefresh, { licenseKey: atual.keys?.[atual.provider] || '', fetch: comPrazo20s });
      // Mescla com o que está no storage AGORA (a ida à rede demora; outra
      // janela pode ter mudado o modo, a fonte, a licença nesse meio).
      const depois = (await storage.get(['settings'])).settings || atual;
      state.settings = {
        ...depois,
        supabaseToken: r.token,
        supabaseRefresh: r.refresh || atual.supabaseRefresh,
        supabaseExpiresAt: r.expiraEm ? Date.now() + r.expiraEm * 1000 : null,
      };
      await storage.set({ settings: state.settings });
      state.supabase = new Supabase(r.token);
      return true;
    } catch {
      exigirReconexao('supabase');
      return false;
    }
  };
  if (!navigator.locks?.request) return renovar();
  try {
    return await navigator.locks.request('renovar-supabase', { signal: AbortSignal.timeout(45_000) }, renovar);
  } catch {
    toast('A conexão com o Supabase está sendo renovada em outra janela. Tente de novo em instantes.');
    return false;
  }
}

// A renovação é uma só no navegador inteiro (trava acima): uma ida à rede
// travada prenderia todas as janelas. Prazo de 20 s.
const comPrazo20s = (url, opcoes = {}) => fetch(url, { ...opcoes, signal: AbortSignal.timeout(20_000) });

// Escopo: a extensão só é usada em projetos SEM banco, ou com banco Supabase
// EXTERNO comprovado (o token do usuário acessa aquele projeto). Bancos que não
// dá para comprovar como externos (Lovable Cloud) ficam bloqueados.
// Estados: 'none' (sem banco → liberado), 'connected' (externo comprovado →
// liberado), 'no-token' (tem banco, falta token → bloqueado),
// 'foreign' (banco fora do alcance do token, ex.: Lovable Cloud → bloqueado).
async function refreshDbConnection() {
  state.dbRef = null;
  state.dbProjectName = null;
  state.dbStatus = 'none';
  state.schemaSynced = false;
  state.schemaSyncedAt = null;
  state.schemaChecked = false;
  state.schemaNoCodigo = false;
  state.dbKeys = null;
  state.dbMismatch = false;
  state.dbPanelOpen = false; // trocou de projeto: o painel volta fechado

  if (!state.github || !state.project) return finishDbState();

  let ref = null;
  try {
    ref = await detectSupabaseRef();
  } catch {
    ref = null;
  }

  if (!state.supabase) {
    // Sem token: com banco no código é o fluxo Lovable Cloud; sem, projeto sem banco.
    state.dbStatus = ref ? 'no-token' : 'none';
    return finishDbState();
  }

  const bound = (await getDbBindMap())[state.project.fullName] || null;
  if (!ref && !bound) {
    // Conectado mas o código ainda não usa Supabase. Antes de perguntar,
    // tenta casar pelo NOME do projeto: um projeto do Supabase com o mesmo
    // nome do projeto do Lovable é o banco dele — o leigo não precisa escolher.
    const alvo = normalizeName(state.lovable?.title || state.project.name || '');
    if (!state.supabaseProjects) {
      state.supabaseProjects = await state.supabase.listProjects().catch(() => []);
    }
    const porNome = alvo ? state.supabaseProjects.filter((p) => normalizeName(p.name || '') === alvo) : [];
    if (porNome.length === 1) {
      await saveDbBind(state.project.fullName, porNome[0].id);
      toast(`✓ Banco de dados: Supabase — ${porNome[0].name}`);
      return refreshDbConnection();
    }
    state.dbStatus = 'unbound';
    return finishDbState();
  }

  try {
    if (!state.supabaseProjects) {
      state.supabaseProjects = await state.supabase.listProjects();
    }
    // O que está no código sempre vence o vínculo manual (trava de projeto certo).
    const target = ref || bound;
    const match = state.supabaseProjects.find((p) => p.id === target);
    if (match) {
      state.dbRef = target;
      state.dbProjectName = match.name || target;
      state.dbStatus = 'connected';
      state.dbMismatch = Boolean(ref && bound && ref !== bound);
      fetchDbKeys(target); // em segundo plano; a IA usa quando precisar do client.ts
    } else {
      state.dbStatus = ref ? 'foreign' : 'unbound';
    }
  } catch {
    state.dbStatus = 'no-token'; // token com problema: trate como pendente
  }
  finishDbState();
}

// ---------- Vínculo manual com um projeto Supabase externo ----------
// Para repositórios que ainda não usam Supabase no código: o usuário escolhe o
// projeto da conta dele e a extensão faz o resto (client.ts + dependência).

async function getDbBindMap() {
  return (await storage.get(['dbBindMap'])).dbBindMap || {};
}

async function saveDbBind(fullName, ref) {
  const map = await getDbBindMap();
  map[fullName] = ref;
  await storage.set({ dbBindMap: map });
}

// ---------- Vínculo repositório -> projeto da Vercel (para o preview) ----------

async function getVercelMap() {
  return (await storage.get(['vercelMap'])).vercelMap || {};
}

async function saveVercelLink(fullName, link) {
  const map = await getVercelMap();
  map[fullName] = link; // { projectId?, name?, url }
  await storage.set({ vercelMap: map });
}

// ---------- Linhas de conexão (Vercel / Supabase / Lovable Cloud) ----------

// Descobre o projeto da Vercel deste repositório para a linha de conexão.
// Sem vínculo salvo mas com token, consulta a API uma vez por sessão.
async function refreshVercelLink() {
  state.vercelLink = null;
  updateConnLines();
  if (!state.project) return;
  const fullName = state.project.fullName;
  let link = (await getVercelMap())[fullName] || null;
  if (!link && state.vercel && !state.vercelChecked[fullName]) {
    state.vercelChecked[fullName] = true;
    try {
      const proj = await state.vercel.findProjectByRepo(fullName);
      if (proj) {
        link = { projectId: proj.id, name: proj.name, url: defaultSiteUrl(proj.name) };
        await saveVercelLink(fullName, link);
      }
    } catch (e) {
      // Sem vínculo, a linha só não aparece. Credencial morta é outra coisa:
      // pede para conectar de novo.
      if (e?.status === 401 || e?.status === 403) {
        exigirReconexao('vercel', 'Sua conexão com a Vercel expirou ou a integração foi removida.');
      }
    }
  }
  // O usuário pode ter trocado de projeto enquanto a API respondia.
  if (state.project?.fullName !== fullName) return;
  state.vercelLink = link;
  updateConnLines();
}

// Quanto tempo faz, em português de gente. O retrato do banco envelhece:
// o usuário precisa ver de relance se vale re-sincronizar.
const DIA_MS = 86_400_000;
function haQuantoTempo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const dias = Math.floor((Date.now() - t) / DIA_MS);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'há 1 mês' : `há ${meses} meses`;
}
// A partir daqui o retrato é velho o bastante para merecer aviso na cor.
const SCHEMA_VELHO_DIAS = 14;
function schemaEstaVelho(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && Date.now() - t >= SCHEMA_VELHO_DIAS * DIA_MS;
}

// Sufixo da linha do banco no modo manual: desde quando o retrato foi tirado.
// Sem isso o usuário não tinha como saber que o schema envelheceu e que a IA
// está lendo uma foto velha do banco.
function extraDoSchema() {
  if (!state.schemaSynced) return { texto: '· sem schema — sincronizar', alerta: true };
  const quando = haQuantoTempo(state.schemaSyncedAt);
  return {
    texto: quando ? `· sincronizado ${quando}` : '· sincronizado',
    alerta: schemaEstaVelho(state.schemaSyncedAt),
  };
}

function connLine(kind, label, name, onClick, extra) {
  const row = el(onClick ? 'button' : 'div', `conn-line ${kind}`);
  row.append(el('span', 'conn-dot'), el('span', 'conn-label', label), el('strong', null, name));
  if (extra) row.append(el('span', `conn-extra${extra.alerta ? ' alerta' : ''}`, extra.texto));
  if (onClick) {
    row.type = 'button';
    row.addEventListener('click', onClick);
  }
  return row;
}

function updateConnLines() {
  const box = $('#conn-lines');
  if (!box) return;
  box.replaceChildren();
  const lines = [];
  if (state.vercelLink) {
    let name = state.vercelLink.name || null;
    if (!name && state.vercelLink.url) {
      try { name = new URL(state.vercelLink.url).hostname; } catch { /* URL inválida */ }
    }
    if (name) lines.push(connLine('vercel', 'Vercel', name));
  }
  if (state.dbStatus === 'connected') {
    lines.push(connLine('supabase', 'Supabase', state.dbProjectName || state.dbRef));
  } else if (state.dbStatus === 'foreign' || (state.dbStatus === 'no-token' && state.schemaSynced)) {
    // Duas maneiras de chegar ao Lovable Cloud, as duas com base:
    //  - 'foreign': há token, o projeto foi procurado na conta do usuário e
    //    não está lá — logo o banco é de fora. Prova nossa.
    //  - 'no-token' com schema JÁ sincronizado: o painel oferece "conecte o
    //    Supabase" OU "sincronize o schema, se é Lovable Cloud"; ao escolher
    //    sincronizar, o usuário declarou qual é o caso. Declaração dele, não
    //    chute nosso — e se depois ele conectar o Supabase e o banco estiver
    //    lá, o estado vira 'connected' e esta linha some sozinha.
    lines.push(connLine('lovable', 'Banco', 'Lovable Cloud', toggleDbPanel, extraDoSchema()));
  } else if (state.dbStatus === 'no-token' && state.schemaChecked) {
    // Sem Supabase conectado E sem schema sincronizado NÃO dá para saber de
    // quem é o banco. Dizer "Lovable Cloud" aqui era diagnóstico inventado: o
    // projeto do dono era Supabase externo e a extensão anunciava Lovable
    // Cloud, empurrando para o SQL manual sem necessidade.
    // Só depois de `schemaChecked`: a consulta ao GitHub é assíncrona, e sem
    // esta guarda a linha piscava "conecte o Supabase" antes de virar
    // "Lovable Cloud" em quem já tinha sincronizado.
    lines.push(connLine('lovable', 'Banco', 'conecte o Supabase para identificar', toggleDbPanel));
  }
  box.hidden = !lines.length;
  box.append(...lines);
}

// ---------- Preview do site ----------

async function abrirPreview() {
  if (!state.project) return;
  const map = await getVercelMap();
  let link = map[state.project.fullName] || null;

  // Sem vínculo mas com token: tenta descobrir sozinho antes de perguntar.
  if (!link && state.vercel) {
    try {
      const proj = await state.vercel.findProjectByRepo(state.project.fullName);
      if (proj) {
        link = { projectId: proj.id, name: proj.name, url: defaultSiteUrl(proj.name) };
        await saveVercelLink(state.project.fullName, link);
        refreshVercelLink();
      }
    } catch { /* cai no overlay */ }
  }

  if (link) {
    const url = chrome.runtime.getURL(
      `preview/preview.html?repo=${encodeURIComponent(state.project.fullName)}`
    );
    chrome.tabs.create({ url });
    return;
  }

  $('#pv-import').href =
    `https://vercel.com/new/import?s=${encodeURIComponent(`https://github.com/${state.project.fullName}`)}`;
  $('#pv-detect').hidden = !state.vercel;
  $('#pv-url').value = '';
  showError('#pv-error', null);
  $('#preview-overlay').hidden = false;
}

$('#btn-preview')?.addEventListener('click', abrirPreview);
$('#btn-close-preview')?.addEventListener('click', () => { $('#preview-overlay').hidden = true; });
$('#preview-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('#preview-overlay')) $('#preview-overlay').hidden = true;
});

$('#pv-detect')?.addEventListener('click', async () => {
  showError('#pv-error', null);
  try {
    const proj = await state.vercel.findProjectByRepo(state.project.fullName);
    if (!proj) {
      showError('#pv-error', 'Não achei um projeto da Vercel ligado a este repositório. Publique primeiro pelo botão acima.');
      return;
    }
    await saveVercelLink(state.project.fullName, {
      projectId: proj.id, name: proj.name, url: defaultSiteUrl(proj.name),
    });
    refreshVercelLink();
    $('#preview-overlay').hidden = true;
    abrirPreview();
  } catch (e) {
    showError('#pv-error', e.message);
  }
});

$('#btn-save-preview')?.addEventListener('click', async () => {
  const url = $('#pv-url').value.trim();
  if (!/^https:\/\/[^\s]+\.[^\s]+/.test(url)) {
    showError('#pv-error', 'Cole a URL completa do site (começando com https://).');
    return;
  }
  await saveVercelLink(state.project.fullName, { url });
  refreshVercelLink();
  $('#preview-overlay').hidden = true;
  abrirPreview();
});

// Avisa a página de preview que um commit novo saiu deste repositório.
async function pingPreview() {
  if (!state.project) return;
  await storage.set({ previewPing: { repo: state.project.fullName, at: Date.now() } });
}

// Credenciais públicas (URL + anon) do projeto conectado, para o contexto da IA.
async function fetchDbKeys(ref) {
  if (state.dbKeys?.url === `https://${ref}.supabase.co`) return;
  try {
    state.dbKeys = await state.supabase.getPublicCredentials(ref);
  } catch {
    state.dbKeys = null; // sem elas a IA segue normal (run_sql não depende disso)
  }
}

// Deixa o frontend pronto sem gastar IA: commita o client.ts padrão (Lovable)
// com as credenciais públicas e garante @supabase/supabase-js no package.json.
async function scaffoldSupabaseClient(ref) {
  const { owner, name, branch } = state.project;
  try {
    const current = await state.github.readFile(
      owner, name, branch, 'src/integrations/supabase/client.ts'
    );
    // Com URL real dentro, não mexe (o código vence). Um client só com
    // placeholders de env (VITE_...) está quebrado — substitui pelo real.
    if (/https:\/\/[a-z0-9]{15,25}\.supabase\.co/i.test(current)) return;
  } catch {
    /* não existe — cria abaixo */
  }

  const creds = await state.supabase.getPublicCredentials(ref);
  state.dbKeys = creds;

  const clientTs = [
    `// Cliente Supabase do projeto — gerado pelo ${MARCA.nome} ao vincular o banco.`,
    '// A chave abaixo é a publishable/anon: pública por design (RLS protege os dados).',
    "import { createClient } from '@supabase/supabase-js';",
    '',
    `const SUPABASE_URL = '${creds.url}';`,
    `const SUPABASE_PUBLISHABLE_KEY = '${creds.anonKey}';`,
    '',
    'export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);',
    '',
  ].join('\n');

  const changes = new Map([['src/integrations/supabase/client.ts', { content: clientTs }]]);
  try {
    const pkg = JSON.parse(await state.github.readFile(owner, name, branch, 'package.json'));
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies['@supabase/supabase-js']) {
      pkg.dependencies['@supabase/supabase-js'] = '^2.45.0';
      changes.set('package.json', { content: JSON.stringify(pkg, null, 2) + '\n' });
    }
  } catch {
    /* package.json ausente/ilegível — o client.ts sozinho já destrava a IA */
  }

  await state.github.commitChanges(
    owner,
    name,
    branch,
    changes,
    prefixarCommit('conecta o projeto ao Supabase (client.ts)')
  );
}

async function bindDbProject(ref, btn) {
  if (!ref || !state.project) return;
  btn.disabled = true;
  btn.textContent = 'Vinculando…';
  try {
    await saveDbBind(state.project.fullName, ref);
    await scaffoldSupabaseClient(ref);
    await refreshDbConnection();
    toast('Banco vinculado — a IA já pode alterar este banco quando você pedir.');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Vincular';
    toast(e.message || 'Não consegui vincular o banco.');
  }
}

function finishDbState() {
  // Banco não comprovado como externo (Lovable Cloud) entra no modo semi-automático:
  // a IA gera o SQL e o usuário aplica no editor do Lovable. Não bloqueia mais.
  state.dbManual = state.dbStatus === 'no-token' || state.dbStatus === 'foreign';
  state.dbLock = false;
  updateDbChip();
  updateConnLines();
  updateComposerLock();
  renderDbGateOrHide();
  if (state.dbManual) checkSchemaExists();
}

// docs/DB_SCHEMA.json já existe no repo? (o retrato do banco para a IA ler)
// O que o REPOSITÓRIO já conta sobre o banco. Uma chamada de árvore (só
// caminhos, sem conteúdo) responde as duas perguntas: existe o retrato
// sincronizado? e existe schema legível no próprio código?
//
// A segunda importa porque, num pedido comum ("adicione um campo"), o código
// já basta: o arquivo de tipos que o Lovable gera lista tabelas e colunas, e
// as próprias consultas do frontend nomeiam a tabela. Exigir a sincronização
// antes disso era portaria desnecessária — e para um usuário leigo, um passo
// de 3 etapas que ele não sabe por que está fazendo.
const SCHEMA_NO_CODIGO = /^(src\/integrations\/supabase\/types\.ts|supabase\/migrations\/.+\.sql)$/;

async function checkSchemaExists() {
  const { owner, name, branch } = state.project;
  try {
    const { files } = await state.github.getTree(owner, name, branch);
    state.schemaNoCodigo = files.some((f) => SCHEMA_NO_CODIGO.test(f.path));
  } catch {
    state.schemaNoCodigo = false;
  }
  try {
    const cru = await state.github.readFile(owner, name, branch, 'docs/DB_SCHEMA.json');
    state.schemaSynced = true;
    // Retrato antigo (anterior ao carimbo) não tem a data — segue valendo
    // como sincronizado, só sem o "há N dias".
    try {
      const d = JSON.parse(cru)?.geckoai_sincronizado_em;
      state.schemaSyncedAt = typeof d === 'string' ? d : null;
    } catch {
      state.schemaSyncedAt = null;
    }
  } catch {
    state.schemaSynced = false;
    state.schemaSyncedAt = null;
  }
  state.schemaChecked = true;
  if (!state.lovableLock) renderDbGateOrHide();
  updateDbChip();
  updateConnLines();
}

function updateDbChip() {
  const chip = $('#db-chip');
  if (!chip) return;
  chip.classList.remove('warn', 'manual');
  chip.onclick = null;
  if (state.dbStatus === 'connected') {
    chip.hidden = false;
    chip.title =
      `Banco conectado: ${state.dbProjectName} (${state.dbRef}) — ` +
      'A IA pode alterar este banco quando você pedir.';
    if (state.dbMismatch) {
      chip.classList.add('warn');
      chip.title +=
        ' Atenção: o vínculo manual aponta para OUTRO projeto; o que está no código prevalece.';
    }
  } else if (state.dbManual) {
    chip.hidden = false;
    chip.classList.add('manual');
    if (state.dbStatus === 'no-token' && !state.schemaSynced) {
      chip.title = 'Este projeto usa banco de dados. Clique para conectar o Supabase ou sincronizar o schema.';
    } else {
      const quando = state.schemaSynced ? haQuantoTempo(state.schemaSyncedAt) : null;
      chip.title = state.schemaSynced
        ? `Banco Lovable Cloud — schema sincronizado${quando ? ` ${quando}` : ''}. ` +
          'Clique para re-sincronizar.'
        : 'Banco Lovable Cloud — clique para sincronizar o schema.';
      if (state.schemaSynced && schemaEstaVelho(state.schemaSyncedAt)) chip.classList.add('warn');
    }
    chip.onclick = toggleDbPanel;
  } else if (state.dbStatus === 'unbound') {
    // Sem o painel abrindo sozinho, o ícone é o único caminho para vincular.
    chip.hidden = false;
    chip.classList.add('manual');
    chip.title = 'Vincular um banco Supabase a este projeto.';
    chip.onclick = toggleDbPanel;
  } else {
    chip.hidden = true;
  }
}

// O painel do banco só existe se o usuário pedir (clique no ícone).
function toggleDbPanel() {
  state.dbPanelOpen = !state.dbPanelOpen;
  renderDbGateOrHide();
}

// X de fechar dos banners: eles são avisos, não trabalho pendente — quem já
// entendeu fecha e recupera a tela. A dispensa vale para o projeto atual.
function dismissButton(onClose) {
  const btn = el('button', 'lb-close');
  btn.type = 'button';
  btn.title = 'Fechar';
  btn.setAttribute('aria-label', 'Fechar aviso');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';
  btn.addEventListener('click', onClose);
  return btn;
}

// Modo Lovable Cloud (SQL manual): informa e oferece "Sincronizar schema".
// Não bloqueia o envio — a IA trabalha e faz o handoff do SQL quando precisar.
function renderDbGateOrHide() {
  if (state.lovableLock) return; // o bloqueio do GitHub controla o banner
  const box = $('#lovable-banner');
  if (!box) return;
  box.replaceChildren();
  // Nada de aviso automático: os blocos poluíam a tela de quem só quer escrever
  // um pedido. Abrem apenas pelo ícone do banco na barra do projeto.
  if (!state.dbPanelOpen) {
    box.hidden = true;
    return;
  }
  if (state.dbStatus === 'unbound') {
    renderDbBindBanner(box);
    return;
  }
  if (!state.dbManual) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = 'lovable-banner db-manual';
  box.append(dismissButton(() => {
    state.dbPanelOpen = false;
    renderDbGateOrHide();
  }));

  const text = el('div', 'lb-text');
  const actions = el('div', 'lb-actions');
  const sync = el('button', 'lb-btn', 'Sincronizar schema');
  sync.addEventListener('click', openSchemaSync);

  if (state.dbStatus === 'no-token' && !state.schemaSynced) {
    // Tem banco no código e nenhum Supabase conectado: pode ser o Supabase
    // do próprio usuário (conecta em 1 clique) ou o Lovable Cloud (SQL manual).
    text.append(el('strong', null, 'Este projeto usa banco de dados.'));
    text.append(
      el('div', 'lb-sub',
        state.schemaNoCodigo
          // O código já mostra as tabelas: não trava o usuário num passo de 3
          // etapas antes de ele conseguir pedir qualquer coisa.
          ? 'Pode pedir as mudanças normalmente — eu entendo o seu banco lendo o código do projeto. Se em algum momento eu precisar conhecer o banco por dentro, eu aviso e explico o que fazer.'
          : 'Ainda não sei como o seu banco é montado. Clique em "Sincronizar schema" e eu explico o passo a passo — leva um minuto e você só faz uma vez.')
    );
    const conectar = el('button', 'lb-btn', 'Conectar Supabase');
    conectar.addEventListener('click', async () => {
      conectar.disabled = true;
      try {
        await salvarConexao('supabase', await conectarServico('supabase'));
        toast('Supabase conectado.');
        refreshDbConnection();
      } catch (err) {
        toast(err.message || 'Não deu certo.');
        conectar.disabled = false;
      }
    });
    actions.append(conectar, sync);
  } else {
    text.append(el('strong', null, 'Banco de dados: Lovable Cloud'));
    const quando = state.schemaSynced ? haQuantoTempo(state.schemaSyncedAt) : null;
    text.append(
      el('div', 'lb-sub',
        (quando ? `Retrato do seu banco atualizado ${quando}. ` : '') +
        'Quando um pedido precisar mudar o banco, eu preparo o comando e você aplica no Lovable — eu aviso na hora. Se você mexer no banco por lá, clique aqui de novo para eu enxergar as novidades.')
    );
    actions.append(sync);
    // Veio de 'no-token' (o usuário declarou Lovable Cloud ao sincronizar).
    // Se ele errou, ou se depois quiser ligar o próprio Supabase, precisa de
    // caminho de volta — senão fica preso no SQL manual para sempre.
    if (state.dbStatus === 'no-token') {
      const conectar = el('button', 'lb-btn ghost', 'Conectar Supabase');
      conectar.addEventListener('click', async () => {
        conectar.disabled = true;
        try {
          await salvarConexao('supabase', await conectarServico('supabase'));
          toast('Supabase conectado.');
          refreshDbConnection();
        } catch (err) {
          toast(err.message || 'Não deu certo.');
          conectar.disabled = false;
        }
      });
      actions.append(conectar);
    }
  }
  box.append(text, actions);
}

// Banner "Vincular banco Supabase": aparece quando há token mas o código do
// repositório ainda não usa Supabase. O usuário escolhe o projeto e pronto.
function renderDbBindBanner(box) {
  box.hidden = false;
  box.className = 'lovable-banner db-manual';
  box.append(dismissButton(() => {
    state.dbPanelOpen = false;
    renderDbGateOrHide();
  }));

  const text = el('div', 'lb-text');
  text.append(
    el('strong', null, `Qual destes é o banco de dados de ${state.lovable?.title || state.project?.name || 'este projeto'}?`)
  );
  text.append(
    el('div', 'lb-sub',
      'Escolha o projeto do seu Supabase. A extensão configura o código sozinha e a IA passa a criar tabelas, políticas RLS e o que mais você pedir.')
  );
  box.append(text);

  const actions = el('div', 'lb-actions');
  const select = el('select', 'lb-select');
  const loading = el('option', null, 'Carregando projetos…');
  loading.value = '';
  select.append(loading);
  select.disabled = true;

  const bind = el('button', 'lb-btn', 'Vincular');
  bind.disabled = true;
  bind.addEventListener('click', () => bindDbProject(select.value, bind));

  const later = el('button', 'lb-btn', 'Agora não');
  later.addEventListener('click', () => {
    state.dbBindDismissed = state.project?.fullName;
    box.hidden = true;
  });

  actions.append(select, bind, later);
  box.append(actions);

  (async () => {
    try {
      if (!state.supabaseProjects) {
        state.supabaseProjects = await state.supabase.listProjects();
      }
      select.replaceChildren();
      for (const p of state.supabaseProjects) {
        const opt = el('option', null, p.name || p.id);
        opt.value = p.id;
        select.append(opt);
      }
      if (!state.supabaseProjects.length) {
        const none = el('option', null, 'Nenhum projeto nesta conta do Supabase');
        none.value = '';
        select.append(none);
      } else {
        select.disabled = false;
        bind.disabled = false;
      }
    } catch (e) {
      loading.textContent = 'Erro ao listar os projetos';
      toast(e.message || 'Não consegui listar os projetos do Supabase.');
    }
  })();
}

// ---------- Sincronização de schema e migração (Lovable Cloud) ----------

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Id do projeto no Lovable — para o deep-link do editor de SQL.
// O projeto do Lovable DESTE chat — nunca "o da aba aberta" sem prova. Antes
// devolvia a aba ativa: com o projeto B aberto no Lovable e o chat do A, o
// Autorizar de um cartão do A rodava o SQL do A no banco do B (revisão de
// 2026-09-26; regras 3 e 4 do projeto). A aba só vale quando o vínculo
// salvo diz que ela é deste repositório.
async function currentLovableId() {
  const full = state.project?.fullName;
  if (!full) return null;
  let map = {};
  try {
    map = (await getLovableMap()) || {};
  } catch {
    map = {};
  }
  const aba = state.lovable?.projectId;
  if (aba && map[aba] === full) return aba;
  const hit = Object.entries(map).find(([, f]) => f === full);
  return hit ? hit[0] : null;
}

async function openLovableSqlEditor() {
  const id = await currentLovableId();
  const url = id
    ? `https://lovable.dev/projects/${id}?view=more&subview=cloud&section=sql`
    : 'https://lovable.dev/';
  try {
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noreferrer');
  }
  if (!id) toast('Abra o editor de SQL do seu projeto no Lovable.');
}

// Lovable Cloud com a aba do projeto aberta: o retrato sai sozinho, numa
// consulta que só lê, sem o leigo copiar SQL e colar resultado. A API corta
// resposta grande: retrato cortado não passa no parseSchemaPaste, e aí vale o
// passo a passo de sempre.
// O projeto é o de QUANDO o clique aconteceu: trocar de projeto durante a
// leitura mandaria o retrato para o repositório errado. E um clique por vez.
let sincronizandoSchema = false;
async function sincronizarSchemaSozinho() {
  if (state.dbManual !== true) return false;
  const projeto = state.project;
  toast('Lendo o seu banco pela aba do Lovable…');
  const r = await aplicarSqlNoLovable(sqlDeLeitura(INTROSPECT_SQL_COMPACTO), { abrirAba: false });
  const texto = r?.ok ? linhasDaResposta(r.dados)[0]?.retrato : null;
  if (typeof texto !== 'string') return false;
  let json;
  try {
    json = parseSchemaPaste(texto);
  } catch {
    return false;
  }
  if (state.project?.fullName !== projeto?.fullName) {
    toast('Você trocou de projeto durante a leitura — nada foi salvo. Clique de novo.');
    return true;
  }
  try {
    await salvarRetratoDoBanco(json, projeto);
  } catch (e) {
    toast(e.message || 'Não consegui salvar no GitHub.');
  }
  return true;
}

async function openSchemaSync() {
  if (!state.project || sincronizandoSchema) return;
  sincronizandoSchema = true;
  let pronto = false;
  try {
    pronto = await sincronizarSchemaSozinho();
  } finally {
    sincronizandoSchema = false;
  }
  if (pronto) return;
  $('#schema-sql').textContent = INTROSPECT_SQL;
  $('#schema-paste').value = '';
  showError('#schema-error', null);
  $('#schema-overlay').hidden = false;
}

$('#btn-close-schema')?.addEventListener('click', () => {
  $('#schema-overlay').hidden = true;
});
$('#schema-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('#schema-overlay')) $('#schema-overlay').hidden = true;
});
$('#btn-schema-copy')?.addEventListener('click', async () => {
  const ok = await copyToClipboard(INTROSPECT_SQL);
  toast(
    ok
      ? 'SQL copiado. Rode no editor do Lovable e exporte/cole o resultado aqui.'
      : 'Não consegui copiar — selecione e copie o SQL manualmente.'
  );
  openLovableSqlEditor();
});
// Enviar o CSV exportado do Lovable direto (sem abrir/copiar).
$('#btn-schema-file')?.addEventListener('click', () => $('#schema-file').click());
$('#schema-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  showError('#schema-error', null);
  let text = '';
  try {
    text = await file.text();
  } catch {
    showError('#schema-error', 'Não consegui ler esse arquivo.');
    return;
  }
  $('#schema-paste').value = text;
  try {
    parseSchemaPaste(text); // valida na hora para dar retorno
    toast(`"${file.name}" carregado. Clique em "Salvar schema".`);
  } catch (err) {
    showError('#schema-error', err.message);
  }
});
// Carimba a data DENTRO do arquivo e commita docs/DB_SCHEMA.json. Assim a data
// viaja com o repositório (vale em qualquer computador) e o checkSchemaExists,
// que já baixa o arquivo, lê a data de graça — sem chamada extra à API do
// GitHub. Usado pelo passo a passo manual e pelo retrato automático.
async function salvarRetratoDoBanco(jsonValidado, projeto = state.project) {
  const obj = JSON.parse(jsonValidado);
  obj.geckoai_sincronizado_em = new Date().toISOString();
  const json = JSON.stringify(obj, null, 2);
  const { owner, name, branch } = projeto;
  const changes = new Map([['docs/DB_SCHEMA.json', { content: json }]]);
  await state.github.commitChanges(
    owner,
    name,
    branch,
    changes,
    prefixarCommit('atualiza retrato do banco (docs/DB_SCHEMA.json)')
  );
  state.schemaSynced = true;
  state.schemaSyncedAt = new Date().toISOString();
  state.schemaChecked = true;
  $('#schema-overlay').hidden = true;
  updateDbChip();
  renderDbGateOrHide();
  updateConnLines();
  toast('Schema sincronizado e salvo no repositório.');
}

$('#btn-schema-save')?.addEventListener('click', async () => {
  showError('#schema-error', null);
  let json;
  try {
    json = parseSchemaPaste($('#schema-paste').value);
  } catch (e) {
    showError('#schema-error', e.message);
    return;
  }
  const btn = $('#btn-schema-save');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  try {
    await salvarRetratoDoBanco(json);
  } catch (e) {
    showError('#schema-error', e.message || 'Não consegui salvar no GitHub.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar schema';
  }
});

// ---------- Sincronização com a aba do Lovable ----------
// Observa a aba ativa: ao entrar em lovable.dev/projects/<id>, descobre qual
// repositório GitHub pertence àquele projeto (o README gerado pelo Lovable
// contém a URL com o id) e troca sozinho. Sem correspondência verificada,
// o envio fica bloqueado para não editar o projeto errado.

const LOVABLE_URL_RE = /^https:\/\/(?:www\.)?lovable\.(?:dev|app)\/projects\/([a-z0-9-]{10,})/i;

// Títulos que são telas/painéis do Lovable, não nome de projeto. Com um
// painel aberto, o título da aba vira o nome do painel — visto em produção
// (2026-08-31): banner acusando o projeto "Git" e a busca de repositório
// priorizando nomes parecidos com "git". A identidade real é o id da URL;
// o título é só apresentação e atalho de busca, então na dúvida vai vazio.
const TITULOS_GENERICOS = new Set([
  'git', 'github', 'settings', 'preview', 'publish', 'chat', 'code', 'editor',
  'project', 'projects', 'lovable', 'dashboard', 'workspace', 'knowledge',
  'domains', 'analytics', 'integrations', 'supabase', 'account', 'security',
]);

function parseLovableTab(tab) {
  const m = tab?.url?.match(LOVABLE_URL_RE);
  if (!m) return null;
  // `tabId` fica guardado para o modo automático: é nessa aba que o comando
  // do banco é executado (ver aplicarSqlNoLovable).
  let title = (tab.title || '')
    .replace(/\s*[·\-|–—]\s*Lovable.*$/i, '')
    .trim();
  if (TITULOS_GENERICOS.has(title.toLowerCase())) title = '';
  return { projectId: m[1].toLowerCase(), title, tabId: tab.id ?? null };
}

function normalizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function getLovableMap() {
  return (await storage.get(['lovableMap'])).lovableMap || {};
}

async function saveLovableMapping(projectId, fullName) {
  const map = await getLovableMap();
  map[projectId] = fullName;
  await storage.set({ lovableMap: map });
}

let lastHandledLovableId = null;
let lovableResolving = false;

// Relê a aba ativa. force=true refaz a resolução mesmo para o mesmo projeto
// (usado logo após conectar contas ou salvar configurações).
async function syncWithActiveTab(force = false) {
  if (!chrome.tabs) return;
  try {
    let tab;
    if (MODO_NATIVO) {
      // Chat nativo: a aba é a da Lovable onde o quadro está, nunca "a ativa"
      // — com duas abas de projetos diferentes, cada chat é do seu.
      if (state.abaNativa?.id == null) return;
      tab = await chrome.tabs.get(state.abaNativa.id);
      state.abaNativa = tab;
    } else {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      // No celular o painel vive numa ABA: voltar do Lovable para ela não pode
      // apagar o vínculo (nem a trava) descobertos lá. Página nossa = fica tudo
      // como está. No painel lateral do PC isso nunca acontece.
      if (tab && ehAbaDaExtensao(tab.url, chrome.runtime.getURL(''))) return;
    }
    if (force) lastHandledLovableId = null;
    if (tab) await handleActiveTab(tab);
  } catch {
    /* sem acesso às abas */
  }
}

async function handleActiveTab(tab) {
  if (!state.github || !state.settings) return;
  if (lovableResolving) {
    // A aba mudou (a Lovable é SPA: outro projeto na MESMA aba) enquanto o
    // projeto anterior ainda era identificado. Antes o evento se perdia, a
    // identificação terminava e o chat liberava o envio para o repositório
    // do projeto ANTERIOR (regra 4 — revisão da 1.11). Fica para depois.
    abaQueMudouNoMeio = tab;
    return;
  }
  const info = parseLovableTab(tab);
  if (!info) {
    // Fora de um projeto do Lovable: mantém tudo como está e libera o envio.
    state.lovable = null;
    state.lovableLock = false;
    lastHandledLovableId = null;
    updateComposerLock();
    showLovableBanner(null);
    return;
  }
  if (info.projectId === lastHandledLovableId) {
    state.lovable = info;
    return;
  }
  if (state.running) {
    state.pendingLovable = tab; // aplica depois que a execução atual terminar
    return;
  }
  lastHandledLovableId = info.projectId;
  state.lovable = info;
  await resolveLovableProject(info);
}

let abaQueMudouNoMeio = null;

async function resolveLovableProject(info) {
  if (lovableResolving) return;
  lovableResolving = true;
  try {
    await doResolveLovableProject(info);
  } finally {
    lovableResolving = false;
  }
  const depois = abaQueMudouNoMeio;
  abaQueMudouNoMeio = null;
  if (depois) await handleActiveTab(depois);
}

async function doResolveLovableProject(info) {
  state.lovableLock = true;
  updateComposerLock();
  showLovableBanner({
    type: 'info',
    text: `Identificando o repositório de "${info.title || 'projeto do Lovable'}"…`,
  });

  let fullName = null;
  try {
    const map = await getLovableMap();
    fullName = map[info.projectId] || (await findRepoForLovable(info));
  } catch {
    fullName = null;
  }

  // Chat nativo sem projeto nenhum ainda: o banner mora no chat, que não
  // abre sem projeto — a escolha de repositório é a saída (e a escolha passa
  // pela mesma conferência do README, em selectRepo).
  const semSaidaNoNativo = (texto) => {
    if (MODO_NATIVO && !state.project) {
      openReposView();
      // O banner com a explicação mora no chat, que não abre sem projeto:
      // a explicação vai no topo da escolha de repositório.
      const sub = document.querySelector('#view-repos .section-sub');
      if (sub) sub.textContent = texto;
    }
  };
  if (fullName && typeof fullName === 'object' && fullName.candidato) {
    // Parece ser, mas o README não prova: o usuário decide, com o nome na tela.
    showLovableBanner({ type: 'warn', info, candidato: fullName.candidato });
    semSaidaNoNativo(`Parece ser ${fullName.candidato}. Escolha abaixo o repositório deste projeto da Lovable — os envios vão para ele.`);
    return; // segue bloqueado até ele confirmar
  }
  const semRepositorio = 'Este projeto ainda não está ligado ao GitHub. Na Lovable, clique em GitHub → Connect; depois escolha o repositório abaixo.';
  if (!fullName) {
    showLovableBanner({ type: 'warn', info });
    semSaidaNoNativo(semRepositorio);
    return; // segue bloqueado
  }

  try {
    await saveLovableMapping(info.projectId, fullName);
    if (state.project?.fullName !== fullName) {
      const [owner, name] = fullName.split('/');
      const repo =
        allRepos.find((r) => r.full_name === fullName) ||
        (await state.github.getRepo(owner, name));
      await selectRepo(repo);
      toast(`✓ Projeto conectado ao repositório ${fullName}`);
    }
    state.lovableLock = false;
    updateComposerLock();
    showLovableBanner(null);
  } catch {
    // Mapeamento salvo pode estar obsoleto (repo apagado/renomeado):
    // invalida para a próxima verificação refazer a busca do zero.
    try {
      const map = await getLovableMap();
      delete map[info.projectId];
      await storage.set({ lovableMap: map });
    } catch {
      /* segue bloqueado mesmo assim */
    }
    showLovableBanner({ type: 'warn', info });
    semSaidaNoNativo(semRepositorio);
  }
}

// Encontra o repositório cujo README contém o id do projeto do Lovable.
async function findRepoForLovable(info) {
  // 1) Busca de código do GitHub (1 chamada, quando o token permite).
  try {
    const user = await state.github.getUserCached();
    const res = await state.github.request(
      `/search/code?q=${encodeURIComponent(`"${info.projectId}" user:${user.login}`)}&per_page=5`
    );
    const hit = res?.items?.find((i) => i.repository?.full_name);
    if (hit) return hit.repository.full_name;
  } catch {
    /* busca indisponível para este token — varre READMEs abaixo */
  }

  if (!allRepos.length) {
    allRepos = await state.github.listRepos();
  }

  // 2) Candidatos por nome primeiro, depois os mais recentes.
  const target = normalizeName(info.title || '');
  const byName = allRepos.filter((r) => {
    const n = normalizeName(r.name);
    return target && (n === target || n.includes(target) || target.includes(n));
  });
  const rest = allRepos.filter((r) => !byName.includes(r)).slice(0, 25);

  for (const r of [...byName, ...rest]) {
    try {
      const readme = await state.github.readFile(
        r.owner.login, r.name, r.default_branch, 'README.md'
      );
      if (readme.toLowerCase().includes(info.projectId)) return r.full_name;
    } catch {
      /* sem README — próximo */
    }
  }
  // Nada provado. Se existe candidato com o MESMO nome do projeto, oferece —
  // com a confirmação explícita do usuário (D7 da spec), nunca sozinho.
  if (byName.length) return { candidato: byName[0].full_name };
  return null;
}

function isSendBlocked() {
  return Boolean(state.lovableLock || state.dbLock);
}

function updateComposerLock() {
  // A trava por atualização fica FORA de isSendBlocked: aquela fala de
  // projeto/banco e responde "conecte o projeto" também no anexo.
  $('#btn-send').disabled = isSendBlocked() || atualizacaoObrigatoria();
  renderContextBanner();
}

function showLovableBanner(banner) {
  const box = $('#lovable-banner');
  if (!box) return;
  box.replaceChildren();
  if (!banner) {
    // GitHub ok: cede o banner à trava de banco (se houver), senão esconde.
    renderDbGateOrHide();
    return;
  }
  box.hidden = false;
  box.className = `lovable-banner ${banner.type}`;

  if (banner.type === 'info') {
    box.append(el('span', 'lb-spin'), el('span', null, banner.text));
    return;
  }

  const text = el('div', 'lb-text');
  const title = banner.info.title || 'este projeto do Lovable';
  const actions = el('div', 'lb-actions');

  // Liberação consciente (D7 da spec): a trava automática continua igual;
  // aqui o usuário autoriza com o nome do repositório na tela, e o vínculo
  // fica guardado — mesmo padrão do SQL destrutivo, não afrouxamento.
  const liberar = async (fullName) => {
    await saveLovableMapping(banner.info.projectId, fullName);
    const [owner, name] = fullName.split('/');
    const repo = allRepos.find((r) => r.full_name === fullName) || (await state.github.getRepo(owner, name));
    lovableResolving = true;
    try {
      await selectRepo(repo);
    } finally {
      lovableResolving = false;
    }
    state.lovableLock = false;
    updateComposerLock();
    showLovableBanner(null);
    toast(`✓ Projeto conectado ao repositório ${fullName}`);
    // A aba mudou de projeto enquanto isto rodava: vale a mais nova.
    const depois = abaQueMudouNoMeio;
    abaQueMudouNoMeio = null;
    if (depois) handleActiveTab(depois);
  };

  if (banner.candidato) {
    text.append(el('strong', null, `Parece ser ${banner.candidato}. É este mesmo?`));
    text.append(
      el('div', 'lb-sub', `Confirme só se este for o repositório de "${title}" no GitHub. Os commits vão para ele.`)
    );
    const sim = el('button', 'lb-btn', 'Sim, é este');
    sim.addEventListener('click', () => liberar(banner.candidato));
    const outro = el('button', 'lb-btn', 'Escolher outro');
    outro.addEventListener('click', () => openReposView());
    actions.append(sim, outro);
  } else if (banner.mismatch) {
    text.append(el('strong', null, `"${banner.mismatch}" não parece ser o repositório de "${title}".`));
    text.append(
      el('div', 'lb-sub',
        'Para não editar o projeto errado, o envio fica bloqueado. Se você tem certeza de que é este, pode liberar.')
    );
    const usar = el('button', 'lb-btn', 'Usar mesmo assim');
    usar.addEventListener('click', () => {
      if (confirm(`Os commits vão para ${banner.mismatch}. Tem certeza de que é o repositório de "${title}"?`)) {
        liberar(banner.mismatch);
      }
    });
    const outro = el('button', 'lb-btn', 'Escolher outro');
    outro.addEventListener('click', () => openReposView());
    actions.append(usar, outro);
  } else {
    text.append(el('strong', null, 'Este projeto ainda não está conectado ao GitHub.'));
    text.append(
      el('div', 'lb-sub', 'No Lovable, clique em GitHub → Connect. Depois volte aqui e clique em Verificar de novo.')
    );
    const retry = el('button', 'lb-btn', 'Verificar de novo');
    retry.addEventListener('click', () => state.lovable && resolveLovableProject(state.lovable));
    const choose = el('button', 'lb-btn', 'Já conectei — escolher o repositório');
    choose.addEventListener('click', () => openReposView());
    actions.append(retry, choose);
  }
  box.append(text, actions);
}

// Conexão morreu (401/403 ou refresh falhou): em vez de "token inválido, cole
// outro", um único caminho — o botão Conectar. Decisão do dono: leigo só clica.
// Exceção: a Vercel não tem OAuth (ver `linhaTokenVercel`), então lá o caminho
// é abrir as Configurações, onde fica o campo de token.
function exigirReconexao(provider, mensagem) {
  const box = $('#lovable-banner');
  if (!box) return;
  box.replaceChildren();
  box.hidden = false;
  box.className = 'lovable-banner warn';
  const text = el('div', 'lb-text');
  text.append(el('strong', null, mensagem || `Sua conexão com o ${nomeServico(provider)} expirou.`));
  if (provider === 'vercel') {
    text.append(el('div', 'lb-sub', 'Crie um token novo na Vercel e cole em Configurações.'));
    const abrir = el('button', 'lb-btn', 'Abrir Configurações');
    abrir.addEventListener('click', () => {
      box.hidden = true;
      abrirConfiguracoes();
    });
    const acoesVc = el('div', 'lb-actions');
    acoesVc.append(abrir);
    box.append(text, acoesVc);
    return;
  }
  text.append(el('div', 'lb-sub', 'Clique para autorizar de novo na janela que vai abrir. Leva um instante.'));
  const actions = el('div', 'lb-actions');
  const btn = el('button', 'lb-btn', `Conectar ${nomeServico(provider)} de novo`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const pacote = await conectarServico(provider);
      await salvarConexao(provider, pacote);
      box.hidden = true;
      toast(`${nomeServico(provider)} conectado.`);
      if (provider === 'github') {
        state.lovableLock = false;
        updateComposerLock();
        await openReposView();
        syncWithActiveTab(true);
      } else {
        refreshDbConnection();
        refreshVercelLink();
      }
    } catch (err) {
      toast(err.message || 'Não deu certo. Tente de novo.');
      btn.disabled = false;
    }
  });
  actions.append(btn);
  box.append(text, actions);
  if (provider === 'github') {
    state.lovableLock = true;
    updateComposerLock();
  }
}

let watchingTabs = false;

function watchLovableTabs() {
  if (!chrome.tabs || watchingTabs) return;
  watchingTabs = true;
  if (MODO_NATIVO) {
    // Só a aba deste quadro: trocar de projeto nela (a Lovable é SPA) troca o
    // chat; outras abas não são da conta dele.
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId === state.abaNativa?.id && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) {
        syncWithActiveTab();
      }
    });
    syncWithActiveTab(true);
    return;
  }
  chrome.tabs.onActivated.addListener(() => syncWithActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url || changeInfo.title || changeInfo.status === 'complete')) {
      syncWithActiveTab();
    }
  });
  syncWithActiveTab(true);
}

async function loadBranches() {
  const select = $('#branch-select');
  select.replaceChildren(new Option(state.project.branch, state.project.branch, true, true));
  try {
    const branches = await state.github.listBranches(state.project.owner, state.project.name);
    select.replaceChildren(
      ...branches.map(
        (b) => new Option(b.name, b.name, false, b.name === state.project.branch)
      )
    );
  } catch {
    /* mantém só o branch atual */
  }
}

$('#branch-select').addEventListener('change', async (e) => {
  state.project.branch = e.target.value;
  await storage.set({ project: state.project });
  toast(`Branch: ${state.project.branch}`);
});

function attachSummary(attach) {
  if (!attach) return '';
  const bits = [];
  if (attach.images) bits.push(`${attach.images} ${attach.images === 1 ? 'imagem' : 'imagens'}`);
  for (const n of attach.files || []) bits.push(n);
  return bits.length ? `📎 ${bits.join(' · ')}` : '';
}

function buildUserMessage(record) {
  const node = el('div', 'msg-user');
  if (record.text) node.append(document.createTextNode(record.text));
  const note = attachSummary(record.attach);
  if (note) node.append(el('div', 'msg-attach', note));
  return node;
}

function renderHistory() {
  const thread = $('#thread');
  thread.replaceChildren();

  for (const record of state.history) {
    if (record.kind === 'user') {
      thread.append(buildUserMessage(record));
    } else if (record.kind === 'run') {
      thread.append(buildRunElement(record));
    }
  }
  scrollThread();
}

function scrollThread() {
  const thread = $('#thread');
  thread.scrollTop = thread.scrollHeight;
}

const OP_VERBS = {
  read: 'leu',
  edit: 'editou',
  write: 'reescreveu',
  create: 'criou',
  delete: 'apagou',
  commit: 'enviou',
  sql: 'SQL',
  migration: 'migração',
  plano: 'plano',
  save: 'salvou',
  image: 'criou imagem',
  search: 'buscou',
  dbread: 'consultou o banco',
};

// Conteúdo dos arquivos por sha, para a busca no código (search_code): a
// primeira busca de um projeto baixa os arquivos de texto dele; nas outras
// buscas e nos pedidos seguintes com o painel aberto, só o que mudou (sha
// novo). Só em memória — gravar megabytes no chrome.storage a cada pedido
// custaria mais que baixar de novo. Teto em caracteres, sai o mais antigo.
const cacheDeArquivos = (() => {
  const TETO = 30_000_000;
  const mapa = new Map(); // sha -> texto (ordem de inserção = antiguidade)
  let total = 0;
  return {
    get(sha) {
      const texto = mapa.get(sha);
      if (texto === undefined) return undefined;
      mapa.delete(sha); // recém-usado vai para o fim
      mapa.set(sha, texto);
      return texto;
    },
    set(sha, texto) {
      if (typeof texto !== 'string' || mapa.has(sha)) return;
      mapa.set(sha, texto);
      total += texto.length;
      for (const [velho, t] of mapa) {
        if (total <= TETO) break;
        mapa.delete(velho);
        total -= t.length;
      }
    },
  };
})();

function planChip() {
  return el('div', 'run-mode-chip', 'Plano');
}

// Constrói o bloco visual de uma execução (concluída ou em andamento).
function buildRunElement(record) {
  const root = el('div', 'run');
  if (record.mode === 'plan') {
    root.classList.add('run-plan');
    root.append(planChip());
  }

  if (record.steps?.length) {
    const { tl, contar } = caixaDaLinhaDoTempo(root);
    for (const s of record.steps) {
      tl.append(timelineItem(s.op, s.path));
    }
    contar(record.steps.length);
  }

  if (record.summary) {
    root.append(resumoFormatado(record.summary));
  }
  if (record.pendingWork && !record.commit) {
    root.append(buildPendingWorkCard(record));
  }
  if (record.pendingMigration && !record.pendingMigration.applied && !record.commit) {
    root.append(buildMigrationCard(record));
  }
  if (record.commit) {
    root.append(buildCommitCard(record.commit, false, record));
  }
  if (record.erroChatGPT) {
    root.append(buildErroChatGPTCard(record));
  } else if (record.erroPremium) {
    root.append(buildErroPremiumCard(record));
  } else if (record.error) {
    root.append(el('div', 'run-error', record.error));
  }
  if (record.cancelled) {
    root.append(el('div', 'run-cancelled', 'Cancelado — nenhuma mudança foi enviada.'));
  }
  if (record.planoRecusado) {
    root.append(buildPlanoRecusadoCard(record.planoRecusado));
  }
  // Parte de um plano: o cartão volta ao reabrir o painel — com os botões, se
  // o usuário ainda não decidiu; como texto, se já seguiu ou parou.
  if (record.plano && record.planoResultado) {
    root.append(buildPlanoCard(record));
  }
  if (
    !record.summary && !record.commit && !record.error &&
    !record.cancelled && !record.pendingMigration && !record.pendingWork
  ) {
    // Ainda marcado "em andamento" aqui = vivo em OUTRA janela (a recuperação
    // só roda com a trava do projeto livre): o resultado aparece quando acabar.
    root.append(el('div', 'run-cancelled', record.emAndamento
      ? `Este pedido está rodando em outra janela do ${MARCA.nome}. O resultado aparece aqui quando terminar.`
      : 'Execução interrompida: a janela foi fechada no meio do pedido.'));
  }
  return root;
}

// A linha do tempo. No chat nativo ela fica dobrada numa linha ("12 etapas"),
// como a atividade no chat da Lovable — quem quiser ver, abre.
function caixaDaLinhaDoTempo(root) {
  const tl = el('div', 'timeline');
  if (!MODO_NATIVO) {
    root.append(tl);
    return { tl, contar: () => {} };
  }
  const dobra = el('details', 'tl-dobra');
  const rotulo = el('summary', 'tl-rotulo', 'Etapas');
  dobra.append(rotulo, tl);
  dobra.hidden = true;
  root.append(dobra);
  return {
    tl,
    contar: (n) => {
      rotulo.textContent = n === 1 ? '1 etapa' : `${n} etapas`;
      dobra.hidden = n === 0;
    },
  };
}

function timelineItem(op, path) {
  const item = el('div', `tl-item op-${op}`);
  item.append(el('span', 'tl-verb', OP_VERBS[op] || op));
  if (path) item.append(el('span', 'tl-path', path));
  return item;
}

// Resumo da IA formatado (negrito, listas, títulos, código) — lib/formatar.js.
// Só elementos e textContent: o resumo vem da IA e nunca vira HTML.
function resumoFormatado(texto) {
  const caixa = el('div', 'run-summary md');
  const partes = (lista, pai) => {
    for (const p of lista) {
      if (p.tipo === 'negrito') pai.append(el('strong', null, p.texto));
      else if (p.tipo === 'codigo') pai.append(el('code', null, p.texto));
      else pai.append(document.createTextNode(p.texto));
    }
  };
  for (const b of blocosDoResumo(texto)) {
    if (b.tipo === 'p' || b.tipo === 'titulo') {
      const n = el(b.tipo === 'p' ? 'p' : 'div', b.tipo === 'titulo' ? 'md-titulo' : undefined);
      partes(b.partes, n);
      caixa.append(n);
    } else if (b.tipo === 'lista') {
      const l = el(b.ordenada ? 'ol' : 'ul');
      if (b.ordenada && b.inicio > 1) l.start = b.inicio;
      for (const item of b.itens) {
        const li = el('li');
        partes(item, li);
        l.append(li);
      }
      caixa.append(l);
    } else if (b.tipo === 'codigo') {
      caixa.append(el('pre', 'md-codigo', b.texto));
    }
  }
  return caixa;
}

// "Commit" é palavra de programador: para o cliente, a alteração foi enviada.
const TOAST_ENVIADO = () =>
  state.project?.kind === 'novo'
    ? 'Alteração enviada — a Vercel publica em instantes.'
    : 'Alteração enviada — a Lovable atualiza o preview em instantes.';

function buildCommitCard(commit, live, record = null) {
  const card = el('div', 'commit-card');
  if (commit?.sha) card.dataset.sha = commit.sha;

  const head = el('div', 'commit-head');
  head.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  head.append(
    el('span', null, `Alteração enviada · ${commit.files.length} arquivo${commit.files.length > 1 ? 's' : ''}`)
  );
  // "Desfazer último prompt": só no último envio, só se não mexeu no banco,
  // e só enquanto ninguém desfez. Ver podeDesfazer.
  if (record && podeDesfazer(record)) head.append(botaoDesfazer(record, card));
  card.append(head);

  card.append(el('div', 'commit-msg', commit.message));

  const meta = el('div', 'commit-meta');
  const link = el('a', null, commit.sha.slice(0, 7));
  link.href = commit.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  meta.append(link, el('span', null, 'ver no GitHub'));
  card.append(meta);

  const note = el('div', 'sync-note');
  note.append(el('span', 'dot'));
  const novo = state.project?.kind === 'novo';
  note.append(
    el('span', null, novo
      ? (live ? 'A Vercel vai publicar essa mudança em instantes.' : 'Publicado pela Vercel.')
      // Ao reabrir, "sincronizado" seria uma afirmação que ninguém conferiu.
      : (live ? 'O Lovable vai puxar essa mudança em instantes.' : 'Enviada ao projeto.'))
  );
  card.append(note);

  if (record?.desfeito) card.append(el('div', 'commit-undone', 'Desfeito. O app voltou como estava antes deste envio.'));

  return card;
}

// ---------- Desfazer último prompt ----------
// Uma seta no cartão do último envio. Clicou: o app volta ao que era antes
// daquele envio — commit novo com a árvore do pai (lib/github.js
// revertCommit), que o Lovable sincroniza como qualquer outro. SEM contagem
// regressiva: a de 5 s dependia do painel continuar vivo, e fechar o painel
// ou ele recarregar enquanto o usuário ia ao Lovable conferir matava o
// temporizador em silêncio — nem commit, nem mensagem (teste do dono,
// 2026-09-13). Sem IA, sem prompt, sem pergunta: o clique é a decisão, e o leigo
// não precisa saber o que é commit. Não existe "refazer": se quiser de volta,
// pede de novo. Regras que evitam o suporte:
//   - só o ÚLTIMO envio do histórico, e só enquanto ele é a ponta do branch
//     (o servidor confere no clique; mudou depois → mensagem, sem estrago);
//   - envio que mexeu no banco NÃO ganha a seta: voltar só o código deixaria
//     o app apontando para tabela que ainda existe (ou vice-versa);
//   - travado durante execução, e o envio fica travado enquanto desfaz.

function bancoAlteradoNoRun(record) {
  if (typeof record.bancoAlterado === 'boolean') return record.bancoAlterado;
  // Registro de versão anterior (sem o campo): decide pelos passos.
  return (record.steps || []).some((s) => s.op === 'sql' || s.op === 'migration');
}

function ultimoEnvio() {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const r = state.history[i];
    if (r.kind === 'run' && r.commit) return r;
  }
  return null;
}

function podeDesfazer(record) {
  if (!record?.commit || record.desfeito) return false;
  if (bancoAlteradoNoRun(record)) return false;
  return ultimoEnvio() === record;
}

function botaoDesfazer(record, card) {
  const btn = el('button', 'btn-undo');
  btn.type = 'button';
  btn.title = 'Desfazer último prompt';
  btn.setAttribute('aria-label', 'Desfazer último prompt');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  btn.addEventListener('click', async () => {
    if (state.running) { toast('Espere a execução atual terminar.'); return; }
    if (state.desfazendo) return;
    if (!podeDesfazer(record)) {
      btn.remove();
      toast('Este envio não pode mais ser desfeito.');
      return;
    }
    state.desfazendo = true;
    limparCampoDoPrompt();
    console.log('[GeckoAI] desfazer: iniciando', record.commit?.sha);
    const head = btn.parentElement;
    btn.remove();
    const aviso = el('div', 'commit-undo-wait');
    aviso.append(el('span', 'spin'), el('span', null, 'Desfazendo…'));
    if (head) head.after(aviso);
    await executarDesfazer(record, card, aviso);
  });
  return btn;
}

async function executarDesfazer(record, card, aviso) {
  const p = state.project;
  const titulo = semPrefixo(record.commit?.message).slice(0, 80);
  // O cartão que está NA TELA agora (o da closure pode ter saído num
  // redesenho); sem cartão, o toast e o console ainda contam o resultado.
  const alvo = () => (card.isConnected ? card : cartaoDoCommit(record.commit?.sha));
  const nota = (classe, texto) => { alvo()?.append(el('div', classe, texto)); };

  // Rastro no histórico salvo (sem token, sem conteúdo): se falhar no
  // computador do cliente, dá para saber em que ponto sem pedir DevTools.
  record.desfazerTentativa = new Date().toISOString();
  delete record.desfazerErro;
  // Marca de versão anterior: o 409 gravado como definitivo sumia com a seta
  // de vez, mesmo quando a checagem tinha visto dado velho de cache.
  delete record.desfazerIndisponivel;
  try { await saveHistory(); } catch { /* rastro não pode impedir o desfazer */ }

  try {
    if (!state.github || !p) throw new Error('Conecte o projeto antes de desfazer.');
    if (!record.commit?.sha) throw new Error('Este envio não tem commit para desfazer.');
    // Com a trava do projeto: um pedido rodando na outra janela commitaria
    // por cima do desfazer (e vice-versa).
    const r = await comTravaDoProjeto(() => state.github.revertCommit(
      p.owner, p.name, p.branch, record.commit.sha,
      prefixarCommit(`desfaz "${titulo}"`)
    ), { lancar: true });
    record.desfeito = { sha: r.sha, url: r.url, at: new Date().toISOString() };
    console.log('[GeckoAI] desfazer: ok', r.sha);
    await saveHistory();
    pingPreview();
    alvo()?.querySelector('.btn-undo')?.remove();
    nota('commit-undone', 'Pronto. O app voltou como estava antes deste envio.');
    toast('Desfeito — o Lovable vai puxar a versão anterior.');
  } catch (e) {
    console.error('[GeckoAI] desfazer: falhou', e);
    record.desfazerErro = {
      status: typeof e?.status === 'number' ? e.status : null,
      mensagem: String(e?.message || e || '').slice(0, 200),
      at: new Date().toISOString(),
    };
    if (e?.name === 'GitHubError' && (e.status === 409 || e.status === 400)) {
      // O envio já não é a ponta do branch (ou é o primeiro). NÃO grava como
      // definitivo: se reabrir o painel a seta volta, e clicar de novo só
      // repete esta explicação caso o projeto tenha mudado mesmo.
      nota('commit-undone', e.message);
      toast(e.message);
    } else if (e?.name === 'GitHubError' && e.status === 401) {
      nota('commit-undone err', 'Sua conexão com o GitHub expirou. Conecte de novo e tente outra vez.');
      toast('Sua conexão com o GitHub expirou.');
      exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
    } else {
      // Falha passageira: a seta volta para tentar de novo.
      nota('commit-undone err', 'Não consegui desfazer agora. Tente de novo em instantes.');
      toast('Não consegui desfazer agora. Tente de novo em instantes.');
      const c = alvo();
      if (c && !c.querySelector('.btn-undo')) c.querySelector('.commit-head')?.append(botaoDesfazer(record, c));
    }
    try { await saveHistory(); } catch { /* */ }
  } finally {
    aviso.remove();
    state.desfazendo = false;
  }
}

// O cartão de commit visível para um sha (marcado em buildCommitCard).
function cartaoDoCommit(sha) {
  if (!sha) return null;
  return document.querySelector(`.commit-card[data-sha="${CSS.escape(sha)}"]`);
}

// ---------- Modo automático: aplicar o SQL no banco do Lovable Cloud ----------
//
// O comando NÃO sai daqui: ele é executado dentro da aba do Lovable (ver
// lib/lovable.js). Assim a extensão nunca vê o token da conta do usuário —
// só o resultado da consulta.

// `scripting` e `lovable.dev` são declaradas no manifest, não pedidas em
// tempo de execução (decisão do dono, 2026-09-01): o cliente já autorizou ao
// instalar, e uma janela do Chrome no meio do fluxo confundia. Em troca, a
// instalação padrão passou de 4 para 5 hosts — ver docs/DECISOES.md.

function esperarAbaPronta(tabId, tetoMs = 20000) {
  return new Promise((resolve) => {
    let pronto = false;
    const fim = setTimeout(() => {
      if (pronto) return;
      pronto = true;
      chrome.tabs.onUpdated.removeListener(ouvinte);
      resolve(false);
    }, tetoMs);
    function ouvinte(id, info) {
      if (id !== tabId || info.status !== 'complete' || pronto) return;
      pronto = true;
      clearTimeout(fim);
      chrome.tabs.onUpdated.removeListener(ouvinte);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(ouvinte);
  });
}

// Aba do projeto no Lovable. Reaproveita uma aberta; se não houver, abre em
// segundo plano — o usuário não precisa fazer nada nem colar link nenhum, o
// id do projeto já veio da aba ou do vínculo salvo (currentLovableId).
async function abaDoLovableAberta(projectId) {
  try {
    const abas = await chrome.tabs.query({
      url: ['https://lovable.dev/projects/*', 'https://www.lovable.dev/projects/*'],
    });
    return abas.find((t) => (t.url || '').toLowerCase().includes(projectId))?.id ?? null;
  } catch {
    return null;
  }
}

async function abaDoLovable(projectId) {
  try {
    const abas = await chrome.tabs.query({
      url: ['https://lovable.dev/projects/*', 'https://www.lovable.dev/projects/*'],
    });
    const achada = abas.find((t) => (t.url || '').toLowerCase().includes(projectId));
    if (achada?.id != null) return achada.id;
  } catch {
    /* sem permissão de host ainda — cai no create abaixo */
  }
  const nova = await chrome.tabs.create({
    url: `https://lovable.dev/projects/${projectId}`,
    active: false,
  });
  // Sem esperar o carregamento não há documento onde injetar.
  await esperarAbaPronta(nova.id);
  return nova.id;
}

// -> { ok, dados } | { erro, tipo }
// `tipo`: 'banco' = o Postgres recusou o SQL (a IA corrige, na mesma
// conversa); 'acesso' = aba, sessão, projeto ou instabilidade (cai na reserva
// manual). Ver tipoDoErro em lib/lovable.js.
// `abrirAba: false`: só usa a aba do projeto que já está aberta. LER o banco
// (retrato no começo de todo pedido, consultar_banco) e ENSAIAR o SQL não
// podem abrir aba sozinhos — só aplicar, que o usuário acabou de autorizar.
async function aplicarSqlNoLovable(sql, { abrirAba = true } = {}) {
  const projectId = await currentLovableId();
  if (!projectId) {
    return { erro: 'Não descobri qual é o seu projeto no Lovable. Abra ele numa aba e tente de novo.', tipo: 'acesso' };
  }
  let tabId;
  try {
    tabId = abrirAba ? await abaDoLovable(projectId) : await abaDoLovableAberta(projectId);
  } catch {
    return { erro: 'Não consegui abrir o seu projeto no Lovable. Abra ele numa aba e tente de novo.', tipo: 'acesso' };
  }
  if (tabId == null) {
    return { erro: 'A aba do projeto no Lovable não está aberta.', tipo: 'acesso' };
  }

  let saida;
  try {
    [saida] = await chrome.scripting.executeScript({
      target: { tabId },
      func: codigoInjetado,
      args: [projectId, sql],
    });
  } catch {
    return { erro: 'Não consegui falar com a aba do Lovable. Abra o seu projeto lá e tente de novo.', tipo: 'acesso' };
  }

  const r = saida?.result;
  if (!r) return { erro: 'A aba do Lovable não respondeu. Atualize a página e tente de novo.', tipo: 'acesso' };
  if (r.falha) return { erro: traduzFalha(r.falha), tipo: 'acesso' };
  if (!r.ok) return { erro: mensagemDeErro(r.status, r.dados), tipo: tipoDoErro(r.status, r.dados) };
  return { ok: true, dados: r.dados };
}

// Cartão de autorização NO MEIO do run (Lovable Cloud automático). A IA fica
// parada esperando; ao Autorizar, a extensão aplica o SQL e o resultado do
// banco volta para ela — erro do banco é corrigido na mesma conversa, que o
// servidor não cobra. Antes o SQL só rodava depois que a IA tinha ido embora,
// e um erro de ordem (regra de acesso antes da tabela) ficava com o leigo.
// Devolve o que runAgent espera: {ok, dados} | {erro, tipo} | {cancelado}.
function aplicarSqlDoLovable(sql, root, { resumo = null, ensaiado = false } = {}) {
  return new Promise((resolve) => {
    if (state.abort?.signal.aborted) return resolve({ cancelado: true });
    pedirAtencao();

    const card = el('div', 'migration-card');
    let decidido = false;
    const encerrar = (classe, texto, valor) => {
      if (decidido) return;
      decidido = true;
      state.abort?.signal.removeEventListener('abort', aoCancelar);
      card.replaceWith(el('div', classe, texto));
      resolve(valor);
    };
    const aoCancelar = () => encerrar('mig-msg err', 'Você cancelou — nada foi alterado no seu banco.', { cancelado: true });

    const apaga = isDestructiveSql(sql);
    // Libera acesso aos dados (RLS desligado, política aberta para escrever):
    // o SQL não fica escondido atrás do resumo, e o aviso diz o porquê.
    const abre = !apaga && abreAcesso(sql);
    const head = el('div', 'mig-head');
    head.append(el('span', 'mig-ico', apaga || abre ? '⚠️' : '🗄️'));
    head.append(el('span', null,
      apaga ? 'Este ajuste apaga informações do seu banco'
        : abre ? 'Este ajuste libera o acesso a dados do seu banco'
          : 'Ajuste no banco de dados'));
    card.append(head);
    // O resumo que a IA escreveu, em português de gente, vem primeiro; o SQL
    // fica em "Ver o comando" — um leigo diante de SQL puro tinha medo de
    // clicar. Quando APAGA ou ABRE dados, o comando continua à vista.
    if (resumo) card.append(el('div', 'mig-resumo', resumo));
    card.append(
      el('div', 'mig-hint',
        apaga
          ? 'Vou rodar o comando abaixo no seu banco de dados. Ele remove informações que já estão lá, e depois não dá para voltar atrás. Autorize só se for isso mesmo que você pediu.'
          : abre
            ? 'O comando abaixo deixa dados do seu banco visíveis ou alteráveis por qualquer visitante do site. Autorize só se você pediu isso de propósito.'
            : ensaiado
              ? 'Já conferi que o ajuste funciona no seu banco. Clique em Autorizar para eu aplicar.'
              : 'Preparei o ajuste. Clique em Autorizar para eu aplicar no seu banco.')
    );
    const pre = el('pre', 'mig-sql');
    pre.textContent = sql;
    if (resumo && !apaga && !abre) {
      const detalhes = el('details', 'mig-detalhes');
      detalhes.append(el('summary', null, 'Ver o comando'), pre);
      card.append(detalhes);
    } else {
      card.append(pre);
    }

    const actions = el('div', 'mig-actions');
    const go = el('button', 'mig-go', 'Autorizar');
    const no = el('button', 'mig-cancel', 'Cancelar');
    go.addEventListener('click', async () => {
      // Chat nativo: o cartão mora num quadro DENTRO da página da Lovable, e
      // uma página hostil poderia escondê-lo sob uma isca e induzir o clique.
      // No que apaga ou abre dados, a confirmação nativa do navegador — que
      // página nenhuma disfarça (revisão da 1.11).
      if (MODO_NATIVO && (apaga || abre) && !confirm(apaga
        ? 'Autorizar o comando que APAGA informações do seu banco?'
        : 'Autorizar o comando que LIBERA o acesso a dados do seu banco?')) return;
      go.disabled = true;
      no.disabled = true;
      go.textContent = 'Aplicando…';
      const r = await aplicarSqlNoLovable(sql);
      if (decidido) return; // cancelado enquanto aplicava
      if (r.ok) {
        encerrar('mig-msg', 'Aplicado no seu banco.', r);
      } else if (r.tipo === 'banco') {
        // A IA recebe a mensagem do Postgres e propõe de novo — o usuário só
        // precisa saber que vai ver outro cartão.
        encerrar('mig-msg err', 'O banco não aceitou este ajuste — vou corrigir e mostrar de novo para você autorizar.', r);
      } else {
        encerrar('mig-msg err', `Não consegui aplicar sozinho: ${r.erro} Vou deixar o comando pronto para você aplicar no Lovable.`, r);
      }
    });
    no.addEventListener('click', () => {
      aoCancelar();
      // Parar o run inteiro: commitar frontend que depende de tabela que não
      // existe quebraria o app do cliente. Mesmo caminho do botão Cancelar.
      state.abort?.abort();
    });
    actions.append(go, no);
    card.append(actions);

    state.abort?.signal.addEventListener('abort', aoCancelar, { once: true });
    root.append(card);
    scrollThread();
  });
}

// Cartão de handoff da migração (Lovable Cloud): mostra o SQL para o usuário
// rodar no editor do Lovable e, ao confirmar, envia o commit do frontend.
// Cartão do trabalho guardado. O run não terminou e NADA foi para o GitHub:
// o que a IA preparou espera aqui. Continuar é um run novo (rodada), e o
// servidor conta 1 prompt por ele — decisão do dono, para a continuação não
// sair de graça (no premium, também 1 envio da cota do dia).
//
// Até 6 rodadas de MAX_ITERATIONS (50) = 300 etapas por pedido (decisão do
// dono, 2026-09-26, com a IA mais barata). Antes eram 3 rodadas (150), e um
// pedido do dono no modelo premium morreu na 3ª ESCREVENDO: 10 -> 13 -> 16 arquivos
// prontos, 1-2 voltas sem escrever — trabalho de verdade, cortado pelo teto.
// Quem gira em falso continua sendo parado cedo pelas travas do agente
// (16 voltas sem novidade, 24 sem escrever).
const MAX_CONTINUACOES = 5;
const MAX_RODADAS = MAX_CONTINUACOES + 1;

// Roda a próxima rodada do trabalho guardado. Parte de um plano leva o plano
// junto: sem ele a continuação não sabe em que parte está, e no fim o cartão
// das partes não avança.
// Devolve false quando o run nem começou (token do Supabase morto, envio
// travado): quem chamou devolve os botões ao cartão.
// Os anexos que ainda não entraram no projeto vêm no próprio trabalho
// guardado (lib/agent.js); as imagens, só enquanto o painel não recarregou.
async function continuarTrabalho(record, fonte) {
  return runAndRender({
    userText: record.pedido?.userText || '',
    promptForAI: record.pedido?.promptForAI || record.pedido?.userText || '',
    attach: null,
    images: anexosDoRegistro.get(record)?.images || null,
    mode: record.pedido?.mode || 'build',
    plano: record.plano ? { ...record.plano, partes: record.plano.partes.map((p) => ({ ...p })) } : null,
    trabalhoAnterior: record.pendingWork,
    continuacoes: (record.pedido?.continuacoes ?? 0) + 1,
    mostrarPedido: false,
    fonte,
  });
}

// Botões que disparam run FORA do compositor (Continuar, Tentar de novo,
// Autorizar, os cartões de erro) passam pelas mesmas travas do Enviar: versão
// abaixo da mínima e projeto errado aberto no Lovable. Antes só o compositor
// travava — e o Autorizar de um cartão podia aplicar SQL no projeto errado.
function podeEnviarAgora() {
  if (state.running || state.enviando) { toast('Espere a execução atual terminar.'); return false; }
  if (atualizacaoObrigatoria()) { toast('Baixe a nova versão da extensão para continuar usando.'); return false; }
  if (isSendBlocked()) { toast('Abra no Lovable o projeto deste chat (ou conecte o banco) antes de continuar.'); return false; }
  if (state.desfazendo) { toast('Espere o desfazer terminar.'); return false; }
  return true;
}

// Chave ilimitada (ou pelo ChatGPT do cliente, que não desconta prompt): a
// rodada parou no teto de etapas ESCREVENDO, então a próxima começa sem
// clique — igual às partes de um plano. Chamado depois de o run anterior
// liberar o painel (setTimeout no fim do runAndRender). Se algo mudou no
// meio (outro envio, projeto trocado, envio travado), não segue: o cartão
// fica com os botões.
function seguirParaProximaRodada(record, cartao, fonte, projetoDoRun) {
  const mesmoProjeto = state.project
    && state.project.owner === projetoDoRun.owner
    && state.project.name === projetoDoRun.name
    && state.project.branch === projetoDoRun.branch;
  if (!mesmoProjeto || state.running || state.lovableLock || isSendBlocked()) return;
  if (atualizacaoObrigatoria()) return; // versão abaixo da mínima: nada sai sozinho
  if (!state.settings?.keys?.[state.settings.provider]) return;
  if (fonte === 'chatgpt' && !chatgptConectado()) return;
  if (fonte !== 'chatgpt' && !chaveIlimitada()) return;
  record.pendingWorkFeito = 'Continuei sozinho de onde parei.';
  saveHistory();
  const novo = buildPendingWorkCard(record);
  cartao.replaceWith(novo);
  continuarTrabalho(record, fonte).then((r) => {
    if (r !== false) return;
    delete record.pendingWorkFeito;
    saveHistory();
    novo.replaceWith(buildPendingWorkCard(record));
  });
}

function buildPendingWorkCard(record) {
  const pend = record.pendingWork;
  const card = el('div', 'migration-card');

  // Quem parou foi o ChatGPT do cliente (limite, acesso, plano), não uma trava.
  const paradaDoChatGPT = ['limite', 'acesso', 'plano'].includes(pend.codigo);
  const titulo = {
    limite: 'O limite do seu ChatGPT acabou no meio do pedido',
    acesso: 'Sua conta do ChatGPT desconectou no meio do pedido',
    plano: 'Sua assinatura do ChatGPT não inclui este uso',
    commit: 'O GitHub não aceitou o envio',
  }[pend.codigo] || 'Não terminei este pedido';
  // O trabalho estava PRONTO; quem recusou foi o GitHub. Enviar de novo não
  // passa pela IA nem gasta prompt.
  const recusadoPeloGitHub = pend.codigo === 'commit';

  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', '⏸️'));
  head.append(el('span', null, titulo));
  card.append(head);

  const n = pend.feitos?.length || 0;
  const volta = pend.codigo === 'limite' ? quandoVoltaTexto(pend.limite) : '';
  // Rodada que só mexeu no banco: "o projeto continua como estava" seria
  // mentira — o banco já mudou, o código é que falta.
  const soBanco = n === 0 && Boolean(pend.sqlAplicados?.length || pend.sqlRodados?.length || pend.sqlExecutados);
  card.append(
    el(
      'div',
      'mig-hint',
      paradaDoChatGPT
        ? `Já preparei ${n} arquivo${n === 1 ? '' : 's'} e nada se perdeu${volta ? ` (o limite ${volta})` : ''}. Nada foi enviado ao seu projeto ainda — dá para terminar agora pelos prompts, com um commit só no fim.`
        : recusadoPeloGitHub
          ? `Terminei o pedido (${n} arquivo${n === 1 ? '' : 's'}), mas o GitHub não aceitou o envio${pend.status === 401 ? ': a conexão com ele expirou. Conecte de novo e toque em Enviar agora' : ''}. Nada se perdeu, e enviar de novo não gasta prompt.`
          : soBanco
            ? `O banco do seu projeto já foi ajustado, mas o código ainda não: falta concluir. Nada foi enviado ao código ainda, e no fim sai um commit só com tudo.`
            : `Já preparei ${n} arquivo${n === 1 ? '' : 's'}, mas ainda falta concluir. Nada foi enviado ao seu projeto ainda — ele continua como estava, e no fim sai um commit só com tudo.`
    )
  );

  const lista = el('div', 'timeline');
  for (const caminho of pend.feitos || []) lista.append(timelineItem('edit', caminho));
  card.append(lista);

  if (record.pendingWorkFeito) {
    card.append(el('div', 'commit-undone', record.pendingWorkFeito));
    return card;
  }

  const continuacoes = record.pedido?.continuacoes ?? 0;
  const acoes = el('div', 'mig-actions');
  // O teto existe contra pedido impossível virando série de prompts cobrados.
  // Limite de assinatura não é sinal disso, e não se repete pelos prompts (só
  // o ChatGPT tem limite) — então não trava a saída pelos prompts.
  const noTeto = continuacoes >= MAX_CONTINUACOES && !paradaDoChatGPT && !recusadoPeloGitHub;
  if (noTeto) {
    card.append(
      el(
        'div',
        'mig-hint',
        `Não consegui terminar este pedido de uma vez. Peça uma parte por vez — por exemplo, só a tela, e depois o resto. O próximo pedido que você escrever começa do zero, e este rascunho fica de lado.`
      )
    );
  }

  const continuar = async (fonte, botao) => {
    if (!podeEnviarAgora()) return;
    if (fonte === 'chatgpt' && !chatgptConectado()) {
      toast('Conecte o seu ChatGPT nas Configurações e toque aqui de novo.');
      abrirConfiguracoes();
      return;
    }
    botao.disabled = true;
    record.pendingWorkFeito = 'Continuando de onde parou…';
    await saveHistory();
    acoes.remove();
    const r = await continuarTrabalho(record, fonte);
    if (r === false) {
      delete record.pendingWorkFeito;
      await saveHistory();
      card.replaceWith(buildPendingWorkCard(record));
    }
  };

  // Commit recusado: o mesmo commit de novo, sem IA e sem prompt.
  const enviarAgora = async (botao) => {
    if (!podeEnviarAgora()) return;
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const commit = await comTravaDoProjeto(() => enviarTrabalhoGuardado({
        github: state.github,
        owner: state.project.owner,
        repo: state.project.name,
        branch: state.project.branch,
        pendingWork: pend,
      }), { lancar: true });
      record.pendingWorkFeito = commit ? 'Enviado.' : 'Nada a enviar — o projeto já estava assim.';
      if (commit) {
        record.commit = commit;
        record.bancoAlterado = record.bancoAlterado || Boolean(pend.sqlAplicados?.length || pend.sqlExecutados);
        if (record.plano && !record.planoResultado) record.planoResultado = 'concluida';
        pingPreview();
      }
      await saveHistory();
      document.querySelectorAll('.btn-undo').forEach((b) => b.remove());
      const novo = commit ? buildCommitCard(commit, true, record) : el('div', 'commit-undone', record.pendingWorkFeito);
      card.replaceWith(novo);
      if (commit && record.plano) novo.after(buildPlanoCard(record));
      toast(commit ? TOAST_ENVIADO() : record.pendingWorkFeito);
    } catch (err) {
      botao.disabled = false;
      botao.textContent = 'Enviar agora (não usa prompt)';
      if (err?.name === 'GitHubError' && err.status === 401) {
        exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
      }
      toast(err?.message || 'O GitHub não aceitou o envio. Tente de novo em instantes.');
    }
  };

  if (recusadoPeloGitHub) {
    const envia = el('button', 'mig-go', 'Enviar agora (não usa prompt)');
    envia.type = 'button';
    envia.addEventListener('click', () => enviarAgora(envia));
    acoes.append(envia);
    // Se o projeto mudou no meio, enviar é recusado: aí a IA refaz em cima
    // da versão atual (rodada normal, 1 prompt).
    const refazer = botaoComCusto('mig-cancel', 'Continuar');
    refazer.addEventListener('click', () => continuar(fonteAtual(), refazer));
    acoes.append(refazer);
  } else if (noTeto) {
    // Passou do teto de rodadas: só o Descartar (o trabalho continua visível).
  } else if (paradaDoChatGPT) {
    // Fonte explícita em cada botão: não depende do que está no seletor.
    const pelosPrompts = el('button', 'mig-go', `Continuar com prompts ${nomeDaMarca()} (usa 1 prompt)`);
    pelosPrompts.type = 'button';
    pelosPrompts.addEventListener('click', () => continuar('geckoai', pelosPrompts));
    acoes.append(pelosPrompts);
    if (pend.codigo !== 'plano') {
      const peloChatGPT = el('button', 'mig-cancel', 'Continuar pelo ChatGPT');
      peloChatGPT.type = 'button';
      peloChatGPT.title = pend.codigo === 'limite'
        ? 'Funciona quando o limite da sua assinatura voltar.'
        : 'Conecte o ChatGPT de novo nas Configurações antes.';
      peloChatGPT.addEventListener('click', () => continuar('chatgpt', peloChatGPT));
      acoes.append(peloChatGPT);
    }
  } else {
    const btn = botaoComCusto('mig-go', 'Continuar');
    btn.addEventListener('click', () => continuar(fonteAtual(), btn));
    acoes.append(btn);
  }

  const parar = el('button', 'mig-cancel', 'Descartar');
  parar.type = 'button';
  parar.addEventListener('click', async () => {
    record.pendingWorkFeito = 'Descartado — nada foi enviado ao seu projeto.';
    await saveHistory();
    acoes.remove();
    card.append(el('div', 'commit-undone', record.pendingWorkFeito));
  });
  acoes.append(parar);
  card.append(acoes);
  return card;
}

function buildMigrationCard(record) {
  const pending = record.pendingMigration;
  const card = el('div', 'migration-card');

  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', '🗄️'));
  head.append(el('span', null, 'Ajuste no banco de dados'));
  card.append(head);

  // O resumo em português (propor_migracao), quando a IA escreveu um.
  if (pending.resumo) card.append(el('div', 'mig-resumo', pending.resumo));
  const hint = el('div', 'mig-hint',
    'Preparei o ajuste abaixo. Clique em Autorizar para eu aplicar no seu banco.');
  card.append(hint);

  const pre = el('pre', 'mig-sql');
  pre.textContent = pending.sql;
  card.append(pre);

  // Aviso REESCRITO para leigo (pedido do dono): sem "SQL destrutivo", sem
  // "DROP/TRUNCATE", sem caixinha de "entendo o risco" — aquilo assustava em
  // migração de rotina. A caixinha também não protegia nada aqui: neste fluxo
  // quem roda o comando é o usuário, no editor do Lovable; o ato de colar e
  // clicar em Run JÁ é a autorização. Só sobra uma frase calma, e só quando o
  // comando realmente apaga dados (ver isDestructiveSql, recalibrada para
  // perder-dados em vez de contém-a-palavra-DROP).
  if (pending.isDestructive) {
    const warn = el('div', 'mig-warn');
    warn.append(el('strong', null, 'Este ajuste apaga informações que já existem'));
    warn.append(
      el('div', 'lb-sub',
        'Depois de aplicado não dá para voltar atrás. Se ficou em dúvida, feche este cartão e me pergunte o que ele faz.')
    );
    card.append(warn);
  }

  // Caminho manual: NÃO aparece no fluxo normal (decisão do dono, 2026-09-01
  // — só duas opções na tela). Fica escondido e só é revelado se a aplicação
  // automática falhar: é API interna do Lovable, um dia ela muda sem avisar, e
  // sem esta reserva o cliente ficaria sem saída nenhuma.
  const tools = el('div', 'mig-tools');
  tools.hidden = true;
  const copy = el('button', 'lb-btn', 'Copiar comando');
  copy.addEventListener('click', async () => {
    const ok = await copyToClipboard(pending.sql);
    toast(ok ? 'Comando copiado.' : 'Selecione e copie o comando manualmente.');
  });
  const open = el('button', 'lb-btn', 'Abrir editor do Lovable');
  open.addEventListener('click', openLovableSqlEditor);
  tools.append(copy, open);
  card.append(tools);

  const actions = el('div', 'mig-actions');
  const auto = el('button', 'mig-go', 'Autorizar');
  const go = el('button', 'mig-go', 'Já apliquei');
  const bad = el('button', 'mig-cancel', 'Cancelar');
  go.hidden = true;   // só na reserva, se o automático falhar
  actions.append(auto, go, bad);
  card.append(actions);

  const msg = el('div', 'mig-msg');
  msg.hidden = true;
  card.append(msg);

  // Commit do frontend: acontece DEPOIS do banco, nos dois caminhos.
  async function enviarCommit({ travaJaPega = false } = {}) {
    const commit = await comTravaDoProjeto(() => commitMigration({
      github: state.github,
      owner: state.project.owner,
      repo: state.project.name,
      branch: state.project.branch,
      changes: pending.changes,
      message: pending.message,
      sql: pending.sql,
      baseSha: pending.baseSha || null,
    }), { lancar: true, jaPega: travaJaPega });
    record.pendingMigration.applied = true;
    if (!commit) {
      // Nada a enviar (o projeto já estava assim): o banco foi aplicado e só.
      await saveHistory();
      card.replaceWith(el('div', 'mig-msg', 'Banco atualizado. O código já estava assim — nada a enviar.'));
      return;
    }
    record.commit = commit;
    // Parte de um plano só conta como concluída com o SQL aplicado E o
    // commit enviado — é agora.
    if (record.plano) record.planoResultado = 'concluida';
    pingPreview();
    await saveHistory();
    document.querySelectorAll('.btn-undo').forEach((b) => b.remove());
    const commitCard = buildCommitCard(commit, true, record);
    card.replaceWith(commitCard);
    if (record.plano) commitCard.after(buildPlanoCard(record));
  }

  // Só é revelado se o automático falhar (ver comentário na criação de
  // `tools`): no fluxo normal a tela tem duas opções e mais nada.
  function oferecerManual(motivo) {
    msg.hidden = false;
    msg.className = 'mig-msg err';
    msg.textContent = motivo;
    auto.hidden = true;
    tools.hidden = false;
    go.hidden = false;
    go.disabled = false;
    bad.disabled = false;
    hint.textContent =
      'Sem problema: copie o comando, cole no editor do Lovable e clique em Run. Depois volte aqui e confirme.';
  }

  auto.addEventListener('click', async () => {
    if (!podeEnviarAgora()) return;
    // Chat nativo: SQL que apaga ou abre dados pede também a confirmação do
    // navegador (ver aplicarSqlDoLovable).
    const perigoso = pending.isDestructive || abreAcesso(pending.sql);
    if (MODO_NATIVO && perigoso && !confirm('Autorizar este comando no seu banco? Ele apaga ou libera acesso a informações.')) return;
    auto.disabled = true;
    bad.disabled = true;
    msg.hidden = true;
    auto.textContent = 'Aplicando…';
    try {
      // Sem pedido de permissão aqui: `scripting` e `lovable.dev` já vêm
      // declaradas no manifest (decisão do dono, 2026-09-01). O clique em
      // Autorizar É a autorização — o navegador não pergunta de novo.
      // Banco E commit dentro da trava do projeto: com um pedido rodando na
      // outra janela, o banco mudava e o commit era recusado, e um novo
      // Autorizar aplicaria o mesmo SQL de novo (revisão da 1.11).
      const feito = await comTravaDoProjeto(async () => {
        const r = await aplicarSqlNoLovable(pending.sql);
        if (r.erro) {
          auto.disabled = false;
          auto.textContent = 'Autorizar';
          oferecerManual(r.erro);
          return 'erro';
        }
        auto.textContent = 'Enviando o código…';
        await enviarCommit({ travaJaPega: true });
        toast('Pronto — banco atualizado e código enviado.');
        return 'ok';
      });
      if (feito === false) {
        // Trava ocupada (o aviso já saiu): nada foi aplicado, o cartão volta.
        auto.disabled = false;
        bad.disabled = false;
        auto.textContent = 'Autorizar';
      }
    } catch (e) {
      auto.disabled = false;
      bad.disabled = false;
      auto.textContent = 'Autorizar';
      oferecerManual(e.message || 'Não consegui concluir.');
    }
  });

  go.addEventListener('click', async () => {
    if (!podeEnviarAgora()) return;
    go.disabled = true;
    bad.disabled = true;
    go.textContent = 'Enviando…';
    try {
      await enviarCommit();
      toast('Aplicado e commitado — o Lovable vai sincronizar.');
    } catch (e) {
      go.disabled = false;
      bad.disabled = false;
      go.textContent = 'Já apliquei';
      msg.hidden = false;
      msg.className = 'mig-msg err';
      msg.textContent = e.message || 'Não consegui enviar o commit.';
    }
  });

  // Cancelar: nada é aplicado no banco e nada é commitado. O cartão vira uma
  // nota curta — sem "Deu erro" e sem caixa para colar mensagem, que só faziam
  // sentido quando o usuário rodava o comando à mão.
  bad.addEventListener('click', async () => {
    const nota = el('div', 'mig-msg', 'Você cancelou — nada foi alterado no seu banco.');
    card.replaceWith(nota);
    // Parte de um plano: não some — vira "não concluída", com Tentar de novo.
    if (record.plano && !record.planoResultado) {
      record.planoResultado = 'falhou';
      await saveHistory();
      nota.after(buildPlanoCard(record));
    }
  });

  return card;
}

// Pedido de autorização para SQL destrutivo (Supabase externo, modo Build).
// Nesse modo a IA roda SQL direto no banco do usuário; DROP/TRUNCATE/DELETE sem
// WHERE só saem daqui com ele dizendo sim. Devolve Promise<boolean> — o agente
// fica parado esperando, e cancelar a execução responde "não".
function confirmarSqlDestrutivo(sql, root) {
  return new Promise((resolve) => {
    // Já cancelado antes de chegar aqui: responde "não" na hora. Sem isto o
    // listener de 'abort' nunca dispararia (signal já abortado não reemite) e a
    // promessa ficaria pendurada, travando o agente e a UI.
    if (state.abort?.signal.aborted) return resolve(false);
    pedirAtencao();

    const card = el('div', 'migration-card');
    let decidido = false;

    const decidir = (autorizado) => {
      if (decidido) return;
      decidido = true;
      state.abort?.signal.removeEventListener('abort', aoCancelar);
      const nota = el(
        'div',
        autorizado ? 'mig-msg' : 'mig-msg err',
        autorizado
          ? 'Você autorizou este comando.'
          : 'Você não autorizou — nada foi alterado no seu banco.'
      );
      card.replaceWith(nota);
      resolve(autorizado);
    };
    const aoCancelar = () => decidir(false);

    // Sem jargão e sem caixinha de "li e concordo" (pedido do dono: o cliente
    // é leigo). O que NÃO sai daqui é o gesto de autorizar: neste caminho a
    // extensão roda o comando no banco de produção do cliente, com o token
    // dele. Um clique consciente é o que separa "a IA propôs" de "a IA fez".
    const head = el('div', 'mig-head');
    head.append(el('span', 'mig-ico', '⚠️'));
    head.append(el('span', null, 'Este ajuste apaga informações do seu banco'));
    card.append(head);

    card.append(
      el('div', 'mig-hint',
        'Vou rodar o comando abaixo no seu banco de dados. Ele remove informações que já estão lá, e depois não dá para voltar atrás. Autorize só se for isso mesmo que você pediu.')
    );

    const pre = el('pre', 'mig-sql');
    pre.textContent = sql;
    card.append(pre);

    const actions = el('div', 'mig-actions');
    const go = el('button', 'mig-go', 'Autorizar');
    const no = el('button', 'mig-cancel', 'Não rodar');
    // Chat nativo: confirmação nativa do navegador (ver aplicarSqlDoLovable).
    go.addEventListener('click', () => {
      if (MODO_NATIVO && !confirm('Autorizar o comando que APAGA informações do seu banco?')) return;
      decidir(true);
    });
    no.addEventListener('click', () => decidir(false));
    actions.append(go, no);
    card.append(actions);

    state.abort?.signal.addEventListener('abort', aoCancelar, { once: true });
    root.append(card);
    scrollThread();
  });
}

// ---------- Pedido grande em partes ----------
// A IA chama dividir_em_partes e o laço fica parado até o usuário aprovar aqui
// (mesmo mecanismo do SQL destrutivo). Cada parte é um run — e um prompt da
// chave — e termina com commit, então nada se perde se ele parar no meio.
// O plano vive no registro do run (state.history → saveHistory): fechar e
// reabrir o painel mostra o cartão de novo.

function listaDePartes(partes, atual = -1) {
  const ol = el('ol', 'mig-hint');
  partes.forEach((p, k) => {
    const li = el('li');
    const marca = p.feita || (atual >= 0 && k < atual) ? '✓ ' : '';
    li.append(el('strong', null, `${marca}${p.titulo}`));
    li.append(document.createTextNode(` — ${p.descricao}`));
    ol.append(li);
  });
  return ol;
}

// Chave sem limite de prompts (Max ilimitado, mensal ilimitada — o servidor
// afirma; ver licenseIlimitado). O pedido em partes existe para o cliente ver
// o gasto ANTES de gastar; sem cota, não há o que autorizar.
function chaveIlimitada() {
  // Cada nova parte pela API pode ter custo: pedir confirmação antes de continuar.
  return false;
}

// Devolve Promise<boolean>; cancelar a execução responde "não".
function confirmarPlano(partes, root) {
  return new Promise((resolve) => {
    if (state.abort?.signal.aborted) return resolve(false);
    pedirAtencao();

    // Chave ilimitada: mostra o plano e começa. As partes seguem sozinhas
    // (seguirParaProximaParte); parar continua sendo o botão de cancelar.
    if (chaveIlimitada()) {
      const card = el('div', 'migration-card');
      const head = el('div', 'mig-head');
      head.append(el('span', 'mig-ico', '🧩'));
      head.append(el('span', null, `Vou fazer em ${partes.length} partes, uma depois da outra`));
      card.append(head);
      card.append(
        el('div', 'mig-hint',
          'Cada parte termina com um commit — o Lovable sincroniza a cada uma. Sua chave é ilimitada: as partes seguem sozinhas. Se uma falhar, eu paro e você decide.')
      );
      card.append(listaDePartes(partes));
      root.append(card);
      scrollThread();
      return resolve(true);
    }

    const card = el('div', 'migration-card');
    let decidido = false;
    const decidir = (ok) => {
      if (decidido) return;
      decidido = true;
      state.abort?.signal.removeEventListener('abort', aoCancelar);
      const nota = el(
        'div',
        ok ? 'mig-msg' : 'mig-msg err',
        ok
          ? `Plano aprovado — começando a parte 1 de ${partes.length}.`
          : 'Plano cancelado por você — nada foi alterado.'
      );
      card.replaceWith(nota);
      resolve(ok);
    };
    const aoCancelar = () => decidir(false);

    const head = el('div', 'mig-head');
    head.append(el('span', 'mig-ico', '🧩'));
    head.append(el('span', null, `Vou fazer em ${partes.length} partes`));
    card.append(head);
    card.append(
      el('div', 'mig-hint',
        `Cada parte é um prompt da sua chave e termina com um commit — o Lovable sincroniza a cada uma. Você aprova cada próxima parte. Total: ${partes.length} prompts.`)
    );
    card.append(listaDePartes(partes));

    const actions = el('div', 'mig-actions');
    const go = el('button', 'mig-go', 'Começar a parte 1');
    const no = el('button', 'mig-cancel', 'Cancelar');
    go.addEventListener('click', () => decidir(true));
    no.addEventListener('click', () => decidir(false));
    actions.append(go, no);
    card.append(actions);

    state.abort?.signal.addEventListener('abort', aoCancelar, { once: true });
    root.append(card);
    scrollThread();
  });
}

function buildPlanoRecusadoCard(partes) {
  const card = el('div', 'migration-card');
  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', '🧩'));
  head.append(el('span', null, 'Plano proposto (cancelado por você)'));
  card.append(head);
  card.append(listaDePartes(partes));
  return card;
}

// Cartão pós-run de uma parte: concluída (continuar/parar) ou falhou (tentar
// de novo/parar). `planoSeguido` marca que o usuário já decidiu — o cartão
// vira texto, para o histórico não reoferecer botões de prompts já gastos.
function buildPlanoCard(record) {
  const plano = record.plano;
  const card = el('div', 'migration-card');
  if (!plano?.partes?.[plano.atual]) return card;

  const n = plano.partes.length;
  const atual = plano.atual;
  const concluida = record.planoResultado === 'concluida';
  const proxima = concluida ? atual + 1 : atual;
  const acabou = concluida && proxima >= n;

  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', acabou ? '🏁' : '🧩'));
  head.append(
    el('span', null,
      acabou
        ? `Tudo concluído — ${n} partes, ${n} commits`
        : concluida
          ? `Parte ${atual + 1} de ${n} concluída — ${plano.partes[atual].titulo}`
          : `Parte ${atual + 1} de ${n} não concluída — ${plano.partes[atual].titulo}`)
  );
  card.append(head);
  if (acabou) return card;

  card.append(
    el('div', 'mig-hint',
      concluida
        ? `Próxima: ${plano.partes[proxima].titulo} — ${plano.partes[proxima].descricao}`
        : 'As partes anteriores estão salvas no projeto. Você pode tentar esta de novo.')
  );

  if (record.planoSeguido) {
    card.append(
      el('div', 'mig-msg',
        record.planoSeguido === 'parou'
          ? 'Encerrado por você aqui.'
          : record.planoSeguido === 'ajuste'
            ? 'Continuou pelo chat.'
            : `Seguiu para a parte ${proxima + 1}.`)
    );
    return card;
  }

  const actions = el('div', 'mig-actions');
  // O custo no rótulo segue a IA escolhida no seletor (pelo ChatGPT, não
  // desconta prompt) e é reescrito quando ela muda.
  const go = botaoComCusto('mig-go',
    concluida ? `Continuar — parte ${proxima + 1}` : 'Tentar de novo');
  const stop = el('button', 'mig-cancel', 'Parar aqui');
  go.addEventListener('click', async () => {
    // Outro botão (cartão de erro) já seguiu com esta parte.
    if (record.planoSeguido) { card.replaceWith(buildPlanoCard(record)); return; }
    if (!podeEnviarAgora()) return;
    record.planoSeguido = 'continuou';
    await saveHistory();
    const novo = buildPlanoCard(record);
    card.replaceWith(novo);
    const r = await continuarPlano(plano, proxima, concluida ? null : record.planoFalha);
    // O run nem começou (sem chave, token do banco morto): o cartão volta
    // com os botões, em vez de "Seguiu para a parte N" sem parte nenhuma.
    if (r === false) {
      delete record.planoSeguido;
      await saveHistory();
      novo.replaceWith(buildPlanoCard(record));
    }
  });
  stop.addEventListener('click', async () => {
    record.planoSeguido = 'parou';
    await saveHistory();
    card.replaceWith(buildPlanoCard(record));
  });
  actions.append(go, stop);
  card.append(actions);
  return card;
}

// Chave ilimitada: a parte terminou bem, então a próxima começa sem clique.
// Chamado DEPOIS do run anterior liberar o painel (setTimeout no fim do
// runAndRender). Se algo mudou no meio — outro envio rodando, projeto trocado,
// envio travado —, não segue: o cartão fica com os botões, como em qualquer
// chave, e ninguém vê "Seguiu para a parte N" sem a parte ter começado.
function seguirParaProximaParte(record, cartao, proxima, projetoDoRun) {
  const mesmoProjeto = state.project
    && state.project.owner === projetoDoRun.owner
    && state.project.name === projetoDoRun.name
    && state.project.branch === projetoDoRun.branch;
  if (!chaveIlimitada() || !mesmoProjeto || state.running || state.lovableLock || isSendBlocked()) return;
  if (atualizacaoObrigatoria()) return; // versão abaixo da mínima: nada sai sozinho
  if (!state.settings?.keys?.[state.settings.provider]) return;
  record.planoSeguido = 'continuou';
  saveHistory();
  const novo = buildPlanoCard(record);
  cartao.replaceWith(novo);
  continuarPlano(record.plano, proxima).then((r) => {
    if (r !== false) return;
    delete record.planoSeguido;
    saveHistory();
    novo.replaceWith(buildPlanoCard(record));
  });
}

// Dispara o run da parte `k`. É um prompt novo de verdade: o servidor conta
// pela forma do corpo (mensagem nova de usuário), sem header nem exceção.
// Devolve false quando nem começou (quem chamou devolve os botões ao cartão).
// `fonte`: os cartões de erro do premium/ChatGPT refazem a parte pelos
// prompts — sem ela, o padrão voltaria a ser a fonte do seletor.
async function continuarPlano(plano, k, parteFalhou = null, fonte = undefined) {
  if (!state.project || state.running || state.lovableLock || isSendBlocked() || atualizacaoObrigatoria()) return false;
  if (!state.settings?.keys?.[state.settings.provider]) {
    toast('Configure sua API de IA em Configurações.');
    return false;
  }
  const partes = plano.partes.map((p, i) => ({ ...p, feita: i < k }));
  const p = partes[k];
  return runAndRender({
    userText: `▶ Parte ${k + 1} de ${partes.length}: ${p.titulo}`,
    attach: null,
    promptForAI:
      `Continue the plan from the <plano> block: implement ONLY part ${k + 1} of ${partes.length} — "${p.titulo}": ${p.descricao}. The parts before it are already committed in the repository.` +
      (parteFalhou
        ? ' The previous attempt at this part FAILED — follow the <retry> block: split this part with dividir_em_partes FIRST.'
        : '') +
      ' Finish with set_commit_message and a short summary of this part.',
    images: [],
    mode: 'build',
    plano: { pedido: plano.pedido, partes, atual: k },
    parteFalhou,
    ...(fonte ? { fonte } : {}),
  });
}

// ---------- ChatGPT do cliente (v1.6.0) ----------
// O cliente conecta a PRÓPRIA assinatura do ChatGPT e os pedidos rodam por
// ela, direto do navegador para a OpenAI (lib/chatgpt.js +
// lib/providers-chatgpt.js). Decisão do dono (2026-09-25): envio pelo ChatGPT
// NÃO desconta prompt, mas a chave vale pelo mesmo prazo — cada envio começa
// pela mesma validação de sempre (x-gecko-validate), que não desconta nada.
// O cliente escolhe o modelo e o nível de raciocínio no compositor e troca
// quando quiser. O token dele vive só em chrome.storage.local ('chatgpt').

// A única referência à marca nesta seção: os textos visíveis passam por aqui.
const nomeDaMarca = () => MARCA.nome;

function chatgptConectado() {
  return Boolean(state.chatgpt?.access && state.chatgpt?.refresh);
}

// 'chatgpt' só com a escolha feita E a conta conectada: desconectou, volta
// sozinho aos prompts. Pelos prompts, QUAL modelo é opcaoEfetiva() (catálogo).
function fonteAtual() {
  return state.settings?.fonteIA === 'chatgpt' && chatgptConectado() ? 'chatgpt' : 'geckoai';
}

// ---------- Modelos que o cliente escolhe (catálogo, 1.9) ----------
// O dono monta no admin a lista do seletor (três modelos hoje, um deles
// premium), com descrição e ícone. Tudo vem do SERVIDOR na validação da chave —
// o pacote não cita modelo nenhum. Uma opção pode ser premium: com cota por
// dia nos planos que a têm, e BLOQUEADA (com o aviso do dono) nos outros. A
// cota é conferida no servidor; aqui é só mostrar e pedir.
function catalogo() {
  const c = state.settings?.modelos;
  return c?.opcoes?.length ? c : null;
}

function restanteDaCota(o) {
  return o?.cota ? Math.max(o.cota.porDia - o.cota.usados, 0) : Infinity;
}

function opcaoDisponivel(o) {
  return Boolean(o?.liberado) && restanteDaCota(o) > 0;
}

// O modelo que o próximo envio pelos prompts usa: o escolhido, se ainda
// estiver disponível; senão o padrão do dono.
function opcaoEfetiva() {
  const cat = catalogo();
  if (!cat) return null;
  const escolhida = cat.opcoes.find((o) => o.id === state.settings?.modeloCliente);
  if (opcaoDisponivel(escolhida)) return escolhida;
  const padrao = cat.opcoes.find((o) => o.id === cat.padrao);
  return opcaoDisponivel(padrao) ? padrao : cat.opcoes.find(opcaoDisponivel) || null;
}

// O premium desta chave, quando ela tem cota (para o selo "<nome> 3/10" na barra).
function opcaoComCota() {
  return catalogo()?.opcoes.find((o) => o.liberado && o.cota) || null;
}

async function salvarChatGPT() {
  if (state.chatgpt) await storage.set({ chatgpt: state.chatgpt });
  else await storage.remove('chatgpt');
}

// A aba de login termina na página de erro do localhost: é a URL dela que
// traz o código (lib/chatgpt.js explica por quê).
function esperarRetornoDaAba(abaId, prefixo) {
  return new Promise((resolve, reject) => {
    let acabou = false;
    const fim = (fn, v) => {
      if (acabou) return;
      acabou = true;
      chrome.tabs.onUpdated.removeListener(aoMudar);
      chrome.tabs.onRemoved.removeListener(aoFechar);
      clearTimeout(relogio);
      fn(v);
    };
    const aoMudar = (id, info, tab) => {
      if (id !== abaId) return;
      const url = info.url || tab?.url || tab?.pendingUrl || '';
      if (url.startsWith(prefixo)) fim(resolve, url);
    };
    const aoFechar = (id) => {
      if (id === abaId) {
        fim(reject, new ChatGPT.ChatGPTError('A aba de login foi fechada antes de terminar.', { codigo: 'login' }));
      }
    };
    const relogio = setTimeout(() => {
      fim(reject, new ChatGPT.ChatGPTError('O login do ChatGPT demorou demais. Tente de novo.', { codigo: 'login' }));
    }, 5 * 60_000);
    chrome.tabs.onUpdated.addListener(aoMudar);
    chrome.tabs.onRemoved.addListener(aoFechar);
  });
}

async function conectarChatGPT() {
  const conta = await ChatGPT.conectar({
    abrirAba: async (url) => (await chrome.tabs.create({ url, active: true })).id,
    esperarRetorno: esperarRetornoDaAba,
    fecharAba: async (id) => chrome.tabs.remove(id),
  });
  const modelos = await ChatGPT.buscarCatalogo({ access: conta.access, conta: conta.conta });
  // Reconectando depois de uma queda: modelo e níveis escolhidos voltam.
  const anterior = state.chatgpt;
  state.chatgpt = {
    ...conta,
    modelo: modelos.some((m) => m.slug === anterior?.modelo) ? anterior.modelo : modelos[0].slug,
    esforcos: anterior?.esforcos || {},
    catalogo: { lidoEm: Date.now(), modelos },
    limite: null,
  };
  await salvarChatGPT();
  state.settings.fonteIA = 'chatgpt';
  await storage.set({ settings: state.settings });
  aoMudarFonte();
  atualizarUsoChatGPT(); // o selo já com a porcentagem, sem esperar o 1º pedido
}

async function desconectarChatGPT() {
  state.chatgpt = null;
  await salvarChatGPT();
  state.settings.fonteIA = 'geckoai';
  await storage.set({ settings: state.settings });
  // A permissão de falar com a OpenAI sai junto: quem desconecta volta à
  // instalação de sempre.
  try { await chrome.permissions.remove({ origins: ChatGPT.HOSTS }); } catch { /* sem permissão para tirar */ }
  aoMudarFonte();
}

// Acesso válido para a próxima chamada (o motor pede a cada volta): renova
// antes de vencer e guarda o novo.
async function acessoChatGPT() {
  if (!state.chatgpt) {
    throw new ChatGPT.ChatGPTError('Conecte sua conta do ChatGPT nas Configurações.', { codigo: 'acesso', retomavel: true });
  }
  if (ChatGPT.precisaRenovar(state.chatgpt)) {
    // Uma renovação só no navegador inteiro (mesmo motivo do Supabase): a
    // janela que perdia a corrida marcava a conta como desconectada e apagava
    // os tokens novos da vencedora em todas as janelas.
    const renovar = async () => {
      const atual = (await storage.get(['chatgpt'])).chatgpt || state.chatgpt;
      if (atual?.access && !ChatGPT.precisaRenovar(atual)) {
        state.chatgpt = atual;
        return;
      }
      state.chatgpt = await ChatGPT.renovar(atual, { fetch: comPrazo20s });
      await salvarChatGPT();
    };
    if (navigator.locks?.request) await navigator.locks.request('renovar-chatgpt', { signal: AbortSignal.timeout(45_000) }, renovar);
    else await renovar();
  }
  return { access: state.chatgpt.access, conta: state.chatgpt.conta };
}

// Relê o catálogo com mais de um dia (ou na hora, quando a OpenAI recusou o
// modelo). Modelo guardado que sumiu cai no primeiro da lista, com aviso.
async function atualizarCatalogoChatGPT({ forcar = false } = {}) {
  if (!chatgptConectado()) return;
  if (!forcar && Date.now() - (state.chatgpt.catalogo?.lidoEm || 0) < 86_400_000) return;
  try {
    const { access, conta } = await acessoChatGPT();
    const modelos = await ChatGPT.buscarCatalogo({ access, conta });
    const anterior = state.chatgpt.modelo;
    state.chatgpt.catalogo = { lidoEm: Date.now(), modelos };
    if (!modelos.some((m) => m.slug === anterior)) {
      state.chatgpt.modelo = modelos[0].slug;
      if (anterior && fonteAtual() === 'chatgpt') {
        toast(`O modelo ${anterior} não está mais na sua conta. Agora é ${modelos[0].nome}.`);
      }
    }
    await salvarChatGPT();
    populateModelSelect();
  } catch {
    /* sem rede ou acesso caído: o próximo envio mostra o cartão certo */
  }
}

// ---------- Seletor de IA do compositor ----------
// Uma lista própria (não um <select>: ele não mostra descrição, ícone nem o
// aviso do modelo bloqueado). Itens: o catálogo do servidor — ou "Prompts
// <marca>" sem catálogo — e, com o ChatGPT do cliente conectado, os modelos
// dele. Escolher o item é escolher a fonte: não há interruptor para esquecer
// ligado. A linha só aparece com catálogo ou ChatGPT.

// Ícones pelo NOME que o servidor manda (cerebro, codigo...): o pacote só
// sabe desenhar, não sabe de modelo nenhum. Nome desconhecido = o padrão.
const ICONES_IA = {
  cerebro: '<path d="M12 5.5V19"/><path d="M12 5.5a3 3 0 0 0-5.5-1.2A3 3 0 0 0 4 8a3 3 0 0 0-.5 5 3.2 3.2 0 0 0 2.5 5.2A3 3 0 0 0 12 19"/><path d="M12 5.5a3 3 0 0 1 5.5-1.2A3 3 0 0 1 20 8a3 3 0 0 1 .5 5 3.2 3.2 0 0 1-2.5 5.2A3 3 0 0 1 12 19"/><path d="M8 9.5a2 2 0 0 1 2 2m6-2a2 2 0 0 0-2 2m-6.5 3.5a2 2 0 0 1 2-1m7 1a2 2 0 0 0-2-1"/>',
  codigo: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4M13.5 5l-3 14"/>',
  raio: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"/>',
  estrela: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>',
  foguete: '<path d="M5 15c-1.5 1-2 4-2 4s3-.5 4-2m1.5-5.5A15 15 0 0 1 20 4c0 5-3.5 9-7.5 11.5L8.5 11.5Zm0 0L5 11l3-3.5 3.5.5m1 4.5.5 3.5L9.5 19 9 15.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5Z"/>',
  padrao: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6"/>',
};
const SVG_CADEADO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

function iconeIA(nome) {
  const chave = ICONES_IA[nome] ? nome : 'padrao';
  const span = el('span', `ia-ico ico-${chave}`);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONES_IA[chave]}</svg>`;
  return span;
}

function itensDoSeletorIA() {
  const itens = [];
  const cat = catalogo();
  if (cat) {
    for (const o of cat.opcoes) {
      let bloqueio = null;
      if (!o.liberado) bloqueio = o.bloqueio || 'Indisponível na sua chave';
      else if (restanteDaCota(o) <= 0) bloqueio = `Os ${o.cota.porDia} prompts de hoje acabaram — voltam à meia-noite`;
      itens.push({
        valor: `cat:${o.id}`, nome: o.nome, descricao: o.descricao, icone: o.icone,
        bloqueio, cota: o.liberado ? o.cota : null,
      });
    }
  } else {
    itens.push({ valor: 'geckoai', nome: state.settings?.models?.geckoai || 'Minha API', descricao: 'Direto para sua API de IA', icone: 'padrao' });
  }
  if (chatgptConectado()) {
    itens.push({ grupo: 'Meu ChatGPT' });
    const modelos = state.chatgpt.catalogo?.modelos?.length ? state.chatgpt.catalogo.modelos : ChatGPT.CATALOGO_RESERVA;
    for (const m of modelos) {
      itens.push({ valor: `chatgpt::${m.slug}`, nome: m.nome, descricao: 'Pela sua assinatura — não desconta prompts', icone: 'chat' });
    }
  }
  return itens;
}

function valorAtualIA() {
  if (fonteAtual() === 'chatgpt') return `chatgpt::${ChatGPT.modeloEscolhido(state.chatgpt).slug}`;
  const o = opcaoEfetiva();
  return o ? `cat:${o.id}` : 'geckoai';
}

const textoDaCota = (c) => `${c.usados}/${c.porDia} hoje`;

function populateModelSelect() {
  const linha = $('#composer-ia');
  if (!chatgptConectado() && !catalogo()) {
    if (linha) linha.hidden = true;
    fecharMenuIA();
    renderNivelChatGPT();
    return;
  }
  if (linha) linha.hidden = false;
  // O botão mostra o que o próximo envio usa.
  const atual = itensDoSeletorIA().find((i) => i.valor === valorAtualIA());
  const botao = $('#ia-picker');
  botao.replaceChildren(iconeIA(atual?.icone), el('span', 'ia-nome', atual?.nome || 'IA'));
  if (atual?.cota) botao.append(el('span', `ia-cota${restanteDaCota({ cota: atual.cota }) <= 0 ? ' fim' : ''}`, textoDaCota(atual.cota)));
  const seta = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  seta.setAttribute('viewBox', '0 0 24 24');
  seta.setAttribute('class', 'ia-seta');
  seta.innerHTML = '<path d="m6 15 6-6 6 6"/>';
  botao.append(seta);
  botao.title = atual?.descricao ? `${atual.nome} — ${atual.descricao}` : 'Qual IA faz os pedidos';
  if (!$('#ia-menu').hidden) renderMenuIA();
  renderNivelChatGPT();
}

function renderMenuIA() {
  const menu = $('#ia-menu');
  const atual = valorAtualIA();
  menu.replaceChildren();
  for (const item of itensDoSeletorIA()) {
    if (item.grupo) {
      menu.append(el('div', 'ia-grupo', item.grupo));
      continue;
    }
    const b = el('button', 'ia-item');
    b.type = 'button';
    b.setAttribute('role', 'option');
    const ativo = item.valor === atual;
    b.classList.toggle('ativo', ativo);
    b.setAttribute('aria-selected', String(ativo));

    const textos = el('span', 'ia-textos');
    const nome = el('span', 'ia-item-nome', item.nome);
    textos.append(nome);
    if (item.descricao) textos.append(el('span', 'ia-item-desc', item.descricao));
    b.append(iconeIA(item.icone), textos);
    if (item.cota) b.append(el('span', `ia-cota${restanteDaCota(item) <= 0 ? ' fim' : ''}`, textoDaCota(item.cota)));

    if (item.bloqueio) {
      // Não clicável: o aviso troca a descrição ao passar o mouse (ou ao
      // focar), e o toque mostra o mesmo aviso — no celular não há "passar".
      b.classList.add('bloqueado');
      b.setAttribute('aria-disabled', 'true');
      b.setAttribute('aria-label', `${item.nome}: ${item.bloqueio}`);
      const cadeado = el('span', 'ia-cadeado');
      cadeado.innerHTML = SVG_CADEADO;
      nome.append(cadeado);
      const dica = el('span', 'ia-dica');
      dica.innerHTML = SVG_CADEADO;
      dica.append(document.createTextNode(item.bloqueio));
      textos.append(dica);
      b.addEventListener('click', () => toast(item.bloqueio));
    } else {
      b.addEventListener('click', () => {
        fecharMenuIA();
        if (item.valor !== atual) escolherIA(item.valor);
      });
    }
    menu.append(b);
  }
}

function abrirMenuIA() {
  if (state.running) return;
  renderMenuIA();
  $('#ia-menu').hidden = false;
  $('#ia-picker').setAttribute('aria-expanded', 'true');
  ($('#ia-menu .ia-item.ativo') || $('#ia-menu .ia-item'))?.focus();
}

function fecharMenuIA() {
  const menu = $('#ia-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('#ia-picker')?.setAttribute('aria-expanded', 'false');
}

$('#ia-picker').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#ia-menu').hidden) abrirMenuIA();
  else fecharMenuIA();
});
$('#ia-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', fecharMenuIA);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#ia-menu').hidden) {
    fecharMenuIA();
    $('#ia-picker').focus();
  }
});

// Só os níveis que o modelo escolhido aceita (lidos do catálogo da conta),
// lembrados por modelo.
function renderNivelChatGPT() {
  const sel = $('#effort-select');
  const campo = $('#effort-campo'); // rótulo + seletor
  if (!sel || !campo) return;
  sel.replaceChildren();
  const modelo = fonteAtual() === 'chatgpt' ? ChatGPT.modeloEscolhido(state.chatgpt) : null;
  if (!modelo?.niveis?.length) {
    campo.hidden = true;
    return;
  }
  for (const n of modelo.niveis) sel.append(new Option(ChatGPT.rotuloDoNivel(n.effort), n.effort));
  sel.value = ChatGPT.esforcoDe(state.chatgpt, modelo.slug);
  sel.title = 'Raciocínio do ChatGPT: mais alto pensa mais, demora mais e gasta mais do limite da sua assinatura.';
  campo.hidden = false;
}

async function escolherIA(valor) {
  if (valor === 'geckoai') {
    state.settings.fonteIA = 'geckoai';
  } else if (valor.startsWith('cat:')) {
    const o = catalogo()?.opcoes.find((x) => `cat:${x.id}` === valor);
    if (!opcaoDisponivel(o)) return;
    state.settings.fonteIA = 'geckoai';
    state.settings.modeloCliente = o.id;
  } else if (valor.startsWith('chatgpt::') && state.chatgpt) {
    state.settings.fonteIA = 'chatgpt';
    state.chatgpt.modelo = valor.slice('chatgpt::'.length);
    await salvarChatGPT();
  }
  await storage.set({ settings: state.settings });
  aoMudarFonte();
  if (fonteAtual() === 'chatgpt') {
    toast(`Pedidos pelo seu ChatGPT (${ChatGPT.modeloEscolhido(state.chatgpt).nome}): não descontam prompts.`);
    return;
  }
  const o = opcaoEfetiva();
  if (o?.cota) {
    const restam = restanteDaCota(o);
    toast(`Pedidos pelo ${o.nome}: ${restam} de ${o.cota.porDia} restante${restam === 1 ? '' : 's'} hoje.`);
  } else {
    toast(o ? `Pedidos pelo ${o.nome}.` : `Pedidos pelos prompts ${nomeDaMarca()}.`);
  }
}

$('#effort-select')?.addEventListener('change', async (e) => {
  if (!state.chatgpt) return;
  const slug = ChatGPT.modeloEscolhido(state.chatgpt).slug;
  state.chatgpt.esforcos = { ...(state.chatgpt.esforcos || {}), [slug]: e.target.value };
  await salvarChatGPT();
});

function aoMudarFonte() {
  populateModelSelect();
  updateLicenseUI();
  atualizarRotulosDeCusto();
  if (!$('#settings-overlay')?.hidden) renderConexoes();
}

// Botões que custam 1 prompt dizem isso; pelo ChatGPT, dizem que não custam.
// Guardam o texto-base em data-custo e são reescritos quando a fonte muda.
// Chave ilimitada: não há custo a anunciar, o botão fica só com o nome.
function custoDoProximoEnvio() {
  if (fonteAtual() === 'chatgpt') return 'pelo seu ChatGPT';
  return 'cobrança da sua API';
}

function rotuloComCusto(base) {
  const custo = custoDoProximoEnvio();
  return custo ? `${base} (${custo})` : base;
}

function botaoComCusto(className, base) {
  const b = el('button', className, rotuloComCusto(base));
  b.type = 'button';
  b.dataset.custo = base;
  return b;
}

function atualizarRotulosDeCusto() {
  document.querySelectorAll('[data-custo]').forEach((b) => {
    b.textContent = rotuloComCusto(b.dataset.custo);
  });
}

// Linha do ChatGPT nas Configurações (depois de GitHub/Supabase/Vercel).
function linhaChatGPT() {
  const ligado = chatgptConectado();
  const itens = [];
  const row = el('div', ligado ? 'conn-item ligado' : 'conn-item');
  const info = el('div', 'conn-item-info');
  info.append(el('div', 'conn-item-nome', 'ChatGPT'));
  const plano = state.chatgpt?.plano
    ? `ChatGPT ${state.chatgpt.plano.charAt(0).toUpperCase()}${state.chatgpt.plano.slice(1)}`
    : 'conectado';
  info.append(el('div', 'conn-item-status',
    ligado ? `${plano} · ${ChatGPT.modeloEscolhido(state.chatgpt).nome}` : 'não conectado — opcional'));
  const btn = el('button', ligado ? 'conn-acao' : 'conn-acao principal', ligado ? 'Desconectar' : 'Conectar');
  btn.addEventListener('click', async () => {
    showError('#settings-error', null);
    if (ligado) {
      await desconectarChatGPT();
      toast('ChatGPT desconectado. Os pedidos voltam a usar os prompts.');
      return;
    }
    // O pedido de permissão tem de ser a PRIMEIRA coisa do clique: o Chrome
    // só mostra a janela durante o gesto do usuário.
    const permissao = chrome.permissions.request({ origins: ChatGPT.HOSTS });
    btn.disabled = true;
    btn.textContent = 'Aguardando…';
    try {
      if (!(await permissao)) {
        throw new Error('Sem essa permissão a extensão não consegue falar com o ChatGPT.');
      }
      await conectarChatGPT();
      toast('ChatGPT conectado. Escolha o modelo na barra de envio.');
    } catch (err) {
      showError('#settings-error', err.message || 'Não foi possível conectar ao ChatGPT.');
    } finally {
      btn.disabled = false;
      renderConexoes();
    }
  });
  row.append(info, btn);
  itens.push(row);
  if (!ligado) {
    itens.push(el('p', 'field-hint',
      'Use a sua assinatura do ChatGPT (Plus ou Pro) no lugar dos prompts: os pedidos não descontam ' +
      'prompts, mas gastam o limite da sua assinatura. A tela de login da OpenAI mostra o nome "Codex". ' +
      'A OpenAI não apoia oficialmente o uso em outros apps e pode mudar essa regra; se mudar, você ' +
      'continua pelos prompts.'));
  }
  return itens;
}

// "Volta às 14:30" (hoje) ou "volta em 27/09 às 14:30".
function quandoVoltaTexto(limite) {
  const ms = ChatGPT.quandoVolta(limite);
  if (!ms) return '';
  const d = new Date(ms);
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hoje = new Date().toDateString() === d.toDateString();
  return hoje ? `volta às ${hora}` : `volta em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hora}`;
}

// Anexos do envio, só em memória (não vão para o storage): o "usar os
// prompts neste envio" repete o pedido com eles.
const anexosDoRegistro = new WeakMap();

// Resultado da validação da chave -> validade, prompts e aviso de versão.
async function aplicarLicencaValidada(info) {
  aplicarVersaoDoServidor(info.versao);
  const mudou =
    (info.expiresAt ?? null) !== (state.settings.licenseExpiresAt ?? null) ||
    (info.remaining ?? null) !== (state.settings.licenseRemaining ?? null) ||
    (info.ilimitado === true) !== (state.settings.licenseIlimitado === true) ||
    (info.imagens === true) !== (state.settings.imagensAtivas === true) ||
    JSON.stringify(info.modelos ?? null) !== JSON.stringify(state.settings.modelos ?? null) ||
    'premium' in state.settings;
  if (mudou) {
    state.settings.licenseExpiresAt = info.expiresAt ?? null;
    state.settings.licenseRemaining = info.remaining ?? null;
    state.settings.licenseIlimitado = info.ilimitado === true;
    state.settings.imagensAtivas = info.imagens === true;
    state.settings.modelos = info.modelos ?? null;
    // Quem veio da 1.8 com o premium escolhido continua nele, agora como
    // opção do catálogo.
    if (state.settings.fonteIA === 'premium') {
      state.settings.fonteIA = 'geckoai';
      state.settings.modeloCliente = catalogo()?.opcoes.find((o) => o.cota)?.id ?? null;
    }
    delete state.settings.premium;
    // O modelo escolhido não está mais disponível (cota de hoje acabou,
    // plano mudou, o dono tirou da lista): volta ao padrão, e amanhã o
    // cliente escolhe de novo — não volta sozinho ao premium à meia-noite.
    const escolhida = catalogo()?.opcoes.find((o) => o.id === state.settings.modeloCliente);
    if (state.settings.modeloCliente && !opcaoDisponivel(escolhida)) state.settings.modeloCliente = null;
    await storage.set({ settings: state.settings });
    atualizarRotulosDeCusto(); // "(usa 1 prompt)" some/volta com a chave ilimitada
    populateModelSelect();
  }
  updateLicenseUI();
}

// Acesso recusado pela OpenAI: o login guardado não serve mais. As escolhas
// (modelo, níveis) ficam para quando ele conectar de novo; os pedidos voltam
// aos prompts até lá.
function marcarChatGPTDesconectado() {
  if (!state.chatgpt) return;
  state.chatgpt = { ...state.chatgpt, access: null, refresh: null };
  salvarChatGPT();
  aoMudarFonte();
}

// Refaz pelos prompts o envio que o premium ou o ChatGPT recusou. Parte de um
// plano refaz a PARTE (com o <plano> e o motivo da falha) — o pedido "cru" ia
// sem plano: a IA recebia "continue o plano" sem plano nenhum, e o cartão da
// parte seguia oferecendo refazer o que já tinha sido feito.
async function refazerPelosPrompts(record) {
  // A parte já seguiu pelo cartão do plano: refazer aqui repetiria o que o
  // outro botão já fez, cobrado de novo.
  if (record.plano && record.planoSeguido) return null;
  if (record.plano && record.planoResultado === 'falhou') {
    record.planoSeguido = 'continuou';
    await saveHistory();
    const r = await continuarPlano(record.plano, record.plano.atual, record.planoFalha, 'geckoai');
    if (r === false) {
      delete record.planoSeguido;
      await saveHistory();
    }
    return r;
  }
  const anexos = anexosDoRegistro.get(record) || {};
  // Ajuste pelo chat no meio de um plano (parte já concluída): o mesmo pedido,
  // com o plano junto — sem ele o cartão das próximas partes sumia.
  let plano = null;
  if (record.plano) {
    plano = {
      ...record.plano,
      partes: record.plano.partes.map((p) => ({ ...p })),
      ajuste: true,
      resultadoAnterior: record.planoResultado || null,
    };
    record.planoSeguido = 'ajuste';
    await saveHistory();
  }
  const r = await runAndRender({
    userText: record.pedido?.userText || '',
    promptForAI: record.pedido?.promptForAI || record.pedido?.userText || '',
    attach: null,
    images: anexos.images || null,
    projectFiles: anexos.projectFiles || [],
    mode: record.pedido?.mode || 'build',
    mostrarPedido: false,
    fonte: 'geckoai',
    ...(plano ? { plano } : {}),
  });
  // Nem começou (trava de outra janela, token do banco morto): o cartão do
  // plano volta a ter os botões.
  if (r === false && plano) {
    delete record.planoSeguido;
    await saveHistory();
  }
  return r;
}

// Cartão de erro cujo envio já seguiu por outro botão (o do plano): vira texto.
const JA_SEGUIU = 'Esta parte já seguiu pelo cartão do plano.';

// O ChatGPT recusou o envio antes de haver trabalho a guardar.
function buildErroChatGPTCard(record) {
  const { codigo, limite } = record.erroChatGPT || {};
  const card = el('div', 'migration-card');
  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', '⏸️'));
  const volta = codigo === 'limite' ? quandoVoltaTexto(limite) : '';
  head.append(el('span', null, codigo === 'limite'
    ? `O limite do seu ChatGPT acabou${volta ? ` — ${volta}` : ''}`
    : record.error));
  card.append(head);
  if (codigo === 'limite') card.append(el('div', 'mig-hint', record.error));
  if (record.erroChatGPTFeito || (record.plano && record.planoSeguido)) {
    card.append(el('div', 'commit-undone', record.erroChatGPTFeito || JA_SEGUIU));
    return card;
  }

  const acoes = el('div', 'mig-actions');
  const pelosPrompts = el('button', 'mig-go', `Usar prompts ${nomeDaMarca()} neste envio (usa 1 prompt)`);
  pelosPrompts.type = 'button';
  pelosPrompts.addEventListener('click', async () => {
    if (record.plano && record.planoSeguido) { card.replaceWith(buildErroChatGPTCard(record)); return; }
    if (!podeEnviarAgora()) return;
    record.erroChatGPTFeito = `Enviado de novo pelos prompts ${nomeDaMarca()}.`;
    await saveHistory();
    acoes.remove();
    card.append(el('div', 'commit-undone', record.erroChatGPTFeito));
    if ((await refazerPelosPrompts(record)) === false) {
      delete record.erroChatGPTFeito;
      await saveHistory();
      card.replaceWith(buildErroChatGPTCard(record));
    }
  });
  acoes.append(pelosPrompts);
  if (codigo === 'acesso') {
    const reconectar = el('button', 'mig-cancel', 'Conectar de novo');
    reconectar.type = 'button';
    reconectar.addEventListener('click', () => abrirConfiguracoes());
    acoes.append(reconectar);
  }
  card.append(acoes);
  return card;
}

// O servidor recusou o modelo premium (cota de hoje acabou, chave sem cota,
// desligado) antes de a IA começar — o prompt já foi devolvido. O botão manda
// o MESMO pedido pelo modelo padrão do dono.
function buildErroPremiumCard(record) {
  const card = el('div', 'migration-card');
  const head = el('div', 'mig-head');
  head.append(el('span', 'mig-ico', '⏸️'));
  head.append(el('span', null, record.error));
  card.append(head);
  if (record.erroPremiumFeito || (record.plano && record.planoSeguido)) {
    card.append(el('div', 'commit-undone', record.erroPremiumFeito || JA_SEGUIU));
    return card;
  }
  const pedido = record.pedido?.userText || record.pedido?.promptForAI;
  if (!pedido) return card;

  const acoes = el('div', 'mig-actions');
  const custo = custoDoProximoEnvio();
  const cat = catalogo();
  const padrao = cat?.opcoes.find((o) => o.id === cat.padrao);
  const destino = padrao ? padrao.nome : `prompts ${nomeDaMarca()}`;
  const pelosPrompts = el('button', 'mig-go', custo
    ? `Enviar pelo ${destino} (${custo})`
    : `Enviar pelo ${destino}`);
  pelosPrompts.type = 'button';
  pelosPrompts.addEventListener('click', async () => {
    if (record.plano && record.planoSeguido) { card.replaceWith(buildErroPremiumCard(record)); return; }
    if (!podeEnviarAgora()) return;
    // O padrão do dono, mesmo que o seletor tenha mudado desde a recusa.
    state.settings.modeloCliente = null;
    await storage.set({ settings: state.settings });
    record.erroPremiumFeito = `Enviado de novo pelo ${destino}.`;
    await saveHistory();
    acoes.remove();
    card.append(el('div', 'commit-undone', record.erroPremiumFeito));
    if ((await refazerPelosPrompts(record)) === false) {
      delete record.erroPremiumFeito;
      await saveHistory();
      card.replaceWith(buildErroPremiumCard(record));
    }
  });
  acoes.append(pelosPrompts);
  card.append(acoes);
  return card;
}

// ---------- Modos Plan / Build ----------

function currentMode() {
  return state.settings?.mode === 'plan' ? 'plan' : 'build';
}

function applyModeUI() {
  const mode = currentMode();
  document.querySelectorAll('.mode-btn').forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
  promptInput.placeholder =
    mode === 'plan'
      ? 'Pergunte ou peça um plano — neste modo nada é alterado…'
      : 'Descreva a mudança no seu projeto…';
  if (MODO_NATIVO) {
    // Chat nativo: o campo com a cara do da Lovable — a pílula do modo
    // ("Construir"/"Planejar") e o enviar redondo com a seta.
    document.querySelectorAll('.mode-btn').forEach((b) => {
      const texto = b.lastChild;
      if (texto?.nodeType === Node.TEXT_NODE) texto.textContent = b.dataset.mode === 'plan' ? ' Planejar' : ' Construir';
    });
  }
  pintarBotaoEnviar();
  document.querySelector('.composer')?.classList.toggle('mode-plan', mode === 'plan');
}

function pintarBotaoEnviar() {
  const enviar = $('#btn-send');
  if (!enviar) return;
  // Sem botão "Pôr na fila" (decisão do dono): a fila se forma sozinha quando
  // o usuário manda outro pedido com um rodando. No PC o Enter já faz isso, e
  // com o Cancelar ao lado o botão não cabia na linha — some durante o pedido.
  // No toque o Enter quebra linha (o botão é o único envio) e no chat nativo
  // ele é só a seta: nesses dois ele fica, com a cara de sempre.
  const rotulo = currentMode() === 'plan' ? 'Planejar' : 'Enviar';
  const naFila = state.running ? `Entra na fila (até ${MAX_FILA}) e começa quando o pedido atual terminar` : '';
  enviar.hidden = state.running && !MODO_NATIVO && ENTER_ENVIA;
  if (MODO_NATIVO) {
    if (!enviar.querySelector('svg')) enviar.replaceChildren(setaDeEnviar());
    enviar.setAttribute('aria-label', rotulo);
    enviar.title = naFila || (currentMode() === 'plan' ? 'Planejar (nada é alterado)' : 'Enviar');
  } else {
    enviar.textContent = rotulo;
    enviar.title = naFila;
  }
}

function setaDeEnviar() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M12 19V5m-6 6 6-6 6 6');
  svg.append(p);
  return svg;
}

document.querySelectorAll('.mode-btn').forEach((btn) =>
  btn.addEventListener('click', async () => {
    // Com um pedido rodando também: ele já tem o modo dele, e o que se manda
    // agora (a fila) usa o novo — antes, um "pode implementar" posto na fila
    // depois de um Planejar rodava em Plan, pago, sem mudar nada.
    if (!state.settings) return;
    let modo = btn.dataset.mode;
    // Chat nativo: só a pílula do modo atual aparece; clicar nela alterna.
    if (MODO_NATIVO && modo === currentMode()) modo = modo === 'plan' ? 'build' : 'plan';
    state.settings.mode = modo;
    await storage.set({ settings: state.settings });
    applyModeUI();
  })
);

// ---------- Validade da licença ----------
// Mostra até quando o acesso vale, conforme a data de vencimento da chave.

function formatDatePt(iso) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  } catch {
    return '';
  }
}

// { tone: 'ok'|'warn'|'bad', text, detail } — ou null se ainda não ativado.
function licenseStatus() {
  if (!state.settings?.keys?.geckoai) return null;
  return { tone: 'ok', text: 'Uso pessoal · API própria', detail: 'Sem licença do GeckoAI. Uso, disponibilidade e cobrança dependem da sua conta do provedor de IA.' };
}

// ---------- Aviso de atualização ----------
//
// A extensão vai descompactada para o cliente: o Chrome não atualiza sozinha,
// e quem ficou para trás só descobria quando algo quebrava. O servidor diz a
// versão publicada e a mínima na mesma resposta que já valida a chave. Quem
// está abaixo da mínima NÃO envia: é o que faz de fato atualizar. Ver
// lib/versao.js — dado ruim lá nunca trava ninguém.

// "Agora não" vale até fechar o painel: na próxima abertura a faixa volta.
// Guardar no storage faria o aviso sumir para sempre justo em quem ignora.
let avisoDeVersaoDispensado = false;

function aplicarVersaoDoServidor(doServidor) {
  const antes = JSON.stringify(state.atualizacao);
  state.atualizacao = estadoDaAtualizacao(chrome.runtime.getManifest().version, doServidor);
  if (JSON.stringify(state.atualizacao) !== antes) avisoDeVersaoDispensado = false;
  renderUpdateBar();
  updateComposerLock();
}

function atualizacaoObrigatoria() {
  return Boolean(state.atualizacao?.obrigatoria);
}

function renderUpdateBar() {
  const bar = $('#update-bar');
  if (!bar) return;
  const a = state.atualizacao;
  bar.replaceChildren();
  bar.hidden = !a || (avisoDeVersaoDispensado && !a.obrigatoria);
  if (bar.hidden) return;

  bar.className = `update-bar${a.obrigatoria ? ' obrigatoria' : ''}`;
  bar.append(
    el('span', 'upd-text', `Versão ${a.versao} disponível. Baixe a nova versão da extensão para continuar usando.`)
  );

  // <a href> não navega no painel lateral: abre aba pelo chrome.tabs.
  const link = el('a', 'upd-link', 'Baixar');
  link.href = a.url;
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.tabs.create({ url: a.url, active: true });
  });
  bar.append(link);

  if (!a.obrigatoria) {
    const depois = el('button', 'upd-later', 'Agora não');
    depois.type = 'button';
    depois.addEventListener('click', () => {
      avisoDeVersaoDispensado = true;
      renderUpdateBar();
    });
    bar.append(depois);
  }
}

function updateLicenseUI() {
  const st = comLimiteDoChatGPT(licenseStatus());
  const bar = $('#license-bar');
  if (bar) {
    bar.hidden = !st;
    if (st) {
      bar.className = `license-bar ${st.tone}`;
      bar.title = st.detail;
      $('#license-text').textContent = st.text;
    }
    // Contador do premium de hoje, à direita (só com cota na chave).
    // Laranja quando a cota do dia acabou.
    const seloPremium = $('#license-premium');
    if (seloPremium) {
      const p = st ? opcaoComCota() : null;
      seloPremium.hidden = !p;
      if (p) {
        const restam = restanteDaCota(p);
        seloPremium.textContent = `${p.nome} ${p.cota.usados}/${p.cota.porDia}`;
        seloPremium.classList.toggle('quase', restam <= 0);
        seloPremium.title = restam > 0
          ? `${p.nome}: ${p.cota.usados} de ${p.cota.porDia} prompts usados hoje. Escolha na barra de envio quando quiser usar. Zera à meia-noite.`
          : `${p.nome}: os ${p.cota.porDia} prompts de hoje acabaram. Voltam à meia-noite.`;
      }
    }
    // Selo do ChatGPT à parte, à direita (só no modo ChatGPT).
    const selo = $('#license-chatgpt');
    if (selo) {
      selo.hidden = !st?.chatgpt;
      if (st?.chatgpt) {
        selo.textContent = st.chatgpt.texto;
        selo.classList.toggle('quase', st.chatgpt.quase);
      }
    }
  }
  const box = $('#settings-license');
  if (box) {
    box.hidden = !st;
    if (st) {
      box.className = `license-status ${st.tone}`;
      box.textContent = st.detail;
    }
  }
  // Chat nativo: a barra da licença não aparece — a situação vai no menu do
  // gecko ("Ativo até 26/10/2026 · Ilimitado").
  avisarAbaNativa({ tipo: 'nativo:status', texto: st?.text || '' });
}

// Revalida a chave em segundo plano para atualizar a validade (o admin pode
// ter mudado o vencimento). Falhas duras são tratadas no envio do prompt.
async function refreshLicenseInfo() {
  const key = state.settings?.keys?.geckoai;
  if (!key) return;
  try {
    await aplicarLicencaValidada(await getProvider('geckoai').validate(key));
  } catch {
    /* mantém o valor guardado */
  }
  updateLicenseUI();
}

// Com o ChatGPT CONECTADO, a barra mostra quanto do limite da assinatura já
// foi usado — em qualquer fonte escolhida no seletor (pedido do dono: conectou,
// aparece; desconectou ou nunca conectou, some, igual aos seletores). O uso
// vai num selo à parte (`chatgpt`), não colado no texto da chave: "71 prompts
// · ChatGPT 3%" parecia uma coisa só. A cor da barra continua sendo a da
// chave; o laranja de "quase no limite" (80% da janela de 5 h) fica no selo.
function comLimiteDoChatGPT(st) {
  if (!st || !chatgptConectado()) return st;
  const limite = state.chatgpt?.limite;
  const quase = (limite?.janela5h ?? 0) >= 80;
  const volta = quase ? quandoVoltaTexto(limite) : '';
  const fonte = fonteAtual() === 'chatgpt'
    ? ' Os pedidos estão indo pelo seu ChatGPT e não descontam prompts.'
    : ' Seu ChatGPT está conectado: escolha um modelo dele na barra de envio para os pedidos não descontarem prompts.';
  return {
    ...st,
    chatgpt: { texto: ChatGPT.textoDoLimite(limite) || 'ChatGPT', quase },
    detail: `${st.detail}${fonte}` +
      (limite?.janela5h != null ? ` Você usou ${Math.round(limite.janela5h)}% do limite de 5 horas da sua assinatura${volta ? ` (${volta})` : ''}.` : ''),
  };
}

// Lê o uso da assinatura sem chamar a IA (lib/chatgpt.js: buscarUso) — ao
// conectar e ao abrir o painel. Falhou, o selo espera o primeiro pedido.
async function atualizarUsoChatGPT() {
  if (!chatgptConectado()) return;
  try {
    const { access, conta } = await acessoChatGPT();
    const limite = await ChatGPT.buscarUso({ access, conta });
    if (!limite || !state.chatgpt) return;
    state.chatgpt.limite = { ...limite, lidoEm: Date.now() };
    await salvarChatGPT();
    updateLicenseUI();
  } catch {
    /* informação de fundo: sem ela o selo mostra só "ChatGPT" */
  }
}

// ---------- Composer ----------

const promptInput = $('#prompt-input');

promptInput.addEventListener('input', autoResize);
function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
}

promptInput.addEventListener('keydown', (e) => {
  if (ENTER_ENVIA && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (isSendBlocked()) return; // projeto sem GitHub, ou com banco não suportado
    sendPrompt();
  }
});

$('#btn-send').addEventListener('click', sendPrompt);

// ---------- Ditado por voz ----------
// Quem transcreve é o próprio navegador (lib/voz.js): não passa pelo nosso
// servidor e NÃO consome prompt da licença. O ditado só escreve no campo — o
// envio continua sendo um clique do usuário, de propósito.

const btnMic = $('#btn-mic');
const PLACEHOLDER_PROMPT = promptInput.getAttribute('placeholder');
const TITULO_MIC = btnMic.getAttribute('title');
let ditado = null;
let textoAntesDoDitado = '';

// Chat nativo: o quadro só tem microfone se a página da Lovable deixar
// (Permissions-Policy) e o `allow` do quadro valer. Sem isso o Chrome nega
// com o MESMO erro do microfone bloqueado pelo usuário, e o aviso "libere o
// microfone" não teria saída — melhor não mostrar o botão.
const micPermitidoAqui = () => !MODO_NATIVO || document.featurePolicy?.allowsFeature?.('microphone') !== false;

let vozLocal = false;
if (vozDisponivel() && micPermitidoAqui()) {
  btnMic.hidden = false;
  // Se o Chrome já tem o modelo de pt-BR na máquina, o áudio nem sai daqui.
  ditadoLocalDisponivel().then((ok) => (vozLocal = ok));
}

function pintarMic(gravando) {
  btnMic.classList.toggle('gravando', gravando);
  btnMic.setAttribute('aria-pressed', gravando ? 'true' : 'false');
  btnMic.title = gravando ? 'Parar de ditar' : TITULO_MIC;
  // Chat nativo: a coluna é estreita e o texto longo quebrava em duas linhas
  // (com barra de rolagem); o botão vermelho pulsando já diz como parar.
  promptInput.placeholder = gravando
    ? (MODO_NATIVO ? 'Ouvindo…' : 'Ouvindo… clique no microfone para parar')
    : PLACEHOLDER_PROMPT;
}

// O que já estava escrito fica; a fala entra depois.
function escreverDitado(texto) {
  promptInput.value =
    textoAntesDoDitado && texto ? `${textoAntesDoDitado} ${texto}` : textoAntesDoDitado + texto;
  autoResize();
}

// Campo do prompt vazio de verdade: o ditado é DESCARTADO (abort, sem
// entregar trecho atrasado) antes de limpar. Com parar(), o navegador mandava
// o último trecho depois do envio e escreverDitado regravava o pedido inteiro
// no campo. Usado depois de enviar e depois de desfazer.
function limparCampoDoPrompt() {
  if (ditado?.gravando) ditado.descartar();
  textoAntesDoDitado = '';
  promptInput.value = '';
  autoResize();
}

// O painel lateral nem sempre consegue mostrar o pedido de microfone do
// Chrome. Numa aba comum ele aparece, e a permissão vale para a extensão
// inteira (mesma origem) — acontece uma vez por instalação.
let pedindoPermissao = false;
async function abrirPermissaoDeMicrofone() {
  if (pedindoPermissao) return;
  pedindoPermissao = true;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/microfone.html'), active: true });
  } catch {
    /* aba recusada: a mensagem do toast já explica o que houve */
  }
  setTimeout(() => (pedindoPermissao = false), 3000);
}

btnMic.addEventListener('click', () => {
  if (ditado?.gravando) {
    ditado.parar();
    return;
  }
  textoAntesDoDitado = promptInput.value.trim();
  try {
    ditado = criarDitado({
      local: vozLocal,
      onTexto: escreverDitado,
      onFim: () => {
        pintarMic(false);
        promptInput.focus();
      },
      onErro: (e) => {
        // Chat nativo: dentro da página da Lovable a autorização do
        // microfone é DA LOVABLE (o Chrome pergunta por lovable.dev), não da
        // extensão — a aba de permissão da extensão não resolveria. Provado
        // no Chromium: só a autorização da página libera o quadro.
        if (e.precisaPermissao && MODO_NATIVO) {
          if (!micPermitidoAqui()) {
            btnMic.hidden = true;
            toast(`O ditado não funciona dentro da Lovable agora. Use pelo painel do ${MARCA.nome}.`, 6000);
            return;
          }
          // Liberar vale na hora: recarregar a página interromperia um pedido
          // rodando e esvaziaria a fila.
          toast('O microfone está bloqueado para a Lovable. Clique no ícone à esquerda do endereço do site, libere o Microfone e clique aqui de novo (não precisa recarregar a página).', 9000);
          return;
        }
        toast(e.mensagem);
        if (e.precisaPermissao) abrirPermissaoDeMicrofone();
      },
    });
    ditado.iniciar();
    pintarMic(true);
  } catch {
    toast('Este navegador não reconhece voz.');
    btnMic.hidden = true;
  }
});

$('#btn-cancel').addEventListener('click', () => {
  state.abort?.abort();
});

$('#btn-clear-chat').addEventListener('click', async () => {
  if (state.running) return;
  // Pedido vivo na outra janela (chat nativo ou painel): limpar agora faria o
  // resultado dele nunca ser gravado (ele nasceu antes da marca de limpeza).
  if (!(await travaLivre())) {
    toast(AVISO_TRAVA());
    return;
  }
  if (!confirm('Limpar a conversa deste projeto?')) return;
  // Com a trava do projeto: um pedido que começasse durante a pergunta
  // nasceria antes da marca de limpeza, e o resultado dele sumiria.
  const limpou = await comTravaDoProjeto(async () => {
    state.history = [];
    clearAttachments();
    // A marca de limpeza vale também para a outra janela (chat nativo): o
    // que ela tiver na memória de antes daqui não volta na próxima gravação.
    const chave = historyKey();
    const limpeza = chaveDeLimpeza(state.project.fullName);
    await naFilaDoHistorico(async () => {
      fotografarHistorico([]);
      ultimoHistoricoGravado = '[]';
      await storage.set({ [chave]: [], [limpeza]: Date.now() });
    });
    return true;
  });
  if (limpou) renderHistory();
});

// ---------- Anexos (imagens e arquivos de texto) ----------

const MAX_IMAGES = 6;
const MAX_TEXT_FILES = 4;
const IMG_MAX_SIDE = 1024; // menor = menos tokens
const IMG_QUALITY = 0.82;
const MAX_TEXT_CHARS = 40_000;  // ~10k tokens por anexo (corta o excedente, não recusa)
// Anexo que vai PARA O PROJETO (foto, PDF, vídeo, fonte, zip…): os bytes vão
// direto para o commit, nunca para a IA — ela recebe uma linha por arquivo.
// O teto é por arquivo e por envio; acima disso o GitHub e o Lovable sofrem.
const MAX_PROJECT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_FILES = 6;
const MAX_PROMPT_CHARS = 20_000; // texto digitado/colado no campo (~5k tokens)
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'js', 'jsx', 'ts', 'tsx',
  'html', 'htm', 'css', 'scss', 'sql', 'yml', 'yaml', 'xml', 'svg', 'py',
  'sh', 'toml', 'ini', 'vue', 'astro', 'php', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'cs',
]);

// Arquivo de ambiente não vira anexo: o conteúdo iria INTEIRO para a IA, e é
// onde mora a chave de API, a senha do banco e o service role do próprio
// usuário. Ele quase nunca precisa mandar isso — quando precisa (mostrar quais
// variáveis existem), colar os NOMES no prompt resolve sem entregar os valores.
// A checagem é por nome de arquivo porque 'env' saiu do TEXT_EXT, mas um ".env"
// que o navegador rotule como text/plain entraria pela outra porta.
//
// Exige o ponto na frente (.env, .env.local, .env.production) ou um sufixo de
// ambiente conhecido. "env.ts", "env.js" e "environment.js" são CÓDIGO — em
// projeto TypeScript, "src/env.ts" (tipagem das variáveis) é rotina, e recusar
// ele quebraria um anexo legítimo para proteger um arquivo que não tem segredo.
const NOME_DE_AMBIENTE =
  /^\.env(\..+)?$|^env$|^env\.(local|development|production|test|staging|example|sample)(\..+)?$/i;

let attachSeq = 0;
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const isImageFile = (f) => /^image\//i.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name);
const countKind = (kind) => state.attachments.filter((a) => a.kind === kind).length;

async function addFiles(files) {
  for (const file of files) {
    if (NOME_DE_AMBIENTE.test(file.name || '')) {
      toast(`${file.name} é arquivo de ambiente — não mando ele para a IA.`);
      continue;
    }
    if (file.size > MAX_PROJECT_FILE_BYTES) {
      toast(`${file.name} é muito grande (máximo ${Math.round(MAX_PROJECT_FILE_BYTES / 1024 / 1024)} MB).`);
      continue;
    }
    if (state.attachments.length >= MAX_PROJECT_FILES) {
      toast(`Máximo de ${MAX_PROJECT_FILES} arquivos por envio.`);
      break;
    }
    // Todo anexo guarda os bytes originais: é o que vai para o projeto quando
    // o pedido é "coloque/substitua este arquivo". Imagem e texto seguem
    // TAMBÉM para a IA olhar, como antes; o resto é só projeto.
    let base64 = '';
    try { base64 = await bytesParaBase64(file); } catch { toast(`Não consegui ler ${file.name}.`); continue; }
    const comum = { id: ++attachSeq, name: file.name || 'arquivo', size: file.size, mediaType: file.type || '', base64 };

    if (isImageFile(file)) {
      if (countKind('image') >= MAX_IMAGES) { toast(`Máximo de ${MAX_IMAGES} imagens.`); continue; }
      try {
        const img = await downscaleImage(file);
        state.attachments.push({ ...comum, kind: 'image', ...img });
      } catch {
        toast('Não consegui ler essa imagem.');
      }
    } else if (TEXT_EXT.has(extOf(file.name)) || /^text\//i.test(file.type)) {
      if (countKind('text') >= MAX_TEXT_FILES) { toast(`Máximo de ${MAX_TEXT_FILES} arquivos de texto.`); continue; }
      let content = '';
      try { content = await file.text(); } catch { toast(`Não consegui ler ${file.name}.`); continue; }
      const truncated = content.length > MAX_TEXT_CHARS;
      state.attachments.push({
        ...comum, kind: 'text',
        content: truncated ? content.slice(0, MAX_TEXT_CHARS) : content, truncated,
      });
    } else {
      state.attachments.push({ ...comum, kind: 'file' });
    }
  }
  renderAttachments();
}

// Bytes -> base64 sem estourar a pilha (String.fromCharCode em lote).
async function bytesParaBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const LOTE = 0x8000;
  for (let i = 0; i < bytes.length; i += LOTE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + LOTE));
  }
  return btoa(bin);
}

function tamanhoCurto(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Encolhe a imagem no navegador (menos tokens) → base64 JPEG.
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMG_MAX_SIDE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG não tem transparência
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', IMG_QUALITY);
      resolve({ mediaType: 'image/jpeg', dataBase64: dataUrl.split(',')[1] || '', thumbUrl: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    img.src = url;
  });
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function renderAttachments() {
  const box = $('#attachments');
  if (!box) return;
  box.replaceChildren();
  box.hidden = state.attachments.length === 0;
  for (const a of state.attachments) {
    const chip = el('div', `attach-chip ${a.kind}`);
    if (a.kind === 'image') {
      const img = el('img', 'attach-thumb');
      img.src = a.thumbUrl;
      img.alt = a.name;
      chip.append(img);
      chip.append(el('span', 'attach-name', 'imagem'));
    } else if (a.kind === 'file') {
      chip.append(el('span', 'attach-ico', '📎'));
      chip.append(el('span', 'attach-name', `${a.name} · ${tamanhoCurto(a.size)}`));
      chip.title = 'Vai para o projeto — diga no pedido onde colocar ou o que substituir';
    } else {
      chip.append(el('span', 'attach-ico', '📄'));
      chip.append(el('span', 'attach-name', a.name));
    }
    const rm = el('button', 'attach-rm');
    rm.type = 'button';
    rm.setAttribute('aria-label', `Remover ${a.name}`);
    rm.textContent = '×';
    rm.addEventListener('click', () => removeAttachment(a.id));
    chip.append(rm);
    box.append(chip);
  }
}

// Botão, seletor de arquivo, colar (Ctrl+V) e arrastar-e-soltar.
$('#btn-attach').addEventListener('click', () => {
  if (isSendBlocked()) { toast('Conecte o projeto antes de anexar.'); return; }
  $('#file-input').click(); // qualquer tipo: imagem/texto vão para a IA e para o projeto; o resto só para o projeto
});
$('#file-input').addEventListener('change', async (e) => {
  await addFiles([...e.target.files]);
  e.target.value = '';
});
promptInput.addEventListener('paste', async (e) => {
  const imgs = [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file' && /^image\//i.test(it.type))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!imgs.length) return;
  e.preventDefault();
  if (isSendBlocked()) { toast('Conecte o projeto antes de anexar.'); return; }
  await addFiles(imgs);
});
{
  const chatView = $('#view-chat');
  chatView.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    chatView.classList.add('dragging');
  });
  chatView.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && chatView.contains(e.relatedTarget)) return;
    chatView.classList.remove('dragging');
  });
  chatView.addEventListener('drop', async (e) => {
    chatView.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (isSendBlocked()) { toast('Conecte o projeto antes de anexar.'); return; }
    await addFiles(files);
  });
}

// Contexto das últimas execuções, para pedidos de continuação
// ("agora deixe o botão maior").
function buildRecentHistory() {
  const runs = [];
  for (let i = state.history.length - 1; i >= 0 && runs.length < 3; i--) {
    const r = state.history[i];
    if (r.kind !== 'run' || (!r.summary && !r.commit && !r.pendingMigration)) continue;
    const prompt = state.history[i - 1]?.kind === 'user' ? state.history[i - 1].text : '';
    const isPlan = r.mode === 'plan';
    const pend = r.pendingMigration && !r.pendingMigration.applied ? r.pendingMigration : null;
    runs.unshift(
      [
        `- Pedido${isPlan ? ' (modo Plan — nada foi alterado)' : ''}: ${JSON.stringify(prompt.slice(0, 200))}`,
        // Instalar/remover skill mexe em dezenas de arquivos que não são código
        // do projeto: uma linha basta, sem a lista.
        r.commit
          ? `  Arquivos alterados: ${r.skill ? `.agents/skills/${r.skill}/ (skill, not project code)` : r.commit.files.join(', ')}`
          : null,
        r.summary
          ? `  ${isPlan ? 'Plano proposto' : 'Resultado'}: ${r.summary.slice(0, isPlan ? 1200 : 300)}`
          : null,
        pend
          ? `  SQL de migração proposto (aguardando o usuário aplicar no Lovable):\n${pend.sql.slice(0, 1500)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return runs.join('\n');
}

// ---------- Histórico com duas janelas (1.11.0) ----------
// O painel e o chat nativo (dentro da Lovable) guardam a MESMA conversa.
// Antes cada janela gravava a lista inteira que tinha na memória, e a última
// apagava o que a outra tinha escrito. Agora a gravação mescla por `id`
// (lib/rodadas.js): vale a versão desta janela só no que ela criou ou mudou
// desde a última leitura/gravação (a "foto"); o resto fica como está no
// storage. As gravações vão em fila, na ordem em que foram pedidas.
let fotoDoHistorico = new Map(); // id -> JSON do que esta janela leu ou gravou
// Ids que esta janela já viu no storage ou gravou. Sumiram de lá = saíram
// (limite de 40, "Limpar conversa"), não são novos: sem isto voltavam no FIM
// da conversa, e um pedido de 20 prompts atrás "continuava" (revisão da 1.11).
let idsGravados = new Set();
let filaDoHistorico = Promise.resolve();
let ultimoHistoricoGravado = '';
const novoIdDeRegistro = () => crypto.randomUUID();
const chaveDeLimpeza = (full) => `chatLimpo:${full}`;

function fotografarHistorico(lista) {
  fotoDoHistorico = new Map((lista || []).filter((r) => r?.id).map((r) => [r.id, JSON.stringify(r)]));
}

// Gravar e reler vão na MESMA fila: uma releitura nunca lê o storage de
// antes de uma gravação desta janela (senão tirava da tela o registro novo).
function naFilaDoHistorico(trabalho) {
  filaDoHistorico = filaDoHistorico.then(trabalho).catch((e) => console.error('[GeckoAI] histórico:', e));
  return filaDoHistorico;
}

function saveHistory() {
  if (!state.project) return Promise.resolve();
  const chave = historyKey();
  const limpeza = chaveDeLimpeza(state.project.fullName);
  const lista = state.history;
  // Id já na hora do pedido (síncrono): um recarregamento que entre antes da
  // gravação reconhece o registro novo como desta janela.
  garantirIds(lista, novoIdDeRegistro, Date.now());
  return naFilaDoHistorico(async () => {
    if (state.desconectado) return; // "Desconectar e apagar tudo" na outra janela
    garantirIds(lista, novoIdDeRegistro, Date.now());
    const guardado = await storage.get([chave, limpeza]);
    for (const g of guardado[chave] || []) if (g?.id) idsGravados.add(g.id);
    const tocados = new Set(
      lista.filter((r) => r?.id && fotoDoHistorico.get(r.id) !== JSON.stringify(r)).map((r) => r.id)
    );
    const mesclado = mesclarHistorico(guardado[chave] || [], lista, {
      tocados, limpoEm: Number(guardado[limpeza]) || 0, persistidos: idsGravados,
    });
    // A foto é do que vai AGORA para o storage: mudança feita durante a
    // gravação continua "tocada" e vai na próxima.
    const texto = JSON.stringify(mesclado);
    // O que esta janela NÃO mudou vira, na memória, o que foi gravado (a
    // versão da outra janela): senão a próxima gravação o via como "mudado
    // aqui" e desfazia a outra (segunda revisão da 1.11).
    alinharAoGravado(lista, JSON.parse(texto), tocados);
    fotografarHistorico(JSON.parse(texto));
    ultimoHistoricoGravado = texto;
    await storage.set({ [chave]: JSON.parse(texto) });
    const noStorage = new Set(mesclado.map((r) => r.id));
    for (const id of noStorage) idsGravados.add(id);
    // O que saiu do storage (limite de 40) sai da memória também — senão a
    // lógica do painel (trabalho aberto, plano em andamento) ainda o via.
    for (let i = lista.length - 1; i >= 0; i--) {
      const r = lista[i];
      if (r?.id && idsGravados.has(r.id) && !noStorage.has(r.id)) lista.splice(i, 1);
    }
    // A outra janela tinha registros que esta não mostra: com nada rodando
    // aqui, a conversa na tela passa a ter os dois.
    const daqui = new Set(lista.map((r) => r?.id));
    if (!state.running && historyKey() === chave && mesclado.some((r) => !daqui.has(r.id))) {
      recarregarHistorico();
    }
  });
}

// Relê o histórico do storage (a outra janela escreveu). Mantém o MESMO
// objeto para cada registro que esta janela já tinha: botões e anexos em
// memória apontam para ele.
function recarregarHistorico() {
  return naFilaDoHistorico(async () => {
    if (!state.project || state.running || state.enviando) return;
    // Esta janela está no meio de um Autorizar/Enviar agora: redesenhar agora
    // trocaria o cartão em uso por um novo, habilitado — e o mesmo SQL podia
    // ser aplicado duas vezes. Relê no fim (o próximo aviso do storage).
    if (travasDestaJanela.has(nomeDaTrava(state.project.fullName))) return;
    const chave = historyKey();
    const guardado = (await storage.get([chave]))[chave] || [];
    if (state.running || state.enviando || historyKey() !== chave) return;
    // lib/rodadas.js: mesmo objeto para o que esta janela já tinha; o que ela
    // mudou e ainda não gravou, e o registro novo que ainda não chegou ao
    // storage, ficam; o que já foi gravado e sumiu, sai.
    state.history = integrarHistorico(state.history, guardado, fotoDoHistorico, idsGravados);
    for (const g of guardado) if (g?.id) idsGravados.add(g.id);
    // A foto é do STORAGE: o que só esta janela mudou continua "tocado".
    fotografarHistorico(guardado);
    renderHistory();
  });
}

// A outra janela (chat nativo ↔ painel) mudou a conversa deste projeto.
chrome.storage.onChanged.addListener((mudou, area) => {
  if (area !== 'local' || !state.project || state.running) return;
  const chave = historyKey();
  const limpeza = chaveDeLimpeza(state.project.fullName);
  if (!mudou[chave] && !mudou[limpeza]) return;
  if (mudou[chave] && !mudou[limpeza] && JSON.stringify(mudou[chave].newValue ?? []) === ultimoHistoricoGravado) return;
  recarregarHistorico();
});

let esperandoTravaDe = null;
function esperarTravaParaRecuperar() {
  const full = state.project?.fullName;
  if (!full || !navigator.locks?.request || esperandoTravaDe === full) return;
  esperandoTravaDe = full;
  // Pedido comum (não ifAvailable): o navegador entrega quando quem segura
  // terminar ou morrer. A recuperação roda COM a trava, para nenhum pedido
  // novo começar no meio dela e ser confundido com o interrompido.
  navigator.locks.request(nomeDaTrava(full), async () => {
    esperandoTravaDe = null;
    if (state.project?.fullName !== full || state.running) return;
    await recarregarHistorico();
    if (state.project?.fullName !== full) return;
    if (recuperarInterrompidos(state.history)) {
      await saveHistory();
      renderHistory();
    }
  }).catch(() => { esperandoTravaDe = null; });
}

// ---------- Um pedido por vez em cada projeto (1.11.0) ----------
// Painel e chat nativo podem estar abertos no mesmo projeto: dois pedidos ao
// mesmo tempo commitariam um por cima do outro. A trava é do navegador
// (Web Locks, compartilhada entre as páginas da extensão — provado em
// 2026-09-30) e cai sozinha se a janela que a segura morrer.
const nomeDaTrava = (full) => `rodando:${full}`;

async function travaLivre(full = state.project?.fullName) {
  if (!full || !navigator.locks?.query) return true;
  try {
    const { held = [] } = await navigator.locks.query();
    return !held.some((t) => t.name === nomeDaTrava(full));
  } catch {
    return true;
  }
}

const AVISO_TRAVA = () =>
  `Um pedido deste projeto está rodando em outra janela do ${MARCA.nome} (painel ou chat da Lovable). Espere ele terminar.`;

// Roda `fn` com a trava do projeto. Ocupada (depois de 3 tentativas, para
// cobrir a troca entre um run e a próxima parte automática): avisa e devolve
// false — o mesmo "nem começou" que os botões já tratam. `lancar`: para os
// envios sem IA, que mostram o erro no próprio cartão.
// `jaPega`: quem chama JÁ segura a trava (o envio a pega antes de mexer no
// campo e chama o run lá dentro). É explícito, de propósito: com "esta janela
// já tem a trava, pode entrar", qualquer outro começo da mesma janela (a
// próxima parte automática, um botão) entrava junto — dois pedidos pagos ao
// mesmo tempo, do mesmo ponto de partida (revisão da fila, 1.11).
// `travasDestaJanela` só diz se ESTA janela está começando/rodando algo: é o
// que manda o Enter para a fila e escolhe o aviso certo.
const travasDestaJanela = new Set();

async function comTravaDoProjeto(fn, { lancar = false, jaPega = false } = {}) {
  const full = state.project?.fullName;
  if (!full || !navigator.locks?.request || jaPega) return fn();
  const nome = nomeDaTrava(full);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa) await new Promise((r) => setTimeout(r, 500));
    let rodou = false;
    let resultado;
    await navigator.locks.request(nome, { ifAvailable: true }, async (trava) => {
      if (!trava) return;
      rodou = true;
      travasDestaJanela.add(nome);
      try {
        resultado = await fn();
      } finally {
        travasDestaJanela.delete(nome);
      }
    });
    if (rodou) return resultado;
  }
  const aviso = travasDestaJanela.has(nome)
    ? 'Um pedido deste projeto está começando aqui. Espere ele terminar.'
    : AVISO_TRAVA();
  if (lancar) throw new Error(aviso);
  toast(aviso);
  return false;
}

function setRunning(on) {
  state.running = on;
  document.body.classList.toggle('running', on);
  // Fila (1.11): com um pedido rodando, o campo continua vivo — o que se
  // manda agora entra na fila. Na linha fica o Cancelar (ver pintarBotaoEnviar).
  $('#btn-cancel').hidden = !on;
  $('#branch-select').disabled = on;
  $('#ia-picker').disabled = on;
  if (on) fecharMenuIA();
  $('#effort-select') && ($('#effort-select').disabled = on);
  pintarBotaoEnviar();
  pintarFila();
  updateComposerLock();
  // Chat nativo: o gecko gira enquanto o pedido roda, e o quadro não sai da
  // página no meio dele (desligar espera o fim).
  avisarAbaNativa({ tipo: 'nativo:trabalhando', on });
}

async function sendPrompt() {
  if (atualizacaoObrigatoria()) {
    toast('Baixe a nova versão da extensão para continuar usando.');
    return;
  }
  const text = promptInput.value.trim();
  const attachments = state.attachments;
  if ((!text && !attachments.length) || state.desfazendo || isSendBlocked()) return;
  // Um pedido RODANDO: este entra na fila (lib/fila.js) — é o fim dele que a
  // solta. Algo só COMEÇANDO (envio ainda sem run, Autorizar, Enviar agora)
  // pode nem virar pedido: aí o texto fica no campo, senão ficava numa fila
  // que nada soltaria (segunda revisão da 1.11).
  if (state.running) {
    porNaFila(text, attachments);
    return;
  }
  const comecando = state.project && travasDestaJanela.has(nomeDaTrava(state.project.fullName));
  if (state.enviando || comecando) {
    toast('Um pedido está começando — espere um instante e envie de novo.');
    return;
  }
  // Até o run marcar state.running há awaits no caminho (renovar o token do
  // banco é uma ida à rede): um segundo Enter nesse meio disparava DOIS
  // pedidos pagos. A trava é síncrona e sai no fim do envio.
  state.enviando = true;
  try {
    // A trava vem ANTES de limpar o campo, os anexos e o plano: com um pedido
    // deste projeto rodando na outra janela, o texto digitado fica onde está
    // (antes sumia, e o cartão do plano perdia os botões).
    await comTravaDoProjeto(() => enviarPedido(text, attachments, { travaJaPega: true }));
  } finally {
    state.enviando = false;
  }
}

// ---------- Fila de pedidos (1.11.0) ----------
// Pedido do dono: enquanto um pedido roda, o cliente manda até mais 2; o
// próximo começa quando o atual TERMINA BEM (alteração enviada ou nada a
// alterar). Se o atual parou (erro, cancelado, "Não terminei", banco, plano),
// a fila espera o cliente — seguir sozinha gastaria prompt em cima de um
// problema (lib/fila.js). Só em memória: fechar o painel (ou recarregar a
// aba, no chat nativo) esvazia a fila, e o pedido que rodava segue as regras
// de sempre.

function porNaFila(text, attachments) {
  if (!state.project) return;
  // As mesmas recusas do envio, antes de o texto sair do campo: na fila ele
  // travaria o começo e só sobraria a prévia de 70 letras.
  if (text.length > MAX_PROMPT_CHARS) {
    toast(`Pedido muito longo (${Math.round(text.length / 1000)}k caracteres). Encurte ou anexe o conteúdo como arquivo.`);
    return;
  }
  if (!state.settings?.keys?.[state.settings.provider]) {
    toast('Configure sua API de IA em Configurações.');
    return;
  }
  if (!cabeNaFila(state.fila)) {
    toast(`A fila já tem ${MAX_FILA} pedidos. Espere o próximo começar.`);
    return;
  }
  state.fila.push({
    id: crypto.randomUUID(),
    texto: text,
    anexos: [...attachments],
    modo: currentMode(),
    projeto: state.project.fullName,
  });
  // Campo e anexos livres para o próximo; o pedido da fila leva os dele.
  clearAttachments();
  limparCampoDoPrompt();
  pintarFila();
  toast('Na fila — começa quando o pedido atual terminar.');
}

function pintarFila() {
  const box = $('#fila');
  if (!box) return;
  box.replaceChildren();
  const daqui = state.fila.filter((i) => i.projeto === state.project?.fullName);
  box.hidden = daqui.length === 0;
  if (!daqui.length) return;
  box.append(el('div', 'fila-titulo', `Na fila (${daqui.length}/${MAX_FILA})`));
  for (const item of daqui) {
    const linha = el('div', 'fila-item');
    if (item.modo === 'plan') linha.append(el('span', 'fila-modo', 'Planejar'));
    linha.append(el('span', 'fila-texto', resumoDaFila({ texto: item.texto, anexos: item.anexos.length })));
    const tirar = el('button', 'fila-tirar', '✕');
    tirar.type = 'button';
    tirar.title = 'Tirar da fila';
    tirar.setAttribute('aria-label', 'Tirar da fila');
    tirar.addEventListener('click', () => {
      state.fila = state.fila.filter((i) => i.id !== item.id);
      if (!state.fila.length) state.filaParada = null;
      pintarFila();
    });
    linha.append(tirar);
    box.append(linha);
  }
  // Parada, ou nada rodando com pedido esperando (a continuação automática
  // que a fila esperava pode não ter começado): sempre há um botão.
  const ociosa = !state.running && !state.enviando;
  if (state.filaParada || ociosa) {
    if (state.filaParada) box.append(el('div', 'fila-parada', state.filaParada));
    const acoes = el('div', 'fila-acoes');
    const seguir = el('button', 'lb-btn', state.running ? 'Retomar a fila' : 'Continuar a fila');
    seguir.type = 'button';
    seguir.addEventListener('click', () => {
      state.filaParada = null;
      pintarFila();
      if (!state.running) iniciarProximoDaFila();
    });
    const limpar = el('button', 'lb-btn ghost', 'Limpar a fila');
    limpar.type = 'button';
    limpar.addEventListener('click', () => {
      state.fila = [];
      state.filaParada = null;
      pintarFila();
    });
    acoes.append(seguir, limpar);
    box.append(acoes);
  }
}

// Um pedido terminou (fim do executarERenderizar): segue, espera ou para.
function decidirAFila(record, automaticoAgendado) {
  if (!state.fila.length) return;
  const d = depoisDoRun(record, { automaticoAgendado });
  // Já parada (o cliente cancelou, deu erro): um pedido que ele mandou direto
  // e deu certo NÃO solta a fila sozinha — os da fila podiam ser justamente o
  // que ele quis evitar. Só o "Continuar a fila" solta.
  if (state.filaParada) {
    if (d.acao === 'parar') state.filaParada = d.texto;
    pintarFila();
    return;
  }
  if (d.acao === 'seguir') {
    state.filaParada = null;
    // Depois do finally: a trava do projeto já foi devolvida.
    setTimeout(iniciarProximoDaFila, 400);
  } else if (d.acao === 'parar') {
    state.filaParada = d.texto;
    pedirAtencao();
  }
  pintarFila();
}

async function iniciarProximoDaFila() {
  if (state.running || state.enviando || state.desfazendo || state.filaParada) return;
  // Pedido de outro projeto (o chat trocou de projeto): não vai para este.
  const deOutro = state.fila.filter((i) => i.projeto !== state.project?.fullName);
  if (deOutro.length) {
    state.fila = state.fila.filter((i) => i.projeto === state.project?.fullName);
    toast('A fila tinha pedidos de outro projeto: eles foram descartados.');
  }
  const item = state.fila[0];
  if (!item) {
    pintarFila();
    return;
  }
  // Chat nativo desligado (o cliente abriu o painel): este quadro vai sair da
  // página — não começa pedido novo aqui dentro.
  if (MODO_NATIVO && !(await storage.get(['nativo'])).nativo?.ligado) {
    state.filaParada = 'O chat nativo foi desligado — a fila não segue por aqui.';
    pintarFila();
    return;
  }
  if (atualizacaoObrigatoria() || isSendBlocked() || !podeEnviarAgora()) {
    state.filaParada = 'O envio está travado agora (veja o aviso acima) — a fila está parada.';
    pintarFila();
    return;
  }
  state.fila.shift();
  pintarFila();
  state.enviando = true;
  let r;
  try {
    r = await comTravaDoProjeto(() => enviarPedido(item.texto, item.anexos, { doCampo: false, modo: item.modo, travaJaPega: true }));
  } finally {
    state.enviando = false;
  }
  if (r === false) {
    // Nem começou (trava de outra janela, token do banco): volta para a frente.
    state.fila.unshift(item);
    state.filaParada = 'Não consegui começar o próximo pedido da fila — ele continua aqui.';
    pintarFila();
  }
}

async function enviarPedido(text, attachments, { doCampo = true, modo = null, travaJaPega = false } = {}) {

  // Pedido colado gigante (ex.: um arquivo inteiro no campo) vira token caro sem
  // ninguém perceber. 20k chars ≈ 5k tokens já é um texto bem longo; acima disso
  // o caminho certo é anexar o arquivo, que tem corte próprio.
  if (text.length > MAX_PROMPT_CHARS) {
    toast(`Pedido muito longo (${Math.round(text.length / 1000)}k caracteres). Encurte ou anexe o conteúdo como arquivo.`);
    return false;
  }

  const providerId = state.settings.provider;
  const provider = getProvider(providerId);
  const apiKey = state.settings.keys?.[providerId];
  if (!apiKey) {
    toast('Configure sua API de IA em Configurações.');
    return false;
  }
  const model =
    state.settings.models?.[providerId] || provider.preferredModels[0];
  // Pedido da fila: o modo de quando entrou nela.
  const mode = modo || currentMode();

  // Imagens vão como imagem; arquivos de texto entram no próprio prompt (barato).
  const images = attachments
    .filter((a) => a.kind === 'image')
    .map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }));
  const textFiles = attachments.filter((a) => a.kind === 'text');
  let promptForAI = text;
  if (textFiles.length) {
    const blocks = textFiles.map(
      (f) =>
        `Arquivo anexado "${f.name}":\n\`\`\`\n${f.content}\n\`\`\`${f.truncated ? '\n(conteúdo truncado)' : ''}`
    );
    promptForAI = [text, ...blocks].filter(Boolean).join('\n\n');
  }
  // Todo anexo pode ir para o projeto (bytes originais) com salvar_anexo.
  // Imagem e texto a IA VÊ: pode ser só o print do problema, e ela decide.
  // O resto (PDF, vídeo, fonte…) só se anexa para entrar — a extensão salva
  // em public/ no fim se a IA não salvar.
  const projectFiles = attachments.map((a) => ({
    name: a.name, size: a.size, mediaType: a.mediaType, base64: a.base64,
    vistoPelaIA: a.kind === 'image' || a.kind === 'text',
  }));
  const attach = attachments.length
    ? { images: images.length, files: attachments.filter((a) => a.kind !== 'image').map((a) => a.name) }
    : null;

  // Banco conectado com token que não renova: o runAndRender desistiria DEPOIS
  // de o campo e os anexos terem sido apagados. Confere antes.
  if (state.dbRef && !(await renovarSupabaseSeNecessario())) return false;
  // Pedido da fila já saiu do campo quando entrou nela: aqui não se mexe no
  // que o cliente está escrevendo agora.
  if (doCampo) clearAttachments();

  // Só aqui, com o envio aceito: um Enter recusado (sem chave, pedido longo)
  // não pode apagar o que a pessoa está escrevendo ou ditando.
  if (doCampo) limparCampoDoPrompt();

  // Cartão "Não terminei" aberto: o que a pessoa digitou ("continua", "e
  // deixe o botão verde") segue o MESMO pedido, com o trabalho guardado.
  // Antes virava um run do zero que ignorava as rodadas pagas — e o commit
  // dele ainda invalidava o rascunho.
  const guardado = mode === 'build' ? trabalhoAberto(state.history) : null;
  // Passou das 6 rodadas: o cartão manda pedir uma parte por vez, então o que
  // foi digitado é um pedido NOVO — seguir o rascunho gigante seria a série
  // paga que o teto existe para parar. O rascunho fica de lado, avisado.
  const aberto = guardado && !passouDoTeto(guardado, MAX_CONTINUACOES) ? guardado : null;
  if (guardado && !aberto) {
    guardado.pendingWorkFeito = 'Você mandou um pedido novo — este rascunho ficou de lado.';
    await saveHistory();
    renderHistory();
  }
  if (aberto) {
    aberto.pendingWorkFeito = 'Continuou pelo chat.';
    await saveHistory();
    renderHistory();
    const r = await runAndRender({
      travaJaPega,
      userText: text,
      attach,
      promptForAI: promptDeSeguimento(aberto.pedido?.promptForAI || aberto.pedido?.userText, promptForAI),
      images,
      mode,
      projectFiles,
      plano: aberto.plano ? { ...aberto.plano, partes: aberto.plano.partes.map((p) => ({ ...p })) } : null,
      trabalhoAnterior: aberto.pendingWork,
      continuacoes: (aberto.pedido?.continuacoes ?? 0) + 1,
    });
    if (r === false) {
      delete aberto.pendingWorkFeito;
      await saveHistory();
      renderHistory();
    }
    return r;
  }

  // Plano em andamento: o pedido vai com o plano junto (a IA sabe que está na
  // parte N de M) e, ao terminar, o cartão "Continuar" volta a aparecer. Sem
  // isto, qualquer ajuste mandado no meio ("deu erro, corrija") virava um run
  // solto e o plano sumia da tela — as partes 2 e 3 nunca eram oferecidas.
  const plano = mode === 'build' ? await planoEmAndamento() : null;
  return runAndRender({ travaJaPega, userText: text, attach, promptForAI, images, mode, plano, projectFiles });
}

// O último plano do histórico que ainda tem parte por fazer e que o usuário
// não encerrou. Marca o registro dono como "seguiu pelo chat" (o cartão dele
// vira texto) e devolve a cópia que o run novo carrega, com a marca `ajuste`
// e o estado anterior da parte — é ele que decide o cartão no fim.
async function planoEmAndamento() {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const r = state.history[i];
    if (r.kind !== 'run' || !r.plano) continue;
    if (r.planoSeguido) return null; // já decidiu: continuou, parou ou ajustou
    const { plano, planoResultado } = r;
    const acabou = planoResultado === 'concluida' && plano.atual + 1 >= plano.partes.length;
    if (acabou) return null;
    r.planoSeguido = 'ajuste';
    await saveHistory();
    return {
      pedido: plano.pedido,
      partes: plano.partes.map((p) => ({ ...p })),
      atual: plano.atual,
      ajuste: true,
      resultadoAnterior: planoResultado || null,
    };
  }
  return null;
}

// Núcleo compartilhado: cria o bloco vivo da execução, roda o agente e trata o
// resultado. Usado pelo envio do composer e pela geração de contexto do projeto.
// Com a trava do projeto: painel e chat nativo nunca rodam dois pedidos do
// mesmo projeto ao mesmo tempo (ocupada = false, "nem começou").
function runAndRender(opcoes) {
  return comTravaDoProjeto(() => executarERenderizar(opcoes), { jaPega: opcoes?.travaJaPega === true });
}

async function executarERenderizar({
  userText, attach, promptForAI, images, mode, plano = null, parteFalhou = null, projectFiles = [],
  // Retomada de um run que não terminou: o trabalho preparado vai junto e o
  // pedido do usuário NÃO aparece de novo no chat (é o mesmo pedido).
  trabalhoAnterior = null, continuacoes = 0, mostrarPedido = true,
  // 'chatgpt' roda pela assinatura do cliente (sem descontar prompt);
  // 'geckoai' pelos prompts. Os cartões de queda forçam 'geckoai' no botão
  // "usar os prompts neste envio".
  fonte = fonteAtual(),
}) {
  // Banco conectado por OAuth: renova o token antes de começar. Se não der, o
  // banner já pediu para conectar de novo — não se gasta prompt com token morto.
  // false = nem começou: quem chamou por um botão devolve os botões ao cartão.
  if (state.dbRef && !(await renovarSupabaseSeNecessario())) return false;
  const providerId = state.settings.provider;
  let provider = getProvider(providerId);
  const apiKey = state.settings.keys?.[providerId];
  let model = state.settings.models?.[providerId] || provider.preferredModels[0];
  if (fonte === 'chatgpt' && !chatgptConectado()) fonte = 'geckoai';
  if (fonte === 'premium') fonte = 'geckoai'; // registro da 1.8
  // Pelos prompts, com o modelo escolhido no seletor (catálogo do servidor).
  // O servidor confere de novo — no premium, a cota de hoje.
  const opcao = fonte === 'geckoai' ? opcaoEfetiva() : null;
  if (opcao) model = `cat:${opcao.id}`;

  const thread = $('#thread');
  if (mostrarPedido) {
    const userRecord = { kind: 'user', text: userText, attach: attach || null };
    state.history.push(userRecord);
    thread.append(buildUserMessage(userRecord));
  }

  const record = {
    kind: 'run', steps: [], summary: '', commit: null,
    model: opcao ? opcao.nome : model,
    mode, fonte,
  };
  // O que a continuação precisa saber: o pedido original (o mesmo texto vai
  // para a IA) e quantas vezes já continuamos.
  record.pedido = { userText, promptForAI, mode, continuacoes };
  // Se o painel fechar no meio (celular descarta a aba, recarregar para
  // atualizar), a reabertura precisa saber o que este run carregava: o
  // trabalho das rodadas anteriores e a parte do plano. Sem isto os dois
  // ficavam sem botão nenhum (lib/rodadas.js, recuperarInterrompidos). As
  // marcas saem no finally.
  record.emAndamento = true;
  if (trabalhoAnterior) record.trabalhoAnterior = trabalhoAnterior;
  if (plano) {
    const { ajuste, resultadoAnterior, ...limpo } = plano;
    record.planoProvisorio = {
      plano: limpo,
      resultado: ajuste && resultadoAnterior === 'concluida' ? 'concluida' : 'falhou',
    };
  }
  // Anexos só em memória (não vão para o storage): o "usar os prompts neste
  // envio" repete o pedido com eles.
  anexosDoRegistro.set(record, { images, projectFiles, attach });
  state.history.push(record);
  await saveHistory();

  // Bloco vivo da execução.
  const root = el('div', 'run');
  if (mode === 'plan') {
    root.classList.add('run-plan');
    root.append(planChip());
  }
  const status = el('div', 'run-status');
  const textoDoStatus = el('span', null, 'Preparando…');
  status.append(el('span', 'spin'), textoDoStatus);
  root.append(status);
  // Tempo e etapas na linha de status: "Analisando… parado" por minutos
  // parecia travado para o leigo (mediana de 10 etapas, 10% passam de 35).
  const inicioDoRun = Date.now();
  let faseDoRun = 'Preparando…';
  let etapasDoRun = 0;
  const pintarStatus = () => {
    const s = Math.floor((Date.now() - inicioDoRun) / 1000);
    const tempo = s < 5 ? '' : s < 60 ? ` · ${s} s` : ` · ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    const etapas = etapasDoRun ? ` · ${etapasDoRun} ${etapasDoRun === 1 ? 'etapa' : 'etapas'}` : '';
    textoDoStatus.textContent = `${faseDoRun}${tempo}${etapas}`;
  };
  const mudarFase = (texto) => {
    faseDoRun = texto;
    pintarStatus();
  };
  const relogioDoRun = setInterval(pintarStatus, 1000);
  const { tl, contar: contarEtapas } = caixaDaLinhaDoTempo(root);
  thread.append(root);
  scrollThread();

  setRunning(true);
  state.abort = new AbortController();
  let result = null;
  // Chave ilimitada em pedido de partes: a próxima parte, disparada só no
  // fim do finally (com o painel já liberado deste run).
  let proximaParteAutomatica = null;
  // Pedido grande que parou no teto de etapas escrevendo: a próxima rodada,
  // também disparada no fim do finally.
  let proximaRodadaAutomatica = null;

  try {
    if (fonte === 'chatgpt') {
      // A chave vale pelo mesmo prazo no modo ChatGPT: a mesma validação de
      // sempre, que NÃO desconta prompt (vencida, bloqueada ou em outro
      // computador para aqui, com a mensagem de sempre).
      mudarFase('Conectando à sua conta ChatGPT…');
      const escolhido = ChatGPT.modeloEscolhido(state.chatgpt);
      model = escolhido.slug;
      record.model = escolhido.nome;
      provider = criarProvedorChatGPT({
        obterAcesso: acessoChatGPT,
        esforco: ChatGPT.esforcoDe(state.chatgpt, escolhido.slug),
        resumo: escolhido.resumo !== false,
        aoUsar: (limite) => {
          if (!state.chatgpt) return;
          state.chatgpt.limite = { ...limite, lidoEm: Date.now() };
          salvarChatGPT();
          updateLicenseUI();
        },
      });
      mudarFase('Preparando…');
    }
    result = await runAgent(
      {
        github: state.github,
        provider,
        apiKey,
        model,
        owner: state.project.owner,
        repo: state.project.name,
        branch: state.project.branch,
        prompt: promptForAI,
        attachments: images,
        recentHistory: buildRecentHistory(),
        mode,
        supabase: state.dbRef
          ? { client: state.supabase, ref: state.dbRef, ...(state.dbKeys || {}) }
          : null,
        dbManual: state.dbManual === true,
        projectContext: state.projectContext || null,
        projectFiles,
        confirmarSql: (sql) => confirmarSqlDestrutivo(sql, root),
        // Lovable Cloud: a extensão aplica o SQL no meio do run (cartão
        // Autorizar) e devolve o resultado à IA. Se a aba não responder, o
        // agente cai sozinho na reserva manual (pendingMigration).
        aplicarSql: state.dbManual === true ? (sql, opcoes) => aplicarSqlDoLovable(sql, root, opcoes) : null,
        // Lovable Cloud: a IA também LÊ o banco (numa transação que só lê —
        // quem barra a escrita é o próprio Postgres) e o SQL é ENSAIADO antes
        // do cartão. Os dois só usam a aba do projeto que já está aberta.
        consultarSql: state.dbManual === true
          ? (sql) => aplicarSqlNoLovable(sqlDeLeitura(sql), { abrirAba: false })
          : null,
        // A sentinela é sorteada a cada ensaio e volta junto, para o agente
        // saber que o erro proposital é o NOSSO (lib/lovable.js).
        ensaiarSql: state.dbManual === true
          ? async (sql) => {
              const ensaio = sqlDeEnsaio(sql);
              const r = await aplicarSqlNoLovable(ensaio.sql, { abrirAba: false });
              return { ...r, sentinela: ensaio.sentinela };
            }
          : null,
        cacheDeArquivos,
        // Skills instaladas no projeto: o texto que a IA segue vem do pacote.
        // Só nos planos que têm skills — em chave de outro plano a IA nem
        // recebe o índice, mesmo com a pasta no repositório.
        lerSkill: lerSkillDoPacote,
        usarSkills: acessoSkills().liberado,
        plano,
        parteFalhou,
        trabalhoAnterior,
        confirmarPlano: (partes) => confirmarPlano(partes, root),
        // Criar imagem: só com a criação ligada no servidor e pelos prompts —
        // pelo ChatGPT do cliente não há prompt cobrado, e o servidor só
        // libera imagem dentro de um prompt cobrado.
        gerarImagem: fonte !== 'chatgpt' && state.settings.imagensAtivas === true
          ? (pedido, sinal) => getProvider('geckoai').gerarImagem(apiKey, pedido, sinal)
          : null,
      },
      (event) => {
        if (event.type === 'phase') {
          mudarFase(event.text);
        } else if (event.type === 'tool') {
          record.steps.push({ op: event.op, path: event.path });
          tl.append(timelineItem(event.op, event.path));
          etapasDoRun++;
          pintarStatus();
          contarEtapas(record.steps.length);
          scrollThread();
        } else if (event.type === 'commit') {
          const label = event.sha.slice(0, 7);
          record.steps.push({ op: 'commit', path: label });
          tl.append(timelineItem('commit', label));
          contarEtapas(record.steps.length);
          scrollThread();
        }
      },
      state.abort.signal
    );

    record.summary = result.summary;
    record.commit = result.commit;
    record.bancoAlterado = result.bancoAlterado === true;
    if (result.commit) pingPreview();
    status.remove();
    if (result.summary) root.append(resumoFormatado(result.summary));
    if (result.diagnostico) record.diagnostico = result.diagnostico;
    if (result.pendingWork) {
      // Não terminou: o que ficou pronto espera aqui, sem ir para o GitHub.
      const pend = result.pendingWork;
      record.pendingWork = pend;
      const cartao = buildPendingWorkCard(record);
      root.append(cartao);
      // Parou no TETO de etapas, ESCREVENDO (não girando em falso), e ainda
      // cabe rodada: segue sozinho onde continuar não pede autorização de
      // gasto (chave ilimitada, ou pelo ChatGPT do cliente). Nas outras
      // chaves, o botão "Continuar (usa 1 prompt)".
      const segueSozinho = pend.teto && pend.escritas > 0 && !pend.codigo
        && continuacoes < MAX_CONTINUACOES && (fonte === 'chatgpt' || chaveIlimitada());
      if (segueSozinho) {
        const projetoDoRun = { ...state.project };
        proximaRodadaAutomatica = () => seguirParaProximaRodada(record, cartao, fonte, projetoDoRun);
      }
      // Seguindo sozinho, sem aviso: o pedido só continua (decisão do dono).
      if (!segueSozinho || pend.codigo === 'limite' || pend.codigo === 'commit') {
        toast(pend.codigo === 'limite'
          ? 'O limite do seu ChatGPT acabou — o que já ficou pronto está guardado.'
          : pend.codigo === 'commit'
            ? 'O GitHub não aceitou o envio — o trabalho está guardado.'
            : 'Não terminei este pedido — veja o que já preparei.');
      }
      if (pend.codigo === 'acesso') marcarChatGPTDesconectado();
      if (pend.codigo === 'commit' && pend.status === 401) {
        exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
      }
    } else if (result.pendingMigration) {
      record.pendingMigration = { ...result.pendingMigration, applied: false };
      root.append(buildMigrationCard(record));
      toast('Migração pronta — aplique o SQL no Lovable.');
    } else if (result.commit) {
      // Envio novo: a seta do envio anterior sai da tela (ele já não é a ponta).
      document.querySelectorAll('.btn-undo').forEach((b) => b.remove());
      root.append(buildCommitCard(result.commit, true, record));
      toast(TOAST_ENVIADO());
    }
    if (!result.summary && !result.commit && !result.pendingMigration && !result.pendingWork) {
      root.append(el('div', 'run-summary', 'Nada a alterar para esse pedido.'));
    }
    // Pedido em partes: este run implementou a parte `atual`. Concluída se
    // terminou sem erro — com ou sem commit (a parte "banco" no Supabase
    // conectado pode ser só run_sql). No modo manual, só depois do "Já
    // apliquei" (ver buildMigrationCard).
    if (result.plano) {
      const { ajuste, resultadoAnterior, ...limpo } = result.plano;
      record.plano = limpo;
      // Trabalho guardado (a parte parou no teto de etapas) NÃO é parte
      // concluída: o plano fica no registro para a continuação levar junto,
      // e só avança quando a continuação fizer o commit. Antes a parte era
      // dada como feita e, na chave ilimitada, a próxima começava sozinha —
      // com o trabalho desta ainda sem commit.
      if (!result.pendingMigration && !result.pendingWork) {
        // Run de ajuste (mensagem livre no meio do plano): commit = a parte
        // avançou; sem commit (uma pergunta), o estado anterior fica.
        record.planoResultado = ajuste && !result.commit
          ? (resultadoAnterior || 'concluida')
          : 'concluida';
        const cartao = buildPlanoCard(record);
        root.append(cartao);
        // Chave ilimitada: parte concluída segue sozinha. Ajuste pelo chat,
        // falha e SQL manual (que nem chega aqui) esperam o clique, como
        // em qualquer chave.
        const proxima = limpo.atual + 1;
        if (chaveIlimitada() && !ajuste && record.planoResultado === 'concluida' && proxima < limpo.partes.length) {
          const projetoDoRun = { ...state.project };
          proximaParteAutomatica = () => seguirParaProximaParte(record, cartao, proxima, projetoDoRun);
        }
      }
    }
  } catch (err) {
    status.remove();
    if (err.name === 'AbortError') {
      record.cancelled = true;
      root.append(el('div', 'run-cancelled', 'Cancelado — nenhuma mudança foi enviada.'));
    } else if (err.deviceConflito) {
      // A chave está presa em outra máquina. Aqui NÃO dá para reusar o
      // showDeviceConflict (ele escreve numa caixa de formulário), e sem o botão
      // a pessoa fica sem saída no meio do chat.
      record.error = err.message;
      root.append(buildDeviceConflictBlock(err.message));
    } else if (err.name === 'GitHubError' && err.status === 401) {
      record.error = 'Sua conexão com o GitHub expirou. Conecte de novo e envie outra vez.';
      root.append(el('div', 'run-error', record.error));
      exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
    } else if (err.name === 'SupabaseError' && (err.status === 401 || err.status === 403)) {
      record.error = 'Sua conexão com o Supabase expirou. Conecte de novo e envie outra vez.';
      root.append(el('div', 'run-error', record.error));
      exigirReconexao('supabase');
    } else if (err.planoRecusado) {
      // O usuário viu o plano e não quis gastar. O prompt do planejamento foi
      // consumido; o plano fica visível para ele ajustar o pedido.
      record.error = err.message;
      record.planoRecusado = err.planoRecusado;
      root.append(el('div', 'run-error', record.error));
      root.append(buildPlanoRecusadoCard(err.planoRecusado));
    } else if (err.name === 'ChatGPTError' && err.retomavel && trabalhoAnterior) {
      // A continuação parou de novo (limite ou acesso do ChatGPT): o trabalho
      // que ela recebeu volta para este registro, com o cartão — nada se perde.
      record.pedido.continuacoes = continuacoesAposFalha(continuacoes);
      record.pendingWork = { ...trabalhoAnterior, codigo: err.codigo, limite: err.limite || null };
      root.append(buildPendingWorkCard(record));
      if (err.codigo === 'acesso') marcarChatGPTDesconectado();
    } else if (err.name === 'ChatGPTError' && trabalhoAnterior) {
      // Numa rodada de continuação, o caminho é o cartão do trabalho guardado
      // (abaixo). O "usar os prompts neste envio" refaria o pedido do ZERO,
      // pago, e o commit dele ainda invalidaria o rascunho.
      record.error = err.message;
      root.append(el('div', 'run-error', record.error));
      if (err.codigo === 'acesso') marcarChatGPTDesconectado();
    } else if (err.name === 'ChatGPTError') {
      record.error = err.message;
      record.erroChatGPT = { codigo: err.codigo, limite: err.limite || null };
      root.append(buildErroChatGPTCard(record));
      if (err.codigo === 'modelo') atualizarCatalogoChatGPT({ forcar: true });
      if (err.codigo === 'acesso') marcarChatGPTDesconectado();
    } else if (err.premium) {
      // O servidor recusou o modelo premium (cota de hoje acabou, desligado)
      // e já devolveu o prompt. O seletor volta ao padrão, e o cartão
      // oferece mandar o MESMO pedido por ele. Numa rodada de continuação, o
      // cartão é o do trabalho guardado (abaixo), que segue pelo padrão.
      record.error = err.message;
      state.settings.fonteIA = 'geckoai';
      state.settings.modeloCliente = null; // volta ao padrão do dono
      await storage.set({ settings: state.settings });
      if (trabalhoAnterior) {
        root.append(el('div', 'run-error', record.error));
      } else {
        record.erroPremium = err.premium;
        root.append(buildErroPremiumCard(record));
      }
      aoMudarFonte();
    } else {
      record.error = err.message || 'Erro inesperado.';
      root.append(el('div', 'run-error', record.error));
    }
    // Rastro para o dono medir depois, sem pedir DevTools a ninguém.
    if (err.diagnostico) record.diagnostico = err.diagnostico;
    // Uma RODADA de continuação que falhou (rede, prompts da chave, cota do
    // premium, cancelamento…) não leva junto o trabalho que recebeu: ele
    // volta a este registro, com o cartão de continuar. Antes, qualquer erro
    // na rodada 2 jogava fora o que as anteriores tinham preparado.
    // Recusar uma divisão nova não é recusar o trabalho guardado; e a rodada
    // que falhou sem produzir nada não gasta vaga do teto (senão uma queda na
    // 6ª prendia 5 rodadas pagas sem botão).
    const devolveTrabalho = Boolean(trabalhoAnterior) && !record.pendingWork;
    if (devolveTrabalho) {
      record.pedido.continuacoes = continuacoesAposFalha(continuacoes);
      record.pendingWork = { ...trabalhoAnterior };
      root.append(buildPendingWorkCard(record));
    }
    // A parte falhou (erro ou cancelamento): o plano não se perde — o cartão
    // oferece tentar de novo. `err.plano` cobre o plano criado NESTE run. Com
    // trabalho guardado neste registro, o plano só fica nele (o "Continuar"
    // leva) — um "Tentar de novo" ao lado refaria a parte sem o trabalho.
    const planoDoRun = err.plano || plano;
    if (planoDoRun && !err.planoRecusado && record.pendingWork) {
      const { ajuste, resultadoAnterior, ...limpo } = planoDoRun;
      record.plano = limpo;
    } else if (planoDoRun && !err.planoRecusado) {
      const { ajuste, resultadoAnterior, ...limpo } = planoDoRun;
      record.plano = limpo;
      // Ajuste que falhou não rebaixa uma parte já concluída.
      record.planoResultado = ajuste && resultadoAnterior === 'concluida' ? 'concluida' : 'falhou';
      // Motivo mecânico da falha (err.trava, em inglês). Com ele, o "Tentar
      // de novo" manda a IA DIVIDIR esta parte primeiro — repetir a mesma
      // tentativa daria no mesmo erro, pago de novo.
      record.planoFalha = err.trava || null;
      root.append(buildPlanoCard(record));
    }
  } finally {
    clearInterval(relogioDoRun);
    // O run terminou aqui mesmo (bem, com erro ou cancelado): nada a recuperar.
    delete record.emAndamento;
    delete record.trabalhoAnterior;
    delete record.planoProvisorio;
    // GRAVA antes de avisar que acabou: no chat nativo, "acabou" libera a
    // página a tirar o quadro (o usuário abriu o painel no meio), e o
    // resultado pago — resumo, commit, trabalho guardado — morria com ele
    // (revisão adversarial da 1.11).
    state.abort = null;
    await saveHistory();
    setRunning(false);
    scrollThread();
    // No chat nativo, só puxa o foco se o usuário ainda está no nosso chat:
    // ele pode ter ido mexer no preview enquanto esperava.
    if (!MODO_NATIVO || document.hasFocus()) promptInput.focus();
    // Terminou com a janela flutuante escondida: o resultado aparece.
    pedirAtencao();
    // Mostrador de prompts: revalida em segundo plano após cada envio (o
    // servidor devolve os restantes e a validade; sem await de propósito).
    refreshLicenseInfo();
    // O usuário trocou de projeto no Lovable durante a execução? Aplica agora.
    if (state.pendingLovable) {
      const tab = state.pendingLovable;
      state.pendingLovable = null;
      handleActiveTab(tab);
    }
    // Fora desta chamada (setTimeout): cada parte é um run próprio, e a
    // próxima não pode ficar pendurada dentro do await desta. O intervalo dá
    // tempo de a trava do projeto (runAndRender) ser devolvida antes.
    if (proximaParteAutomatica) setTimeout(proximaParteAutomatica, 300);
    if (proximaRodadaAutomatica) setTimeout(proximaRodadaAutomatica, 300);
    // Fila: o próximo começa só se este terminou bem (lib/fila.js).
    decidirAFila(record, Boolean(proximaParteAutomatica || proximaRodadaAutomatica));
  }
  return result;
}

// ---------- Contexto automático do projeto (docs/CONTEXTO.md) ----------

const CONTEXT_GEN_PROMPT = `Analise este projeto e gere o arquivo docs/CONTEXTO.md — um mapa CONCISO do projeto, para servir de contexto rápido em tarefas futuras (economizar leituras). Leia os arquivos necessários (package.json, configs, rotas, componentes principais, estilos) e, se existir docs/DB_SCHEMA.json, use-o para resumir o banco.

O docs/CONTEXTO.md deve conter, em português e em tópicos curtos:
- Stack e como o projeto roda (framework, build).
- Estrutura das pastas principais e o que cada uma contém.
- Rotas/páginas principais e o arquivo de cada uma.
- Componentes reutilizáveis importantes e onde ficam (ex.: botões, header, layout).
- Onde ficam o tema, as cores e os estilos globais (ex.: tailwind config, css).
- Como o projeto usa dados/banco (resumo das tabelas se houver docs/DB_SCHEMA.json).
- Convenções que a IA deve seguir ao editar.

Escreva o conteúdo COMPLETO em Markdown com write_file em "docs/CONTEXTO.md". NÃO altere nenhum outro arquivo. Ao terminar, chame set_commit_message com "Gera contexto do projeto (docs/CONTEXTO.md)".`;

// docs/CONTEXTO.md já existe? (mapa do projeto que a IA lê em toda tarefa)
async function checkProjectContext() {
  state.contextChecked = false;
  state.hasContext = false;
  state.projectContext = null;
  if (!state.github || !state.project) {
    renderContextBanner();
    return;
  }
  try {
    const content = await state.github.readFile(
      state.project.owner, state.project.name, state.project.branch, 'docs/CONTEXTO.md'
    );
    // Cap de segurança: o resumo vai em TODA tarefa; não deixa virar um custo de token.
    state.projectContext =
      content.length > 12000 ? content.slice(0, 12000) + '\n… (contexto truncado)' : content;
    state.hasContext = true;
  } catch {
    /* ainda não existe */
  }
  state.contextChecked = true;
  renderContextBanner();
}

// Banner "primeira vez" — só quando o projeto está verificado e ainda não tem contexto.
// O convite para gerar contexto NÃO abre sozinho: polui a tela de quem só quer
// escrever um pedido. Quem quiser gera pelo ícone da bússola na barra.
function renderContextBanner() {
  const box = $('#context-banner');
  if (!box) return;
  box.replaceChildren();
  box.hidden = true;
}

// Roda a análise e salva/atualiza docs/CONTEXTO.md (conta como um prompt normal).
async function generateContext() {
  if (!state.project || state.running || state.lovableLock) return;
  if (!state.settings?.keys?.[state.settings.provider]) {
    toast('Configure sua API de IA em Configurações.');
    return;
  }
  const result = await runAndRender({
    userText: '🧭 Analisar o projeto e salvar o contexto (docs/CONTEXTO.md)',
    attach: null,
    promptForAI: CONTEXT_GEN_PROMPT,
    images: [],
    mode: 'build',
  });
  if (result?.commit) {
    toast('Contexto salvo — a IA vai trabalhar com o projeto mapeado.');
    await checkProjectContext(); // recarrega o conteúdo e esconde o banner
  } else if (result) {
    // rodou, mas não escreveu o arquivo (a IA narrou em vez de editar)
    toast('A IA não gerou o arquivo desta vez. Tente novamente.');
  }
}

// ---------- Remover o logo do Lovable ----------
// O selo "Edit with Lovable" não está no código do projeto: o Lovable injeta no
// DOM depois do carregamento. A defesa é dupla — CSS que esconde e um vigia que
// remove o que for injetado. Receita validada em projeto real (2026-08-28).

const REMOVE_LOGO_PROMPT = `Remova o selo/badge "Edit with Lovable" que aparece flutuando sobre o site publicado. IMPORTANTE: esse selo NÃO está no código-fonte — o Lovable injeta o elemento dinamicamente no DOM depois que a página carrega (um link/iframe apontando para lovable.dev ou lovable.app, às vezes com id/classe contendo "lovable"). Portanto não perca iterações procurando o selo no código; aplique direto a defesa dupla:

1. CSS global — no arquivo de estilos global do projeto (ex.: src/index.css ou src/styles.css), adicione regras escondendo com display: none !important os seletores do badge: a[href*="lovable.dev"], a[href*="lovable.app"], #lovable-badge, [id*="lovable" i], [class*="lovable" i], iframe[src*="lovable"].

2. Vigia no DOM — crie um arquivo novo (ex.: src/lib/hide-lovable-badge.ts, ou .js se o projeto não usa TypeScript) com um MutationObserver observando document.body que remove imediatamente qualquer elemento injetado que case com esses seletores. Importe e execute esse vigia no ponto de entrada real da aplicação (leia a estrutura antes: src/main.tsx, src/App.tsx, src/routes/__root.tsx ou equivalente).

Cuidado: os seletores devem mirar só o badge injetado — não esconda conteúdo legítimo do site que por acaso mencione "lovable" em texto. Faça um commit único com a mudança.`;

async function removeLovableLogo() {
  if (!state.project || state.running || state.lovableLock) return;
  if (!state.settings?.keys?.[state.settings.provider]) {
    toast('Configure sua API de IA em Configurações.');
    return;
  }
  const result = await runAndRender({
    userText: '🚫 Remover o logo "Edit with Lovable" do site',
    attach: null,
    promptForAI: REMOVE_LOGO_PROMPT,
    images: [],
    mode: 'build',
  });
  if (result?.commit) {
    toast('Logo removido — publique/aguarde o deploy e confira o site.');
  } else if (result && !result.pendingMigration) {
    toast('A IA não fez o commit desta vez. Tente de novo.');
  }
}

// ---------- Skills (1.12.0) ----------
// Instruções de especialista que o cliente instala no projeto com um clique
// (lib/skills.js). Instalar e remover são um commit SEM IA — não usam prompt.
// Depois de instalada, a IA segue a skill sozinha nos pedidos daquele tema; o
// "Usar agora" é um pedido pronto (1 prompt, como qualquer envio) que aplica a
// skill no projeto inteiro.

// Os textos das skills vêm do próprio pacote da extensão (skills/<id>/…).
async function lerDoPacote(caminho) {
  const r = await fetch(chrome.runtime.getURL(caminho));
  if (!r.ok) throw new Error(`Arquivo da extensão não encontrado: ${caminho}`);
  return r.text();
}
const lerSkillDoPacote = (id, arquivo) => lerArquivoDaSkill(id, arquivo, lerDoPacote);

const mesmoProjeto = (a, b) => Boolean(a && b) && a.fullName === b.fullName && a.branch === b.branch;
// De qual projeto/branch é a lista que está na tela (cópia: o seletor de
// branch muda state.project no mesmo objeto).
let skillsNaTela = null;

async function abrirSkills() {
  if (!state.project || !state.github) return;
  if (state.lovableLock) { toast('Conecte o projeto ao GitHub primeiro.'); return; }
  $('#skills-overlay').hidden = false;
  await carregarSkills();
}

// Relê a árvore do repositório: "instalada" é o que está no GitHub agora (o
// cliente pode ter instalado por outro computador, ou desfeito o envio).
async function carregarSkills() {
  const lista = $('#skills-list');
  if (!lista || !state.project) return;
  const projeto = { ...state.project };
  skillsNaTela = null;
  // Plano sem skills: a lista aparece (é vitrine), travada. Nem consulta o
  // GitHub — não há o que instalar nem remover.
  if (!acessoSkills().liberado) {
    instaladasNaTela = [];
    pintarSkills();
    return;
  }
  // Enquanto confere: cartões-fantasma no formato dos de verdade, para a
  // folha não pular de tamanho quando a lista chega.
  lista.replaceChildren(...Array.from({ length: 4 }, () => {
    const fantasma = el('div', 'skill-item skill-fantasma');
    fantasma.setAttribute('aria-hidden', 'true');
    return fantasma;
  }));
  $('#skills-filtro').hidden = true;
  try {
    const { files } = await state.github.getTree(projeto.owner, projeto.name, projeto.branch);
    if (!mesmoProjeto(state.project, projeto)) return; // trocou de projeto ou de branch no meio
    skillsNaTela = projeto;
    instaladasNaTela = skillsInstaladas(files);
    pintarSkills();
  } catch (err) {
    if (err?.name === 'GitHubError' && err.status === 401) {
      exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
    }
    lista.replaceChildren(el('p', 'form-error', 'Não consegui ler o projeto no GitHub. Feche e abra de novo em instantes.'));
  }
}

// O desenho de cada skill (traço, 24×24). A cor do quadrinho vem do CSS, por
// `data-skill` — é a identidade da skill, igual em todos os temas e marcas.
const ICONES_DAS_SKILLS = {
  'frontend-design':
    '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.2A4.8 4.8 0 0 0 21 9.6C21 5.9 17 3 12 3Z"/><circle cx="7.6" cy="11.6" r="1.1"/><circle cx="10.4" cy="7.6" r="1.1"/><circle cx="15.2" cy="7.6" r="1.1"/>',
  seo:
    '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m20.5 20.5-4.9-4.9"/><path d="m7.6 12.4 2.1-2.3 1.9 1.6 2.6-3.1"/>',
  'supabase-security':
    '<path d="M12 3l7 2.8v5.4c0 4.5-2.9 8.4-7 9.8-4.1-1.4-7-5.3-7-9.8V5.8L12 3Z"/><path d="m8.9 12 2.2 2.2 4-4.1"/>',
  'react-best-practices':
    '<path d="M13 2.5 4.8 13.4H11L10 21.5l8.2-10.9H12L13 2.5Z"/>',
  'web-design-guidelines':
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="7.4" r="1.1"/><path d="M7.8 10.3h8.4M12 10.3v4.2m0 0-2.3 3.6m2.3-3.6 2.3 3.6"/>',
  copywriting:
    '<path d="M5 7.5V5h14v2.5"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  cro:
    '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="0.9"/>',
  signup:
    '<circle cx="9.8" cy="8" r="3.6"/><path d="M3.4 19.6c.6-3.4 3.1-5.4 6.4-5.4s5.8 2 6.4 5.4"/><path d="M18.6 6.8v5.4M15.9 9.5h5.4"/>',
  'supabase-postgres-best-practices':
    '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  'core-web-vitals':
    '<path d="M4.6 17a8.6 8.6 0 1 1 14.8 0"/><path d="m12 13.6 3.6-4.4"/><circle cx="12" cy="14" r="1.3"/>',
};

function iconeDaSkill(id) {
  const caixa = el('span', 'skill-ico');
  caixa.setAttribute('aria-hidden', 'true');
  // Só texto fixo deste arquivo entra aqui (nunca dado de fora).
  caixa.innerHTML = `<svg viewBox="0 0 24 24">${ICONES_DAS_SKILLS[id] || ''}</svg>`;
  return caixa;
}

// As skills são dos planos que têm o modelo premium (decisão do dono): o
// mesmo sinal que o servidor manda para o cadeado do seletor de IA.
const acessoSkills = () => acessoAsSkills(state.settings?.modelos);

// O que a folha mostra agora: as skills instaladas neste projeto (da última
// leitura do GitHub, ajustada a cada instalar/remover) e o filtro escolhido.
let instaladasNaTela = [];
let filtroDeSkills = 'todas'; // 'todas' | 'instaladas'

function cabecalhoDoCartao(skill, selo, noCanto = null) {
  const topo = el('div', 'skill-topo');
  topo.append(el('span', 'skill-nome', skill.nome));
  if (selo) topo.append(selo);
  const texto = el('div', 'skill-texto');
  texto.append(topo, el('p', 'skill-resumo', skill.resumo));
  const cab = el('div', 'skill-cab');
  cab.append(iconeDaSkill(skill.id), texto);
  if (noCanto) cab.append(noCanto);
  return cab;
}

// Remover: uma lixeira discreta no canto do cartão, longe do botão principal
// (e ainda com a confirmação do navegador antes de qualquer coisa).
function botaoRemoverSkill(skill) {
  const b = el('button', 'skill-remover');
  b.type = 'button';
  b.title = `Remover a skill ${skill.nome} deste projeto`;
  b.setAttribute('aria-label', b.title);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2m-6 4v6m4-6v6M7 7l1 13h8l1-13"/></svg>';
  b.addEventListener('click', () => mudarSkill(skill, false, b));
  return b;
}

function botaoDeSkill(classe, rotulo) {
  const b = el('button', `skill-btn ${classe}`, rotulo);
  b.type = 'button';
  return b;
}

function pintarFiltroDeSkills(quantas) {
  const caixa = $('#skills-filtro');
  if (!caixa) return;
  caixa.replaceChildren();
  // Sem nada instalado não há o que filtrar.
  caixa.hidden = quantas === 0 || !acessoSkills().liberado;
  if (caixa.hidden) { filtroDeSkills = 'todas'; return; }
  for (const [id, rotulo] of [['todas', `Todas · ${SKILLS.length}`], ['instaladas', `Instaladas · ${quantas}`]]) {
    const b = el('button', 'skills-aba', rotulo);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(filtroDeSkills === id));
    if (filtroDeSkills === id) b.classList.add('ativa');
    b.addEventListener('click', () => {
      if (filtroDeSkills === id) return;
      filtroDeSkills = id;
      pintarSkills();
    });
    caixa.append(b);
  }
}

// Redesenha a lista SEM consultar o GitHub e sem perder a posição da rolagem
// (depois de instalar a 7ª skill, a folha não volta para o topo).
function pintarSkills() {
  const lista = $('#skills-list');
  if (!lista) return;
  const folha = lista.closest('.sheet');
  const rolagem = folha ? folha.scrollTop : 0;
  const instaladas = instaladasNaTela;
  lista.replaceChildren();
  const acesso = acessoSkills();
  const quantas = SKILLS.filter((s) => instaladas.includes(s.id)).length;
  pintarFiltroDeSkills(quantas);

  if (!acesso.liberado) {
    // Vitrine: os cartões aparecem, nenhum responde — o clique em qualquer um
    // mostra o aviso do plano.
    const faixa = el('div', 'skills-trava');
    faixa.append(el('span', 'skills-trava-ico', '🔒'), el('span', null, acesso.aviso));
    lista.append(faixa);
  }

  for (const grupo of GRUPOS) {
    const doGrupo = SKILLS.filter((s) => s.grupo === grupo.id
      && (filtroDeSkills === 'todas' || instaladas.includes(s.id)));
    if (!doGrupo.length) continue;
    const secao = el('section', 'skills-grupo');
    secao.append(el('h3', 'skills-grupo-nome', grupo.nome));
    for (const skill of doGrupo) {
      if (!acesso.liberado) {
        const item = el('div', 'skill-item travada');
        item.dataset.skill = skill.id;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-disabled', 'true');
        item.title = acesso.aviso;
        item.append(cabecalhoDoCartao(skill, el('span', 'skill-cadeado', '🔒')));
        item.addEventListener('click', () => toast(acesso.aviso));
        secao.append(item);
        continue;
      }
      const tem = instaladas.includes(skill.id);
      const item = el('div', tem ? 'skill-item instalada' : 'skill-item');
      item.dataset.skill = skill.id;
      item.append(cabecalhoDoCartao(
        skill,
        tem ? el('span', 'skill-selo', '✓ Instalada') : null,
        tem ? botaoRemoverSkill(skill) : null
      ));

      const acoes = el('div', 'skill-acoes');
      if (tem) {
        const usar = botaoComCusto('skill-btn usar', skill.usar.rotulo);
        usar.addEventListener('click', () => usarSkill(skill));
        acoes.append(usar);
      } else {
        const instalar = botaoDeSkill('instalar mig-go', 'Instalar');
        instalar.addEventListener('click', () => mudarSkill(skill, true, instalar));
        // Sem "grátis / não usa prompt" na tela (decisão do dono): as skills
        // são do plano Max, que é ilimitado — falar de prompt ali só confunde.
        acoes.append(instalar);
      }
      item.append(acoes);
      secao.append(item);
    }
    lista.append(secao);
  }
  if (folha) folha.scrollTop = rolagem;
}

// Instala (ou remove) a skill: um commit direto, sem IA e sem prompt, pelas
// mesmas travas de qualquer envio (projeto certo aberto, versão, trava do
// projeto entre janelas). Fica no histórico como um envio — o "desfazer" do
// cartão desinstala.
async function mudarSkill(skill, instalar, botao) {
  // A chave pode ter mudado com a folha aberta (trocou de chave, plano venceu).
  if (!acessoSkills().liberado) { toast(acessoSkills().aviso); pintarSkills(); return; }
  if (!podeEnviarAgora()) return;
  // A lista é de outro projeto/branch (trocou com a folha aberta): relê.
  if (!mesmoProjeto(state.project, skillsNaTela)) { await carregarSkills(); return; }
  // O desfazer só alcança o ÚLTIMO envio: este commit passa a ser o último,
  // e a seta do envio anterior (pago) deixa de valer. O cliente decide.
  const anterior = ultimoEnvio();
  const perdeDesfazer = anterior && !anterior.skill && podeDesfazer(anterior)
    ? '\n\nDepois disso, o seu último envio não poderá mais ser desfeito pela seta.'
    : '';
  if (!instalar && !confirm(`Remover a skill "${skill.nome}" deste projeto?${perdeDesfazer}`)) return;
  if (instalar && perdeDesfazer && !confirm(`Instalar a skill "${skill.nome}"?${perdeDesfazer}`)) return;
  const projeto = { ...state.project };
  // Um por vez: todos os botões da folha esperam, e o que foi clicado gira.
  $('#skills-list').querySelectorAll('button').forEach((b) => { b.disabled = true; });
  botao.classList.add('ocupado');
  // Instalar mostra o giro com o texto; a lixeira (sem texto) só gira.
  botao.replaceChildren(el('span', 'spin'), ...(instalar ? [document.createTextNode('Instalando…')] : []));
  let mudou = false;
  try {
    const commit = await comTravaDoProjeto(async () => {
      const { files } = await state.github.getTree(projeto.owner, projeto.name, projeto.branch);
      const mudancas = instalar
        ? await mudancasParaInstalar(skill.id, lerDoPacote, files)
        : mudancasParaRemover(skill.id, files);
      if (!mudancas.size) return null;
      const mensagem = prefixarCommit(`${instalar ? 'Instala' : 'Remove'} a skill ${skill.nome}`);
      // São dezenas de arquivos de texto: vão dentro da árvore, em 3 chamadas
      // ao GitHub em vez de uma por arquivo (lib/github.js).
      const c = await state.github.commitChanges(
        projeto.owner, projeto.name, projeto.branch, mudancas, mensagem, undefined, { textoNaArvore: true }
      );
      return c ? { sha: c.sha, url: c.url, message: mensagem, files: [...mudancas.keys()] } : null;
    }, { lancar: true });

    if (commit && mesmoProjeto(state.project, projeto)) {
      const pedido = { kind: 'user', text: `🧩 ${instalar ? 'Instalar' : 'Remover'} a skill ${skill.nome}`, attach: null };
      const record = {
        kind: 'run', steps: [], commit, mode: 'build', skill: skill.id,
        summary: instalar
          ? `Skill **${skill.nome}** instalada neste projeto. A partir de agora eu sigo essa skill sozinho sempre que o pedido for desse tema — e você pode aplicá-la no projeto inteiro pelo botão "${skill.usar.rotulo}", em Skills.`
          : `Skill **${skill.nome}** removida deste projeto.`,
      };
      state.history.push(pedido, record);
      await saveHistory();
      // O envio mais recente agora é este: a seta de desfazer sai dos anteriores.
      document.querySelectorAll('.btn-undo').forEach((b) => b.remove());
      $('#thread').append(buildUserMessage(pedido), buildRunElement(record));
      scrollThread();
    }
    mudou = true;
    toast(commit
      ? (instalar ? `Skill ${skill.nome} instalada.` : `Skill ${skill.nome} removida.`)
      : (instalar ? `A skill ${skill.nome} já estava instalada.` : `A skill ${skill.nome} já não estava no projeto.`));
  } catch (err) {
    if (err?.name === 'GitHubError' && err.status === 401) {
      exigirReconexao('github', 'Sua conexão com o GitHub expirou ou foi revogada.');
    }
    // Erro do GitHub vem em inglês ("Update is not a fast forward"…): o leigo
    // recebe a frase de sempre. Os avisos nossos (trava do projeto, arquivo
    // da extensão) já estão em português.
    toast(err?.name === 'GitHubError'
      ? 'O GitHub não aceitou o envio. Tente de novo em instantes.'
      : (err?.message || 'Não consegui concluir. Tente de novo em instantes.'));
  }
  // A lista se ajusta no lugar (sem reler o GitHub nem voltar ao topo). Se o
  // projeto mudou no meio, a leitura de verdade acontece na próxima abertura.
  if (mudou && mesmoProjeto(state.project, projeto)) {
    instaladasNaTela = instalar
      ? [...new Set([...instaladasNaTela, skill.id])]
      : instaladasNaTela.filter((id) => id !== skill.id);
  }
  if (!$('#skills-overlay').hidden) {
    if (mesmoProjeto(state.project, skillsNaTela)) pintarSkills();
    else await carregarSkills();
  }
}

// Aplica a skill no projeto: um pedido pronto, que custa o mesmo que qualquer
// envio. A IA lê a skill (do pacote) e corrige o que encontrar.
async function usarSkill(skill) {
  if (!acessoSkills().liberado) { toast(acessoSkills().aviso); pintarSkills(); return; }
  if (!podeEnviarAgora()) return;
  // Lista de outro projeto/branch: aqui a skill pode nem estar instalada, e
  // o pedido seria cobrado sem ela. Relê em vez de rodar.
  if (!mesmoProjeto(state.project, skillsNaTela)) {
    await carregarSkills();
    toast('O projeto mudou — confira as skills deste projeto.');
    return;
  }
  // Pedido em aberto (cartão "Não terminei") ou plano no meio: um run novo
  // mexeria nos mesmos arquivos e invalidaria o trabalho já pago.
  if (trabalhoAberto(state.history)) {
    toast('Termine ou descarte o pedido em aberto antes de aplicar uma skill.');
    return;
  }
  if (await planoEmAndamento()) {
    toast('Termine ou pare o plano em andamento antes de aplicar uma skill.');
    return;
  }
  if (!state.settings?.keys?.[state.settings.provider]) {
    toast('Configure sua API de IA em Configurações.');
    return;
  }
  $('#skills-overlay').hidden = true;
  const result = await runAndRender({
    userText: skill.usar.pedido,
    attach: null,
    promptForAI: skill.usar.prompt,
    images: [],
    mode: 'build',
  });
  if (result && !result.commit && !result.pendingMigration && !result.pendingWork) {
    toast('Nada foi alterado desta vez — veja o resumo no chat.');
  }
}

$('#btn-skills')?.addEventListener('click', () => { abrirSkills(); });
$('#btn-close-skills')?.addEventListener('click', () => {
  $('#skills-overlay').hidden = true;
});
$('#skills-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('#skills-overlay')) $('#skills-overlay').hidden = true;
});

// ---------- Configurações ----------

async function renderSettingsKeyFields() {
  const box = $('#settings-keys');
  box.replaceChildren();
  renderAIFields(box, state.settings?.personalAI || await readAI());
  // API própria e configuração por instalação.
  const p = getProvider('geckoai');
  const field = el('div', 'field');
  const label = el('label', null, 'Chave da API de IA');
  label.htmlFor = `set-key-${p.id}`;
  const input = el('input');
  input.id = `set-key-${p.id}`;
  input.type = 'password';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'sua chave de API (dispensável para Ollama local)';
  input.value = state.settings?.keys?.[p.id] || '';
  box.querySelector('[data-personal-url]').addEventListener('input', () => { input.value = ''; });
  field.append(label, input);
  box.append(field);
}

// Cada serviço valida seu token pela API oficial antes de persistir a conexão.
function renderConexoes() {
  const box = $('#settings-connections');
  if (!box) return;
  box.replaceChildren();
  box.className = 'conn-itens';
  const s = state.settings || {};
  const linhas = [
    { p: 'github', ligado: Boolean(s.githubToken),
      quem: state.user?.login, obrigatorio: true },
    { p: 'supabase', ligado: Boolean(s.supabaseToken), quem: null },
    { p: 'vercel', ligado: Boolean(s.vercelToken),
      quem: s.vercelTeamId ? `time ${s.vercelTeamId}` : null },
  ];
  for (const l of linhas) {
    // Vercel desconectada pede token colado: é o único serviço sem OAuth
    // (decisão do dono, 2026-09-01 — registrar a integração exigia formulário
    // público com EULA e política de privacidade, caro demais para um passo
    // opcional). Conectada, a linha é igual às outras.
    // All three services use their own personal-token connection dialog.

    const row = el('div', l.ligado ? 'conn-item ligado' : 'conn-item');
    const info = el('div', 'conn-item-info');
    info.append(el('div', 'conn-item-nome', nomeServico(l.p)));
    info.append(el('div', 'conn-item-status',
      l.ligado
        ? (l.quem || 'conectado')
        : (l.obrigatorio ? 'não conectado — obrigatório' : 'não conectado')));
    const btn = el('button', l.ligado ? 'conn-acao' : 'conn-acao principal',
      l.ligado ? 'Desconectar' : 'Conectar');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      showError('#settings-error', null);
      try {
        if (l.ligado) {
          if (l.p === 'github' && !confirm('Desconectar o GitHub? O envio fica bloqueado até conectar de novo.')) return;
          await desconectarServico(l.p);
        } else {
          btn.textContent = 'Aguardando…';
          const pacote = await conectarServico(l.p);
          await salvarConexao(l.p, pacote);
          toast(`${nomeServico(l.p)} conectado.`);
          if (!$('#view-chat').hidden) {
            refreshDbConnection();
            refreshVercelLink();
          }
          syncWithActiveTab(true);
        }
      } catch (err) {
        showError('#settings-error', err.message || `Não foi possível conectar ao ${nomeServico(l.p)}.`);
      } finally {
        btn.disabled = false;
        renderConexoes();
      }
    });
    row.append(info, btn);
    box.append(row);
  }
  box.append(...linhaChatGPT());
}

// A Vercel é conectada com um token que o usuário cria na conta dele. O campo
// existe só aqui: GitHub e Supabase continuam em um clique, sem campo nenhum.
async function desconectarServico(provider) {
  const s = { ...(state.settings || {}) };
  if (provider === 'github') {
    delete s.githubToken;
    state.github = null;
    state.user = null;
    allRepos = [];
  }
  if (provider === 'supabase') {
    delete s.supabaseToken;
    delete s.supabaseRefresh;
    delete s.supabaseExpiresAt;
    state.supabase = null;
    state.supabaseProjects = null;
  }
  if (provider === 'vercel') {
    delete s.vercelToken;
    delete s.vercelTeamId;
    state.vercel = null;
  }
  state.settings = s;
  await storage.set({ settings: s });
  if (provider === 'github') {
    // Sem GitHub não há painel: recarrega e cai no passo 2 do setup.
    $('#settings-overlay').hidden = true;
    location.reload();
    return;
  }
  if (!$('#view-chat').hidden) {
    refreshDbConnection();
    refreshVercelLink();
  }
}

// Abrir as Configurações tem dois chamadores: o botão da barra e o aviso de
// reconexão da Vercel (que não tem OAuth e precisa levar ao campo de token).
function abrirConfiguracoes() {
  renderConexoes();
  renderSettingsKeyFields();
  showError('#settings-error', null);
  $('#settings-overlay').hidden = false;
  if (MODO_NATIVO) conferirFuro();
}

$('#btn-settings').addEventListener('click', abrirConfiguracoes);

$('#btn-close-settings').addEventListener('click', () => {
  $('#settings-overlay').hidden = true;
});

$('#btn-back-settings').addEventListener('click', () => {
  $('#settings-overlay').hidden = true;
});

$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('#settings-overlay')) $('#settings-overlay').hidden = true;
});

$('#btn-save-settings').addEventListener('click', async () => {
  let config;
  const drafts = {};
  try {
    config = fieldsAI($('#settings-keys'));
    drafts.geckoai = credentialForAI($('#set-key-geckoai')?.value, config);
    if (!(await requestAIOrigin(config))) throw new Error('Permita o acesso à API escolhida para conectar.');
  } catch (error) { showError('#settings-error', error.message); return; }
  const connected = PROVIDERS.filter((p) => drafts[p.id]);
  if (connected.length === 0) {
    showError('#settings-error', 'Informe a chave de acesso.');
    return;
  }

  const btn = $('#btn-save-settings');
  btn.disabled = true;
  btn.textContent = 'Validando…';
  try {
    const old = state.settings || { keys: {}, models: {} };

    // Valida apenas chaves novas ou alteradas (e aproveita para buscar modelos).
    const keys = {};
    const models = { ...(old.models || {}) };
    for (const p of connected) {
      const key = drafts[p.id];
      keys[p.id] = key;
      if (p.id === 'geckoai' || key !== old.keys?.[p.id]) {
        const list = await getProvider(p.id).listModels(key, undefined, { config });
        if (!list.length) {
          throw new Error(`Nenhum modelo disponível na ${p.brand} para esta chave.`);
        }
        state.modelsCache[p.id] = list.slice(0, 40);
        if (!models[p.id] || !list.some((m) => m.id === models[p.id])) {
          models[p.id] = pickDefaultModel(p, list);
        }
      } else if (!models[p.id]) {
        models[p.id] = pickDefaultModel(p, currentModelsFor(p.id));
      }
    }

    models.geckoai = config.model;
    let provider = old.provider;
    if (!keys[provider]) provider = connected[0].id;
    if (!models[provider]) {
      models[provider] = pickDefaultModel(getProvider(provider), currentModelsFor(provider));
    }

    // As conexões (GitHub/Supabase/Vercel) vivem em `old` e não passam por
    // aqui: conectar e desconectar é pelas linhas de conexão acima.
    state.settings = {
      ...old,
      provider,
      personalAI: config,
      keys,
      models,
      mode: old.mode || 'build',
      modelos: null, imagensAtivas: false,
    };
    await storage.set({ settings: state.settings, modelsCache: state.modelsCache, personalAI: config });
    populateModelSelect();
    updateLicenseUI();
    refreshLicenseInfo(); // revalida a chave e atualiza a validade
    if (!$('#view-chat').hidden) {
      refreshDbConnection();
      refreshVercelLink();
    }
    $('#settings-overlay').hidden = true;
    toast('Configurações salvas.');
    if ($('#view-setup').hidden === false) location.reload();
    syncWithActiveTab(true);
  } catch (err) {
    showError('#settings-error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
});

$('#btn-disconnect').addEventListener('click', async () => {
  if (!confirm('Apagar chaves, projeto e histórico deste navegador?')) return;
  state.abort?.abort();
  // O id da MÁQUINA sobrevive: desconectar não é trocar de computador. Se ele
  // fosse embaixo junto, reativar aqui mesmo geraria um id novo e a licença
  // acusaria "em uso em outro computador" no próprio PC de sempre.
  const { geckoDevice } = await chrome.storage.local.get('geckoDevice');
  await storage.clear();
  if (geckoDevice) await chrome.storage.local.set({ geckoDevice });
  location.reload();
});

// ---------- Chat nativo (1.11.0) ----------
// Este mesmo painel dentro da página da Lovable (nativo/conteudo.js). Aqui:
// a cara (body.nativo + nativo.css, com a cor da própria página), o que o
// gecko mostra, e o botão do painel lateral que liga o modo.

function avisarAbaNativa(msg) {
  if (!MODO_NATIVO || state.abaNativa?.id == null) return;
  chrome.tabs.sendMessage(state.abaNativa.id, msg, { frameId: 0 }).catch(() => {});
}

// Um cartão espera o clique (Autorizar, partes): se o chat estiver na janela
// flutuante escondida, ele precisa aparecer.
function pedirAtencao() {
  avisarAbaNativa({ tipo: 'nativo:mostrar' });
}

function aplicarTemaNativo({ tema, fundo } = {}) {
  document.body.classList.toggle('nat-escuro', tema === 'escuro');
  const cor = corSegura(fundo);
  if (cor) document.body.style.setProperty('--nat-fundo-pagina', cor);
  else document.body.style.removeProperty('--nat-fundo-pagina');
}

function prepararModoNativo() {
  document.body.classList.add('nativo');
  // Primeira pintura já no tema da página (o content script manda no hash).
  aplicarTemaNativo({ tema: new URLSearchParams(location.hash.slice(1)).get('tema') });
  // Tema da Lovable trocado: vem do content script DESTA aba, do quadro
  // principal — nunca de outra aba, e a página em si não fala com a extensão.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if ((msg?.tipo !== 'nativo:tema' && msg?.tipo !== 'nativo:furo-lovable') || sender?.id !== chrome.runtime.id) return;
    if (state.abaNativa?.id == null || sender.tab?.id !== state.abaNativa.id || sender.frameId !== 0) return;
    if (msg.tipo === 'nativo:tema') aplicarTemaNativo(msg);
    else receberFuro(msg.furo);
  });
  // A vaga do "+" confere sozinha: outra tela por cima (configurações), o
  // campo mudando de tamanho — medir é barato.
  setInterval(conferirFuro, 400);
  // O content script manda o foco para o quadro (o campo da Lovable ficou
  // embaixo): vai direto para o nosso campo.
  window.addEventListener('focus', () => {
    if (!promptInput.disabled && !$('#view-chat').hidden) promptInput.focus();
  });
}

// ---------- O "+" do campo é o da Lovable ----------
// Pedido do dono (2026-09-30): o "+" abre o menu da própria Lovable; o nosso
// anexo é o clipe ao lado. O content script diz onde o "+" dela está; aqui a
// primeira vaga da linha de botões fica VAZIA naquele lugar, e só quando ela
// está no lugar e à vista (nenhuma outra tela por cima) o quadro confirma —
// aí o content script abre o furo e o clique cai no botão da Lovable.
let furoPedido = null;
let furoAvisado = 'null';
const vagaDoMais = $('#vaga-lovable');

function receberFuro(furo) {
  furoPedido = furoValido(furo);
  // O content script só avisa quando algo muda (ou o quadro recarregou):
  // responde sempre, mesmo que a decisão seja a de antes — uma resposta
  // perdida deixaria o "+" sem furo até a próxima mudança (revisão).
  furoAvisado = '';
  conferirFuro();
}

function conferirFuro() {
  if (!MODO_NATIVO || !vagaDoMais) return;
  vagaDoMais.hidden = !furoPedido;
  let aceito = null;
  if (furoPedido) {
    vagaDoMais.style.width = `${furoPedido.w}px`;
    vagaDoMais.style.height = `${furoPedido.h}px`;
    const b = vagaDoMais.getBoundingClientRect();
    const noLugar = furoAlinhado(furoPedido, { x: b.x, y: b.y, w: b.width, h: b.height });
    const aVista = document.elementFromPoint(furoPedido.x + furoPedido.w / 2, furoPedido.y + furoPedido.h / 2) === vagaDoMais;
    if (noLugar && aVista) aceito = furoPedido;
  }
  const texto = JSON.stringify(aceito);
  if (texto === furoAvisado) return;
  furoAvisado = texto;
  avisarAbaNativa({ tipo: 'nativo:furo', furo: aceito });
}

async function pedirFuroAoContentScript() {
  if (state.abaNativa?.id == null) return;
  try {
    const r = await chrome.tabs.sendMessage(state.abaNativa.id, { tipo: 'nativo:pedir-furo' }, { frameId: 0 });
    if (r) receberFuro(r.furo);
  } catch {
    /* o content script avisa sozinho quando medir */
  }
}

async function pedirTemaAoContentScript() {
  if (state.abaNativa?.id == null) return;
  try {
    const t = await chrome.tabs.sendMessage(state.abaNativa.id, { tipo: 'nativo:pedir-tema' }, { frameId: 0 });
    if (t) aplicarTemaNativo(t);
  } catch {
    /* fica o tema do hash */
  }
}

// Abre o painel lateral a partir do quadro: tem de ser a primeira coisa do
// clique (gesto do usuário), sem await antes.
function abrirPainelLateral() {
  if (state.abaNativa?.id == null) return;
  chrome.sidePanel.open({ tabId: state.abaNativa.id }).catch(() => {
    toast(`Clique no ícone do ${MARCA.nome} na barra do Chrome.`);
  });
}
$('#btn-nativo-painel')?.addEventListener('click', abrirPainelLateral);

// Fecha o painel lateral (Chrome 141+); antes disso, window.close() — os dois
// provados em 2026-09-30.
async function fecharPainelLateral() {
  try {
    const janela = await chrome.windows.getCurrent();
    await chrome.sidePanel.close({ windowId: janela.id });
    return;
  } catch {
    /* Chrome sem sidePanel.close */
  }
  window.close();
}

// Botão "Chat nativo" do painel lateral: só no PC, e só com o projeto certo
// aberto na aba da Lovable (o chat nativo aparece nela).
(() => {
  const botao = $('#btn-nativo');
  if (!botao) return;
  const noCelular = abreEmAba({
    userAgent: navigator.userAgent,
    temSidePanel: Boolean(chrome.sidePanel?.setPanelBehavior),
  });
  botao.hidden = MODO_NATIVO || noCelular;
  botao.addEventListener('click', async () => {
    if (state.running) {
      toast('Espere o pedido terminar.');
      return;
    }
    if (!state.project || !state.lovable?.projectId || state.lovableLock) {
      toast('Abra este projeto na Lovable para usar o chat nativo.');
      return;
    }
    // Aba da Lovable aberta ANTES de instalar/atualizar a extensão não tem o
    // content script (o do manifest só entra em página carregada depois): o
    // painel fechava e nada aparecia (revisão da 1.11). Confere e, se
    // preciso, injeta agora.
    const abaId = state.lovable.tabId;
    if (abaId != null && !(await chatNativoNaAba(abaId))) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: abaId, frameIds: [0] },
          files: ['nativo/guarda.js', 'nativo/conteudo.js'],
        });
      } catch {
        toast('Recarregue a página da Lovable (F5) e clique em "Chat nativo" de novo.');
        return;
      }
    }
    await storage.set({ nativo: { ligado: true } });
    await fecharPainelLateral();
  });
})();

async function chatNativoNaAba(abaId) {
  try {
    const r = await chrome.tabs.sendMessage(abaId, { tipo: 'nativo:ping' }, { frameId: 0 });
    return r?.ok === true;
  } catch {
    return false;
  }
}

// ---------- Várias janelas abertas ----------
// Painel e chat nativo (um por aba da Lovable) podem estar vivos ao mesmo
// tempo, cada um com as configurações na memória. Quem grava por último não
// pode desfazer o que outro gravou (um token do Supabase renovado lá seria
// trocado pelo velho aqui): cada janela acompanha as mudanças das outras.
chrome.storage.onChanged.addListener((mudou, area) => {
  if (area !== 'local') return;
  if ('settings' in mudou && !mudou.settings.newValue && state.settings) {
    // "Desconectar e apagar tudo" em outra janela: esta para o que estiver
    // rodando e recomeça do zero (revisão da 1.11 — o chat nativo, vivo até o
    // fim do pedido, regravava a chave, o token e a conversa apagados).
    state.desconectado = true;
    state.abort?.abort();
    setTimeout(() => location.reload(), 300);
    return;
  }
  const novas = mudou.settings?.newValue;
  if (novas && JSON.stringify(novas) !== JSON.stringify(state.settings)) {
    const antes = state.settings || {};
    state.settings = novas;
    if (novas.supabaseToken !== antes.supabaseToken) state.supabase = novas.supabaseToken ? new Supabase(novas.supabaseToken) : null;
    // Conta do GitHub trocada (ou desconectada) em outra janela: o próximo
    // pedido usa a nova — ou não roda.
    if (novas.githubToken !== antes.githubToken) state.github = novas.githubToken ? new GitHub(novas.githubToken) : null;
    applyModeUI();
    updateLicenseUI();
  }
  if ('chatgpt' in mudou) state.chatgpt = mudou.chatgpt.newValue || null;
});

// ---------- Start ----------

init();
