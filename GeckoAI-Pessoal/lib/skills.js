// GeckoAI — skills: instruções de especialista que o cliente instala no
// projeto com um clique (1.12.0).
//
// Uma skill é uma pasta com um SKILL.md (formato aberto "Agent Skills") e,
// às vezes, arquivos de apoio. Os textos NÃO são nossos: são skills públicas,
// já muito usadas, com licença que permite redistribuir (origem e cortes de
// cada uma em docs/SKILLS.md). Vêm no pacote, em skills/<id>/.
//
// Instalar = commitar a pasta em `.agents/skills/<id>/` do repositório do
// cliente — sem IA, sem prompt. A partir daí o agente recebe um índice de uma
// linha por skill instalada e lê o SKILL.md (read_file) quando o pedido é do
// tema: o texto inteiro só entra na conversa de quem vai usar.
//
// Só skill deste catálogo entra no índice: pasta desconhecida em
// `.agents/skills/` é ignorada, para um repositório não injetar instrução
// por esse caminho. E o conteúdo que a IA lê vem do PACOTE, não do
// repositório (lib/agent.js): o que está no GitHub marca "instalada", o texto
// é sempre o conferido.
//
// Puro: sem `chrome.*` e sem rede. Quem lê os arquivos do pacote é injetado.

export const PASTA_DAS_SKILLS = '.agents/skills/';

const REGRAS_DE_REACT = [
  'advanced-event-handler-refs', 'advanced-init-once',
  'async-cheap-condition-before-await', 'async-defer-await', 'async-parallel',
  'bundle-analyzable-paths', 'bundle-conditional', 'bundle-preload',
  'client-localstorage-schema', 'client-passive-event-listeners',
  'js-batch-dom-css', 'js-cache-function-results', 'js-cache-property-access', 'js-cache-storage',
  'js-combine-iterations', 'js-early-exit', 'js-flatmap-filter', 'js-hoist-regexp', 'js-index-maps',
  'js-length-check-first', 'js-min-max-loop', 'js-request-idle-callback', 'js-set-map-lookups',
  'js-tosorted-immutable',
  'rendering-animate-svg-wrapper', 'rendering-conditional-render', 'rendering-content-visibility',
  'rendering-hoist-jsx', 'rendering-hydration-no-flicker', 'rendering-hydration-suppress-warning',
  'rendering-script-defer-async', 'rendering-svg-precision', 'rendering-usetransition-loading',
  'rerender-defer-reads', 'rerender-dependencies', 'rerender-derived-state-no-effect',
  'rerender-derived-state', 'rerender-functional-setstate', 'rerender-lazy-state-init',
  'rerender-memo-with-default-value', 'rerender-memo', 'rerender-move-effect-to-event',
  'rerender-no-inline-components', 'rerender-simple-expression-in-memo', 'rerender-split-combined-hooks',
  'rerender-transitions', 'rerender-use-deferred-value', 'rerender-use-ref-transient-values',
];

// O que cada "Usar agora" tem em comum: ler a skill antes, CORRIGIR (não
// listar), caber num pedido e dizer o que ficou de fora.
const comoAplicar = (id, limite) =>
  `Leia primeiro "${PASTA_DAS_SKILLS}${id}/SKILL.md" e siga o que ela diz. Corrija de verdade o que encontrar — não devolva só uma lista. Mexa em no máximo ${limite} arquivos: comece pelo que mais importa e, se sobrar, diga no resumo o que ficou para um próximo pedido. Não mude o que funciona nem o que não tem a ver com o tema. No resumo, em linguagem simples, diga o que foi corrigido, em quais páginas, e o que depende do usuário.`;

/**
 * `nome`/`resumo`: o que o cliente lê no painel. `quando`: a linha do índice
 * que a IA recebe (em inglês, como os prompts). `nota`: o que muda no NOSSO
 * agente e na stack da Lovable — a skill foi escrita para agentes em geral.
 * `arquivos`: tudo o que vai para o repositório, relativo à pasta da skill
 * (o teste confere com o que está em skills/<id>/).
 */
export const SKILLS = [
  {
    id: 'frontend-design',
    nome: 'Design',
    grupo: 'aparencia',
    resumo: 'Visual com identidade própria: tipografia, cores e layout pensados para o seu negócio, sem cara de site genérico.',
    quando: 'building a new page or section, or redesigning an existing one; requests to make the UI look better, more professional or less generic (typography, palette, layout, copy).',
    nota: 'Use it for new screens and for requests about the look. For a small change inside an existing screen, keep the project\'s current theme tokens, fonts and components — do not restyle what was not asked. You cannot take screenshots or ask the client to confirm: decide, and state the direction you took in the summary.',
    arquivos: ['SKILL.md', 'LICENSE.txt'],
    usar: {
      rotulo: 'Melhorar o visual da página inicial',
      pedido: '🎨 Skill Design: melhorar o visual da página inicial',
      prompt: `Aplique a skill de design na PÁGINA INICIAL deste projeto. ${comoAplicar('frontend-design', 8)} Mantenha o conteúdo, as seções, os links e tudo o que funciona hoje; melhore tipografia, cores, espaçamento e hierarquia visual seguindo a skill. Se o projeto já tem cores de marca evidentes, parta delas. Só a página inicial (e os estilos globais que ela precisar) — as outras páginas ficam como estão.`,
    },
  },
  {
    id: 'seo',
    nome: 'SEO',
    grupo: 'crescimento',
    resumo: 'Para o site aparecer no Google: títulos e descrições por página, prévia ao compartilhar o link, sitemap, robots e dados estruturados.',
    quando: 'SEO work: page titles and meta descriptions, Open Graph / link previews, canonical URLs, robots.txt, sitemap.xml, structured data (JSON-LD), heading structure, image alt text; "appear on Google".',
    nota: null, // depende do formato do projeto: ver notaDeSeo
    arquivos: ['SKILL.md', 'LICENSE.txt', 'references/STRUCTURED-DATA.md'],
    usar: {
      rotulo: 'Revisar o SEO do projeto',
      pedido: '🔎 Skill SEO: revisar e corrigir o SEO do projeto',
      prompt: `Aplique a skill de SEO neste projeto. ${comoAplicar('seo', 12)} Siga a ordem do checklist da skill: título e descrição únicos em cada página, idioma do documento, um título principal claro por página, prévia de compartilhamento (Open Graph), URL canônica, robots.txt, sitemap.xml, texto alternativo das imagens e dados estruturados onde fizer sentido. Não mude o visual nem o texto que o visitante lê além do necessário. Se o endereço real do site não aparecer no projeto, use um marcador óbvio e avise no resumo onde trocar.`,
    },
  },
  {
    id: 'supabase-security',
    nome: 'Segurança',
    grupo: 'tecnico',
    resumo: 'Protege os dados do seu app: quem pode ver e editar cada informação, login, chaves e arquivos — o checklist oficial do Supabase.',
    quando: 'anything touching login/auth, RLS policies, who can see or edit which data, storage access or API keys in the client; "data does not show up" or "everyone can see everything"; a security review.',
    nota: 'Lovable Cloud is Supabase. Look at the real state before changing anything: with a database tool available, query pg_policies and pg_class.relrowsecurity; otherwise read supabase/migrations and the generated types. Database changes go through the database tool this project gives you (never claim a change you could not apply). The app must keep working for the people who use it today: before restricting a table, check how the app reads and writes it (with or without login) and write policies that still allow that. Lovable projects often call a SECURITY DEFINER helper such as public.has_role() inside policies — never move, drop or revoke EXECUTE on a function that policies call (a policy runs with the privileges of whoever queries, so the app would lose access). Identify the user with (select auth.uid()), never with a custom setting. In the frontend, any VITE_ variable and anything under src/ is sent to the browser.',
    arquivos: ['SKILL.md', 'LICENSE.txt', 'references/security-rls-performance.md'],
    usar: {
      rotulo: 'Revisar a segurança do projeto',
      pedido: '🛡️ Skill Segurança: revisar e corrigir a segurança do projeto',
      prompt: `Aplique a skill de segurança neste projeto. ${comoAplicar('supabase-security', 10)} Percorra o checklist da skill: tabelas sem proteção de acesso por linha, regras que deixam um usuário ver ou alterar dados de outro, chaves secretas no código do navegador, funções e views que ignoram as regras, e acesso aos arquivos enviados. Antes de mudar, confira o estado real do banco com as ferramentas que você tiver. O app tem de continuar funcionando para quem usa hoje: antes de restringir uma tabela, veja como o app lê e grava nela (com ou sem login) e mantenha esse uso permitido; na dúvida, não restrinja — explique o risco no resumo. Nunca apague dados nem tabelas. Se o banco não estiver acessível daqui, corrija o que for de código e diga com clareza o que precisa ser ajustado no banco.`,
    },
  },
  {
    id: 'react-best-practices',
    nome: 'Performance',
    grupo: 'tecnico',
    resumo: 'Deixa o app mais rápido: menos travadas, telas que carregam antes e listas pesadas sem engasgar — 48 regras da engenharia da Vercel.',
    quando: 'performance: slow or laggy screens, unnecessary re-renders, heavy lists, slow data loading, bundle size; a performance review of React code.',
    nota: 'This project is NOT Next.js: ignore anything about next/*, Server Components or Server Actions that a rule may still mention. Check the React version in package.json before using an API newer than it. Rule files are at rules/<rule-name>.md — read only the ones you will apply. Apply a rule only where the code really has that problem; no blanket refactors.',
    arquivos: ['SKILL.md', 'LICENSE.txt', ...REGRAS_DE_REACT.map((r) => `rules/${r}.md`)],
    usar: {
      rotulo: 'Revisar a performance do projeto',
      pedido: '⚡ Skill Performance: revisar e melhorar a performance do projeto',
      prompt: `Aplique a skill de performance neste projeto. ${comoAplicar('react-best-practices', 10)} Procure primeiro os problemas das categorias de maior impacto da skill (carregamentos em sequência que poderiam ser paralelos, código pesado carregado sem necessidade, telas que redesenham à toa, listas grandes) nas páginas principais. Leia o arquivo da regra antes de aplicá-la. O comportamento e o visual do app têm de continuar exatamente iguais.`,
    },
  },
  {
    id: 'web-design-guidelines',
    nome: 'Acessibilidade',
    grupo: 'aparencia',
    resumo: 'Revisão de acessibilidade e acabamento da interface: rótulos, teclado e foco, formulários, toque no celular e modo escuro.',
    quando: 'accessibility and UI quality review: labels, keyboard and focus, forms, hover/active states, animation, touch, dark-mode details, long or empty content; "review my UI", "check accessibility".',
    nota: 'The skill describes a review that outputs findings; in Build mode, fix them and report in plain words instead of printing the file:line list. UI text here is usually Brazilian Portuguese: keep sentence case and the project\'s wording.',
    arquivos: ['SKILL.md', 'LICENSE.txt'],
    usar: {
      rotulo: 'Revisar a acessibilidade e a interface',
      pedido: '♿ Skill Acessibilidade: revisar e corrigir a interface do projeto',
      prompt: `Aplique a skill de acessibilidade e qualidade de interface neste projeto. ${comoAplicar('web-design-guidelines', 12)} Revise as páginas e os componentes principais contra as regras da skill, começando pelos itens da lista de antipadrões e pelos de acessibilidade, foco e formulários. Não mude a aparência além do que a regra pede.`,
    },
  },
  // ---- segunda leva (pedido do dono, 2026-10-02: "mais 5, para um total de 10") ----
  {
    id: 'copywriting',
    nome: 'Textos',
    grupo: 'crescimento',
    resumo: 'Títulos, chamadas e textos que explicam o que você vende e convencem a clicar, sem frases genéricas nem cara de texto de robô.',
    quando: 'writing or improving the text people read on a page: headline, subheadline, button/CTA text, section copy, value proposition; "the text is weak, generic or sounds like AI".',
    nota: 'Write in the language the site already uses (usually Brazilian Portuguese): the English examples are patterns, not text to translate. You cannot interview the user — take the audience, the offer and the proof from what the project already says. Never invent testimonials, numbers, client logos or guarantees, and never leave a [NEED: …] marker on the page (it would be published): leave that element out and list what is missing in the summary. The same goes for any claim the project does not already make — free trial, price, discount, deadline or scarcity, "cancel anytime", privacy or response-time promises: the site owner is legally bound by what the page says. Change the words; keep the layout, components and links.',
    arquivos: ['SKILL.md', 'LICENSE.txt', 'references/ai-tells.md', 'references/copy-frameworks.md'],
    usar: {
      rotulo: 'Melhorar os textos da página inicial',
      pedido: '✍️ Skill Textos: melhorar os textos da página inicial',
      prompt: `Aplique a skill de textos na PÁGINA INICIAL deste projeto. ${comoAplicar('copywriting', 6)} Reescreva o título principal, o subtítulo, os textos dos botões e os textos das seções para ficarem claros, específicos e convincentes, no idioma em que o site já está. Use só o que o projeto já informa sobre o produto e o público: não invente depoimentos, números, clientes nem garantias — se faltar algo importante, diga no resumo o que o usuário precisa informar. O layout, as seções e os links ficam como estão.`,
    },
  },
  {
    id: 'cro',
    nome: 'Conversão',
    grupo: 'crescimento',
    resumo: 'Faz a página transformar visitante em cliente: proposta clara logo no topo, botões no lugar certo, prova de confiança e formulários sem atrito.',
    quando: 'making a page convert better: value proposition clarity, headline, CTA placement and hierarchy, trust signals, objections, friction; lead-capture and contact forms; "this page does not convert".',
    nota: 'The skill describes an analysis that outputs recommendations; in Build mode, implement the quick wins and the high-impact changes in the code, and put the test ideas in the summary. Write in the site\'s language. Never invent testimonials, numbers, logos, security badges or guarantees, and never add a claim the project does not already make ("free", "no credit card", "we never share your data", a response time, a phone or chat channel) — use what the project already has. Do not remove navigation, sections or form fields the app depends on, and do not make a required field optional unless the table that receives it accepts it empty. The conversion percentages in the skill are other people\'s results: never quote them as what this change will achieve.',
    arquivos: ['SKILL.md', 'LICENSE.txt', 'references/form.md'],
    usar: {
      rotulo: 'Revisar a conversão da página inicial',
      pedido: '🎯 Skill Conversão: revisar e melhorar a conversão da página inicial',
      prompt: `Aplique a skill de conversão na PÁGINA INICIAL deste projeto. ${comoAplicar('cro', 8)} Analise na ordem da skill (clareza da proposta, título, botões de ação, hierarquia visual, sinais de confiança, objeções e atrito) e aplique no código as melhorias de maior impacto. Não invente depoimentos, números nem garantias. No resumo, além do que mudou, liste as ideias que valem testar depois.`,
    },
  },
  {
    id: 'signup',
    nome: 'Cadastro',
    grupo: 'crescimento',
    resumo: 'Telas de cadastro e login que as pessoas terminam: menos campos, erros claros, senha sem dor de cabeça e bom uso no celular.',
    quando: 'sign-up, registration, login and account-creation screens: number of fields, validation and error messages, password UX, mobile, what happens right after submit.',
    nota: 'Work on the screens and their validation. Do not add a login provider (Google, Apple…) the project does not already use — turning one on is done by the user in the backend settings; suggest it in the summary instead. Never remove or stop sending a field the database needs (check the table or trigger that receives the sign-up), and do not weaken password or e-mail confirmation rules on your own. Keep the login method the project has (no magic link or passwordless on your own) and keep the pages that require login protected. Never invent testimonials, badges or promises the project does not already make ("free forever", "takes 30 seconds", "we never share your e-mail"). Implement the changes instead of printing a review; test ideas go in the summary.',
    arquivos: ['SKILL.md', 'LICENSE.txt'],
    usar: {
      rotulo: 'Revisar o cadastro e o login',
      pedido: '🔑 Skill Cadastro: revisar as telas de cadastro e login',
      prompt: `Aplique a skill de cadastro nas telas de cadastro e login deste projeto. ${comoAplicar('signup', 8)} Reduza o atrito: campos realmente necessários, mensagens de erro claras e ao lado do campo, mostrar/ocultar senha, teclado certo no celular, e o que o usuário vê logo depois de enviar. Não adicione login social que o projeto ainda não usa nem remova campo que o banco exige. Se o projeto não tiver telas de cadastro ou login, não crie: explique isso no resumo.`,
    },
  },
  {
    id: 'supabase-postgres-best-practices',
    nome: 'Banco de dados',
    grupo: 'tecnico',
    resumo: 'Tabelas e consultas bem feitas para o app não ficar lento quando os dados crescem: índices, tipos certos, paginação e buscas eficientes.',
    quando: 'designing or changing tables, columns, indexes and queries; slow lists or searches; loading related data; pagination; "the app gets slow as data grows".',
    nota: 'Lovable Cloud is Supabase Postgres. Look at the real schema with the database tool you have before proposing anything. Adding an index or a safe constraint goes through the project\'s database tool; never change the type of an existing column (primary key or not), rename or drop columns or tables of an existing app on your own — the app code depends on them and the dry run cannot see that; describe it in the summary. Never create a view over a table: here a view skips the table\'s access rules and exposes its rows. New tables keep the project\'s id convention (uuid default gen_random_uuid()), with no new extension. Use upsert only where a unique constraint on those exact columns already exists. Do not swap the way an existing search or pagination works (offset to cursor, ilike to full-text) unless the user asked for it. In the frontend the rules apply to supabase-js queries: select only the columns used, avoid one query per row, paginate lists that load everything. The speed-up figures in the rules are generic: never promise a number. For access rules (RLS) use the security skill, not this one.',
    arquivos: [
      'SKILL.md', 'LICENSE.txt',
      ...[
        'query-missing-indexes', 'query-composite-indexes', 'query-covering-indexes', 'query-index-types', 'query-partial-indexes',
        'schema-primary-keys', 'schema-data-types', 'schema-constraints', 'schema-foreign-key-indexes', 'schema-lowercase-identifiers',
        'data-n-plus-one', 'data-pagination', 'data-batch-inserts', 'data-upsert',
        'advanced-jsonb-indexing', 'advanced-full-text-search',
      ].map((r) => `references/${r}.md`),
    ],
    usar: {
      rotulo: 'Revisar o banco de dados',
      pedido: '🗄️ Skill Banco de dados: revisar tabelas e consultas do projeto',
      prompt: `Aplique a skill de banco de dados neste projeto. ${comoAplicar('supabase-postgres-best-practices', 8)} Confira primeiro o banco real com as ferramentas que você tiver. Procure o que mais pesa quando os dados crescem: colunas de filtro e de ligação entre tabelas sem índice, telas que fazem uma consulta por item, listas longas sem paginação e consultas que trazem colunas que ninguém usa. Leia a regra antes de aplicá-la. Nunca apague dados, tabelas nem colunas, e não mude o tipo de uma coluna existente. Se o banco não estiver acessível daqui, corrija o que for de código e explique no resumo o que precisa ser feito no banco.`,
    },
  },
  {
    id: 'core-web-vitals',
    nome: 'Carregamento',
    grupo: 'tecnico',
    resumo: 'Site que abre rápido e sem "pulos" na tela: imagem principal priorizada, fontes que não travam o texto e espaço reservado para o conteúdo.',
    quando: 'page loading speed and visual stability: slow first load, PageSpeed / Core Web Vitals score, heavy images or fonts, layout jumping while the page loads.',
    nota: 'You cannot measure anything here. Fix only causes that are visible in the code — images with no reserved space, a hero image that is lazy-loaded or not prioritized, fonts that block text, content inserted above existing content, heavy work inside event handlers — and never claim that a metric improved: say what changed and that the result can be checked in PageSpeed Insights. You cannot see, convert or resize image files: never reference an image that is not in the project tree (no new .webp/.avif, no srcset or <source> pointing to files that do not exist — the image would disappear), and reserve space with the size the layout already gives (aspect-ratio or the existing size classes) instead of guessing width/height numbers. Images served through Lovable asset descriptors (*.asset.json) cannot be changed from the repository. Do not change how the CSS is loaded (no inlined critical CSS, no preload of a fixed /styles.css — the build renames those files) and skip server, CDN and edge advice: this is a client-rendered app on a host you do not configure. Do not delay analytics or pixel scripts the project already loads. For re-render problems inside the app use the performance skill.',
    arquivos: ['SKILL.md', 'LICENSE.txt', 'references/LCP.md', 'references/INP.md', 'references/CLS.md'],
    usar: {
      rotulo: 'Acelerar o carregamento do site',
      pedido: '🚀 Skill Carregamento: acelerar a abertura do site',
      prompt: `Aplique a skill de carregamento neste projeto. ${comoAplicar('core-web-vitals', 8)} Comece pela página inicial: a imagem ou o texto principal do topo deve carregar com prioridade, imagens precisam de largura e altura, fontes não podem segurar o texto, e nada deve empurrar o conteúdo depois que a página aparece. Corrija só o que dá para ver no código. O visual e o comportamento ficam iguais. No resumo, diga o que mudou e lembre que o resultado pode ser conferido no PageSpeed Insights — não prometa nota.`,
    },
  },
];

/** As seções da folha de Skills, na ordem em que aparecem. */
export const GRUPOS = [
  { id: 'aparencia', nome: 'Aparência' },
  { id: 'crescimento', nome: 'Atrair e converter' },
  { id: 'tecnico', nome: 'Qualidade técnica' },
];

export function skillPorId(id) {
  return SKILLS.find((s) => s.id === id) || null;
}

/**
 * A chave deste cliente tem skills? Decisão do dono (2026-10-02): todo mundo
 * vê o botão e a lista, mas só usam os planos que têm o modelo premium (Max
 * 500, Max ilimitado, Mensal ilimitada e Enterprise) — os outros veem os
 * cartões travados, com o aviso do plano.
 *
 * O servidor não tem campo próprio para isso: lê-se o que a validação da
 * chave JÁ manda para o cadeado do modelo premium (`modelos.opcoes`, de
 * `_shared/modelos-cliente.ts`). Só a opção premium vem com `liberado: false`,
 * junto com o aviso que o dono escreveu no admin ("Disponível apenas no plano
 * Max") — é esse o texto mostrado. Sem catálogo, ou sem opção premium nele,
 * não há como saber: fica liberado (travar quem pagou por falta de dado custa
 * mais que deixar passar; mesma linha do aviso de versão).
 * @returns {{liberado: boolean, aviso: string|null}}
 */
export function acessoAsSkills(modelos) {
  const opcoes = Array.isArray(modelos?.opcoes) ? modelos.opcoes : [];
  const travada = opcoes.find((o) => o && o.liberado === false);
  if (!travada) return { liberado: true, aviso: null };
  const aviso = typeof travada.bloqueio === 'string' ? travada.bloqueio.trim() : '';
  return { liberado: false, aviso: aviso || 'Disponível apenas no plano Max' };
}

/** Onde o arquivo da skill mora no repositório do cliente. */
export function caminhoNoProjeto(id, arquivo = 'SKILL.md') {
  return `${PASTA_DAS_SKILLS}${id}/${arquivo}`;
}

/** Onde o arquivo mora no pacote da extensão (relativo à raiz dela). */
export function caminhoNoPacote(id, arquivo = 'SKILL.md') {
  return `skills/${id}/${arquivo}`;
}

export function ehCaminhoDeSkills(path) {
  const p = String(path || '');
  return p.startsWith(PASTA_DAS_SKILLS) || p === PASTA_DAS_SKILLS.slice(0, -1);
}

/**
 * `.agents/skills/<id>/<arquivo>` → { id, arquivo }, só para arquivo que o
 * catálogo conhece. Qualquer outra coisa (skill de fora, arquivo a mais na
 * pasta) devolve null.
 */
export function arquivoDeSkill(path) {
  const m = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(String(path || ''));
  if (!m) return null;
  const skill = skillPorId(m[1]);
  return skill && skill.arquivos.includes(m[2]) ? { id: skill.id, arquivo: m[2] } : null;
}

const caminhosDe = (files) => (files || []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);

/** Ids do catálogo cujo SKILL.md está na árvore do repositório, na ordem do catálogo. */
export function skillsInstaladas(files) {
  const paths = new Set(caminhosDe(files));
  return SKILLS.filter((s) => paths.has(caminhoNoProjeto(s.id))).map((s) => s.id);
}

/**
 * A pasta das skills vira UMA linha na árvore que a IA recebe: só a de
 * performance são 50 arquivos, e iriam linha a linha em toda chamada do laço.
 * Os caminhos que importam estão no bloco <skills> — que só existe com skill
 * do catálogo instalada, por isso a linha não o cita.
 */
export function colapsarSkills(paths) {
  const dentro = paths.filter(ehCaminhoDeSkills);
  if (!dentro.length) return paths;
  const linha = `${PASTA_DAS_SKILLS} (${dentro.length} files — not project code)`;
  const out = [];
  let posto = false;
  for (const p of paths) {
    if (ehCaminhoDeSkills(p)) {
      if (!posto) { out.push(linha); posto = true; }
      continue;
    }
    out.push(p);
  }
  return out;
}

// Nenhuma skill de SEO pública conhece os formatos da Lovable: onde as tags
// ficam é texto nosso, e sai da forma do projeto (lib/projeto.js).
function notaDeSeo(forma) {
  const onde = forma?.roteador === 'arquivos'
    ? 'This project uses file-based routes: each route sets its own title, meta and links in the head() of its route file, and the root route (src/routes/__root.tsx) holds the site-wide ones — never hand-write tags that head() already produces.'
    : 'In this kind of project the site-wide tags live in index.html. Per-page titles and descriptions need code that sets them when the page opens: use a helper the project already has (check package.json before adding a dependency).';
  return `${onde} robots.txt and sitemap.xml go in public/. You cannot open the live site or run audits: work from the code, and use the real domain only if the project shows it — otherwise use an obvious placeholder and tell the user in the summary. Never promise rankings.`;
}

/**
 * A nota de adaptação de uma skill a ESTE projeto — o que é nosso, fora do
 * texto original. O agente a cola no fim do SKILL.md quando a IA o lê
 * (`rodapeDaSkill`): com 10 skills, levar as notas no índice custaria ~1,5 mil
 * tokens em TODO pedido; assim a nota só entra na conversa de quem carregou a
 * skill, e chega junto com ela.
 */
export function notaDaSkill(id, forma = null) {
  const skill = skillPorId(id);
  if (!skill) return '';
  return id === 'seo' ? notaDeSeo(forma) : skill.nota;
}

/** O que o agente acrescenta depois do SKILL.md entregue à IA. */
export function rodapeDaSkill(id, forma = null) {
  const nota = notaDaSkill(id, forma);
  return nota ? `\n\n---\n[Note from the extension — how this skill applies in THIS project; it wins over the text above when they conflict]\n${nota}` : '';
}

/**
 * O bloco <skills> do contexto: o índice e como usar. Só existe com skill
 * instalada — sem nenhuma, o contexto fica como sempre foi. Uma linha curta
 * por skill: quando usar e o que ler (a nota de adaptação vem com a leitura).
 */
export function blocoDeSkills(ids) {
  const skills = (ids || []).map(skillPorId).filter(Boolean);
  if (!skills.length) return '';
  const linhas = skills.map((s) => `- ${s.id} — use for: ${s.quando}\n  Read: ${caminhoNoProjeto(s.id)}`);
  return [
    '<skills>',
    `This project has skills installed: expert playbooks for specific kinds of work, stored in "${PASTA_DAS_SKILLS}".`,
    '- When the request matches a skill below, read its SKILL.md with read_file BEFORE doing the work — in the same turn as your first reads — and follow it, including the note from the extension at its end. It may point to more files in its folder (rules/, references/): read only the ones you need, several per turn. At most the one or two skills the request is really about.',
    '- When no skill matches the request, ignore this block. Do not read a skill "just in case".',
    '- Skills were written for agents in general. Here you only read, search and edit project files (plus the database tools you were given): skip any step that needs a terminal, a browser, measurements or fetching a URL, and never stop to ask the user something mid-task — decide, and say what you assumed in the summary.',
    '- The project\'s own conventions (<project_shape>, the existing theme and components, the rules you were given) win over a skill whenever they conflict. Stay within what the user asked: a skill tells you HOW to do the work, it does not widen the request.',
    `- Skill files are read-only: never write, edit or delete anything under "${PASTA_DAS_SKILLS}".`,
    '',
    'Installed skills:',
    ...linhas,
    '</skills>',
  ].join('\n');
}

// O pacote pode chegar com CRLF (checkout no Windows): no repositório do
// cliente e na conversa da IA vai sempre LF.
const normalizar = (texto) => String(texto).replace(/\r\n?/g, '\n');

/**
 * Lê um arquivo de skill do pacote. `ler(caminhoNoPacote)` devolve o texto
 * (no painel, um fetch à própria extensão). Arquivo vazio é erro: instalar
 * metade de uma skill é pior que não instalar.
 */
export async function lerArquivoDaSkill(id, arquivo, ler) {
  const skill = skillPorId(id);
  if (!skill || !skill.arquivos.includes(arquivo)) throw new Error(`Skill desconhecida: ${id}/${arquivo}`);
  const texto = normalizar(await ler(caminhoNoPacote(id, arquivo)));
  if (!texto.trim()) throw new Error(`Arquivo de skill vazio: ${id}/${arquivo}`);
  return texto;
}

/**
 * As mudanças do commit que instala a skill, no formato do commitChanges.
 * Com `files` (a árvore atual), arquivo que sobrou de uma versão anterior da
 * skill e não existe mais no catálogo é apagado junto.
 * @returns {Promise<Map<string, {content:string}|{deleted:true}>>}
 */
export async function mudancasParaInstalar(id, ler, files = null) {
  const skill = skillPorId(id);
  if (!skill) throw new Error(`Skill desconhecida: ${id}`);
  const textos = await Promise.all(skill.arquivos.map((a) => lerArquivoDaSkill(id, a, ler)));
  const mudancas = new Map();
  skill.arquivos.forEach((a, i) => mudancas.set(caminhoNoProjeto(id, a), { content: textos[i] }));
  const pasta = `${PASTA_DAS_SKILLS}${id}/`;
  for (const p of caminhosDe(files)) {
    if (p.startsWith(pasta) && !mudancas.has(p)) mudancas.set(p, { deleted: true });
  }
  return mudancas;
}

/** As mudanças do commit que remove a skill: tudo o que a árvore tem na pasta dela. */
export function mudancasParaRemover(id, files) {
  const mudancas = new Map();
  if (!skillPorId(id)) return mudancas;
  const pasta = `${PASTA_DAS_SKILLS}${id}/`;
  for (const p of caminhosDe(files)) if (p.startsWith(pasta)) mudancas.set(p, { deleted: true });
  return mudancas;
}
