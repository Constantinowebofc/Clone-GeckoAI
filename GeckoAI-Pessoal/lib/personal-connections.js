const SERVICES = {
  github: { name: 'GitHub', url: 'https://github.com/settings/personal-access-tokens/new', hint: 'Crie um token fine-grained limitado aos repositórios desejados: Contents (leitura e escrita) e Metadata (leitura). Permissões extras só se você precisar dessas funções.' },
  supabase: { name: 'Supabase', url: 'https://supabase.com/dashboard/account/tokens', hint: 'Use um token pessoal da Management API. A chave anon/publishable do projeto não serve para gerenciar projetos ou executar SQL.' },
  vercel: { name: 'Vercel', url: 'https://vercel.com/account/tokens', hint: 'Use um token pessoal da sua conta Vercel.' },
};
export function requestServiceToken(provider) {
  const service = SERVICES[provider];
  if (!service) throw new Error('Serviço de conexão desconhecido.');
  return new Promise((resolve, reject) => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'personal-token-dialog'; dialog.setAttribute('aria-label', `Conectar ${service.name}`);
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.textContent = `Conectar ${service.name}`;
    const hint = document.createElement('p'); hint.textContent = service.hint;
    const label = document.createElement('label'); label.htmlFor = 'personal-service-token'; label.textContent = 'Token pessoal';
    const input = document.createElement('input'); input.id = 'personal-service-token'; input.type = 'password'; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
    const link = document.createElement('a'); link.textContent = `Criar token no ${service.name}`; link.href = service.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const local = document.createElement('p'); local.textContent = 'Salvo no armazenamento local desta extensão; enviado apenas à API do serviço. Não cole tokens na conversa.';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.className = 'btn-ghost';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Conectar'; submit.className = 'btn-primary';
    form.append(title, hint, label, input, link, local, cancel, submit); dialog.append(form); document.body.append(dialog);
    let settled = false;
    function finish(value, error) { if (settled) return; settled = true; input.value = ''; dialog.close(); dialog.remove(); previous?.focus(); error ? reject(error) : resolve(value); }
    cancel.addEventListener('click', () => finish(null, new Error('Conexão cancelada.')));
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null, new Error('Conexão cancelada.')); });
    form.addEventListener('submit', e => { e.preventDefault(); const token = input.value.trim(); if (!token) { input.setCustomValidity('Informe o token pessoal.'); input.reportValidity(); return; } finish({ token }); });
    input.addEventListener('input', () => input.setCustomValidity(''));
    dialog.showModal(); input.focus();
  });
}
