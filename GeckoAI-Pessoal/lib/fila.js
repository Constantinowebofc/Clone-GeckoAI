// Fila de pedidos (1.11.0). Pedido do dono: "o usuário envia um prompt e,
// enquanto ele está sendo processado, pode enviar até mais 2, que ficam na
// fila; só quando o que está rodando terminar o próximo começa".
//
// Puro, sem DOM: quantos cabem, e o que fazer quando um pedido termina. A
// regra de parar é de propósito conservadora — o próximo só começa sozinho
// quando o anterior TERMINOU BEM (alteração enviada, ou nada a alterar). Se
// ele parou num erro, no "Não terminei", esperando o banco ou o plano, a fila
// espera o cliente: seguir sozinha ali gastaria prompt em cima de um problema
// que ele nem viu (cada pedido da fila custa 1 prompt ao começar).

export const MAX_FILA = 2;

export function cabeNaFila(fila) {
  return (fila?.length ?? 0) < MAX_FILA;
}

const PARADA = {
  cancelado: 'Você cancelou o pedido anterior — a fila está parada.',
  erro: 'O pedido anterior não deu certo — a fila está parada até você decidir.',
  'nao-terminou': 'O pedido anterior não terminou (veja o cartão acima) — a fila está parada.',
  banco: 'O pedido anterior espera o ajuste no banco — a fila está parada até ele.',
  plano: 'O pedido anterior está em partes — decida as partes; a fila espera.',
};

const parar = (motivo) => ({ acao: 'parar', motivo, texto: PARADA[motivo] });

/**
 * O pedido `record` acabou de terminar. `automaticoAgendado`: a próxima
 * parte/rodada dele já vai começar sozinha (chave ilimitada, ChatGPT) — ela
 * é o MESMO pedido, então a fila espera o fim dela.
 * @returns {{acao:'seguir'} | {acao:'esperar'} | {acao:'parar', motivo:string, texto:string}}
 */
export function depoisDoRun(record, { automaticoAgendado = false } = {}) {
  const r = record || {};
  if (r.cancelled) return parar('cancelado');
  if (r.error || r.erroChatGPT || r.erroPremium) return parar('erro');
  // A continuação automática (rodada que parou no teto, próxima parte) é o
  // MESMO pedido seguindo sozinho: a fila espera ela, não "para".
  if (automaticoAgendado) return { acao: 'esperar' };
  if (r.pendingWork && !r.pendingWorkFeito && !r.commit) return parar('nao-terminou');
  if (r.pendingMigration && !r.pendingMigration.applied && !r.commit) return parar('banco');
  if (r.plano && r.planoResultado) {
    if (r.planoResultado !== 'concluida') return parar('plano');
    const faltam = (r.plano.partes?.length ?? 0) - ((Number(r.plano.atual) || 0) + 1);
    if (faltam > 0) return parar('plano');
  }
  return { acao: 'seguir' };
}

/** A linha de cada pedido na faixa "Na fila". */
export function resumoDaFila(item) {
  const texto = String(item?.texto ?? '').replace(/\s+/g, ' ').trim();
  if (!texto) {
    const n = Number(item?.anexos) || 0;
    return `📎 ${n} ${n === 1 ? 'anexo' : 'anexos'}`;
  }
  return texto.length > 70 ? `${texto.slice(0, 69)}…` : texto;
}
