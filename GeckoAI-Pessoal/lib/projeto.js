// GeckoAI — a forma do projeto Lovable, lida da árvore de arquivos.
//
// A extensão edita o REPOSITÓRIO do GitHub, mas quem constrói e mostra o
// resultado é a Lovable: o pedido só está cumprido quando a tela do preview
// muda. Um commit válido que quebra o build da Lovable é fracasso, não
// sucesso — e o sintoma que chega ao suporte é "não mudou nada", porque o
// preview continua servindo a última versão que compilou.
//
// A Lovable hoje gera DOIS formatos de projeto, e as convenções são opostas:
//
//   TanStack Start (o atual, 5 de 6 projetos do dono em 2026-09):
//     rotas por arquivo em src/routes/, SSR, Tailwind v4 configurado DENTRO
//     do CSS (src/styles.css, cores em oklch), routeTree.gen.ts gerado.
//   Vite + React Router (o antigo):
//     telas em src/pages/, Tailwind v3 com tailwind.config.ts, src/index.css.
//
// Sem saber qual é, a IA escreve pela convenção errada: o arquivo existe,
// compila e NUNCA aparece na tela (src/pages/ num projeto de rotas por
// arquivo; tailwind.config.ts onde o Tailwind nem lê config).
//
// Nada aqui usa `chrome.*` nem rede: só o caminho dos arquivos (e, no modo
// escuro, o texto de uns poucos arquivos que o agente lê e entrega pronto).

const ehCss = (p) => /^src\/[^/]+\.css$/.test(p);

/**
 * Lê a forma do projeto na árvore. Só caminhos — de graça, sem leitura.
 * @param {{path:string}[]} files
 */
export function detectarForma(files) {
  const paths = new Set((files || []).map((f) => f?.path).filter(Boolean));
  const tem = (p) => paths.has(p);
  const algum = (re) => [...paths].some((p) => re.test(p));

  const rotasPorArquivo = tem('src/routes/__root.tsx') || tem('src/routeTree.gen.ts');
  const temPages = algum(/^src\/pages\//);
  const roteador = rotasPorArquivo ? 'arquivos' : temPages ? 'react-router' : null;

  // SSR: o entry de servidor do TanStack Start. window/document no topo do
  // módulo quebra a renderização no servidor.
  const ssr = rotasPorArquivo && (tem('src/server.ts') || tem('src/start.ts'));

  const configTailwind = [...paths].find((p) => /^tailwind\.config\.(ts|js|cjs|mjs)$/.test(p)) || null;
  const css = tem('src/styles.css')
    ? 'src/styles.css'
    : tem('src/index.css')
      ? 'src/index.css'
      : [...paths].find(ehCss) || null;

  return {
    roteador,
    ssr,
    css,
    // Sem arquivo de config, o Tailwind da Lovable é o v4: tema no CSS.
    tailwind: configTailwind ? 'v3' : css ? 'v4' : null,
    configTailwind,
    // Imagem que a página mostra vem do descritor (URL no servidor da
    // Lovable), não do binário no Git — trocar o binário não muda a tela.
    assets: algum(/\.asset\.json$/) ? 'descritor' : 'arquivo',
    // Arquivos que a Lovable escreve sozinha; editar à mão quebra o build.
    docs: ['AGENTS.md', 'src/routes/README.md'].filter(tem),
  };
}

// Arquivo gerado por ferramenta: a próxima geração sobrescreve, e uma edição
// à mão no meio quebra o build. O src/routes/README.md da Lovable diz isso do
// routeTree.gen.ts com todas as letras.
export function ehArquivoGerado(path) {
  const p = String(path || '');
  return (
    /(^|\/)[^/]+\.gen\.(ts|tsx|js|jsx)$/.test(p) ||
    /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)
  );
}

// O vite.config.ts da Lovable avisa no próprio arquivo: o preset dela já traz
// os plugins, e acrescentar à mão "quebra o app com plugins duplicados".
// Só o que indica plugin ACRESCENTADO: o nome do pacote importado, ou uma
// lista `plugins:`. `tanstackStart:` sozinho é chave legítima do preset e
// está no arquivo original — casar com ela recusaria o arquivo intacto.
const PLUGINS_DA_LOVABLE =
  /@vitejs\/plugin-react|@tailwindcss\/vite|vite-tsconfig-paths|@tanstack\/(react-start|router-plugin)/;

// `usaPreset`: o projeto usa o preset da Lovable (formato TanStack). No
// formato antigo (Vite + React Router) o vite.config ORIGINAL já tem
// `plugins: [react(), componentTagger()]`, e sem esta distinção toda edição
// dele era recusada — até mudar uma porta (revisão de 2026-09-26).
export function duplicaPluginDoVite(path, conteudo, usaPreset = true) {
  if (!/(^|\/)vite\.config\.(ts|js|mts|mjs)$/.test(String(path || ''))) return false;
  if (!usaPreset) return false;
  const c = String(conteudo || '');
  return PLUGINS_DA_LOVABLE.test(c) || /\bplugins\s*:/.test(c);
}

/** Mensagem quando a tela nasce fora do lugar que a Lovable renderiza. */
export function rotaForaDoLugar(forma, path) {
  const p = String(path || '');
  if (forma?.roteador === 'arquivos' && /^src\/pages\//.test(p)) {
    return `This project uses file-based routing: "${p}" would never be rendered. Pages live in "src/routes/" (src/routes/sobre.tsx -> /sobre, src/routes/users/$id.tsx -> /users/:id). See src/routes/README.md.`;
  }
  return null;
}

// ---------- modo escuro ----------
//
// Todo projeto da Lovable já nasce com as cores do modo escuro no CSS (o
// bloco `.dark` e a variante `dark:` presa à classe), mas elas só valem
// quando algo LIGA o modo escuro. Onde algo liga, trocar só a cor clara dá o
// pior sintoma: commit feito, e quem está no escuro não vê nada. Foi o
// agendador_tarefa do dono (2026-09-25): seis commits seguidos trocando o
// fundo, numa linha que tinha `dark:from-slate-950` — e um botão nas próprias
// páginas fazendo `classList.toggle("dark")`.
//
// Quem liga varia, então os candidatos são poucos e pequenos: o CSS do tema,
// a raiz, a página inicial (onde estava o botão do agendador) e o que tiver
// tema no nome. Os de `src/components/ui/` ficam de fora: o `sonner.tsx` do
// shadcn chama `useTheme` em todo projeto, ligado ou não.

const MAX_ARQUIVOS_DO_TEMA = 8;
// "tema" só no começo do nome ou depois de separador: "sistema.tsx" não é tema.
const NOME_DE_TEMA = /(theme|dark|escuro|mode-?toggle|(?:^|[^a-z])tema)/i;

/** Arquivos a ler para saber se o modo escuro está ligado. */
export function arquivosDoTema(forma, files) {
  const paths = new Set((files || []).map((f) => f?.path).filter(Boolean));
  const fixos = [
    forma?.css, forma?.configTailwind, 'index.html',
    'src/routes/__root.tsx', 'src/main.tsx', 'src/App.tsx',
    'src/routes/index.tsx', 'src/pages/Index.tsx',
  ];
  const porNome = [...paths].filter(
    (p) =>
      p.startsWith('src/') &&
      !p.startsWith('src/components/ui/') &&
      /\.(tsx|ts|jsx|js)$/.test(p) &&
      NOME_DE_TEMA.test(p.split('/').pop())
  );
  const out = [];
  for (const p of [...fixos, ...porNome]) {
    if (p && paths.has(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_ARQUIVOS_DO_TEMA);
}

// Código comentado não liga nada. `//` só conta fora de URL (https://…).
const semComentarios = (s) =>
  String(s || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// Escuro sempre: classe fixa no <html>, ou o tema padrão/forçado escuro.
const RE_SEMPRE_ESCURO = [
  /<html\b[^>]*\bclass(?:Name)?\s*=\s*(?:"[^"]*\bdark\b[^"]*"|'[^']*\bdark\b[^']*')/,
  /\b(?:default|forced)Theme\s*=\s*\{?\s*["'`]dark["'`]/,
];
// Segue o aparelho: next-themes em "system" (o padrão dele), ou o código
// perguntando ao sistema. `defaultTheme="light"` desliga o padrão.
const RE_SISTEMA = [
  /\bdefaultTheme\s*=\s*\{?\s*["'`]system["'`]/,
  /prefers-color-scheme:\s*dark/,
];
const RE_NEXT_THEMES = /from\s+["']next-themes["']/;
const RE_TEMA_CLARO_PADRAO = /\bdefaultTheme\s*=\s*\{?\s*["'`]light["'`]/;
// Chave de claro/escuro: o botão do agendador, ou o next-themes.
const RE_ALTERNAVEL = [
  /classList\.(?:toggle|add)\(\s*["'`]dark["'`]/,
  /\bsetTheme\s*\(/,
];

/**
 * Se o modo escuro está LIGADO no app, e como. Na dúvida, null: um aviso a
 * mais custa tokens em toda chamada e ensina a IA a mexer no que não precisa.
 * @param {{path:string, texto:string}[]} textos  lidos de arquivosDoTema
 * @returns {{modo:'escuro'|'sistema'|'alternavel', onde:string[]} | null}
 */
export function detectarModoEscuro(textos, forma) {
  const lidos = (textos || []).filter((t) => t?.path && t.texto);
  const doTema = (p) => p === forma?.css || p === forma?.configTailwind;
  const codigo = lidos.filter((t) => !doTema(t.path)).map((t) => ({ path: t.path, texto: semComentarios(t.texto) }));
  const onde = (res) => codigo.filter((t) => res.some((re) => re.test(t.texto))).map((t) => t.path);
  const achou = (modo, arquivos) => (arquivos.length ? { modo, onde: arquivos.slice(0, 3) } : null);

  const sempre = achou('escuro', onde(RE_SEMPRE_ESCURO));
  if (sempre) return sempre;

  const css = lidos.find((t) => t.path === forma?.css)?.texto || '';
  const config = lidos.find((t) => t.path === forma?.configTailwind)?.texto || '';

  // O próprio CSS trocando as cores pelo aparelho, sem classe nenhuma.
  const cssPeloAparelho = /@media[^{]*prefers-color-scheme:\s*dark/.test(semComentarios(css)) ? [forma.css] : [];
  // O app passando defaultTheme="light" ao provedor desliga o "system" que o
  // theme-provider do shadcn traz de fábrica (parâmetro padrão + matchMedia):
  // aí o aparelho só manda se o usuário escolher — é chave, não "segue o
  // aparelho" (falso positivo achado na revisão adversarial).
  const claroPorPadrao = codigo.some((t) => RE_TEMA_CLARO_PADRAO.test(t.texto));
  const nextThemes = codigo.filter((t) => RE_NEXT_THEMES.test(t.texto) && !RE_TEMA_CLARO_PADRAO.test(t.texto));
  const sistema = achou('sistema', [
    ...new Set([...(claroPorPadrao ? [] : [...onde(RE_SISTEMA), ...nextThemes.map((t) => t.path)]), ...cssPeloAparelho]),
  ]);
  if (sistema) return sistema;

  // Variante `dark:` que segue o aparelho, e não a classe: Tailwind v4 sem
  // @custom-variant, ou v3 sem darkMode por classe. Só conta se alguém usa.
  const variantePorMidia =
    forma?.tailwind === 'v4'
      ? css !== '' && !/@(?:custom-)?variant\s+dark\b/.test(css)
      : forma?.tailwind === 'v3'
        ? config !== '' && !/darkMode\s*:\s*\[?\s*["'](?:class|selector)/.test(config)
        : false;
  if (variantePorMidia) {
    const porMidia = achou('sistema', onde([/\bdark:[a-z]/]));
    if (porMidia) return porMidia;
  }

  return achou('alternavel', onde(RE_ALTERNAVEL));
}

const LINHA_ESCURO = {
  escuro: 'This app starts in DARK mode — the colors people see are the dark ones',
  sistema: "This app follows the device's light/dark setting — visitors whose phone or computer is in dark mode see the dark version",
  alternavel: 'This app has a light/dark switch',
};

// ---------- imports que precisam existir ----------

// Pega o que vem depois de from/import()/require(). Sem parser: o objetivo é
// achar caminho quebrado, e o que não casar simplesmente não é checado.
const RE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

export function importsDoArquivo(conteudo) {
  const specs = [];
  for (const m of String(conteudo || '').matchAll(RE_IMPORT)) {
    const s = m[1] || m[2];
    if (s) specs.push(s);
  }
  return specs;
}

const EXTENSOES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];

/**
 * Caminhos possíveis para um import. [] quando não dá para checar (pacote do
 * npm, URL) — pacote é problema do package.json, que já tem regra própria.
 * @param {string} deArquivo caminho do arquivo que contém o import
 * @param {string} spec      o que está entre aspas
 */
export function candidatosDeImport(deArquivo, spec) {
  const bruto = String(spec || '');
  // Vite aceita sufixo: "../styles.css?url", "./logo.svg?raw".
  const limpo = bruto.split('?')[0].split('#')[0];
  if (!limpo || /^[a-z]+:/i.test(limpo)) return [];

  let base;
  if (limpo.startsWith('@/')) base = [`src/${limpo.slice(2)}`]; // alias padrão do Vite/Lovable
  else if (limpo.startsWith('/')) base = [`public${limpo}`, limpo.slice(1)];
  else if (limpo.startsWith('./') || limpo.startsWith('../')) {
    const out = String(deArquivo || '').split('/').slice(0, -1);
    for (const seg of limpo.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    base = [out.join('/')];
  } else return []; // pacote do npm

  const fim = [];
  for (const b of base) {
    if (!b) continue;
    for (const ext of EXTENSOES) fim.push(b + ext);
    for (const ext of EXTENSOES.slice(1)) fim.push(`${b}/index${ext}`);
  }
  return fim;
}

// ---------- componente usado sem importar ----------
//
// O erro mais comum de IA escrevendo JSX, e o mais caro: `<Link to="/x">` com
// o import continuando `import { createFileRoute }`. Compila na cabeça de
// quem escreveu e quebra o build inteiro — aconteceu no projeto do dono em
// 2026-09-23, e quem consertou foi o chat da Lovable, no commit seguinte
// ("Fixed missing link import"). A trava de caminhos não pega: o caminho
// existia; faltava o NOME na lista de importados.
//
// Sem parser (a extensão não tem build step): comentários e textos saem
// antes, e só conta abertura de tag mesmo. Na dúvida, NÃO acusa — recusar
// escrita boa é pior que deixar passar uma ruim.

// Fora os genéricos: `useState<Task[]>` e `React.FC<Props>` têm letra, "]"
// ou ponto antes do "<". JSX vem depois de "(", "{", "=", quebra de linha — e
// também depois de ">", que é tag colada em tag (`</Button><Link ...`), o
// furo que o teste do caso real pegou.
const RE_TAG = /(^|[^A-Za-z0-9_$.])<([A-Z][A-Za-z0-9_$]*)(?:\.[A-Za-z0-9_$]+)*(?=[\s/>])/g;
const SEMPRE_DISPONIVEL = new Set(['React', 'Fragment']);

function semRuido(codigo) {
  return String(codigo || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')       // /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')    // // ... (sem comer "https://")
    .replace(/`(?:\\.|[^`\\])*`/g, '``')        // template strings
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Nomes que o arquivo importa ou declara — tudo que pode ser usado nele. */
export function nomesDisponiveis(codigo) {
  const c = String(codigo || '');
  const nomes = new Set(SEMPRE_DISPONIVEL);
  // import X, { a as b, c } from '...' / import * as NS from '...'
  for (const m of c.matchAll(/\bimport\s+([^;]*?)\s+from\s*['"][^'"]*['"]/g)) {
    const alvo = m[1];
    for (const parte of alvo.split(/[{},]/)) {
      const nome = parte.replace(/\btype\b/g, '').trim();
      if (!nome) continue;
      const comoAlias = nome.match(/\bas\s+([A-Za-z0-9_$]+)$/);
      const puro = comoAlias ? comoAlias[1] : nome.replace(/^\*\s*/, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(puro)) nomes.add(puro);
    }
  }
  // declarações locais, inclusive desestruturação
  for (const m of c.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) nomes.add(m[1]);
  // Qualquer chave/valor dentro de chaves. Pega a desestruturação de
  // parâmetro, que é como o shadcn escreve ícone como prop:
  // `function Item({ icon: Icon })` e depois `<Icon />` (visto em projeto
  // real do dono). Objeto literal também entra e ACRESCENTA nome de mais —
  // de propósito: aqui errar para o lado de não acusar é o certo, porque
  // recusar escrita boa custa mais que deixar passar uma ruim.
  for (const m of c.matchAll(/\{([^{}]*)\}/g)) {
    for (const parte of m[1].split(',')) {
      const nome = parte.split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome)) nomes.add(nome);
    }
  }
  return nomes;
}

/** Componentes abertos em JSX que o arquivo não importa nem declara. */
export function componentesNaoImportados(codigo) {
  // Os nomes saem do código CRU: semRuido esvazia as aspas, e aí o caminho do
  // import (`from "lucide-react"`) viraria `from ""` — a lista de importados
  // sumia inteira e TODO componente virava falso positivo.
  const disponiveis = nomesDisponiveis(codigo);
  const limpo = semRuido(codigo);
  const faltando = new Set();
  for (const m of limpo.matchAll(RE_TAG)) {
    const nome = m[2];
    if (!disponiveis.has(nome)) faltando.add(nome);
  }
  return [...faltando];
}

// ---------- o bloco que vai no contexto da IA ----------

const LINHA = {
  arquivos: 'Routing: file-based. Every .tsx in "src/routes/" is a page (index.tsx -> /, sobre.tsx -> /sobre, users/$id.tsx -> /users/:id). "src/routes/__root.tsx" is the app shell — keep its <Outlet />. NEVER create "src/pages/", "app/" or a router file: a page outside src/routes/ is never rendered.',
  'react-router': 'Routing: React Router. Pages live in "src/pages/" and every new page must ALSO be registered as a <Route> in the router file (usually src/App.tsx) — a page that is not registered is never rendered.',
};

/**
 * Bloco <project_shape>. Curto de propósito: ele viaja em toda chamada do laço.
 * @param {ReturnType<typeof detectarForma>} forma
 * @param {{path:string, texto:string}[]} textos  instruções da própria Lovable
 * @param {ReturnType<typeof detectarModoEscuro>} modoEscuro
 */
export function blocoDoProjeto(forma, textos = [], modoEscuro = null) {
  if (!forma) return '';
  const l = [];
  l.push('<project_shape>');
  l.push(
    'You edit the GitHub repository, but LOVABLE is what builds and shows the result: the request is only done when the PREVIEW SCREEN changes. A commit that breaks Lovable\'s build is a failure — the preview keeps serving the last version that compiled, and the user sees "nothing happened". Keep the branch working.'
  );
  l.push('Some things the preview shows do NOT come from this repository and cannot be changed by a commit: the Lovable Cloud database, images served from Lovable\'s asset CDN, and environment variables. If the request depends on one of those, say so in your summary instead of claiming it is done.');
  if (forma.roteador) l.push(LINHA[forma.roteador]);
  if (forma.ssr) {
    l.push(
      'Server-side rendering is ON (TanStack Start). Never touch window, document, localStorage or matchMedia at module scope or during render — it breaks the build/hydration. Read them inside useEffect, with a safe initial state (this is the usual cause of a broken dark-mode toggle).'
    );
  }
  if (forma.tailwind === 'v4') {
    l.push(
      `Tailwind v4: there is NO tailwind.config file and creating one changes nothing. The theme lives in "${forma.css}" (@theme inline + CSS variables) — read it before styling, reuse the semantic tokens already there (bg-background, text-foreground, bg-primary…), and if you must add a color, follow the instructions written in that file (values in oklch). Tailwind only generates classes it can SEE in the source: always write complete literal class names, never build them ("text-" + cor produces no CSS and no error).`
    );
  } else if (forma.tailwind === 'v3') {
    l.push(
      `Tailwind v3: theme in "${forma.configTailwind}", CSS variables in "${forma.css}". Always write complete literal class names, never build them at runtime ("text-" + cor produces no CSS and no error).`
    );
  }
  if (modoEscuro && LINHA_ESCURO[modoEscuro.modo]) {
    const blocoDark = forma.css ? `the .dark block in "${forma.css}"` : 'the .dark theme colors';
    l.push(
      `Dark mode: ${LINHA_ESCURO[modoEscuro.modo]} (seen in ${modoEscuro.onde.join(', ')}). Every color change must work in BOTH themes: when you change a background, text, border or accent color, check the same element's dark: classes and ${blocoDark}, and update them too — or use the theme tokens (bg-background, text-foreground, bg-primary…), which already have both versions. Changing only the light color is invisible to anyone in dark mode. In the summary, say which theme the change affects.`
    );
  }
  if (forma.assets === 'descritor') {
    l.push(
      'Images in this project are referenced through a descriptor: `import foo from "@/assets/foo.jpg.asset.json"` and then `src={foo.url}` — the file the browser loads comes from Lovable\'s CDN, NOT from the binary in this repository. So replacing the binary here does not change what the user sees. If the user wants a different image, say that in the summary.'
    );
  }
  l.push('Never edit generated files (*.gen.ts, routeTree.gen.ts, lockfiles) or add plugins to vite.config — Lovable regenerates the first and its preset already includes the second (duplicate plugins break the app).');
  for (const t of textos) {
    if (t?.texto) l.push(`\n--- ${t.path} (written by Lovable — follow it) ---\n${t.texto}`);
  }
  l.push('</project_shape>');
  return l.join('\n');
}
