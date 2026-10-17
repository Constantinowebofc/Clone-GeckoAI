// Preview do GeckoAI: mostra o site publicado (Vercel) num iframe.
// O painel escreve previewPing no chrome.storage após cada commit; com token da
// Vercel, aqui a gente acompanha o deploy e recarrega quando ficar READY.

import { Vercel } from '../lib/vercel.js';
import { MARCA } from '../lib/marca.js';

const $ = (s) => document.querySelector(s);
const repo = new URLSearchParams(location.search).get('repo');

let link = null;      // { projectId?, name?, url }
let token = null;
let teamId = null;    // integração instalada num time da Vercel (ou null)
let ultimoUid = null; // deploy que está na tela
let polling = false;

function status(tom, texto) {
  $('#status').className = `status ${tom}`;
  $('#status-text').textContent = texto;
}

function recarregar() {
  const frame = $('#frame');
  frame.src = link.url;
}

async function init() {
  const data = await chrome.storage.local.get(['vercelMap', 'settings']);
  link = data.vercelMap?.[repo] || null;
  token = data.settings?.vercelToken || null;
  teamId = data.settings?.vercelTeamId || null;
  $('#site-name').textContent = repo || 'Preview';
  document.title = `${repo} — Preview ${MARCA.nome}`;
  document.querySelectorAll('[data-marca]').forEach((n) => { n.textContent = MARCA.nome; });

  if (!link?.url) {
    $('#frame').hidden = true;
    $('#empty').hidden = false;
    status('err', 'Sem site vinculado');
    return;
  }
  $('#addr').textContent = link.url.replace(/^https:\/\//, '');
  $('#btn-open').href = link.url;
  recarregar();
  status('ok', 'No ar');

  if (token && link.projectId) {
    // Guarda o deploy atual e cobre um deploy que já esteja no meio do caminho.
    const dep = await new Vercel(token, teamId).latestDeployment(link.projectId).catch(() => null);
    ultimoUid = dep?.uid || null;
    if (dep && dep.state !== 'READY') vigiarDeploy();
  }
}

// Espera aparecer um deploy novo (uid diferente) e recarrega quando READY.
async function vigiarDeploy() {
  if (polling || !token || !link?.projectId) return;
  polling = true;
  status('run', 'Publicando…');
  const vercel = new Vercel(token, teamId);
  const inicio = Date.now();
  try {
    while (Date.now() - inicio < 4 * 60_000) {
      const dep = await vercel.latestDeployment(link.projectId).catch(() => null);
      if (dep && dep.uid !== ultimoUid && dep.state === 'READY') {
        ultimoUid = dep.uid;
        recarregar();
        status('ok', 'No ar');
        return;
      }
      if (dep && dep.uid !== ultimoUid && dep.state === 'ERROR') {
        status('err', 'Falha no deploy — veja na Vercel');
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    status('ok', 'No ar');
  } finally {
    polling = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const ping = changes.previewPing?.newValue;
  if (ping?.repo !== repo) return;
  if (token && link?.projectId) {
    vigiarDeploy();
  } else if (link?.url) {
    // Sem token não dá para saber quando o deploy termina: avisa e deixa o refresh.
    status('run', 'Commit enviado — recarregue em ~1 min');
  }
});

$('#btn-reload').addEventListener('click', () => { recarregar(); status('ok', 'No ar'); });
$('#btn-device').addEventListener('click', () => $('#stage').classList.toggle('mobile'));

init();
