// GeckoAI — celular ou PC?
//
// A extensão nasceu como painel lateral do Chrome de PC. Em navegador de
// celular com suporte a extensões (Quetta e afins) não existe painel lateral:
// o clique no ícone precisa abrir o painel numa ABA de tela cheia, e o
// campo de texto convive com um teclado virtual, sem Shift. As decisões
// ficam aqui, sem `chrome.*` nenhum, para dar para testar fora do navegador
// (tests/extension/plataforma.test.js). No PC nada do que está aqui muda o
// comportamento de antes.

// Android cobre celular e tablet (o tablet também não tem painel lateral).
// "Mobile" pega navegadores que se apresentam só assim.
const UA_CELULAR = /Android|iPhone|iPad|iPod|Mobile/i;

export function ehCelular(userAgent) {
  return UA_CELULAR.test(String(userAgent || ''));
}

// O painel abre em ABA quando não há `chrome.sidePanel` (navegador sem a API)
// ou quando é celular — mesmo que a API "exista" ali, painel lateral num
// telefone não é tela de verdade.
export function abreEmAba({ userAgent, temSidePanel }) {
  return !temSidePanel || ehCelular(userAgent);
}

// A aba ativa é uma página da PRÓPRIA extensão (o painel numa aba, o
// preview…)? A sincronização com o Lovable ignora essas abas: voltar do
// Lovable para o painel não pode apagar o vínculo descoberto lá.
export function ehAbaDaExtensao(url, origemDaExtensao) {
  return Boolean(url && origemDaExtensao && String(url).startsWith(origemDaExtensao));
}

// Aba do painel já aberta, para focar em vez de abrir outra.
export function achaAbaDoPainel(abas, urlDoPainel) {
  for (const aba of abas || []) {
    const u = String(aba?.url || '').split(/[?#]/)[0];
    if (u === urlDoPainel) return aba;
  }
  return null;
}

// Em tela de toque o Enter do teclado virtual quebra linha: não há Shift, e um
// envio acidental custa um prompt da licença. O envio é o botão.
export function enterEnvia({ toque }) {
  return !toque;
}
