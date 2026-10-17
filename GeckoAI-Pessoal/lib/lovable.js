// Aplicação automática de SQL no banco do Lovable Cloud.
//
// COMO FUNCIONA, E POR QUE ASSIM
//
// O banco do Lovable Cloud não aceita conexão de fora (é a razão de existir o
// modo SQL manual). Mas o editor de SQL do próprio Lovable chama uma API dele:
//
//   POST https://api.lovable.dev/projects/<id>/cloud/query?env=prod
//   authorization: Bearer <token do Firebase, 1 hora de validade>
//   {"query": "...", "source": "sql-editor"}
//
// A resposta traz `Access-Control-Allow-Origin: https://lovable.dev`. Isso é o
// que define o desenho: se a chamada sair DE DENTRO da página do Lovable, o
// CORS passa — e a extensão **nunca precisa ler nem guardar o token**. Ela
// injeta a função abaixo na aba do Lovable (chrome.scripting), a página faz o
// pedido com a sessão que já tem, e volta apenas o resultado da consulta.
//
// A diferença é grande: o token do Firebase dá acesso à CONTA inteira do
// usuário no Lovable, não só ao banco. Mantê-lo fora do alcance da extensão
// reduz o estrago possível de "conta inteira" para "esta consulta".
//
// Por isso as permissões pedidas são só `scripting` + `https://lovable.dev/*`,
// e OPCIONAIS: quem não liga o modo automático continua com os 4 hosts de
// sempre. `api.lovable.dev` não entra em lugar nenhum do manifest.
//
// LIMITE CONHECIDO: é uma API interna, não documentada. Pode mudar sem aviso —
// se mudar, `aplicarSql` devolve erro e o fluxo cai de volta no modo manual,
// que continua inteiro. Ver docs/DECISOES.md.

export const API_LOVABLE = 'https://api.lovable.dev';

export function urlDaConsulta(projectId) {
  return `${API_LOVABLE}/projects/${encodeURIComponent(projectId)}/cloud/query?env=prod`;
}

// `source` é rótulo de telemetria do Lovable. Mandamos o mesmo que o editor
// deles manda porque é o único valor que sabemos ser aceito — um valor
// desconhecido pode ser recusado e quebrar o recurso para todo mundo.
export function corpoDaConsulta(sql) {
  return { query: String(sql), source: 'sql-editor' };
}

// Mensagens em português, sem jargão: quem lê é o cliente final.
export function mensagemDeErro(status, dados) {
  const doServidor = typeof dados?.message === 'string' ? dados.message : null;
  if (status === 401 || status === 403) {
    return 'Sua sessão do Lovable expirou. Atualize a aba do Lovable e tente de novo.';
  }
  if (status === 404) return 'Não encontrei este projeto no Lovable.';
  if (status === 429) return 'O Lovable pediu para esperar um pouco. Tente de novo em instantes.';
  if (status >= 500) return 'O Lovable está com instabilidade. Tente de novo em instantes.';
  // Erro do banco (SQL inválido, coluna que já existe...): esse texto AJUDA,
  // porque diz o que o Postgres reclamou. Vai como veio.
  if (doServidor) return doServidor;
  return `Não consegui aplicar a mudança (erro ${status}).`;
}

// Que tipo de erro é: 'banco' quando o Postgres recusou o SQL (a IA corrige
// e propõe de novo, na mesma conversa); 'acesso' para o resto (sessão, aba,
// projeto, instabilidade), que cai na reserva manual. Só vale 'banco' com a
// mensagem do servidor em mãos — sem ela não há o que corrigir.
export function tipoDoErro(status, dados) {
  const doServidor = typeof dados?.message === 'string' && dados.message.trim();
  if (!doServidor) return 'acesso';
  if ([401, 403, 404, 429].includes(status)) return 'acesso';
  if (status >= 500) return 'acesso';
  return 'banco';
}

// Erros que a função injetada devolve por código, para a UI traduzir.
export const FALHAS = {
  'sem-sessao': 'Você não está conectado no Lovable nesta aba. Abra o seu projeto no Lovable e tente de novo.',
  'sessao-vencida': 'Sua sessão do Lovable expirou. Atualize a aba do Lovable e tente de novo.',
  'sem-indexeddb': 'Não consegui ler a sessão do Lovable nesta aba. Atualize a página e tente de novo.',
  'sem-resposta': 'O Lovable não respondeu. Verifique sua internet e tente de novo.',
};

export function traduzFalha(codigo) {
  return FALHAS[codigo] || 'Não consegui aplicar a mudança no banco.';
}

// As linhas que a API devolve: {"result":[{...}, ...]} com o resultado do
// ÚLTIMO comando (provado em 2026-09-29, T02 da prova técnica).
export function linhasDaResposta(dados) {
  if (Array.isArray(dados?.result)) return dados.result;
  if (Array.isArray(dados)) return dados;
  return [];
}

// ---------------------------------------------------------------------------
// LER o banco (ferramenta consultar_banco): até 2026-09-29 a IA só ESCREVIA
// no Lovable Cloud — descobria as tabelas por migração antiga e pelo arquivo
// de tipos, que podem estar desatualizados, e não tinha como ver por que "os
// dados não aparecem". A mesma chamada que aplica o SQL serve para ler.
//
// A trava é do PRÓPRIO Postgres: `set transaction read only` na frente, e ele
// recusa qualquer escrita — inclusive de dentro de função chamada pelo
// SELECT. Provado na sessão do dono (T03/T04: "25006: cannot execute CREATE
// TABLE in a read-only transaction", nada criado). Um comando só, para que um
// "commit;" no meio não encerre a transação protegida e abra outra sem trava.
// ---------------------------------------------------------------------------

// Tira comentário, texto entre aspas e corpo $tag$…$tag$: um ";" lá dentro
// não separa comandos. `nomes`: mantém "Identificador" entre aspas duplas
// (tabelasCriadas precisa do nome como foi escrito).
//
// Um caractere por vez, e não uma regex por tipo: com regex, o apóstrofo de
// um comentário ("-- don't") casava com o de um texto lá na frente e
// escondia um "; drop table x;" inteiro da checagem de comando único.
function semLiterais(sql, { nomes = false } = {}) {
  const s = String(sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const dois = s.slice(i, i + 2);
    if (dois === '--') {
      const fim = s.indexOf('\n', i);
      i = fim === -1 ? s.length : fim;
      out += ' ';
    } else if (dois === '/*') {
      const fim = s.indexOf('*/', i + 2);
      i = fim === -1 ? s.length : fim + 2;
      out += ' ';
    } else if (c === "'") {
      let j = i + 1;
      while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
      i = j + 1;
      out += "''";
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && !(s[j] === '"' && s[j + 1] !== '"')) j += s[j] === '"' ? 2 : 1;
      out += nomes ? s.slice(i, j + 1) : '""';
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(s.slice(i));
      if (m) {
        const fim = s.indexOf(m[0], i + m[0].length);
        i = fim === -1 ? s.length : fim + m[0].length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Permitido no modo leitura, mas não é leitura: derruba conexão, dorme,
// mexe em configuração da sessão, avisa ouvintes. O banco não barra; a
// extensão barra. nextval/setval o banco barra em modo leitura, mas ficam
// aqui também: mexer num contador faz o INSERT seguinte colidir.
const FUNCOES_PERIGOSAS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_sleep\w*|pg_advisory\w*|lo_\w+|dblink\w*|pg_read_\w+|pg_ls_\w+|pg_notify|nextval|setval)\s*\(/i;
// Segunda trava, além da do banco: palavra de escrita fora de texto (CTE que
// apaga — "with x as (delete …) select" — e afins). Nome com sublinhado
// (updated_at, delete_log) não casa, e texto entre aspas já saiu.
const PALAVRAS_DE_ESCRITA =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|vacuum|reindex|cluster|refresh|listen|notify|lock)\b/i;

/**
 * A consulta pode ir para o banco pela ferramenta de leitura?
 * @returns {{ok:true, sql:string} | {ok:false, motivo:string}}
 */
export function consultaDeLeitura(sql) {
  const bruto = String(sql ?? '').trim().replace(/;\s*$/, '').trim();
  if (!bruto) return { ok: false, motivo: 'consultar_banco needs a SQL query.' };
  const limpo = semLiterais(bruto).trim();
  if (limpo.includes(';')) {
    return { ok: false, motivo: 'consultar_banco runs ONE read-only query per call (no ";" between statements). Split it into separate calls.' };
  }
  if (!/^(select|with|show|explain|table|values)\b/i.test(limpo)) {
    return { ok: false, motivo: 'consultar_banco only reads (SELECT / WITH / SHOW / EXPLAIN). To change the database, use propor_migracao.' };
  }
  if (FUNCOES_PERIGOSAS.test(limpo)) {
    return { ok: false, motivo: 'That function is not allowed in consultar_banco. Query tables, views and the catalog (information_schema, pg_catalog, pg_policies) instead.' };
  }
  // EXPLAIN ANALYZE executa a consulta de verdade.
  if (PALAVRAS_DE_ESCRITA.test(limpo) || /^explain\b[\s\S]*\banalyze\b/i.test(limpo)) {
    return { ok: false, motivo: 'consultar_banco only reads: no INSERT/UPDATE/DELETE (not even inside WITH), no DDL, no EXPLAIN ANALYZE. To change the database, use propor_migracao.' };
  }
  return { ok: true, sql: bruto };
}

/** O que vai para a API: a consulta dentro de uma transação que só lê. */
export function sqlDeLeitura(sql) {
  return `set transaction read only;\n${sql}`;
}

// ---------------------------------------------------------------------------
// ENSAIO antes do cartão Autorizar: o SQL roda de verdade dentro de um bloco
// que SEMPRE termina em erro proposital — o Postgres desfaz tudo. Se o erro
// que volta é o nosso, o SQL funcionou; se é outro, é o erro real, que a IA
// corrige sem o leigo ver cartão nenhum. Antes, cada tentativa errada virava
// um cartão "o banco não aceitou" e mais um clique em Autorizar.
//
// Provado (T08–T10): nada fica no banco, nem com função ($$) dentro, e o
// banco continua saudável depois. Bloco DO e não begin/rollback porque um
// "commit;" escrito pela IA DENTRO do SQL encerraria o ensaio e aplicaria de
// verdade — dentro do DO ele dá erro, e o ensaio fica inconclusivo. A única
// coisa que o ensaio NÃO desfaz é contador de sequência (nextval de um INSERT
// com id serial): o próximo id pula alguns números, o que é inofensivo.
//
// A sentinela é SORTEADA a cada ensaio: com um texto fixo, um SQL da IA (ou
// induzido por arquivo malicioso do repositório) que fizesse
// "raise exception 'GECKO_ENSAIO_OK'" fingiria ensaio aprovado — e o cartão
// diria ao leigo "já conferi que funciona" (revisão adversarial, 2026-09-29).
// ---------------------------------------------------------------------------
export const PREFIXO_SENTINELA = 'GECKO_ENSAIO_OK';

/** @returns {{sql:string, sentinela:string}} o bloco de ensaio e a sentinela dele */
export function sqlDeEnsaio(sql, sortear = Math.random) {
  const corpo = String(sql ?? '');
  const tag = () => `gk${Math.floor(sortear() * 1e12).toString(36)}`;
  let fora = tag();
  let dentro = tag();
  for (let n = 0; fora === dentro || corpo.includes(`$${fora}$`) || corpo.includes(`$${dentro}$`); n++) {
    fora = `${tag()}${n}a`;
    dentro = `${tag()}${n}b`;
  }
  let sentinela = `${PREFIXO_SENTINELA}_${Math.floor(sortear() * 1e12).toString(36)}${Math.floor(sortear() * 1e12).toString(36)}`;
  for (let n = 0; corpo.includes(sentinela); n++) sentinela = `${sentinela}${n}`;
  return {
    sql: `do $${fora}$\nbegin\n  execute $${dentro}$\n${corpo}\n$${dentro}$;\n  raise exception '${sentinela}';\nend\n$${fora}$;`,
    sentinela,
  };
}

// Não dá para ensaiar dentro de uma transação: comando de transação escrito
// pela IA, CREATE INDEX CONCURRENTLY e afins. Aí vale o fluxo de sempre.
const NAO_ENSAIAVEL =
  /cannot (?:be executed|run) (?:from a function|inside a transaction block)|unsupported transaction command|invalid transaction termination|EXECUTE of transaction commands|CONCURRENTLY/i;

/** Só a linha do erro: o resto é o nosso bloco de ensaio, que a IA não escreveu. */
function erroDoEnsaio(msg) {
  return String(msg)
    .replace(/^Failed to run sql query:\s*/i, '')
    .split(/\n(?:QUERY|CONTEXT):/)[0]
    .trim();
}

/**
 * Lê o que voltou do ensaio.
 * @param {{ok?:boolean, erro?:string, tipo?:string, sentinela?:string}} r
 *   resultado de aplicarSqlNoLovable, com a `sentinela` que sqlDeEnsaio sorteou
 * @returns {{ok:true} | {erro:string} | {inconclusivo:true}}
 */
export function resultadoDoEnsaio(r) {
  if (r?.tipo !== 'banco' || typeof r.erro !== 'string') return { inconclusivo: true };
  // Sem a sentinela sorteada não há como saber se passou: fluxo de sempre.
  if (typeof r.sentinela !== 'string' || !r.sentinela.startsWith(`${PREFIXO_SENTINELA}_`)) return { inconclusivo: true };
  if (new RegExp(`(^|[^A-Za-z0-9_])${r.sentinela}([^A-Za-z0-9_]|$)`).test(r.erro)) return { ok: true };
  if (NAO_ENSAIAVEL.test(r.erro)) return { inconclusivo: true };
  return { erro: erroDoEnsaio(r.erro) };
}

// ---------------------------------------------------------------------------
// RETRATO do banco no começo do pedido (bloco <database_schema>): uma linha
// por tabela, pequena — a API corta resposta grande (o retrato completo de um
// banco de 3 tabelas voltou com 12.000 chars exatos), então nada de um JSON
// numa célula só.
// ---------------------------------------------------------------------------
export const SQL_RESUMO_DO_BANCO = `select c.relname as tabela,
  c.relrowsecurity as rls,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas,
  (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end, ', ' order by a.attnum)
     from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as colunas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by c.relname
limit 300`;

const MAX_BLOCO_DO_BANCO = 6000;

function situacaoDeAcesso(rls, politicas) {
  if (rls === false) return 'RLS OFF — anyone with the public key can read and change it';
  if (Number(politicas) === 0) return 'RLS on, NO policies — the app can neither read nor write it';
  return `RLS on, ${Number(politicas)} ${Number(politicas) === 1 ? 'policy' : 'policies'}`;
}

/** O bloco de contexto a partir das linhas de SQL_RESUMO_DO_BANCO. */
export function blocoDoBanco(linhas, max = MAX_BLOCO_DO_BANCO) {
  const tabelas = (linhas || []).filter((l) => l && typeof l.tabela === 'string');
  if (!tabelas.length) return '';
  const cab = [
    '<database_schema source="live Lovable Cloud database, read at the start of this request">',
    'Tables in the public schema (columns with types). This is the REAL database right now — trust it over migration files, types.ts or docs/DB_SCHEMA.json. For policies, functions, triggers, foreign keys or row counts, use consultar_banco.',
  ];
  const corpo = [];
  let usado = cab.join('\n').length;
  let omitidas = 0;
  for (const t of tabelas) {
    const linha = `- ${t.tabela} (${situacaoDeAcesso(t.rls, t.politicas)}): ${t.colunas || '(no columns)'}`;
    if (usado + linha.length + 1 > max) { omitidas++; continue; }
    corpo.push(linha);
    usado += linha.length + 1;
  }
  if (omitidas) corpo.push(`… +${omitidas} more tables — list them with consultar_banco.`);
  return [...cab, ...corpo, '</database_schema>'].join('\n');
}

// ---------------------------------------------------------------------------
// CONFERÊNCIA depois de aplicar: tabela nova sem RLS deixa os dados abertos a
// qualquer um com a chave pública do site; RLS ligado sem nenhuma política é
// o clássico "os dados não aparecem". Os dois se corrigem na mesma conversa.
// ---------------------------------------------------------------------------
export function tabelasCriadas(sql) {
  const nomes = new Set();
  // "a""b" é o nome a"b: aspas dobradas dentro do identificador.
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?("((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))/gi;
  for (const m of semLiterais(sql, { nomes: true }).matchAll(re)) {
    nomes.add(m[2] != null ? m[2].replace(/""/g, '"') : m[3].toLowerCase());
  }
  return [...nomes];
}

export function sqlConferenciaDeAcesso(nomes) {
  const lista = nomes.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(', ');
  return `select c.relname as tabela, c.relrowsecurity as rls,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname in (${lista})`;
}

/**
 * O ajuste ABRE acesso aos dados (desliga RLS, política "using (true)" para
 * escrever, grant para anon/public)? Aí o cartão não esconde o SQL atrás do
 * resumo: uma IA errada — ou induzida por arquivo malicioso — escreveria um
 * resumo simpático para um SQL que deixa o banco aberto (revisão adversarial).
 */
export function abreAcesso(sql) {
  const s = semLiterais(sql).replace(/\s+/g, ' ');
  return (
    /disable row level security/i.test(s) ||
    /\bno force row level security/i.test(s) ||
    /for (all|insert|update|delete)\b[^;]*\b(using|with check) \( ?true ?\)/i.test(s) ||
    /\bgrant\b[^;]*\bto (anon|public)\b/i.test(s)
  );
}

/** Texto para a IA quando a conferência acha problema; '' quando está tudo certo. */
export function avisoDeAcesso(linhas) {
  const problemas = (linhas || []).filter((l) => l?.rls === false || Number(l?.politicas) === 0);
  if (!problemas.length) return '';
  const itens = problemas.map((l) => `"${l.tabela}" (${situacaoDeAcesso(l.rls, l.politicas)})`).join('; ');
  return `SECURITY CHECK after applying: ${itens}. Fix it NOW with another propor_migracao: ALTER TABLE ... ENABLE ROW LEVEL SECURITY and policies that match how the app uses the table (e.g. each user sees only their own rows). Do not finish with this open.`;
}

// ---------------------------------------------------------------------------
// A função abaixo NÃO roda aqui: ela é serializada e executada DENTRO da aba
// do Lovable por chrome.scripting.executeScript. Por isso é autocontida — não
// pode usar nada deste módulo, nem imports, nem variáveis de fora.
//
// Devolve { ok, status, dados } ou { falha: <código de FALHAS> }.
// NUNCA devolve o token: ele não sai da página.
// ---------------------------------------------------------------------------
export function codigoInjetado(projectId, sql) {
  const url = `https://api.lovable.dev/projects/${encodeURIComponent(projectId)}/cloud/query?env=prod`;

  // O Firebase (autenticação do Lovable) guarda a sessão no IndexedDB do site.
  function lerSessao() {
    return new Promise((resolve) => {
      let pedido;
      try {
        pedido = indexedDB.open('firebaseLocalStorageDb');
      } catch {
        return resolve(null);
      }
      pedido.onerror = () => resolve(null);
      pedido.onsuccess = () => {
        const db = pedido.result;
        let tx;
        try {
          tx = db.transaction('firebaseLocalStorage', 'readonly');
        } catch {
          return resolve(null);
        }
        const req = tx.objectStore('firebaseLocalStorage').getAll();
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const linha = (req.result || []).find(
            (r) => typeof r?.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:')
          );
          resolve(linha?.value?.stsTokenManager || null);
        };
      };
    });
  }

  return (async () => {
    const sessao = await lerSessao();
    if (sessao === null) return { falha: 'sem-indexeddb' };
    if (!sessao.accessToken) return { falha: 'sem-sessao' };
    // O SDK do Firebase renova sozinho enquanto a aba está aberta; se mesmo
    // assim veio vencido, a aba está velha e um F5 resolve.
    if (Number(sessao.expirationTime) && Number(sessao.expirationTime) < Date.now()) {
      return { falha: 'sessao-vencida' };
    }

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessao.accessToken}` },
        body: JSON.stringify({ query: String(sql), source: 'sql-editor' }),
      });
    } catch {
      return { falha: 'sem-resposta' };
    }
    const dados = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, dados };
  })();
}
