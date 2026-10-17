// Personal edition: credentials stay in this browser and go only to the selected API.
export const DEFAULT_AI = Object.freeze({ baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
export const LOCAL_CREDENTIAL = 'local-model-no-api-key';
export function normalizeAI(value = {}) {
  const url = new URL(String(value.baseURL || DEFAULT_AI.baseURL).trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS, ou HTTP somente para um modelo local.');
  if (url.username || url.password || url.search || url.hash) throw new Error('A URL da API não pode conter credenciais, parâmetros ou fragmentos.');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) && local) throw new Error('Use localhost ou 127.0.0.1 para o modelo local.');
  const model = String(value.model || DEFAULT_AI.model).trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Informe um identificador de modelo válido.');
  return { baseURL: url.href.replace(/\/+$/, ''), model };
}
export function isLocalAI(config) { return ['localhost', '127.0.0.1'].includes(new URL(config.baseURL).hostname); }
export function credentialForAI(key, config) {
  const value = String(key || '').trim();
  if (!value && isLocalAI(config)) return LOCAL_CREDENTIAL;
  if (!value || value === LOCAL_CREDENTIAL && !isLocalAI(config)) throw new Error('Informe sua chave de API para este serviço.');
  return value;
}
export async function readAI() {
  const stored = await globalThis.chrome?.storage?.local?.get('personalAI');
  return normalizeAI(stored?.personalAI);
}
// Must be called directly in the button click, before any awaited operation.
export function requestAIOrigin(config) {
  const url = new URL(normalizeAI(config).baseURL);
  const origin = `${url.protocol}//${url.hostname}/*`;
  return chrome.permissions.request({ origins: [origin] });
}
export function renderAIFields(container, config = DEFAULT_AI) {
  for (const [id, label, value] of [['personal-api-url', 'URL da API (compatível com OpenAI)', config.baseURL], ['personal-api-model', 'Modelo', config.model]]) {
    const field = document.createElement('div'); field.className = 'field';
    const title = document.createElement('label'); title.htmlFor = id; title.textContent = label;
    const input = document.createElement('input'); input.id = `${container.id}-${id}`; title.htmlFor = input.id; input.setAttribute(id.endsWith('url') ? 'data-personal-url' : 'data-personal-model', ''); input.type = id.endsWith('url') ? 'url' : 'text'; input.value = value; input.spellcheck = false; input.autocomplete = 'off';
    field.append(title, input); container.append(field);
  }
}
export function fieldsAI(container) { return normalizeAI({ baseURL: container.querySelector('[data-personal-url]').value, model: container.querySelector('[data-personal-model]').value }); }
