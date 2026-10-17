import { readAI, normalizeAI, credentialForAI, LOCAL_CREDENTIAL } from './personal-ai.js';
export const AGENT_MAX_TOKENS = 8192;
export class AIError extends Error {
  constructor(message, status) { super(message); this.name = 'AIError'; this.status = status; }
}
function errorForStatus(status) {
  if (status === 401 || status === 403) return 'A API recusou o acesso. Confira sua chave e as permissões do modelo.';
  if (status === 429) return 'A API atingiu o limite de uso ou de saldo. Confira sua conta do provedor.';
  if (status === 404) return 'Modelo ou rota não encontrado. Confira a URL da API e o modelo.';
  return `A API de IA retornou HTTP ${status}. Confira a configuração do provedor.`;
}
export function createPersonalProvider({ getConfig = readAI, fetch: fetchFn = (...args) => globalThis.fetch(...args), timeoutMs = 120000 } = {}) {
  async function request(config, key, route, { body, signal } = {}) {
    const configSafe = normalizeAI(config);
    const credential = credentialForAI(key, configSafe);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('A API demorou demais para responder.', 'TimeoutError')), timeoutMs);
    try {
      const response = await fetchFn(`${configSafe.baseURL}/${route}`, {
        method: body ? 'POST' : 'GET', signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { ...(credential !== LOCAL_CREDENTIAL ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new AIError(errorForStatus(response.status), response.status);
      try { return await response.json(); } catch { throw new AIError('A API devolveu uma resposta JSON inválida.'); }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    // Internal ID retained for compatibility with the existing agent/UI state.
    id: 'geckoai', label: 'Minha API', brand: 'API própria', keyPlaceholder: 'sua chave de API', keyUrl: 'https://platform.openai.com/api-keys', preferredModels: ['gpt-4.1-mini'],
    async validate(key, signal, options = {}) {
      const config = normalizeAI(options.config || await getConfig());
      const response = await request(config, key, 'models', { signal });
      if (!Array.isArray(response.data) || !response.data.some(m => m.id === config.model)) throw new AIError('O modelo escolhido não aparece na lista desta API. Confira seu identificador.');
      return { expiresAt: null, remaining: null, ilimitado: false, imagens: false, versao: null, modelos: null };
    },
    async listModels(key, signal, options = {}) {
      const config = normalizeAI(options.config || await getConfig());
      await this.validate(key, signal, { config });
      return [{ id: config.model, label: config.model }];
    },
    createSession({ apiKey, model, system, tools = [] }) {
      let configPromise;
      const config = () => configPromise ??= getConfig();
      const messages = [{ role: 'system', content: system }];
      const definitions = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const allowedTools = new Set(tools.map(t => t.name));
      let pending = [];
      async function call(signal) {
        const selected = await config();
        const response = await request(selected, apiKey, 'chat/completions', { signal, body: {
          model: model || selected.model, messages, stream: false, max_tokens: AGENT_MAX_TOKENS,
          ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
        } });
        const choice = response.choices?.[0];
        if (!choice?.message || !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) throw new AIError('Formato de resposta incompatível com Chat Completions.');
        if (choice.finish_reason === 'content_filter' || choice.message.refusal) throw new AIError('O provedor recusou esta solicitação.');
        if (choice.finish_reason === 'length') {
          const error = new AIError('A resposta atingiu o limite de saída. Peça uma alteração menor e tente novamente.'); error.retomavel = true; throw error;
        }
        const assistant = choice.message;
        if (assistant.content != null && typeof assistant.content !== 'string') throw new AIError('O provedor devolveu texto em formato incompatível.');
        const calls = assistant.tool_calls ?? [];
        if (!Array.isArray(calls)) throw new AIError('O provedor devolveu chamadas de ferramentas inválidas.');
        const seen = new Set();
        const toolCalls = calls.map(c => {
          if (c.type !== 'function' || !c.id || seen.has(c.id) || !allowedTools.has(c.function?.name)) throw new AIError('O provedor pediu uma ferramenta desconhecida ou devolveu uma chamada inválida.');
          seen.add(c.id);
          let input;
          try { input = JSON.parse(c.function.arguments); } catch { throw new AIError('A IA devolveu argumentos de ferramenta incompletos. Nenhuma chamada desta resposta foi executada.'); }
          if (!input || Array.isArray(input) || typeof input !== 'object') throw new AIError('Os argumentos da ferramenta precisam ser um objeto JSON.');
          return { id: c.id, name: c.function.name, input };
        });
        if (choice.finish_reason === 'tool_calls' && !toolCalls.length) throw new AIError('A API sinalizou ferramentas sem fornecer as chamadas.');
        pending = toolCalls.map(c => c.id);
        messages.push({ role: 'assistant', content: assistant.content || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: c.type, function: { ...c.function } })) } : {}) });
        return { text: assistant.content || '', toolCalls };
      }
      let started = false;
      return {
        async start(context, prompt, images = [], signal) {
          if (started) throw new AIError('Esta sessão já foi iniciada.');
          started = true;
          const content = [{ type: 'text', text: [context, prompt].filter(Boolean).join('\n\n') }];
          for (const im of images || []) content.push({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.dataBase64}` } });
          messages.push({ role: 'user', content }); return call(signal);
        },
        async reply(results, signal) {
          if (!started || !pending.length || results.length !== pending.length || new Set(results.map(r => r.id)).size !== pending.length || results.some(r => !pending.includes(r.id))) throw new AIError('Os resultados não correspondem às ferramentas pendentes.');
          for (const result of results) messages.push({ role: 'tool', tool_call_id: result.id, content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null) });
          pending = []; return call(signal);
        },
        compact(ids) {
          const stub = '[Conteúdo antigo removido; leia o arquivo novamente se necessário.]';
          for (const message of messages) {
            if (message.role === 'tool' && ids.has(message.tool_call_id) && message.content.length > stub.length) message.content = stub;
            for (const call of message.tool_calls || []) {
              if (!ids.has(call.id)) continue;
              const args = JSON.parse(call.function.arguments);
              if (typeof args.content === 'string' && args.content.length > stub.length) call.function.arguments = JSON.stringify({ ...args, content: stub });
            }
          }
        },
      };
    },
  };
}
export const PROVIDERS = [createPersonalProvider()];
export function getProvider() { return PROVIDERS[0]; }
export function pickDefaultModel(provider, available) { return available[0]?.id || provider.preferredModels[0]; }
