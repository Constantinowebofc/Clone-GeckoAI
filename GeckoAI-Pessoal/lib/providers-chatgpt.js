// O motor do ChatGPT do cliente (v1.6.0): o MESMO contrato de sessão do
// provedor de sempre (lib/providers.js), falando o formato Responses do
// backend do Codex, direto do navegador. O agente não sabe a diferença.
//
//   criarProvedorChatGPT({obterAcesso, esforco, resumo, aoUsar, fetch})
//     .createSession({model, system, tools}) -> { start, reply, compact }
//   start/reply -> { toolCalls:[{id,name,input}], text, cortada? }
//
// O que o backend exige (prova técnica de 2026-09-25, conta Plus do dono):
// - store:false: o servidor não guarda nada, então a conversa inteira volta a
//   cada chamada, inclusive o raciocínio CIFRADO que ele devolve;
// - os itens devolvidos voltam SEM id — com store:false, um id que o servidor
//   não guardou dá "item not found";
// - o nosso prompt de sistema vai em `instructions` (aceito; a recusa de
//   instruções próprias, relatada em 2025, não aconteceu).
//
// Não importa lib/providers.js e não é importado por ele: o pacote de prompts
// continua sem nada que cite a IA do servidor.
import { API, ORIGINATOR, ChatGPTError, lerLimite, erroDaResposta } from './chatgpt.js';

const STUB = '[old content removed to save space — call read_file for the current version]';

// Resposta cortada sem chamada inteira: novas tentativas na mesma conversa
// antes de desistir. Texto igual ao do provedor de sempre (sem importar dele).
const MAX_CORTES = 2;
const AVISO_DE_CORTE =
  'Your reply hit the output limit and was CUT OFF before this call was complete, so it did NOT run. ' +
  'Do not send the same large content again: change existing files with edit_file using small old_string/new_string, ' +
  'create a big file in parts (a short write_file, then edit_file to add the rest), and keep your reasoning brief.';
const AVISO_SEM_CHAMADA =
  '[GeckoAI] Your previous reply hit the output limit before making any tool call (too much reasoning or text), so nothing ran. ' +
  'Keep your reasoning brief, never put code in text, and act now with small edit_file calls.';

export async function lerSSE(res) {
  const leitor = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const itens = [];
  let fim = null;
  let erro = null;
  const processar = (bloco) => {
    const dados = bloco
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!dados || dados === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(dados); } catch { return; }
    if (ev.type === 'response.output_item.done' && ev.item) itens.push(ev.item);
    else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') fim = ev.response || {};
    else if (ev.type === 'response.failed') { fim = ev.response || {}; erro = ev.response?.error || { code: 'failed' }; }
    else if (ev.type === 'error') erro = ev.error || ev;
  };
  for (;;) {
    const { value, done } = await leitor.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      processar(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) processar(buf);
  return { itens: itens.length ? itens : fim?.output || [], fim, erro, terminou: Boolean(fim) && !erro };
}

// Erro que chega DENTRO do stream (não no status HTTP).
function erroDoStream(erro) {
  const codigo = String(erro?.code || erro?.type || '');
  if (/usage_limit|rate_limit/i.test(codigo)) {
    return new ChatGPTError('O limite da sua assinatura do ChatGPT acabou por enquanto.', {
      codigo: 'limite', retomavel: true, limite: null,
    });
  }
  return new ChatGPTError('O ChatGPT interrompeu a resposta. Tente de novo.', { codigo: 'falhou' });
}

const textoDe = (item) =>
  (item.content || []).filter((c) => c.type === 'output_text' && c.text).map((c) => c.text).join('\n');

export function criarProvedorChatGPT({
  obterAcesso, // async () => ({ access, conta }) — renova antes se precisar
  esforco = null, // nível de raciocínio escolhido; null = modelo sem níveis
  resumo = true, // false quando o catálogo diz supports_reasoning_summary_parameter:false
  aoUsar = () => {}, // (limite) a cada resposta: o painel mostra "ChatGPT 34%"
  fetch = globalThis.fetch,
}) {
  return {
    id: 'chatgpt',
    createSession({ model, system, tools }) {
      const input = [];
      const sessao = crypto.randomUUID();
      const defs = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
      // O Codex oficial devolve este cabeçalho a cada volta para cair no
      // mesmo servidor (e no mesmo cache). Estado cifrado: nunca vai para log
      // nem para o agente.
      let estadoDaVolta = null;

      async function chamar(signal, cortes = 0) {
        const { access, conta } = await obterAcesso();
        const corpo = {
          model,
          instructions: system,
          input,
          tools: defs,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          prompt_cache_key: sessao,
        };
        if (esforco || resumo) {
          corpo.reasoning = { ...(esforco ? { effort: esforco } : {}), ...(resumo ? { summary: 'auto' } : {}) };
        }
        const headers = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${access}`,
          originator: ORIGINATOR,
          session_id: sessao,
        };
        if (conta) headers['chatgpt-account-id'] = conta;
        if (estadoDaVolta) headers['x-codex-turn-state'] = estadoDaVolta;

        let res;
        try {
          res = await fetch(`${API}/responses`, { method: 'POST', signal, headers, body: JSON.stringify(corpo) });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          throw new ChatGPTError('Sem conexão com o ChatGPT agora. Tente de novo.', { codigo: 'falhou' });
        }
        const limite = lerLimite(res.headers);
        if (limite) {
          try { aoUsar(limite); } catch { /* mostrador não derruba o pedido */ }
        }
        if (!res.ok) throw await erroDaResposta(res);
        estadoDaVolta = res.headers.get('x-codex-turn-state') || estadoDaVolta;

        const r = await lerSSE(res);
        if (r.erro) throw erroDoStream(r.erro);
        if (!r.terminou) {
          throw new ChatGPTError('A resposta do ChatGPT foi interrompida antes do fim. Tente de novo.', { codigo: 'falhou' });
        }

        // Estourou o teto de saída: a ÚLTIMA chamada veio pela metade e é
        // descartada; as anteriores estão inteiras (mesma regra do provedor
        // de sempre — o agente avisa a IA no tool_result). Sem chamada
        // inteira, a IA é avisada nesta mesma conversa e tenta de novo; se
        // insistir, o erro é retomável e o agente guarda o que ficou pronto.
        let chamadas = r.itens.filter((i) => i.type === 'function_call');
        const cortada = r.fim?.incomplete_details?.reason === 'max_output_tokens';
        if (cortada) {
          const pelaMetade = chamadas[chamadas.length - 1];
          chamadas = chamadas.slice(0, -1);
          if (!chamadas.length) {
            if (cortes < MAX_CORTES) {
              cortes++;
              if (pelaMetade?.call_id) {
                input.push({ type: 'function_call', call_id: pelaMetade.call_id, name: pelaMetade.name, arguments: '{}' });
                input.push({ type: 'function_call_output', call_id: pelaMetade.call_id, output: `ERROR: ${AVISO_DE_CORTE}` });
              } else {
                // Pensou até o limite: repetir o pedido idêntico só pagaria o
                // mesmo corte. O aviso vai no último resultado (ou no pedido,
                // na 1ª chamada), uma vez só.
                const alvo = [...input].reverse().find((i) => i.type === 'function_call_output' || (i.type === 'message' && i.role === 'user'));
                if (alvo?.type === 'function_call_output' && !alvo.output.includes(AVISO_SEM_CHAMADA)) {
                  alvo.output = `${alvo.output}\n\n${AVISO_SEM_CHAMADA}`;
                } else if (alvo?.type === 'message' && !alvo.content.some((c) => c.text === AVISO_SEM_CHAMADA)) {
                  alvo.content.push({ type: 'input_text', text: AVISO_SEM_CHAMADA });
                }
              }
              return chamar(signal, cortes);
            }
            throw new ChatGPTError('A resposta ficou longa demais e foi cortada. Envie de novo; se repetir, peça uma mudança menor por vez.', { codigo: 'cortada', retomavel: true });
          }
        }

        for (const it of r.itens) {
          if (it.type === 'reasoning') {
            input.push({ type: 'reasoning', summary: it.summary || [], encrypted_content: it.encrypted_content });
          } else if (it.type === 'function_call' && chamadas.includes(it)) {
            input.push({ type: 'function_call', call_id: it.call_id, name: it.name, arguments: it.arguments || '{}' });
          } else if (it.type === 'message') {
            const t = textoDe(it);
            if (t) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
          }
        }

        const toolCalls = chamadas.map((c) => {
          let args = {};
          try { args = JSON.parse(c.arguments || '{}'); } catch { /* argumento ilegível vira {} */ }
          return { id: c.call_id, name: c.name, input: args };
        });
        const text = r.itens.filter((i) => i.type === 'message').map(textoDe).filter(Boolean).join('\n').trim();
        return cortada ? { toolCalls, text, cortada: true } : { toolCalls, text };
      }

      return {
        start(context, prompt, images, signal) {
          const content = [{ type: 'input_text', text: context }];
          for (const im of images || []) {
            content.push({ type: 'input_image', image_url: `data:${im.mediaType};base64,${im.dataBase64}` });
          }
          content.push({ type: 'input_text', text: prompt });
          input.push({ type: 'message', role: 'user', content });
          return chamar(signal);
        },
        reply(results, signal) {
          for (const r of results) {
            input.push({
              type: 'function_call_output',
              call_id: r.id,
              output: r.isError ? `ERROR: ${r.output}` : String(r.output),
            });
          }
          return chamar(signal);
        },
        // Mesma compactação do provedor de sempre: a operação obsoleta num
        // arquivo vira um aviso curto, para o custo não crescer ao quadrado.
        compact(ids) {
          for (const it of input) {
            if (it.type === 'function_call_output' && ids.has(it.call_id) && it.output.length > STUB.length) {
              it.output = STUB;
            } else if (it.type === 'function_call' && ids.has(it.call_id)) {
              try {
                const a = JSON.parse(it.arguments);
                if (typeof a.content === 'string' && a.content.length > STUB.length) {
                  it.arguments = JSON.stringify({ ...a, content: STUB });
                }
              } catch { /* sem argumentos legíveis, fica como está */ }
            }
          }
        },
      };
    },
  };
}
