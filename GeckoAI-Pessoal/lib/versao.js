// GeckoAI — aviso de atualização (2026-09-16).
//
// A extensão é instalada descompactada: o Chrome não atualiza sozinho, e quem
// ficou numa versão antiga só descobria o problema quando algo quebrava. Aqui
// só mora a decisão; quem entrega os números é o servidor, na MESMA resposta
// que já valida a chave (sem host novo no manifest, sem custo por prompt).
//
// Duas versões vêm de lá: a publicada (`atual`) e a mínima que ainda funciona
// (`minima`). Abaixo da publicada é aviso; abaixo da mínima o envio trava —
// é o que faz o usuário de fato baixar. `minima` vazia nunca trava ninguém.
//
// Tudo falha para o lado de NÃO incomodar: campo ausente, versão ilegível ou
// link que não é https e a faixa simplesmente não aparece. Aqui o risco é o
// oposto do da trava de dispositivo (que recusa na dúvida, porque lá o risco é
// fraude): travar quem pagou por causa de um dado ruim no banco seria o dano
// caro, e deixar de avisar não custa nada.

const SO_NUMERO = /^\d+$/;

// "1.3.2" -> [1, 3, 2]. null quando não é versão de manifest (1 a 4 números).
function partes(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const ps = s.split('.');
  if (ps.length > 4 || !ps.every((p) => SO_NUMERO.test(p))) return null;
  return ps.map(Number);
}

/** -1, 0 ou 1. Compara por NÚMERO: como texto, "1.10" viria antes de "1.9". */
export function comparaVersao(a, b) {
  const pa = partes(a);
  const pb = partes(b);
  if (!pa || !pb) return 0; // ilegível: ninguém fica atrasado em relação a ninguém
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Só https, e só o que cabe num href. O link vem do nosso servidor, mas ele é
// texto editável no admin: um "javascript:" digitado ali não pode virar clique.
function linkValido(url) {
  const s = String(url ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
}

/**
 * O que o painel deve mostrar.
 * @param {string} instalada  versão desta cópia (manifest)
 * @param {{atual?:string, minima?:string, url?:string}|null} doServidor
 * @returns {null | {versao:string, url:string, obrigatoria:boolean}}
 *   null = nada a mostrar (em dia, servidor antigo ou dado inválido).
 */
export function estadoDaAtualizacao(instalada, doServidor) {
  if (!doServidor || typeof doServidor !== 'object') return null;
  if (!partes(instalada)) return null;
  // Sem para onde mandar, avisar só irrita — e travar seria deixar a pessoa
  // sem saída nenhuma.
  const url = linkValido(doServidor.url);
  if (!url) return null;

  const atual = partes(doServidor.atual) ? String(doServidor.atual).trim() : null;
  const minima = partes(doServidor.minima) ? String(doServidor.minima).trim() : null;
  const obrigatoria = minima ? comparaVersao(instalada, minima) < 0 : false;
  const atrasada = atual ? comparaVersao(instalada, atual) < 0 : false;
  if (!obrigatoria && !atrasada) return null;
  return { versao: atual || minima, url, obrigatoria };
}
