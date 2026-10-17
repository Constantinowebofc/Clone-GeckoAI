// GeckoAI — chat nativo (1.11.0): o chat do GeckoAI no LUGAR do chat da
// Lovable. O dono pediu: "a extensão some da tela e o usuário digita direto
// pelo chat da Lovable, mas o comando vai pela extensão".
//
// Como: com o modo ligado, este content script desenha por cima da coluna do
// chat da Lovable um quadro com o PRÓPRIO painel da extensão dentro
// (sidepanel/panel.html?nativo=1), com a cara do chat da Lovable. O único
// sinal visível é o gecko, que o usuário arrasta para onde quiser.
//
// Regras deste arquivo:
// - Nunca digita nem clica em nada da Lovable, e nunca lê texto dela: só mede
//   onde está a coluna e desenha por cima. Interceptar o Enter do campo real
//   falharia em silêncio no dia em que a Lovable mudasse o campo — e a
//   mensagem iria para a IA da Lovable, gastando os créditos do cliente lá.
// - O "+" do campo é o da Lovable (pedido do dono): o quadro tem um FURO em
//   cima dele, e o clique do usuário cai no botão de verdade.
// - Não lê o storage da extensão (fica trancado para content script, ver
//   background.js): o que precisa vem por mensagem.
// - Teclas e foco que vão para o CHAT da Lovable (a coluna dela, o campo
//   dela) são barrados e o foco vai para o quadro: quando o painel fecha, o
//   foco volta para o último elemento da página — muitas vezes o campo da
//   Lovable, escondido embaixo do quadro. O ouvinte é instalado no começo da
//   página por nativo/guarda.js (antes dos scripts dela); a decisão é daqui.
// - O quadro NUNCA é movido no DOM depois de montado: mover um iframe o
//   recarrega, e um pedido pago rodando dentro dele morria (revisão da 1.11).
// - A página da Lovable não enxerga nada disto: shadow root fechado, e o
//   quadro é da origem da extensão.
//
// Classic script (content script não é módulo): a parte testável vem por
// import() de lib/nativo.js, que está em web_accessible_resources.
(() => {
  // Uma geração por injeção. O painel injeta este arquivo de novo quando a
  // aba da Lovable foi aberta antes de a extensão ser instalada/atualizada
  // (o content script do manifest só entra em página carregada depois); a
  // cópia antiga, se ainda existir, sai de cena sozinha (minhaVez).
  const geracao = (window.__geckoNativoGeracao || 0) + 1;
  window.__geckoNativoGeracao = geracao;
  const minhaVez = () => window.__geckoNativoGeracao === geracao;

  let N = null; // lib/nativo.js
  let nomeDaMarca = 'GeckoAI';
  let ligado = false;
  let trabalhando = false;
  let geckoSalvo = null; // {fx, fy} — fração da tela
  let statusTexto = '';
  let projetoAtual = null;

  let host = null;
  let palco = null;
  let quadro = null;
  let gecko = null;
  let menu = null;
  let area = null; // área coberta; null = janela flutuante
  // Janela flutuante (coluna não reconhecida) nasce ABERTA: escondida, o
  // cliente via o campo da própria Lovable e digitava lá — gastando os
  // créditos dela, o defeito que este desenho existe para evitar.
  let flutuanteAberto = true;
  let desmontagem = null;
  let montadoEm = 0;
  let posGecko = { x: 0, y: 0 };
  let secaoObservada = null;
  let observaTamanho = null;
  let observaPagina = null;
  let relogio = null;
  let agendado = false;
  let temaEnviado = '';
  let temaAtual = { tema: 'claro', fundo: null };
  let ultimoDiag = { quando: 0, marca: undefined };
  let ultimoFoco = 0;
  // O "+" da Lovable: onde está (relativo ao quadro), o que foi avisado ao
  // quadro, o que o quadro confirmou (a vaga dele está vazia e no lugar) e o
  // recorte aplicado. Furo só com a confirmação do quadro para ESTA posição.
  let furoAtual = null;
  let furoEnviado = '';
  let furoAceito = null;
  let furoAtivo = false;
  let recorteAplicado = '';
  let maisApertadoEm = 0; // pointerdown no "+" da Lovable (o clique dele)

  const vivo = () => {
    try {
      return Boolean(chrome.runtime?.id) && minhaVez();
    } catch {
      return false;
    }
  };
  const mandar = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const tela = () => ({ w: innerWidth, h: innerHeight });
  const ret = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const limitar = (v, min, max) => Math.min(Math.max(v, min), max);

  // ---------- Onde está o chat da Lovable ----------
  // Medido na Lovable real (2026-09-30): `section#sidebar-panel` (aria-label
  // "Chat") é a coluna; o campo é `form[data-testid=chat-composer]`. Do mais
  // confiável ao mais genérico; lib/nativo.js decide qual tem cara de coluna.
  function secaoDoChat() {
    return document.querySelector('#sidebar-panel, [data-panel-id="sidebar-panel"], section[aria-label="Chat"]');
  }

  // Sobe do campo até o maior ancestral que ainda é "coluna" (não a tela toda).
  function subida(el, t) {
    let melhor = null;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const r = ret(p);
      if (r.w > t.w * 0.7) break;
      if (r.h >= t.h * 0.45) melhor = r;
    }
    return melhor;
  }

  function medir() {
    const t = tela();
    const candidatos = [];
    const secao = secaoDoChat();
    if (secao) candidatos.push({ fonte: 'secao', r: ret(secao) });
    const painel = document.querySelector('[data-chat-panel]');
    if (painel) candidatos.push({ fonte: 'painel', r: ret(painel) });
    const campo = document.querySelector('[data-testid="chat-composer"], form#chat-input');
    if (campo) {
      const r = subida(campo, t);
      if (r) candidatos.push({ fonte: 'subida', r });
    }
    return { t, candidatos, area: N.areaDoChat({ tela: t, candidatos }) };
  }

  // O "+" do campo da Lovable ("Ações do chat"), medido na Lovable real.
  function maisDaLovable() {
    return document.querySelector('[data-testid="chat-composer"] [data-testid="chat-input-action-menu-trigger"], form#chat-input [data-testid="chat-input-action-menu-trigger"]');
  }

  // A cor que aparece atrás da coluna (o quadro nasce dela, sem piscar branco).
  function corDoFundo() {
    for (let el = secaoDoChat() || document.body; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'transparent' && !/^rgba\(0, 0, 0, 0\)$/.test(c)) return c;
    }
    return null;
  }

  // O quadro entra LOGO DEPOIS da raiz do app no <body>: fica acima da coluna
  // do chat e ABAIXO dos menus e janelas que a Lovable abre por cima (eles
  // entram depois, no fim do body). No fim do body, o menu do projeto — que
  // abre sobre a coluna — ficaria escondido embaixo do nosso chat.
  // UMA vez: mover o host depois recarregaria o quadro (e o pedido dentro
  // dele). Enquanto a página ainda não tem o app, espera até 4 s; sem ele,
  // fim do body. Só volta a encaixar se a página o tirar do DOM.
  function tentarEncaixar() {
    if (host.isConnected) return true;
    const ancora = secaoDoChat() || document.querySelector('[data-testid="project-editor"]');
    const app = ancora ? [...document.body.children].find((c) => c !== host && c.contains(ancora)) : null;
    if (app) {
      app.after(host);
      return true;
    }
    if (document.body && Date.now() - montadoEm > 4000) {
      document.body.append(host);
      return true;
    }
    return false;
  }

  // ---------- Montar / tirar ----------
  const CSS = `
    .quadro { position: fixed; display: block; border: 0; margin: 0; padding: 0; pointer-events: auto;
      color-scheme: normal; }
    .quadro.flutuante { border-radius: 18px; box-shadow: 0 16px 48px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.08); }
    .quadro[hidden] { display: none; }
    .gecko { position: fixed; width: 36px; height: 36px; border-radius: 50%; border: 0; margin: 0; padding: 0;
      display: grid; place-items: center; pointer-events: auto; cursor: grab; touch-action: none; user-select: none;
      color: #6b6b69; background: rgba(255,255,255,.94); box-shadow: 0 2px 10px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.07);
      opacity: .9; transition: opacity .15s, transform .15s; }
    .gecko:hover, .gecko:focus-visible { opacity: 1; outline: none; }
    .gecko:focus-visible { box-shadow: 0 0 0 3px rgba(107,107,105,.45), 0 2px 10px rgba(0,0,0,.16); }
    .gecko.arrastando { cursor: grabbing; transform: scale(1.08); }
    .gecko img { width: 22px; height: 22px; pointer-events: none; -webkit-user-drag: none; }
    .gecko.trabalhando::after { content: ''; position: absolute; inset: -3px; border-radius: 50%;
      border: 2px solid transparent; border-top-color: currentColor; animation: gk-gira 0.9s linear infinite; }
    @keyframes gk-gira { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .gecko.trabalhando::after { animation: none; border-color: currentColor; } }
    .menu { position: fixed; width: 250px; pointer-events: auto; padding: 6px; border-radius: 14px;
      background: #fff; color: #161616; box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.07);
      font: 14px/1.35 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .menu[hidden] { display: none; }
    .menu .status { padding: 8px 10px 6px; color: #6b6b69; font-size: 12.5px; }
    .menu .status:empty { display: none; }
    .menu button { display: block; width: 100%; text-align: left; border: 0; background: none; margin: 0;
      padding: 8px 10px; border-radius: 9px; font: inherit; color: inherit; cursor: pointer; }
    .menu button:hover, .menu button:focus-visible { background: rgba(0,0,0,.06); outline: none; }
    .menu button[hidden] { display: none; }
    .escuro .gecko { color: #a3a3a0; background: rgba(39,39,38,.96); box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
    .escuro .menu { background: #272726; color: #f5f5f4; box-shadow: 0 12px 32px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
    .escuro .menu .status { color: #a3a3a0; }
    .escuro .menu button:hover, .escuro .menu button:focus-visible { background: rgba(255,255,255,.08); }
  `;

  function botaoDoMenu(texto, acao) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = texto;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      acao();
    });
    return b;
  }

  let itemMostrar = null;
  let linhaStatus = null;

  function montar() {
    host = document.createElement('div');
    host.setAttribute('data-gecko-nativo', '');
    for (const [k, v] of [['position', 'fixed'], ['inset', '0'], ['display', 'block'], ['pointer-events', 'none'],
      ['z-index', 'auto'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['background', 'transparent']]) {
      host.style.setProperty(k, v, 'important');
    }
    const raiz = host.attachShadow({ mode: 'closed' });
    const estilo = document.createElement('style');
    estilo.textContent = CSS;
    palco = document.createElement('div');

    quadro = document.createElement('iframe');
    quadro.className = 'quadro';
    quadro.title = nomeDaMarca;
    // Microfone (ditado) e escrita na área de transferência (botões
    // "Copiar") liberados SÓ para a origem da extensão. Com o `allow` sem
    // origem, a regra vale para a origem do `src` — e o endereço de
    // web_accessible_resources com use_dynamic_url é sorteado, diferente da
    // origem em que o painel abre: o Chrome negava os dois em silêncio
    // (provado no Chromium, 2026-09-30). Ler a área de transferência o painel
    // não lê (colar é Ctrl+V), então não é pedido.
    const origemDaExtensao = `chrome-extension://${chrome.runtime.id}`;
    quadro.allow = `microphone ${origemDaExtensao}; clipboard-write ${origemDaExtensao}`;
    temaAtual = lerTema();
    quadro.style.background = temaAtual.fundo || (temaAtual.tema === 'escuro' ? '#1d1d1c' : '#f5f5f5');
    quadro.src = `${chrome.runtime.getURL('sidepanel/panel.html')}?nativo=1#tema=${temaAtual.tema}`;
    // Quadro novo = painel novo: nada rodando nele ainda, e ele ainda não sabe
    // do "+" da Lovable.
    quadro.addEventListener('load', () => {
      marcarTrabalhando(false);
      furoEnviado = '';
      furoAceito = null;
      agendar();
    });

    gecko = document.createElement('button');
    gecko.type = 'button';
    gecko.className = 'gecko';
    gecko.title = `${nomeDaMarca} — chat nativo ligado (arraste para mudar de lugar)`;
    gecko.setAttribute('aria-label', `${nomeDaMarca}: opções do chat nativo`);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = chrome.runtime.getURL('icons/icon48.png');
    gecko.append(img);
    ligarArrasto();

    menu = document.createElement('div');
    menu.className = 'menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    linhaStatus = document.createElement('div');
    linhaStatus.className = 'status';
    itemMostrar = botaoDoMenu('Mostrar o chat', () => {
      flutuanteAberto = !flutuanteAberto;
      fecharMenu();
      agendar();
      if (flutuanteAberto) setTimeout(focarQuadro, 50);
    });
    menu.append(
      linhaStatus,
      itemMostrar,
      botaoDoMenu(`Abrir o painel do ${nomeDaMarca}`, () => {
        fecharMenu();
        mandar({ tipo: 'nativo:abrir-painel' });
      }),
      botaoDoMenu('Voltar ao chat da Lovable', () => {
        fecharMenu();
        mandar({ tipo: 'nativo:desligar' });
      }),
    );

    palco.append(quadro, gecko, menu);
    raiz.append(estilo, palco);
    montadoEm = Date.now();
    tentarEncaixar();

    observaTamanho = new ResizeObserver(agendar);
    observaPagina = new MutationObserver(agendar);
    observaPagina.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observaPagina.observe(document.body, { childList: true });
    addEventListener('resize', agendar);
    // Rede de segurança para o que não gera evento (a divisória arrastada
    // muda estilo lá dentro): medir é barato.
    relogio = setInterval(agendar, 700);
    posicionar();
    tirarFocoDaLovable();
  }

  function desmontar() {
    observaTamanho?.disconnect();
    observaPagina?.disconnect();
    removeEventListener('resize', agendar);
    clearInterval(relogio);
    host?.remove();
    host = palco = quadro = gecko = menu = itemMostrar = linhaStatus = null;
    area = null;
    secaoObservada = null;
    temaEnviado = '';
    furoAtual = furoAceito = null;
    furoEnviado = recorteAplicado = '';
    furoAtivo = false;
    flutuanteAberto = true;
  }

  const deveEstar = () => ligado && Boolean(projetoAtual) && minhaVez();

  function aplicar() {
    if (deveEstar()) {
      clearTimeout(desmontagem);
      desmontagem = null;
      if (!host) montar();
      else agendar();
      return;
    }
    // Pedido rodando no quadro: ele fica até terminar (tirar o quadro mataria
    // o pedido no meio). O aviso de "terminou" chama aplicar() de novo — e
    // ainda assim a saída espera um pouco: a última gravação do pedido pode
    // estar a caminho, e a próxima parte automática pode estar começando.
    if (host && !trabalhando && !desmontagem) {
      desmontagem = setTimeout(() => {
        desmontagem = null;
        if (host && !trabalhando && !deveEstar()) desmontar();
      }, 1500);
    }
  }

  function agendar() {
    if (agendado || !host) return;
    agendado = true;
    requestAnimationFrame(posicionar);
  }

  function lerTema() {
    const fundo = corDoFundo();
    return { tema: N.temaDaPagina(document.documentElement.className, fundo), fundo: N.corSegura(fundo) };
  }

  function colocar(el, r) {
    el.style.left = `${Math.round(r.x)}px`;
    el.style.top = `${Math.round(r.y)}px`;
    el.style.width = `${Math.round(r.w)}px`;
    el.style.height = `${Math.round(r.h)}px`;
  }

  function posicionar() {
    agendado = false;
    if (!host) return;
    if (!vivo()) return desmontar(); // extensão atualizada/removida: sai de cena
    if (!tentarEncaixar()) return; // a página ainda não montou o app
    const { t, candidatos, area: nova } = medir();
    area = nova;

    const secao = secaoDoChat();
    if (secao !== secaoObservada) {
      observaTamanho.disconnect();
      if (secao) observaTamanho.observe(secao);
      secaoObservada = secao;
    }

    temaAtual = lerTema();
    palco.classList.toggle('escuro', temaAtual.tema === 'escuro');
    quadro.style.background = temaAtual.fundo || (temaAtual.tema === 'escuro' ? '#1d1d1c' : '#f5f5f5');

    if (area) {
      quadro.classList.remove('flutuante');
      quadro.hidden = false;
      colocar(quadro, area);
    } else {
      // Sem coluna reconhecível: janela flutuante, que o gecko mostra/esconde.
      quadro.classList.add('flutuante');
      colocar(quadro, N.janelaFlutuante(t));
      quadro.hidden = !flutuanteAberto;
    }
    if (itemMostrar) {
      itemMostrar.hidden = Boolean(area);
      itemMostrar.textContent = flutuanteAberto ? 'Esconder o chat' : 'Mostrar o chat';
    }

    // O "+" da Lovable: o quadro deixa a vaga dele vazia e confirma; aí o furo.
    const mais = area ? maisDaLovable() : null;
    furoAtual = mais && maisAVista(mais)
      ? N.furoDoMais({ area, mais: ret(mais), raio: parseFloat(getComputedStyle(mais).borderTopLeftRadius) })
      : null;
    const chaveFuro = JSON.stringify(furoAtual);
    if (chaveFuro !== furoEnviado) {
      furoEnviado = chaveFuro;
      mandar({ tipo: 'nativo:furo-lovable', furo: furoAtual });
    }
    aplicarFuro();

    posGecko = N.posicaoDoGecko(geckoSalvo, t, area);
    pintarGecko();
    if (!menu.hidden) posicionarMenu();

    const chave = `${temaAtual.tema}|${temaAtual.fundo}`;
    if (chave !== temaEnviado) {
      temaEnviado = chave;
      mandar({ tipo: 'nativo:tema', ...temaAtual });
    }
    diagnostico(t, candidatos);
  }

  // O furo mostra o que estiver NAQUELE ponto da página: tem de ser o "+"
  // (visível), e não algo da Lovable pintado por cima dele (revisão).
  function maisAVista(mais) {
    if (mais.checkVisibility && !mais.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const b = mais.getBoundingClientRect();
    const topo = document.elementsFromPoint(b.x + b.width / 2, b.y + b.height / 2).find((el) => el !== host);
    return Boolean(topo && mais.contains(topo));
  }

  function aplicarFuro() {
    if (!quadro) return;
    furoAtivo = Boolean(area && furoAtual && !quadro.hidden && N.mesmoFuro(furoAceito, furoAtual));
    const recorte = furoAtivo ? N.recorteComFuro(area, furoAtual) : '';
    if (recorte === recorteAplicado) return;
    recorteAplicado = recorte;
    quadro.style.clipPath = recorte;
  }

  function pintarGecko() {
    if (!gecko) return;
    gecko.style.left = `${posGecko.x}px`;
    gecko.style.top = `${posGecko.y}px`;
  }

  // ---------- Gecko arrastável ----------
  function ligarArrasto() {
    let arrasto = null;
    gecko.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      arrasto = { id: e.pointerId, x0: e.clientX, y0: e.clientY, gx: posGecko.x, gy: posGecko.y, moveu: false };
      gecko.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    gecko.addEventListener('pointermove', (e) => {
      if (!arrasto || e.pointerId !== arrasto.id) return;
      const dx = e.clientX - arrasto.x0;
      const dy = e.clientY - arrasto.y0;
      if (!arrasto.moveu && Math.hypot(dx, dy) < 4) return;
      if (!arrasto.moveu) {
        arrasto.moveu = true;
        gecko.classList.add('arrastando');
        fecharMenu();
      }
      const t = tela();
      posGecko = {
        x: limitar(arrasto.gx + dx, 4, t.w - N.TAMANHO_GECKO - 4),
        y: limitar(arrasto.gy + dy, 4, t.h - N.TAMANHO_GECKO - 4),
      };
      pintarGecko();
    });
    const soltar = (e) => {
      if (!arrasto || e.pointerId !== arrasto.id) return;
      const moveu = arrasto.moveu;
      arrasto = null;
      gecko.classList.remove('arrastando');
      if (moveu) {
        geckoSalvo = N.fracaoDoGecko(posGecko, tela());
        mandar({ tipo: 'nativo:gecko', ...geckoSalvo });
      } else if (e.type === 'pointerup') {
        alternarMenu();
      }
    };
    gecko.addEventListener('pointerup', soltar);
    gecko.addEventListener('pointercancel', soltar);
    gecko.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        alternarMenu();
      } else if (e.key === 'Escape') {
        fecharMenu();
      }
    });
  }

  function alternarMenu() {
    if (!menu) return;
    if (menu.hidden) {
      pintarMenu();
      menu.hidden = false;
      posicionarMenu();
      menu.querySelector('button:not([hidden])')?.focus();
    } else {
      fecharMenu();
    }
  }

  function fecharMenu() {
    if (menu) menu.hidden = true;
  }

  function pintarMenu() {
    if (linhaStatus) linhaStatus.textContent = statusTexto;
  }

  function posicionarMenu() {
    const t = tela();
    const m = menu.getBoundingClientRect();
    const alto = m.height || 150;
    const embaixo = posGecko.y + N.TAMANHO_GECKO + 8 + alto <= t.h;
    const top = embaixo ? posGecko.y + N.TAMANHO_GECKO + 8 : posGecko.y - alto - 8;
    const left = posGecko.x + N.TAMANHO_GECKO / 2 > t.w / 2
      ? posGecko.x + N.TAMANHO_GECKO - 250
      : posGecko.x;
    menu.style.top = `${limitar(top, 4, t.h - alto - 4)}px`;
    menu.style.left = `${limitar(left, 4, t.w - 254)}px`;
  }

  // Clique fora (na página) fecha o menu; foco indo para o quadro também.
  // E marca o clique no "+" da Lovable (o foco dele passa pela guarda).
  addEventListener('pointerdown', (e) => {
    if (menu && !menu.hidden && !e.composedPath().includes(host)) fecharMenu();
    const mais = furoAtivo ? maisDaLovable() : null;
    if (mais && e.target instanceof Node && mais.contains(e.target)) maisApertadoEm = Date.now();
  }, true);
  addEventListener('blur', () => fecharMenu());

  // ---------- Guarda: nada chega ao chat escondido da Lovable ----------
  function focarQuadro() {
    const agora = Date.now();
    if (!quadro || quadro.hidden || agora - ultimoFoco < 300) return;
    ultimoFoco = agora;
    quadro.focus();
  }

  // Vai para o chat da LOVABLE? Pela estrutura dela (a coluna, o campo),
  // qualquer que seja o tamanho ou a posição do elemento — um editor de
  // tamanho zero ou fora da tela passava pela conta geométrica (revisão da
  // 1.11). Menus e janelas da Lovable que abrem por cima da coluna ficam FORA
  // da coluna no DOM, e continuam usáveis. Sem a coluna reconhecida, a
  // geometria da área coberta é a reserva.
  function vaiParaOChatDaLovable(el) {
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) return false;
    const secao = secaoDoChat();
    if (secao?.contains(el)) return true;
    if (el.closest('[data-testid="chat-composer"], form#chat-input, [data-testid="chat-composer-area"]')) return true;
    if (secao || !area) return false;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) return false;
    return N.dentroDaArea({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, area);
  }

  // O "+" da Lovable, visível pelo furo, é dela: o CLIQUE nele passa (o
  // foco que o próprio clique dá). Nenhuma tecla passa, e o foco que volta
  // para ele sozinho (o menu da Lovable fechando devolve o foco ao botão) vai
  // para o nosso campo — senão o Enter de "enviar" reabria o menu dela, e o
  // segundo escolhia um item (revisão). É o "+" medido, não qualquer botão
  // igual que a Lovable tenha em outro lugar.
  function ehOMaisLiberado(e) {
    if (!furoAtivo || e.type !== 'focusin' || !(e.target instanceof Node)) return false;
    const mais = maisDaLovable();
    return Boolean(mais && mais.contains(e.target) && Date.now() - maisApertadoEm < 800);
  }

  function guarda(e) {
    // Fora de um projeto (painel de projetos da Lovable, com o campo "novo
    // projeto" dela), nada a guardar — mesmo com o quadro ainda saindo.
    if (!host || !N || !minhaVez() || !projetoAtual) return;
    if (e.composedPath().includes(host)) return; // o nosso gecko/menu
    if (ehOMaisLiberado(e)) return;
    if (!vaiParaOChatDaLovable(e.target)) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    e.target.blur?.();
    // Janela flutuante escondida: quem digita "no chat" quer o chat — abre.
    if (quadro?.hidden) {
      flutuanteAberto = true;
      agendar();
      setTimeout(focarQuadro, 80);
    } else {
      focarQuadro();
    }
  }
  // O ouvinte está em nativo/guarda.js (document_start); cada geração pendura
  // a sua decisão aqui. Sem a guarda (injeção pelo painel numa aba antiga),
  // instala agora mesmo.
  window.__geckoGuarda = guarda;
  if (!window.__geckoGuardaInstalada) {
    window.__geckoGuardaInstalada = true;
    for (const tipo of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'focusin']) {
      addEventListener(tipo, (e) => window.__geckoGuarda?.(e), true);
    }
  }

  function tirarFocoDaLovable() {
    const ativo = document.activeElement;
    if (ativo && vaiParaOChatDaLovable(ativo)) {
      ativo.blur?.();
      focarQuadro();
    }
  }

  // ---------- Pedido rodando (gecko animado) ----------
  function marcarTrabalhando(on) {
    trabalhando = on === true;
    gecko?.classList.toggle('trabalhando', trabalhando);
    if (trabalhando) {
      clearTimeout(desmontagem);
      desmontagem = null;
    } else {
      aplicar();
    }
  }

  // ---------- Diagnóstico sem texto ----------
  function diagnostico(t, candidatos) {
    const agora = Date.now();
    const fonte = area?.fonte ?? null;
    // Mudou a fonte (ou o furo do "+"): grava, mas nunca mais de uma vez a
    // cada 10 s (uma página oscilando entre dois layouts gravaria no storage
    // a cada quadro).
    const marca = `${fonte}|${furoAtivo}`;
    if (agora - ultimoDiag.quando < 10_000) return;
    if (marca === ultimoDiag.marca && agora - ultimoDiag.quando < 60_000) return;
    ultimoDiag = { quando: agora, marca };
    mandar({
      tipo: 'nativo:diag',
      diag: {
        versao: chrome.runtime.getManifest().version,
        caminho: location.pathname.slice(0, 80),
        tela: t,
        area,
        candidatos: candidatos.map((c) => ({ fonte: c.fonte, r: c.r })),
        temSecao: Boolean(secaoDoChat()),
        temCampo: Boolean(document.querySelector('[data-testid="chat-composer"]')),
        mais: furoAtual,
        furo: furoAtivo,
        classeHtml: document.documentElement.className.slice(0, 80),
        tema: temaAtual,
      },
    });
  }

  // ---------- Mensagens (service worker e quadro) ----------
  chrome.runtime.onMessage.addListener((msg, sender, responder) => {
    if (sender?.id !== chrome.runtime.id || !msg?.tipo || !minhaVez()) return;
    if (msg.tipo === 'nativo:ping') {
      // O painel confere se esta aba já tem o chat nativo antes de fechar.
      responder({ ok: true });
    } else if (msg.tipo === 'nativo:estado') {
      ligado = msg.ligado === true;
      if (N) aplicar();
    } else if (msg.tipo === 'nativo:trabalhando') {
      marcarTrabalhando(msg.on);
    } else if (msg.tipo === 'nativo:status') {
      statusTexto = String(msg.texto || '').slice(0, 120);
      pintarMenu();
    } else if (msg.tipo === 'nativo:pedir-tema') {
      responder(temaAtual);
    } else if (msg.tipo === 'nativo:pedir-furo') {
      responder({ furo: furoAtual });
    } else if (msg.tipo === 'nativo:furo') {
      // A vaga do quadro está vazia e no lugar deste furo (ou null: coberta
      // por outra tela, desalinhada). Só números passam.
      furoAceito = N ? N.furoValido(msg.furo) : null;
      aplicarFuro();
    } else if (msg.tipo === 'nativo:mostrar') {
      // O quadro pede para aparecer (um cartão espera o clique do usuário) —
      // só faz diferença na janela flutuante.
      if (!area && host) {
        flutuanteAberto = true;
        agendar();
      }
    }
  });

  (async () => {
    try {
      N = await import(chrome.runtime.getURL('lib/nativo.js'));
    } catch {
      return; // sem o módulo, nada de chat nativo nesta aba
    }
    try {
      nomeDaMarca = (await import(chrome.runtime.getURL('lib/marca.js'))).MARCA?.nome || nomeDaMarca;
    } catch {
      /* fica o nome padrão */
    }
    projetoAtual = N.projetoDaUrl(location.href);
    // A Lovable é SPA: trocar de projeto (ou sair dele) não recarrega a página.
    const olharUrl = setInterval(() => {
      if (!vivo()) {
        clearInterval(olharUrl);
        desmontar();
        return;
      }
      const p = N.projetoDaUrl(location.href);
      if (p !== projetoAtual) {
        projetoAtual = p;
        aplicar();
      }
    }, 500);
    const estado = await mandar({ tipo: 'nativo:estado' });
    ligado = estado?.ligado === true;
    geckoSalvo = estado?.gecko || null;
    aplicar();
  })();
})();
