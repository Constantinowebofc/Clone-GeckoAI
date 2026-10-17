// Chat nativo (1.11.0): o chat do GeckoAI no lugar do chat da Lovable.
//
// Aqui fica só a parte que dá para testar sem navegador: ONDE o nosso chat
// fica, onde o gecko fica, e que cor/tema passa para dentro do quadro. Quem
// mede a página e desenha é o content script (nativo/conteudo.js), que carrega
// este módulo por import() — por isso ele está em web_accessible_resources.
//
// Medido na Lovable real (2026-09-30): a coluna do chat é
// `section#sidebar-panel` (aria-label "Chat"), logo abaixo da barra com o nome
// do projeto; o campo é `form[data-testid=chat-composer]`. Cobrimos a coluna
// inteira e nada acima dela — o nome do projeto e o menu dele continuam da
// Lovable.

export const TAMANHO_GECKO = 36;

const RE_PROJETO = /^https:\/\/(?:www\.)?lovable\.dev\/projects\/([a-z0-9-]{10,})(?=[/?#]|$)/i;

/** Id do projeto (minúsculo, como o painel guarda) ou null fora de um projeto. */
export function projetoDaUrl(url) {
  const m = RE_PROJETO.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : null;
}

const limitar = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * A área a cobrir: o primeiro candidato (em ordem de confiança) que tem cara
 * de coluna de chat — larga o bastante, alta, à esquerda. Nenhum? null, e o
 * content script usa a janela flutuante: melhor que cobrir o lugar errado.
 * @param {{tela:{w,h}, candidatos?:Array<{fonte:string, r:{x,y,w,h}}>}} medidas
 */
export function areaDoChat({ tela, candidatos = [] } = {}) {
  if (!tela) return null;
  for (const c of candidatos) {
    const r = c?.r;
    if (!r) continue;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(tela.w, r.x + r.w);
    const y1 = Math.min(tela.h, r.y + r.h);
    const w = x1 - x0;
    const h = y1 - y0;
    const pareceColuna = w >= 240 && w <= tela.w * 0.7 && h >= tela.h * 0.45
      && x0 <= tela.w * 0.4 && y0 <= tela.h * 0.35;
    if (pareceColuna) {
      return { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h), fonte: c.fonte };
    }
  }
  return null;
}

/** Janela flutuante (quando não há coluna): canto inferior esquerdo. */
export function janelaFlutuante(tela) {
  const w = Math.min(400, tela.w - 32);
  const h = Math.min(640, Math.round(tela.h * 0.85));
  return { x: 16, y: Math.max(0, tela.h - h - 16), w, h };
}

/**
 * Onde o gecko fica. Guardado em FRAÇÃO da tela (a janela muda de tamanho),
 * sempre dentro dela. Sem posição guardada: na barra do nome do projeto, logo
 * acima da área (na Lovable real há espaço livre entre o nome e os ícones da
 * direita) — dentro da área ele cobria a primeira mensagem. Sem espaço acima,
 * no canto de cima da área.
 */
export function posicaoDoGecko(salva, tela, area) {
  const maxX = tela.w - TAMANHO_GECKO - 4;
  const maxY = tela.h - TAMANHO_GECKO - 4;
  const fx = salva?.fx;
  const fy = salva?.fy;
  if (Number.isFinite(fx) && Number.isFinite(fy) && fx >= 0 && fy >= 0) {
    return { x: limitar(Math.round(fx * tela.w), 4, maxX), y: limitar(Math.round(fy * tela.h), 4, maxY) };
  }
  if (area) {
    const cabeAcima = area.y >= TAMANHO_GECKO + 10;
    return {
      x: limitar(area.x + area.w - TAMANHO_GECKO - (cabeAcima ? 70 : 10), 4, maxX),
      y: limitar(cabeAcima ? area.y - TAMANHO_GECKO - 6 : area.y + 10, 4, maxY),
    };
  }
  return { x: limitar(tela.w - TAMANHO_GECKO - 20, 4, maxX), y: limitar(tela.h - TAMANHO_GECKO - 96, 4, maxY) };
}

export function fracaoDoGecko(pos, tela) {
  const q = (v) => Math.round(v * 10000) / 10000;
  return { fx: q(pos.x / tela.w), fy: q(pos.y / tela.h) };
}

const RE_COR = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9a-z.%,\s/+-]*\))$/i;

/** Só cor de verdade vai para dentro do quadro (vira variável CSS lá). */
export function corSegura(valor) {
  if (typeof valor !== 'string' || valor.length > 60) return null;
  const v = valor.trim();
  return RE_COR.test(v) ? v : null;
}

// Luz aproximada de uma cor de fundo: basta para dizer claro/escuro.
function luz(cor) {
  const s = String(cor ?? '');
  const ok = /oklch\(\s*([\d.]+)(%?)/i.exec(s);
  if (ok) return Number(ok[1]) / (ok[2] ? 100 : 1);
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (rgb) return (0.2126 * rgb[1] + 0.7152 * rgb[2] + 0.0722 * rgb[3]) / 255;
  return null;
}

/** A Lovable marca o tema no <html> ("light"/"dark"); sem marca, pela luz do fundo. */
export function temaDaPagina(classeDoHtml, fundo) {
  const c = String(classeDoHtml ?? '');
  if (/\bdark\b/.test(c)) return 'escuro';
  if (/\blight\b/.test(c)) return 'claro';
  const l = luz(fundo);
  return l !== null && l < 0.5 ? 'escuro' : 'claro';
}

export function dentroDaArea(ponto, area) {
  if (!area || !ponto) return false;
  return ponto.x >= area.x && ponto.x < area.x + area.w && ponto.y >= area.y && ponto.y < area.y + area.h;
}

// ---------- O "+" do campo continua sendo o da Lovable ----------
// Pedido do dono (2026-09-30): o "+" abre o menu da PRÓPRIA Lovable, e o
// nosso anexo é um clipe ao lado. O quadro abre um furo exatamente em cima do
// botão dela (clip-path no iframe: a área recortada não recebe clique, que cai
// no botão de verdade) — o content script continua sem clicar em nada.
// Medido na Lovable real: `[data-testid=chat-input-action-menu-trigger]`
// ("Ações do chat"), 28×28, redondo, a 12 px do canto de baixo do campo.

/**
 * Onde está o "+" da Lovable, relativo à área coberta — ou null quando não dá
 * para abrir o furo com segurança (fora da área, tamanho que não é de botão).
 * @param {{area:{x,y,w,h}, mais:{x,y,w,h}, raio?:number}} medidas
 */
export function furoDoMais({ area, mais, raio } = {}) {
  if (!area || !mais) return null;
  const { x, y, w, h } = mais;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 16 || h < 16 || w > 48 || h > 48) return null;
  const rx = x - area.x;
  const ry = y - area.y;
  if (rx < 0 || ry < 0 || rx + w > area.w || ry + h > area.h) return null;
  const r = Number.isFinite(raio) && raio >= 0 ? Math.min(raio, w / 2, h / 2) : Math.min(w, h) / 2;
  return { x: Math.round(rx), y: Math.round(ry), w: Math.round(w), h: Math.round(h), raio: Math.round(r) };
}

/** O que chega por mensagem vira furo só se for número de verdade. */
export function furoValido(f) {
  if (!f || typeof f !== 'object') return null;
  const { x, y, w, h, raio } = f;
  if (![x, y, w, h, raio].every((v) => Number.isFinite(v) && v >= 0 && v <= 10000)) return null;
  if (w < 16 || h < 16 || w > 48 || h > 48) return null;
  return { x, y, w, h, raio };
}

/** O mesmo furo (campo a campo — o que o quadro devolve é o que recebeu). */
export function mesmoFuro(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.raio === b.raio;
}

/** A vaga que o quadro deixou vazia está onde o "+" da Lovable está? */
export function furoAlinhado(furo, vaga, folga = 4) {
  if (!furo || !vaga) return false;
  return Math.abs(furo.x - vaga.x) <= folga && Math.abs(furo.y - vaga.y) <= folga
    && Math.abs(furo.w - vaga.w) <= folga && Math.abs(furo.h - vaga.h) <= folga;
}

/**
 * clip-path do quadro: tudo, menos o furo (retângulo arredondado com 1 px de
 * folga em volta do botão, para o contorno dele aparecer inteiro).
 */
export function recorteComFuro(tamanho, furo) {
  const n = (v) => Math.round(v * 100) / 100;
  const W = n(tamanho.w);
  const H = n(tamanho.h);
  const x = furo.x - 1;
  const y = furo.y - 1;
  const w = furo.w + 2;
  const h = furo.h + 2;
  const r = n(Math.min(furo.raio + 1, w / 2, h / 2));
  const arco = (px, py) => `A${r} ${r} 0 0 1 ${n(px)} ${n(py)}`;
  const buraco = `M${n(x + r)} ${n(y)}H${n(x + w - r)}${arco(x + w, y + r)}V${n(y + h - r)}${arco(x + w - r, y + h)}`
    + `H${n(x + r)}${arco(x, y + h - r)}V${n(y + r)}${arco(x + r, y)}Z`;
  return `path(evenodd, "M0 0H${W}V${H}H0Z ${buraco}")`;
}
