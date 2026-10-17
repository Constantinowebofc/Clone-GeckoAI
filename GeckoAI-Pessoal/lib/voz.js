// GeckoAI — ditado por voz.
//
// Quem transcreve é o PRÓPRIO navegador (Web Speech API). Nenhuma chamada
// nossa, nenhum token, nenhum host novo: por isso o ditado não custa prompt e
// não encosta no proxy. Este arquivo não usa `chrome.*` — o escopo entra por
// parâmetro para dar para testar fora do navegador.

// A API existe como `SpeechRecognition` no padrão e `webkitSpeechRecognition`
// no Chrome (é a que vale hoje).
function classeDeReconhecimento(escopo) {
  return escopo?.SpeechRecognition || escopo?.webkitSpeechRecognition || null;
}

export function vozDisponivel(escopo = globalThis) {
  return Boolean(classeDeReconhecimento(escopo));
}

// Chrome 138+ sabe reconhecer fala SEM mandar o áudio para fora, quando o
// modelo do idioma já foi baixado na máquina. Só ligamos nesse caso: pedir
// `processLocally` sem o modelo faz o reconhecimento falhar em vez de baixar.
// Nunca chamamos `install()` — baixar centenas de MB sem o usuário pedir seria
// grosseiro; quem quiser o modo local instala pelo próprio Chrome.
export async function ditadoLocalDisponivel(escopo = globalThis, lang = 'pt-BR') {
  const Reconhecimento = classeDeReconhecimento(escopo);
  try {
    return (await Reconhecimento?.available?.({ langs: [lang], processLocally: true })) === 'available';
  } catch {
    return false;
  }
}

// Erros que NÃO derrubam o ditado: o navegador encerra a escuta, a gente
// religa e o usuário nem percebe. Silêncio é o caso comum (o Chrome desiste
// depois de alguns segundos parados) e não é problema nenhum.
const ERROS_TOLERADOS = new Set(['no-speech', 'aborted']);

const MENSAGENS = {
  'not-allowed': 'Preciso da sua autorização para usar o microfone.',
  'service-not-allowed': 'Preciso da sua autorização para usar o microfone.',
  'audio-capture': 'Nenhum microfone encontrado. Conecte um e tente de novo.',
  network: 'Sem conexão para reconhecer a fala. Tente de novo.',
};
const MENSAGEM_PADRAO = 'Não consegui ouvir. Tente de novo.';

function descreverErro(code) {
  return {
    code,
    mensagem: MENSAGENS[code] || MENSAGEM_PADRAO,
    // A extensão só consegue pedir a permissão numa aba comum; o painel
    // lateral às vezes não mostra o pedido do Chrome.
    precisaPermissao: code === 'not-allowed' || code === 'service-not-allowed',
  };
}

function juntar(...partes) {
  return partes
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(' ');
}

// Cria um ditado. `onTexto` recebe o texto acumulado inteiro (final + o que
// ainda está sendo dito), `onFim` recebe o texto final quando a escuta acaba,
// `onErro` recebe `{code, mensagem, precisaPermissao}`.
export function criarDitado({
  escopo = globalThis,
  lang = 'pt-BR',
  local = false,
  onTexto = () => {},
  onFim = () => {},
  onErro = () => {},
} = {}) {
  const Reconhecimento = classeDeReconhecimento(escopo);
  if (!Reconhecimento) throw new Error('Este navegador não reconhece voz.');

  let rec = null;
  let ativo = false; // o usuário quer continuar falando
  let finalizado = ''; // o que já virou texto definitivo
  let encerrado = false; // trava o onFim duplo
  // Descartado: o texto já foi usado (enviado) e nada mais pode chegar ao
  // campo. `stop()` do navegador ENTREGA o último trecho depois de parar —
  // era esse resultado atrasado que regravava o prompt no campo logo depois
  // do envio limpar (visto pelo dono em 2026-09-13).
  let descartado = false;

  function encerrar() {
    if (encerrado) return;
    encerrado = true;
    ativo = false;
    onFim(descartado ? '' : finalizado);
  }

  function aoResultado(e) {
    if (descartado) return;
    let parcial = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const trecho = e.results[i][0]?.transcript || '';
      if (e.results[i].isFinal) finalizado = juntar(finalizado, trecho);
      else parcial = juntar(parcial, trecho);
    }
    onTexto(juntar(finalizado, parcial));
  }

  function aoErro(e) {
    if (ERROS_TOLERADOS.has(e.error)) return; // o `onend` religa
    ativo = false;
    onErro(descreverErro(e.error));
  }

  // O Chrome encerra a escuta sozinho depois de um silêncio, mesmo em modo
  // contínuo. Enquanto o usuário não clicou em parar, religa.
  function aoFim() {
    if (!ativo) {
      encerrar();
      return;
    }
    try {
      rec.start();
    } catch {
      encerrar(); // já estava rodando, ou o navegador recusou: não insiste
    }
  }

  return {
    get gravando() {
      return ativo;
    },
    iniciar() {
      if (ativo) return;
      ativo = true;
      encerrado = false;
      descartado = false;
      finalizado = '';
      rec = new Reconhecimento();
      rec.lang = lang;
      if (local) rec.processLocally = true;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = aoResultado;
      rec.onerror = aoErro;
      rec.onend = aoFim;
      try {
        rec.start();
      } catch (err) {
        ativo = false;
        onErro(descreverErro(err?.name === 'NotAllowedError' ? 'not-allowed' : 'start'));
        encerrar();
      }
    },
    parar() {
      if (!rec) return;
      ativo = false;
      try {
        rec.stop();
      } catch {
        encerrar();
      }
    },
    // Para SEM entregar mais nada: `abort()` encerra sem devolver resultado, e
    // qualquer trecho que ainda chegue é ignorado. É o que o envio usa — o
    // texto já foi para o pedido e o campo tem de ficar vazio.
    descartar() {
      if (!rec) return;
      descartado = true;
      ativo = false;
      try {
        rec.abort();
      } catch {
        encerrar();
      }
    },
  };
}
