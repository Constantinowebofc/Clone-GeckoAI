// GeckoAI — service worker.
// O trabalho pesado (agente de IA, chamadas ao GitHub e ao servidor) roda no
// painel, que permanece vivo enquanto estiver aberto. Aqui só decidimos COMO
// o painel abre quando o usuário clica no ícone da extensão:
//
// - PC (Chrome/Edge): painel lateral, como sempre.
// - Celular (Quetta e outros navegadores Android com extensões) ou navegador
//   sem `chrome.sidePanel`: numa ABA de tela cheia — no celular não existe
//   painel lateral, e sem isso o clique no ícone não abria nada.
//
// A decisão (lib/plataforma.js) não usa `chrome.*`, para ser testável.

import { abreEmAba, achaAbaDoPainel } from './lib/plataforma.js';

const URL_DO_PAINEL = chrome.runtime.getURL('sidepanel/panel.html');

const emAba = abreEmAba({
  userAgent: navigator.userAgent,
  temSidePanel: Boolean(chrome.sidePanel?.setPanelBehavior),
});

function configurarPainelLateral() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  // No celular o clique tem de chegar ao onClicked abaixo; com o painel
  // lateral ligado ele seria engolido pelo Chrome.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: !emAba })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(configurarPainelLateral);
chrome.runtime.onStartup?.addListener(configurarPainelLateral);

// ---------- Chat nativo (1.11.0) ----------
// O chat do GeckoAI no lugar do chat da Lovable: o content script
// (nativo/conteudo.js) desenha o quadro com o próprio painel dentro. Ele roda
// na página da Lovable, então o storage da extensão fica TRANCADO para ele —
// só as páginas da extensão (painel, quadro) e este service worker leem os
// tokens. O que o content script precisa passa por mensagem, aqui.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {});

const ABAS_DA_LOVABLE = ['https://lovable.dev/*', 'https://www.lovable.dev/*'];
const RE_LOVABLE = /^https:\/\/(?:www\.)?lovable\.dev\//;

// Só o NOSSO content script, numa aba da Lovable: a página em si não fala
// com a extensão (não há externally_connectable).
function daLovable(sender) {
  return sender?.id === chrome.runtime.id && RE_LOVABLE.test(sender?.tab?.url || '');
}

async function avisarAbasDaLovable(msg) {
  try {
    const abas = await chrome.tabs.query({ url: ABAS_DA_LOVABLE });
    for (const aba of abas) chrome.tabs.sendMessage(aba.id, msg).catch(() => {});
  } catch {
    /* sem abas: nada a avisar */
  }
}

const fracao = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (!msg?.tipo?.startsWith?.('nativo:') || !daLovable(sender)) return;
  if (msg.tipo === 'nativo:abrir-painel') {
    // Primeira coisa da mensagem: o clique no gecko vale como gesto do usuário
    // (provado em 2026-09-30), e um await antes poderia perdê-lo.
    chrome.sidePanel
      .open({ tabId: sender.tab.id })
      .then(() => responder({ ok: true }), (e) => responder({ ok: false, erro: e?.message || String(e) }));
    return true;
  }
  if (msg.tipo === 'nativo:estado') {
    chrome.storage.local.get(['nativo', 'nativoGecko']).then((d) => {
      responder({ ligado: d.nativo?.ligado === true, gecko: d.nativoGecko || null });
    }, () => responder({ ligado: false, gecko: null }));
    return true;
  }
  if (msg.tipo === 'nativo:gecko') {
    if (fracao(msg.fx) && fracao(msg.fy)) chrome.storage.local.set({ nativoGecko: { fx: msg.fx, fy: msg.fy } });
    return;
  }
  if (msg.tipo === 'nativo:desligar') {
    chrome.storage.local.set({ nativo: { ligado: false } });
    return;
  }
  if (msg.tipo === 'nativo:diag') {
    // Rastro sem texto da página (medidas e cores), para ajustar quando a
    // Lovable mudar o layout — legível no storage do cliente sem DevTools.
    const texto = JSON.stringify(msg.diag ?? null);
    if (texto.length <= 16_000) chrome.storage.local.set({ nativoDiag: { em: new Date().toISOString(), ...msg.diag } });
  }
});

// Ligou/desligou (no painel, pelo gecko, ou o painel abrindo): as abas da
// Lovable montam ou tiram o chat na hora.
chrome.storage.onChanged.addListener((mudou, area) => {
  if (area !== 'local' || !mudou.nativo) return;
  avisarAbasDaLovable({ tipo: 'nativo:estado', ligado: mudou.nativo.newValue?.ligado === true });
});

// Só dispara quando o painel lateral NÃO engole o clique (celular, ou
// navegador sem a API). Reaproveita a aba do painel se já estiver aberta.
chrome.action.onClicked.addListener(async () => {
  try {
    const abas = await chrome.tabs.query({ url: `${URL_DO_PAINEL}*` });
    const aberta = achaAbaDoPainel(abas, URL_DO_PAINEL);
    if (aberta?.id != null) {
      await chrome.tabs.update(aberta.id, { active: true });
      return;
    }
  } catch {
    /* sem acesso às abas: abre uma nova */
  }
  await chrome.tabs.create({ url: URL_DO_PAINEL, active: true });
});
