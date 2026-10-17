// Página aberta em ABA só quando o Chrome recusa o microfone no painel lateral:
// lá o pedido de permissão às vezes não aparece. A permissão é por origem, então
// autorizar aqui vale para o painel também — acontece uma vez por instalação.

import { MARCA } from '../lib/marca.js';

document.title = `${MARCA.nome} — permitir o microfone`;

const estado = document.querySelector('#estado');
const dica = document.querySelector('#dica');
const btn = document.querySelector('#btn-tentar');

async function pedir() {
  btn.hidden = true;
  estado.className = '';
  estado.textContent = 'Pedindo a permissão ao Chrome…';
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    fluxo.getTracks().forEach((t) => t.stop()); // só queríamos a permissão
    estado.className = 'ok';
    estado.textContent = `Pronto! Volte ao ${MARCA.nome} e clique no microfone.`;
    dica.hidden = true;
    setTimeout(fechar, 2200);
  } catch (err) {
    estado.className = 'erro';
    estado.textContent =
      err?.name === 'NotFoundError'
        ? 'Nenhum microfone encontrado. Conecte um e tente de novo.'
        : 'Não deu para liberar o microfone.';
    dica.hidden = false;
    btn.hidden = false;
  }
}

async function fechar() {
  try {
    const aba = await chrome.tabs.getCurrent();
    if (aba?.id) {
      await chrome.tabs.remove(aba.id);
      return;
    }
  } catch {
    /* sem permissão de abas: o window.close abaixo resolve */
  }
  window.close();
}

btn.addEventListener('click', pedir);
pedir();
