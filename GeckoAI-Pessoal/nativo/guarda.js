// GeckoAI — chat nativo (1.11.0): a GUARDA de teclado, instalada no começo
// da página (document_start), antes dos scripts da Lovable.
//
// Por que separada de nativo/conteudo.js (que roda em document_idle): quem
// registra primeiro um ouvinte em captura no `window` é quem vê a tecla
// primeiro. Instalada depois, um ouvinte da própria página enxergava cada
// tecla antes de nós (revisão adversarial da 1.11). Aqui só se registra o
// ouvinte; a decisão ("essa tecla ia para o chat escondido da Lovable?") é
// de nativo/conteudo.js, que a pendura em `window.__geckoGuarda` — os
// content scripts da extensão dividem o mesmo mundo isolado.
(() => {
  if (window.__geckoGuardaInstalada) return;
  window.__geckoGuardaInstalada = true;
  const repassar = (e) => {
    try {
      window.__geckoGuarda?.(e);
    } catch {
      /* guarda com defeito não pode quebrar a página */
    }
  };
  for (const tipo of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'focusin']) {
    window.addEventListener(tipo, repassar, true);
  }
})();
