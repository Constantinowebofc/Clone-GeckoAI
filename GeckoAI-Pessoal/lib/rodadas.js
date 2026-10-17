// Decisões do painel sobre trabalho guardado e pedido interrompido — sem DOM
// e sem chrome.*, para dar para testar (tests/extension/rodadas.test.js).
//
// Nasceu da revisão de 2026-09-26: o painel perdia trabalho PAGO em caminhos
// que nenhum teste cobria, porque tudo morava em sidepanel/panel.js.

/** O registro do ÚLTIMO run, se ele tem trabalho guardado esperando decisão
 *  (o cartão "Não terminei" com Continuar/Descartar). */
export function trabalhoAberto(history) {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const r = history[i];
    // Instalar/remover uma skill (1.12) fica no histórico como um envio, mas
    // não é um pedido: o rascunho que estava aberto antes continua aberto.
    if (r?.kind !== 'run' || r.skill) continue;
    return r.pendingWork && !r.pendingWorkFeito && !r.commit ? r : null;
  }
  return null;
}

/** O rascunho já passou do teto de rodadas? Aí o cartão manda pedir uma parte
 *  por vez, e o que a pessoa digita é um pedido NOVO — seguir o mesmo
 *  rascunho gigante seria a série paga que o teto existe para parar. Parada
 *  por limite/acesso/plano do ChatGPT ou commit recusado não é teto. */
export function passouDoTeto(record, maxContinuacoes) {
  const codigo = record?.pendingWork?.codigo;
  if (['limite', 'acesso', 'plano', 'commit'].includes(codigo)) return false;
  return (Number(record?.pedido?.continuacoes) || 0) >= maxContinuacoes;
}

/** Pedido digitado com o cartão "Não terminei" aberto: é o MESMO pedido
 *  seguindo (o leigo escreve "continua" em vez de clicar). Antes virava um
 *  run do zero, que ignorava o trabalho guardado — e o commit dele ainda
 *  invalidava o rascunho, jogando fora as rodadas pagas. */
export function promptDeSeguimento(original, novo) {
  const base = String(original || '').trim();
  const extra = String(novo || '').trim();
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n\nFollow-up from the user about this same request (the prepared work continues): ${extra}`;
}

/** Rodada que falhou sem produzir nada não gasta vaga do teto de rodadas:
 *  sem isto, uma queda na 6ª prendia 5 rodadas pagas sem botão. */
export function continuacoesAposFalha(continuacoes) {
  return Math.max(0, (Number(continuacoes) || 0) - 1);
}

/** Painel fechado (ou recarregado) no meio de um run: o registro ficou com a
 *  marca `emAndamento`. Na reabertura, o que ele carregava volta a ter botão —
 *  o trabalho das rodadas anteriores vira o cartão "Não terminei", e a parte
 *  de um plano vira "não concluída — Tentar de novo". Antes os dois ficavam
 *  sem saída nenhuma, com os dados ainda no storage. Devolve se mudou algo. */
export function recuperarInterrompidos(history) {
  let mudou = false;
  for (const r of history || []) {
    if (r?.kind !== 'run' || !r.emAndamento) continue;
    mudou = true;
    const terminou = r.summary || r.commit || r.error || r.cancelled || r.pendingMigration || r.pendingWork;
    if (!terminou && r.trabalhoAnterior) {
      r.pendingWork = { ...r.trabalhoAnterior };
      if (r.pedido) r.pedido.continuacoes = continuacoesAposFalha(r.pedido.continuacoes);
      r.error = 'O painel foi fechado no meio desta rodada. O que as anteriores prepararam continua guardado.';
      // Parte de plano com trabalho guardado: o plano fica no registro (o
      // Continuar leva), SEM "não concluída — Tentar de novo" ao lado — esse
      // botão refaria a parte do zero e jogaria fora as rodadas pagas (mesma
      // regra do runAndRender quando o erro devolve o trabalho).
      if (r.planoProvisorio && !r.plano) r.plano = r.planoProvisorio.plano;
    } else if (!terminou && r.planoProvisorio && !r.planoResultado) {
      r.plano = r.planoProvisorio.plano;
      r.planoResultado = r.planoProvisorio.resultado || 'falhou';
    }
    delete r.emAndamento;
    delete r.trabalhoAnterior;
    delete r.planoProvisorio;
  }
  return mudou;
}

// ---------------------------------------------------------------------------
// Histórico com DUAS janelas escrevendo (1.11.0, chat nativo): o painel e o
// chat dentro da Lovable guardam a mesma conversa (`chat:<owner/repo>`). Antes
// cada janela gravava a lista inteira que tinha na memória e a última apagava
// o que a outra tinha escrito. Agora cada registro tem `id` e a gravação
// MESCLA com o que está guardado.
// ---------------------------------------------------------------------------

/** Dá `id` e `criadoEm` a quem não tem. `agora` = 0 para o que veio do
 *  storage antigo (nasceu antes de qualquer "Limpar conversa" que se conheça). */
export function garantirIds(historico, gerarId, agora) {
  let mudou = false;
  for (const r of historico || []) {
    if (!r || r.id) continue;
    r.id = gerarId();
    r.criadoEm = agora;
    mudou = true;
  }
  return mudou;
}

/**
 * O que vai para o storage. `tocados`: ids que ESTA janela criou ou mudou
 * desde que leu — só neles a versão daqui vale; nos outros vale a guardada
 * (a outra janela pode ter mudado). Registro que a outra janela tirou (limite
 * de 40) não volta — `persistidos` são os ids que esta janela já viu no
 * storage ou gravou; o que nasceu antes de `limpoEm` ("Limpar conversa" numa
 * das janelas) sai dos dois lados.
 */
export function mesclarHistorico(armazenado, local, { tocados = new Set(), limpoEm = 0, limite = 40, persistidos = new Set() } = {}) {
  const vivo = (r) => r && (Number(r.criadoEm) || 0) >= limpoEm;
  const locais = new Map((local || []).filter((r) => r?.id).map((r) => [r.id, r]));
  const vistos = new Set();
  const saida = [];
  for (const g of armazenado || []) {
    if (!g?.id) continue;
    vistos.add(g.id);
    const l = locais.get(g.id);
    saida.push(l && tocados.has(g.id) ? l : g);
  }
  for (const l of local || []) {
    // Já gravado um dia e fora do storage agora = saiu (limite de 40, limpeza
    // na outra janela), não é novo: voltaria no FIM da conversa.
    if (l?.id && !vistos.has(l.id) && tocados.has(l.id) && !persistidos.has(l.id)) saida.push(l);
  }
  return saida.filter(vivo).slice(-limite);
}

/**
 * A OUTRA janela gravou: a conversa desta passa a ser a do storage, com três
 * cuidados. (1) O objeto de cada registro que esta janela já tinha é o MESMO
 * (botões e anexos em memória apontam para ele) — muda por dentro. (2) O que
 * esta janela mudou e ainda não gravou (difere da `foto`) fica como está: a
 * gravação na fila leva. (3) Registro novo daqui que ainda não chegou ao
 * storage (sem id, ou nunca gravado — fora da foto e de `persistidos`)
 * continua, na ordem em que estava; o que já foi gravado e sumiu, saiu.
 * @param {Array} local  a lista desta janela
 * @param {Array} guardado  a lista do storage
 * @param {Map<string,string>} foto  id -> JSON do que esta janela leu/gravou
 */
export function integrarHistorico(local, guardado, foto, persistidos = new Set()) {
  const locais = new Map((local || []).filter((r) => r?.id).map((r) => [r.id, r]));
  const mudadoAqui = (l) => foto.get(l.id) !== JSON.stringify(l);
  const vistos = new Set();
  const saida = (guardado || []).filter((g) => g?.id).map((g) => {
    vistos.add(g.id);
    const l = locais.get(g.id);
    if (!l) return g;
    if (!mudadoAqui(l) && JSON.stringify(l) !== JSON.stringify(g)) {
      for (const k of Object.keys(l)) delete l[k];
      Object.assign(l, g);
    }
    return l;
  });
  for (const l of local || []) {
    if (!l?.id || (!vistos.has(l.id) && !foto.has(l.id) && !persistidos.has(l.id))) saida.push(l);
  }
  return saida;
}

// Id de registro ANTIGO (de antes da 1.11): o mesmo em qualquer janela que
// abrir a conversa — posição + resumo do conteúdo. Com id sorteado, duas abas
// da Lovable abrindo juntas o mesmo histórico antigo gravavam cada uma o seu
// id, e a mescla duplicava tudo (revisão adversarial, simulação 2).
function resumoDoTexto(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function idsDeLegado(historico) {
  let mudou = false;
  (historico || []).forEach((r, i) => {
    if (!r || r.id) return;
    r.id = `legado-${i}-${resumoDoTexto(JSON.stringify(r))}`;
    r.criadoEm = 0;
    mudou = true;
  });
  return mudou;
}

/**
 * Depois de gravar: o registro que ESTA janela não mudou (fora de `tocados`)
 * passa a ser, na memória, igual ao que foi gravado — a mescla manteve a
 * versão do storage (a da outra janela). Sem isto a cópia velha daqui ficava
 * diferente da foto, a PRÓXIMA gravação a via como "mudada aqui" e desfazia a
 * mudança da outra janela (um "Descartar" voltava a ter "Continuar"). Mesmo
 * objeto, mudado por dentro: botões e anexos em memória apontam para ele.
 */
export function alinharAoGravado(lista, mesclado, tocados = new Set()) {
  const gravados = new Map((mesclado || []).filter((g) => g?.id).map((g) => [g.id, g]));
  for (const l of lista || []) {
    if (!l?.id || tocados.has(l.id)) continue;
    const g = gravados.get(l.id);
    if (!g || g === l || JSON.stringify(g) === JSON.stringify(l)) continue;
    for (const k of Object.keys(l)) delete l[k];
    Object.assign(l, JSON.parse(JSON.stringify(g)));
  }
}
