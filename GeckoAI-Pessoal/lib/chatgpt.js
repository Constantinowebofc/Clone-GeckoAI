// A conta do ChatGPT do PRÓPRIO cliente (v1.6.0, 2026-09-25): login,
// renovação, catálogo de modelos e limite de uso.
//
// O cliente conecta a assinatura dele (Plus/Pro) e os pedidos rodam por ela,
// direto do navegador para a OpenAI: nada passa pelo nosso servidor e nada
// desconta prompt (decisão do dono). É a ÚNICA exceção à regra "nada no pacote
// cita provedor de IA": a IA dos prompts continua escondida no servidor.
//
// O login usa o cliente OAuth público do Codex (o mesmo de OpenCode, Cline e
// OpenClaw). O redirect registrado dele é http://localhost:1455/auth/callback;
// a extensão não escuta porta, então a aba navega para lá, o Chrome mostra a
// página de erro, e o painel lê o código pela URL da aba. Provado na conta
// Plus do dono em 2026-09-25, e a OpenAI aceitou `originator: geckoai` — não
// nos passamos pelo Codex na identificação, só o client_id é o dele.
//
// Sem chrome.* aqui dentro: aba e fetch chegam por injeção (como lib/oauth.js).
// Nenhuma mensagem cita marca: quem acrescenta o nome é o painel.

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER = 'https://auth.openai.com';
export const REDIRECT = 'http://localhost:1455/auth/callback';
export const ORIGINATOR = 'geckoai';
export const API = 'https://chatgpt.com/backend-api/codex';
// Pedidas só no clique de Conectar (optional_host_permissions): quem nunca
// conectar instala exatamente como antes.
export const HOSTS = ['https://auth.openai.com/*', 'https://chatgpt.com/*'];
// O catálogo filtra modelos por versão do cliente; com esta a conta Plus do
// dono recebeu a lista inteira (gpt-6-*, gpt-5.6-*, gpt-5.5).
const VERSAO_CLIENTE = '1.0.0';
// Mesmo escopo do Codex oficial (codex-rs/login/src/server.rs). Sem os dois
// api.connectors.*, há relato de conta grátis recebendo insufficient_quota.
const ESCOPO = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const DIA = 86_400_000;

// Quando o catálogo não vem (rede, formato novo): o único modelo validado de
// ponta a ponta na prova técnica.
export const CATALOGO_RESERVA = [
  {
    slug: 'gpt-5.5',
    nome: 'GPT-5.5',
    niveis: [
      { effort: 'low', descricao: '' },
      { effort: 'medium', descricao: '' },
      { effort: 'high', descricao: '' },
    ],
    nivelPadrao: 'medium',
    resumo: true,
  },
];

// codigo: 'login' | 'limite' | 'plano' | 'acesso' | 'modelo' | 'falhou'.
// `retomavel`: o provedor não pode continuar AGORA, mas o que já foi preparado
// vale — o agente guarda o trabalho em vez de jogar fora (ver lib/agent.js).
export class ChatGPTError extends Error {
  constructor(message, { codigo = 'falhou', status = null, retomavel = false, limite = null } = {}) {
    super(message);
    this.name = 'ChatGPTError';
    this.codigo = codigo;
    this.status = status;
    this.retomavel = retomavel;
    this.limite = limite;
  }
}

// ---------- login ----------

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gerarPkce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)), (b) => chars[b % chars.length]).join('');
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function novoState() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function urlDeLogin({ challenge, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: ESCOPO,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: ORIGINATOR,
  });
  return `${ISSUER}/oauth/authorize?${p}`;
}

// A URL em que a aba de login terminou -> o código. Qualquer coisa fora do
// esperado para aqui: state trocado é tentativa de CSRF, não "quase certo".
export function lerRetorno(url, state) {
  let u;
  try { u = new URL(url); } catch { u = null; }
  if (!u) throw new ChatGPTError('O login do ChatGPT não voltou como esperado.', { codigo: 'login' });
  const erro = u.searchParams.get('error');
  if (erro) {
    throw new ChatGPTError('O login do ChatGPT foi cancelado ou recusado.', { codigo: 'login' });
  }
  if (u.searchParams.get('state') !== state) {
    throw new ChatGPTError('O login do ChatGPT não pôde ser confirmado. Tente de novo.', { codigo: 'login' });
  }
  const code = u.searchParams.get('code');
  if (!code) throw new ChatGPTError('O login do ChatGPT voltou sem autorização. Tente de novo.', { codigo: 'login' });
  return code;
}

export function claims(jwt) {
  try {
    const p = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '==='.slice((p.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

const AUTH = 'https://api.openai.com/auth';

export function contaDoToken(tokens) {
  for (const jwt of [tokens?.id_token, tokens?.access_token]) {
    const c = claims(jwt);
    const id = c.chatgpt_account_id || c[AUTH]?.chatgpt_account_id || c.organizations?.[0]?.id;
    if (id) return id;
  }
  return null;
}

export function planoDoToken(tokens) {
  for (const jwt of [tokens?.id_token, tokens?.access_token]) {
    const c = claims(jwt);
    const p = c[AUTH]?.chatgpt_plan_type || c.chatgpt_plan_type;
    if (p) return p;
  }
  return null;
}

// earliest_refresh_at chegou sem documentação: aceita segundos, ms ou data.
function instante(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return instante(n);
    const d = Date.parse(v);
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

function contaDosTokens(tokens, anterior, agora) {
  return {
    ...(anterior || {}),
    access: tokens.access_token,
    refresh: tokens.refresh_token || anterior?.refresh || null,
    expira: agora + (tokens.expires_in ?? 3600) * 1000,
    renovarApos: instante(tokens.earliest_refresh_at),
    conta: contaDoToken(tokens) || anterior?.conta || null,
    plano: planoDoToken(tokens) || anterior?.plano || null,
  };
}

async function pedirToken(fetchFn, corpo, codigoDeErro) {
  let res;
  try {
    res = await fetchFn(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(corpo).toString(),
    });
  } catch {
    throw new ChatGPTError('Sem conexão com a OpenAI agora. Tente de novo.', { codigo: codigoDeErro });
  }
  if (!res.ok) {
    throw new ChatGPTError(
      codigoDeErro === 'acesso'
        ? 'Sua conta do ChatGPT desconectou. Conecte de novo.'
        : 'A OpenAI não confirmou o login. Tente de novo.',
      { codigo: codigoDeErro, status: res.status }
    );
  }
  return res.json();
}

// Abre a aba de login, espera ela voltar no redirect e troca o código.
//   abrirAba(url) -> id da aba
//   esperarRetorno(id, prefixo) -> URL em que a aba parou (rejeita se fechada)
//   fecharAba(id)
export async function conectar({ abrirAba, esperarRetorno, fecharAba, fetch = globalThis.fetch, agora = () => Date.now() }) {
  const { verifier, challenge } = await gerarPkce();
  const state = novoState();
  const aba = await abrirAba(urlDeLogin({ challenge, state }));
  let code;
  try {
    code = lerRetorno(await esperarRetorno(aba, REDIRECT), state);
  } finally {
    try { await fecharAba(aba); } catch { /* a aba já pode ter sido fechada */ }
  }
  const tokens = await pedirToken(fetch, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }, 'login');
  return contaDosTokens(tokens, null, agora());
}

// ---------- renovação ----------

// O acesso dura 10 dias. Renova com um dia de folga, mas nunca antes do
// earliest_refresh_at que a própria OpenAI manda — exceto se já venceu.
export function precisaRenovar(conta, agora = Date.now()) {
  if (!conta?.refresh) return false;
  if (agora >= (conta.expira || 0) - 60_000) return true;
  return (conta.expira || 0) - agora < DIA && agora >= (conta.renovarApos || 0);
}

export async function renovar(conta, { fetch = globalThis.fetch, agora = () => Date.now() } = {}) {
  const tokens = await pedirToken(fetch, {
    grant_type: 'refresh_token',
    refresh_token: conta.refresh,
    client_id: CLIENT_ID,
  }, 'acesso');
  return contaDosTokens(tokens, conta, agora());
}

// ---------- catálogo e escolhas do cliente ----------

function cabecalhosDaConta(access, conta) {
  const h = { authorization: `Bearer ${access}`, originator: ORIGINATOR };
  if (conta) h['chatgpt-account-id'] = conta;
  return h;
}

// Resposta de /models (struct ModelInfo do Codex) -> o que o seletor mostra.
// visibility 'list' vai para a lista; 'hide'/'none' não. priority: menor
// primeiro (o Codex ordena com sort_by_key(priority)).
export function lerCatalogo(json) {
  const lista = Array.isArray(json?.models) ? json.models : [];
  const modelos = lista
    .filter((m) => m && typeof m.slug === 'string' && String(m.visibility ?? 'list').toLowerCase() === 'list')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => ({
      slug: m.slug,
      nome: m.display_name || m.slug,
      niveis: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((n) => (typeof n === 'string'
          ? { effort: n, descricao: '' }
          : { effort: String(n?.effort ?? ''), descricao: String(n?.description ?? '') }))
        .filter((n) => n.effort),
      nivelPadrao: m.default_reasoning_level || null,
      resumo: m.supports_reasoning_summary_parameter !== false,
    }));
  return modelos.length ? modelos : CATALOGO_RESERVA;
}

export async function buscarCatalogo({ access, conta, fetch = globalThis.fetch }) {
  let res;
  try {
    res = await fetch(`${API}/models?client_version=${VERSAO_CLIENTE}`, {
      headers: cabecalhosDaConta(access, conta),
    });
  } catch {
    return CATALOGO_RESERVA;
  }
  if (res.status === 401 || res.status === 403) {
    throw new ChatGPTError('Sua conta do ChatGPT desconectou. Conecte de novo.', { codigo: 'acesso', status: res.status, retomavel: true });
  }
  if (!res.ok) return CATALOGO_RESERVA;
  return lerCatalogo(await res.json().catch(() => null));
}

function modelosDe(dados) {
  const m = dados?.catalogo?.modelos;
  return Array.isArray(m) && m.length ? m : CATALOGO_RESERVA;
}

export function modeloEscolhido(dados) {
  const lista = modelosDe(dados);
  return lista.find((m) => m.slug === dados?.modelo) || lista[0];
}

// O nível que vai no pedido: o que o cliente escolheu para ESTE modelo, se o
// modelo ainda aceitar; senão o padrão do modelo; senão "medium"; senão o
// primeiro. null = modelo sem níveis (o pedido vai sem effort).
export function esforcoDe(dados, slug) {
  const modelo = modelosDe(dados).find((m) => m.slug === slug) || modeloEscolhido(dados);
  const aceitos = (modelo.niveis || []).map((n) => n.effort);
  const guardado = dados?.esforcos?.[modelo.slug];
  if (!aceitos.length) return modelo.nivelPadrao || null;
  if (guardado && aceitos.includes(guardado)) return guardado;
  if (modelo.nivelPadrao && aceitos.includes(modelo.nivelPadrao)) return modelo.nivelPadrao;
  if (aceitos.includes('medium')) return 'medium';
  return aceitos[0];
}

const NOMES_DOS_NIVEIS = {
  none: 'Nenhum',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
};

export function rotuloDoNivel(effort) {
  return NOMES_DOS_NIVEIS[effort] || effort;
}

// ---------- limite de uso ----------

// Os cabeçalhos que o próprio Codex lê para mostrar "você usou X%". Lista
// fechada de propósito: x-codex-turn-state (estado cifrado) nunca sai daqui.
export function lerLimite(headers) {
  const num = (k) => {
    const v = headers?.get?.(k);
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const janela5h = num('x-codex-primary-used-percent');
  const semanal = num('x-codex-secondary-used-percent');
  if (janela5h == null && semanal == null) return null;
  const emMs = (k) => {
    const n = num(k);
    return n == null ? null : n * 1000;
  };
  return {
    janela5h,
    semanal,
    reset5h: emMs('x-codex-primary-reset-at'),
    resetSemanal: emMs('x-codex-secondary-reset-at'),
  };
}

// Quando o cliente pode voltar a usar: a janela que estourou manda.
export function quandoVolta(limite) {
  if (!limite) return null;
  if ((limite.semanal ?? 0) >= 100 && limite.resetSemanal) return limite.resetSemanal;
  return limite.reset5h ?? limite.resetSemanal ?? null;
}

export function textoDoLimite(limite) {
  if (!limite || limite.janela5h == null) return null;
  return `ChatGPT ${Math.round(limite.janela5h)}%`;
}

// Uso da assinatura SEM chamar a IA (não gasta nada do limite): é daqui que o
// /status do Codex oficial lê (codex-rs/backend-client: GET
// {backend-api}/wham/usage). Faz o selo "ChatGPT 3%" aparecer logo ao
// conectar e ao abrir o painel, não só depois do primeiro pedido.
export function limiteDoUso(json) {
  const rl = json?.rate_limit;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const janela5h = num(rl?.primary_window?.used_percent);
  const semanal = num(rl?.secondary_window?.used_percent);
  if (janela5h == null && semanal == null) return null;
  const emMs = (w) => (num(w?.reset_at) == null ? null : num(w.reset_at) * 1000);
  return {
    janela5h,
    semanal,
    reset5h: emMs(rl?.primary_window),
    resetSemanal: emMs(rl?.secondary_window),
  };
}

// Informação de fundo: qualquer falha (rede, acesso, formato novo) vira null e
// o selo espera o primeiro pedido, que traz o uso nos cabeçalhos.
export async function buscarUso({ access, conta, fetch = globalThis.fetch }) {
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: cabecalhosDaConta(access, conta),
    });
    if (!res.ok) return null;
    return limiteDoUso(await res.json());
  } catch {
    return null;
  }
}

// Resposta de erro do backend -> ChatGPTError em português. Formato do 429
// tirado do código aberto do Codex (codex-api/src/api_bridge.rs):
// {"error":{"type":"usage_limit_reached","resets_at":<segundos>,"plan_type":...}}.
// O corpo cru nunca vira mensagem: pode trazer HTML, ids ou coisa pior.
export async function erroDaResposta(res) {
  const status = res.status;
  const texto = await res.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(texto); } catch { j = null; }
  const tipo = j?.error?.type || j?.error?.code || null;

  if (status === 429) {
    if (tipo === 'usage_not_included' || tipo === 'insufficient_quota') {
      return new ChatGPTError(
        'Sua assinatura do ChatGPT não inclui este uso: ele funciona com ChatGPT Plus ou Pro.',
        { codigo: 'plano', status, retomavel: true }
      );
    }
    const limite = lerLimite(res.headers) || { janela5h: null, semanal: null, reset5h: null, resetSemanal: null };
    const reset = Number(j?.error?.resets_at);
    if (Number.isFinite(reset) && reset > 0) {
      limite.reset5h = reset * 1000;
      if ((limite.semanal ?? 0) >= 100) limite.resetSemanal = reset * 1000;
    }
    return new ChatGPTError('O limite da sua assinatura do ChatGPT acabou por enquanto.', {
      codigo: 'limite', status, retomavel: true, limite,
    });
  }
  if (status === 401 || status === 403) {
    return new ChatGPTError('Sua conta do ChatGPT desconectou. Conecte de novo.', { codigo: 'acesso', status, retomavel: true });
  }
  const detalhe = String(j?.detail || j?.error?.message || '');
  if (status === 400 && /not supported/i.test(detalhe)) {
    return new ChatGPTError('Este modelo não está disponível na sua conta do ChatGPT. Escolha outro.', { codigo: 'modelo', status });
  }
  return new ChatGPTError(`O ChatGPT não respondeu como esperado (${status}). Tente de novo.`, { codigo: 'falhou', status });
}
