// Resumo da IA formatado: negrito, código, listas e títulos — o pedaço de
// Markdown que as IAs usam nos resumos. Antes o painel mostrava o texto cru e o
// cliente lia "**3 tarefas**" com os asteriscos (teste do dono, 2026-09-29).
//
// Puro e sem DOM: devolve blocos que o painel monta com elementos (textContent,
// nunca innerHTML) — o resumo vem da IA, e um arquivo do repositório com
// instrução injetada não pode virar HTML na tela.
//
// Bloco: {tipo:'p'|'titulo', partes} | {tipo:'lista', ordenada, inicio?, itens:[partes]}
//        | {tipo:'codigo', texto}
// Parte: {tipo:'texto'|'negrito'|'codigo', texto}

const ITEM = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;
const TITULO = /^\s*#{1,6}\s+(.*)$/;
const CERCA = /^\s*```/;

/** Marcas de linha: **negrito** e `código`. Marca sem fechamento fica como texto. */
export function partesDaLinha(linha) {
  const partes = [];
  let texto = '';
  let i = 0;
  const s = String(linha);
  const soltaTexto = () => {
    if (texto) partes.push({ tipo: 'texto', texto });
    texto = '';
  };
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const fim = s.indexOf('**', i + 2);
      if (fim > i + 2) {
        soltaTexto();
        partes.push({ tipo: 'negrito', texto: s.slice(i + 2, fim) });
        i = fim + 2;
        continue;
      }
    } else if (s[i] === '`') {
      const fim = s.indexOf('`', i + 1);
      if (fim > i + 1) {
        soltaTexto();
        partes.push({ tipo: 'codigo', texto: s.slice(i + 1, fim) });
        i = fim + 1;
        continue;
      }
    }
    texto += s[i];
    i++;
  }
  soltaTexto();
  return partes;
}

// Junta as partes de linhas seguidas de um parágrafo com a quebra de linha
// entre elas (o texto ao lado da quebra se funde, para não sobrar pedaço solto).
function juntarLinhas(linhas) {
  const partes = [];
  linhas.forEach((linha, k) => {
    if (k > 0) partes.push({ tipo: 'texto', texto: '\n' });
    partes.push(...partesDaLinha(linha));
  });
  const fundidas = [];
  for (const p of partes) {
    const ultima = fundidas[fundidas.length - 1];
    if (p.tipo === 'texto' && ultima?.tipo === 'texto') ultima.texto += p.texto;
    else fundidas.push({ ...p });
  }
  return fundidas;
}

export function blocosDoResumo(entrada) {
  const linhas = String(entrada ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocos = [];
  let paragrafo = [];
  let lista = null;
  let cerca = null;

  const fecharParagrafo = () => {
    if (paragrafo.length) blocos.push({ tipo: 'p', partes: juntarLinhas(paragrafo) });
    paragrafo = [];
  };
  const fecharLista = () => {
    if (lista) blocos.push(lista);
    lista = null;
  };

  for (const linha of linhas) {
    if (cerca) {
      if (CERCA.test(linha)) {
        blocos.push({ tipo: 'codigo', texto: cerca.join('\n') });
        cerca = null;
      } else {
        cerca.push(linha);
      }
      continue;
    }
    if (CERCA.test(linha)) {
      fecharParagrafo();
      fecharLista();
      cerca = [];
      continue;
    }
    if (!linha.trim()) {
      // A lista NÃO fecha na linha em branco: as IAs separam itens numerados
      // com uma, e cada item virava uma lista própria ("1. 1. 1.").
      fecharParagrafo();
      continue;
    }
    const titulo = TITULO.exec(linha);
    if (titulo) {
      fecharParagrafo();
      fecharLista();
      blocos.push({ tipo: 'titulo', partes: partesDaLinha(titulo[1].trim()) });
      continue;
    }
    const item = ITEM.exec(linha);
    if (item) {
      fecharParagrafo();
      const ordenada = item[1] !== undefined;
      if (lista && lista.ordenada !== ordenada) fecharLista();
      if (!lista) {
        lista = { tipo: 'lista', ordenada, itens: [] };
        // "2." depois de outra coisa aparece como 2 (o <ol start>).
        if (ordenada) lista.inicio = Number(item[1]) || 1;
      }
      lista.itens.push(partesDaLinha(item[2].trim()));
      continue;
    }
    fecharLista();
    paragrafo.push(linha.trim());
  }
  // Cerca sem fechamento: o que veio depois dela é código mesmo assim.
  if (cerca) blocos.push({ tipo: 'codigo', texto: cerca.join('\n') });
  fecharParagrafo();
  fecharLista();
  return blocos;
}
