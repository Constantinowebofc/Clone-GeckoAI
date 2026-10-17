// Agente: recebe um prompt, entende o projeto no GitHub, edita arquivos via
// ferramentas (tool calling do provedor de IA escolhido) e finaliza com um
// único commit atômico. Funciona com qualquer provedor de lib/providers.js.
// Com o Supabase conectado, também executa SQL no banco do projeto (run_sql).

import { isReadOnlySql, isDestructiveSql } from './supabase.js';
import {
  detectarForma,
  blocoDoProjeto,
  arquivosDoTema,
  detectarModoEscuro,
  ehArquivoGerado,
  duplicaPluginDoVite,
  rotaForaDoLugar,
  importsDoArquivo,
  candidatosDeImport,
  componentesNaoImportados,
} from './projeto.js';
import { arquivosPesquisaveis, buscarNoTexto, formatarBusca } from './busca.js';
import {
  consultaDeLeitura,
  linhasDaResposta,
  resultadoDoEnsaio,
  SQL_RESUMO_DO_BANCO,
  blocoDoBanco,
  tabelasCriadas,
  sqlConferenciaDeAcesso,
  avisoDeAcesso,
} from './lovable.js';
import { MARCA } from './marca.js';
import { skillsInstaladas, arquivoDeSkill, ehCaminhoDeSkills, blocoDeSkills, colapsarSkills, rodapeDaSkill } from './skills.js';

const MAX_ITERATIONS = 50;
// 120k ≈ 30k tokens de entrada por leitura. É o teto da leitura INTEIRA que
// vai para a IA. Até 2026-09-29 era também o teto de tudo: arquivo maior era
// recusado até para editar (125k no domina-link-pro, e o types.ts do banco
// passa disso perto de 80 tabelas). Agora arquivo grande se lê por trecho
// (start_line/end_line) e se edita normalmente; o teto interno só barra o
// que ninguém edita à mão (bundle de vendor, arquivo gerado gigante).
const MAX_FILE_CHARS = 120_000;
const MAX_FILE_CHARS_INTERNO = 1_000_000;
// Um trecho lido de uma vez: ~10k tokens.
const MAX_TRECHO_CHARS = 40_000;
const MAX_TREE_FILES = 3000;
// Orçamento de contexto: cada volta reenvia a conversa inteira, e num projeto
// grande as leituras se acumulam até cada etapa ficar lenta demais para o
// relógio de 120 s do servidor (simulado no domina-link-pro: ~430 KB por
// chamada na 19ª etapa). Passou do alto, as leituras mais antigas viram
// aviso curto até o baixo — em lote, para não desfazer o cache do prefixo a
// cada volta.
const ORCAMENTO_CONTEXTO_ALTO = 160_000;
const ORCAMENTO_CONTEXTO_BAIXO = 100_000;
// O mesmo aviso que os provedores põem no lugar de um resultado obsoleto.
const STUB_OBSOLETO = '[old content removed to save space — call read_file for the current version]';
// Resultado de run_sql que volta para a IA. Era 30k: um "select * from
// pg_proc" reenviado a cada volta (SQL não era compactado) foi metade do custo
// de um run que travou. Consulta de schema não precisa de 30k.
const MAX_SQL_RESULT_CHARS = 8_000;

// Travas do laço (ver o comentário antes do laço em runAgent).
const REPETICOES_AVISO = 2; // 2ª chamada idêntica com o MESMO resultado: aviso no lugar do resultado
const REPETICOES_ABORTA = 3; // 3ª: o run para
// Duas contagens diferentes, porque são dois problemas diferentes:
//   - SEM NOVIDADE: a volta não produziu informação nova nem mudança. É a IA
//     girando. Ler um arquivo ainda não lido CONTA como novidade — antes não
//     contava, e pedido complexo morria só por precisar olhar vários arquivos
//     antes da primeira edição (reclamação de usuários, 2026-09-23).
//   - SEM ESCRITA: explorando sem começar. Na 6ª a IA é obrigada a decidir
//     (escrever ou dividir, e dividir mostra o cartão ao usuário ANTES de
//     gastar o resto); na 24ª o run para.
const VOLTAS_SEM_NOVIDADE_ABORTA = 16;
const VOLTAS_SEM_ESCRITA_DECISAO = 6;
const VOLTAS_SEM_ESCRITA_ABORTA = 24;
// Pedido grande em partes (dividir_em_partes). Cada parte do plano é um
// prompt da chave do cliente — com teto 12 a IA fatiava pedido médio em 6-8
// partes de um arquivo cada (reclamação real dos usuários, 2026-09-02). O
// prompt pede 2-3; a trava é 5. Subetapas internas de uma parte não custam
// nada e seguem com o teto largo.
const MAX_PARTES = 5;
// Instruções que a própria Lovable deixa no repositório (AGENTS.md,
// src/routes/README.md). São curtas de fábrica; o teto é só contra um
// arquivo que alguém tenha inflado — este texto viaja em toda chamada.
const MAX_DOC_LOVABLE = 3000;
const MAX_SUBETAPAS = 12;

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'webm', 'ogg', 'wav',
  'zip', 'gz', 'tar', 'rar', '7z', 'pdf', 'wasm',
]);

// Formato neutro; cada provedor converte para o seu formato de tool calling.
const TOOLS = [
  {
    name: 'read_file',
    description:
      'Read the current content of a file in the project. Always read a file before modifying it — never guess its content. When you need several files, call read_file for ALL of them in the same turn (up to about 6) — one file per turn re-sends the whole conversation each time. For a BIG file (the tree shows its size in brackets), read only the part you need with start_line/end_line — search_code tells you the line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository-relative path, e.g. "src/App.tsx"',
        },
        start_line: { type: 'integer', description: 'Optional: first line to read (1-based)' },
        end_line: { type: 'integer', description: 'Optional: last line to read (inclusive)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search the project\'s source files for a text and get back "file:line: text" matches — the fast way to find WHERE something lives (a text the user sees on screen, a component, a CSS class, a table or function name) without opening files one by one. Use it FIRST whenever you do not know which file has what you need; then read_file only those files, or just the lines around the matches in big files. Case-insensitive, literal text by default.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to find, e.g. "Fale conosco" or "bg-gradient-to-br"' },
        path: { type: 'string', description: 'Optional: only search under this folder or file prefix, e.g. "src/components"' },
        regex: { type: 'boolean', description: 'Optional: treat pattern as a regular expression' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'consultar_banco',
    description:
      "Run ONE read-only SQL query (SELECT / WITH / SHOW / EXPLAIN) on the project's live Lovable Cloud database and get the rows as JSON. The database itself blocks any write in this tool. Use it to see the real schema before writing SQL (information_schema, pg_policies, pg_proc, pg_trigger, foreign keys) and to diagnose \"the data does not show up\" (do the rows exist? which RLS policy applies?). Keep results small: select only the columns you need and use LIMIT. To CHANGE the database, use propor_migracao.",
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One read-only query' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'edit_file',
    description:
      'PREFERRED way to change an existing file: replace one exact snippet, leaving the rest untouched. Use this instead of write_file whenever the file already exists — rewriting a whole file to change a few lines is slow, expensive and risks losing code. "old_string" must be copied EXACTLY from read_file (whitespace and line breaks included) and must appear exactly once: include the surrounding lines when needed to make it unique. Use an empty "new_string" to delete the snippet. Call it once per snippet.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path' },
        old_string: {
          type: 'string',
          description: 'Exact snippet to replace, copied from the file. Must be unique.',
        },
        new_string: { type: 'string', description: 'Text that replaces it (empty to delete)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a NEW file, or fully rewrite an existing one when the change is so large that replacing snippets makes no sense. For editing an existing file, prefer edit_file. "content" must be the COMPLETE final content of the file, never a fragment or diff.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path' },
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'salvar_anexo',
    description:
      'Put a file the user ATTACHED (listed in <attached_files>) into the project at the path you choose, with its original bytes — replacing the existing file at that path if there is one. Use it when the user asks to add/replace an image, PDF, video, font or any file with the attached one — never for a screenshot that only shows a problem. You cannot read the attached bytes; you decide the path by reading the code (e.g. the href/src/import that points to the current file). Under public/ the file is served at "/<name>"; under src/ it is imported. Call it once per destination; then update the code that references it if the name changed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The attached file name, exactly as listed in <attached_files>' },
        path: { type: 'string', description: 'Destination path inside the project, e.g. "public/ebook.pdf" or "src/assets/logo.png"' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'gerar_imagem',
    description:
      'Create a NEW image with AI and save it into the project at "path" — it goes into the same commit as your code. Use it when the user asks for an image (a photo, illustration, banner, hero, background, product shot, avatar) or the request clearly needs a real picture. Write "prompt" in English and in detail: subject, style, composition, colors, lighting; no text inside the image unless the user asked for it. The extension of "path" picks the format: ".jpg" for photos and backgrounds (much smaller files), ".png" or ".webp" only when transparency is needed (logos, icons, cut-out objects). Each image takes about 20 seconds and costs money: at most 4 per turn. You never see the bytes — the result tells you where it was saved; then reference that path in the code (under public/ it is served at "/<name>"; under src/ import it).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image, in English' },
        path: { type: 'string', description: 'Where to save it, e.g. "public/images/hero.jpg" or "src/assets/logo.png"' },
        tamanho: {
          type: 'string',
          enum: ['1024x1024', '1536x1024', '1024x1536'],
          description: 'Square (default), landscape (banners, heroes, backgrounds) or portrait',
        },
        fundo_transparente: {
          type: 'boolean',
          description: 'Transparent background — only for .png/.webp (logos, icons, cut-out objects)',
        },
      },
      required: ['prompt', 'path'],
    },
  },
  {
    name: 'set_commit_message',
    description:
      'Set the commit message for the changes you made. Call this once, right before finishing, whenever you changed any file. Write a short imperative message in Brazilian Portuguese, e.g. "Adiciona seção de depoimentos na home".',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (one line)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'run_sql',
    description:
      "Execute SQL against the project's Postgres database (Supabase) and return the resulting rows as JSON (empty array for DDL). Use it to inspect the schema (information_schema), create/alter tables, manage RLS policies and run data operations the user asked for. In Plan mode only read-only queries (SELECT/WITH/SHOW/EXPLAIN) are allowed.",
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL statement(s) to execute' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'propor_migracao',
    description:
      "Change the database of a Lovable Cloud project (the only way to do it there). Provide the COMPLETE SQL (idempotent when possible: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS; every new table gets RLS enabled with sensible policies; no BEGIN/COMMIT) and a one-sentence \"resumo\" in plain Brazilian Portuguese that a non-technical user understands. The user must authorize it — the system prompt says whether the extension applies it for them or hands it to them to run manually. Call it once with all the schema changes needed, and make the matching frontend/types changes in the same run.",
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The complete SQL migration to run' },
        resumo: {
          type: 'string',
          description: 'What this change does, in ONE short sentence of plain Brazilian Portuguese, no jargon (no "RLS", "policy", "schema") — e.g. "Cria a tabela de agendamentos, em que cada cliente só vê os próprios horários."',
        },
      },
      required: ['sql', 'resumo'],
    },
  },
  {
    name: 'dividir_em_partes',
    description:
      'Split a request into self-contained parts ONLY when it bundles 3 or more independent features (e.g. "sign-up + booking + admin dashboard + reports") or clearly needs more than about 10 files. Each part costs the user one prompt, so parts must be BIG: a complete feature with its database changes AND its UI in the same part (e.g. "1. Sign-up and login (tables, RLS, screens)", "2. Booking (tables + screen)", "3. Admin dashboard") — never split by layer ("tables" then "screens"). Prefer 2-3 parts; at most 5. Do NOT call it for a single feature, even one that touches the database and the UI — just implement it. At most once per turn. After calling it, implement ONLY the first pending part in this turn and finish — the user starts each following part. If, while implementing a part, it turns out too big to tackle at once, call it again to lay out internal sub-steps for THAT part, then implement ALL of them in this same turn and commit at the end.',
    parameters: {
      type: 'object',
      properties: {
        partes: {
          type: 'array',
          minItems: 2,
          description: 'Ordered parts. Each must work on its own once committed.',
          items: {
            type: 'object',
            properties: {
              titulo: { type: 'string', description: 'Short title, in Brazilian Portuguese' },
              descricao: { type: 'string', description: 'One or two sentences: what gets built, in Brazilian Portuguese' },
            },
            required: ['titulo', 'descricao'],
          },
        },
      },
      required: ['partes'],
    },
  },
];

// Modo Plan: somente leitura — a IA analisa e propõe, nunca altera.
// run_sql entra no Plan apenas para consultas de leitura (o executor bloqueia o resto).
// search_code e consultar_banco são leitura por definição.
const PLAN_TOOLS = ['read_file', 'search_code', 'run_sql', 'consultar_banco'];

function planDbLine(dbMode, leituraDoBanco = false) {
  if (dbMode === 'connected') {
    return "- The project's Supabase database is connected: you may use run_sql for READ-ONLY queries (SELECT / EXPLAIN, e.g. on information_schema) to inspect the schema and data while planning. Write statements are blocked in this mode.";
  }
  if (dbMode === 'manual') {
    return leituraDoBanco
      ? '- This is a Lovable Cloud project. The <database_schema> block is the live schema; use consultar_banco (read-only) for policies, functions, triggers and data. If the request needs a schema change, include in the plan what would change in the database, in plain words — in Build mode the extension checks the SQL and applies it after the user authorizes.'
      : '- This is a Lovable Cloud project: the database cannot be changed from here. To understand the schema, read "docs/DB_SCHEMA.json" (a real snapshot) when it exists, plus "src/integrations/supabase/types.ts". If the request needs a schema change, include in the plan the exact SQL the user would run manually in the Lovable SQL editor — in Build mode the extension hands that SQL off for the user to run before committing the frontend.';
  }
  return '- If the request involves the database, remember it is not connected here — include in the plan the SQL and where the user would apply it.';
}

function makePlanSystem(dbMode, leituraDoBanco = false) {
  return `You are ${MARCA.nome}, an expert senior software engineer working inside a Chrome extension, currently in PLAN mode (read-only) on the user's Lovable project, which lives in a GitHub repository synced with Lovable.

PLAN mode rules:
- You may explore the project with search_code and read_file, but you CANNOT change anything — writing, deleting and committing are unavailable in this mode. Never pretend a change was made.
- Find before you read: use search_code to locate what the request is about, then read only those files (line ranges in big ones). Read in batches: request ALL the read_file calls you need in the SAME turn (up to about 6) instead of one file per turn — each extra turn re-sends the whole conversation.
- Files listed in <attached_files>: an image or text file you can see may be just a screenshot of the problem; files you cannot see (PDF, video, font, zip…) are meant to go INTO the project (in Build mode, salvar_anexo). In the plan, say where each file that goes into the project would go and which code references it.
${planDbLine(dbMode, leituraDoBanco)}
- Understand the request, read the relevant files, and reply with either (a) a direct answer, or (b) a concrete step-by-step plan: which files you would change and what would change in each, plus risks or decisions the user needs to make. Prefer a short numbered list.
- End by asking if the user approves the plan, and remind them to switch to the "Build" mode to apply it.
- Reply in Brazilian Portuguese, in plain language for a non-technical user.`;
}

const BUILD_INTRO = `You are ${MARCA.nome}, an expert senior software engineer working inside a Chrome extension. You modify the user's Lovable project by editing files in its GitHub repository. After you finish, your changes are committed and Lovable syncs them automatically, so the user sees the result in the Lovable editor and preview.

Lovable projects use Vite + React + TypeScript + Tailwind + shadcn/ui, but Lovable generates MORE THAN ONE project shape and their conventions are opposite (file-based routes vs src/pages, Tailwind configured in CSS vs tailwind.config). Never assume one: the <project_shape> block below describes THIS project, and the file tree proves it. Follow the project's existing structure, style and conventions.`;

const DB_DISCONNECTED = `Database (Lovable Cloud / Supabase — NOT connected):
- The project may use Lovable Cloud, a managed Supabase backend. Its schema lives OUTSIDE this repository — you can read "supabase/migrations/*.sql" and "src/integrations/supabase/types.ts" to learn the current schema, but committing a new migration file does NOT execute SQL on the live database.
- If the request only USES existing tables (queries, inserts, forms, listing data), just implement it: read the schema files first and write correct client code.
- If the request REQUIRES schema changes (new table/column, altered RLS policies, new secrets): do NOT pretend it will work. Implement only the code that is safe with the current schema (or none, if nothing is safe), and in your final summary give the user (1) the exact SQL needed and (2) a ready-to-paste prompt for the Lovable chat that applies that schema change (e.g. "Crie a tabela X com as colunas ..."), explaining that the site will only work after they run it. Never commit frontend code that depends on tables or columns that do not exist yet.
- Edge functions in "supabase/functions/" are code and may be edited, but warn in the summary that their deployment happens on the Lovable side.`;

// `automatico`: a extensão aplica o SQL no banco durante a conversa (cartão
// Autorizar no meio do run) e devolve o resultado à IA. Sem isso, o SQL fica
// registrado para o usuário rodar à mão depois — e a IA nunca vê o erro.
const dbLovableCloud = (automatico, leitura = false) => `Database (Lovable Cloud — managed Postgres, NO external access):
${automatico
  ? '- Schema changes go through propor_migracao: the extension first runs your SQL in a DRY RUN that is rolled back (nothing stays in the database). If the database rejects it, you get the real error right away — fix it and call propor_migracao again; the user is not bothered. When it passes, the user sees your "resumo" and authorizes with one click, and the extension applies the SQL on the live database during this conversation and returns the result to you. Do not put BEGIN/COMMIT in the script.'
  : '- You CANNOT execute SQL directly. Schema changes are applied by the USER, who runs your SQL manually in the Lovable SQL editor. Never claim a schema change already happened.'}
${leitura
  ? '- You CAN READ the live database: the <database_schema> block lists every table with its columns and access situation, and consultar_banco runs one read-only query at a time (policies, functions, triggers, foreign keys, whether rows exist). Check the real schema before writing SQL instead of guessing from migration files. When the user says data does not show up, check with consultar_banco whether the rows exist and which RLS policy applies before changing code.'
  : ''}
- Some things are NOT SQL or code, and only the user can do them in the Lovable project settings: turning on a login provider (Google, etc.) or email confirmation, and adding secrets/API keys used by edge functions. When the request needs one of these, do the code part and tell the user plainly, in the summary, what they must turn on — never claim it is done. File storage buckets CAN be created with SQL (insert into storage.buckets) plus policies on storage.objects.
- To learn the REAL schema${leitura ? ' when the <database_schema> block is missing' : ''}, read "docs/DB_SCHEMA.json" when it exists — it is a snapshot (tables, columns, PKs/FKs, RLS policies, functions, triggers) exported from the live database and is the source of truth. Without it, "src/integrations/supabase/types.ts", "supabase/migrations/*.sql" and the queries already in the frontend are enough for ORDINARY work (adding a column, a new table, reading/writing rows) — use them and proceed; do NOT stop to ask for a snapshot you do not need. Ask for it ONLY when the change depends on something those files cannot show: existing RLS policies, constraints, triggers or defaults. When you ask, say it in the summary in PLAIN PORTUGUESE, never in jargon — the user is a layperson who does not know what "schema", "RLS" or "policy" means. Say what you need in terms of what THEY see, e.g.: "Para essa mudança eu preciso enxergar como o seu banco controla quem pode ver e editar cada informação. Clique no ícone do banco e depois em Sincronizar schema — eu explico o passo a passo." If nothing at all describes the database, implement only what is safe and ask the same way.
- If the request only USES existing tables (queries, inserts, forms, listings), just implement the frontend — no migration needed.
- If the request REQUIRES a schema change (new table/column, RLS policy, function, trigger), call propor_migracao ONCE with the COMPLETE SQL, and make the matching frontend/types changes with write_file in the SAME turn. Prefer idempotent SQL ("create table if not exists", "add column if not exists"); every new table must have RLS enabled with sensible policies (Lovable pattern). The user authorizes with one click and the extension applies the SQL for them, then your frontend is committed — so write the SQL to run as-is, with no placeholder for a human to fill in.
- ORDER the statements so every object exists before anything refers to it: create ALL tables first, then indexes, then enable RLS and create the policies, then functions and triggers. A policy may only mention tables created above it — two tables whose policies refer to each other (e.g. teams and team_members) are both created BEFORE either policy. Make the script safe to run twice: IF NOT EXISTS on tables/columns/indexes, and DROP POLICY IF EXISTS right before each CREATE POLICY.
- Reuse the project's existing "src/integrations/supabase/client.ts" (Lovable's standard client) instead of creating a new one. If this is the first code in the project to import "@supabase/supabase-js", read "package.json" and add it to "dependencies" (a recent stable version) if it's missing — otherwise the preview breaks with a "module not found" error even though your code is correct.
- NEVER write destructive SQL (DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER ... DROP) unless the user explicitly asked for that exact removal.
- Edge functions in "supabase/functions/" are code and may be edited; note in the summary that their deployment happens on the Lovable side.`;

const DB_CONNECTED = `Database (Supabase — CONNECTED):
- The project's Supabase Postgres is connected: use the run_sql tool to execute SQL directly (schema changes, RLS policies, data operations the user asked for).
- Inspect the current schema BEFORE changing it: read "supabase/migrations/*.sql" / "src/integrations/supabase/types.ts", or query information_schema via run_sql.
- Every schema change you run with run_sql (create/alter/drop, policies, functions) is recorded AUTOMATICALLY as a migration file in "supabase/migrations/" in the commit — do NOT write migration files yourself. Do update "src/integrations/supabase/types.ts" if the project has it, so Lovable's view of the schema matches the real database.
- A migration FILE does not execute anything: run_sql is what changes the database. Never query the database to "verify" a change you only wrote to a file — it is not there.
- Every new table must have RLS enabled with sensible policies (Lovable pattern).
- ORDER the statements so every object exists before anything refers to it: create ALL tables first, then indexes, then enable RLS and create the policies, then functions and triggers. A policy may only mention tables created above it — two tables whose policies refer to each other (e.g. teams and team_members) are both created BEFORE either policy. Make the script safe to run twice: IF NOT EXISTS on tables/columns/indexes, and DROP POLICY IF EXISTS right before each CREATE POLICY.
- Reuse the project's existing "src/integrations/supabase/client.ts" if present. If this is the first code in the project to import "@supabase/supabase-js", read "package.json" and add it to "dependencies" (a recent stable version) if it's missing — otherwise the preview breaks with a "module not found" error even though your code is correct.
- When a <database> block is present in the context, it contains the project's real URL and publishable (anon) key — they are SAFE to hardcode in frontend code (protected by RLS; this is the standard Lovable pattern). If "src/integrations/supabase/client.ts" is missing, create it with those exact values. NEVER invent placeholder env vars like VITE_SUPABASE_URL, and never ask the user for these credentials.
- NEVER run destructive statements (DROP, TRUNCATE, DELETE without WHERE, irreversible ALTER) unless the user explicitly asked for that exact removal.
- Run schema changes BEFORE committing frontend code that depends on them, and mention in your summary which database changes were executed.`;

// Regra dos arquivos binários. Sem criação de imagem, a IA não tem como
// produzir uma e usa SVG/CSS; com gerar_imagem, ela cria. A troca é feita em
// makeBuildSystem, trocando esta linha inteira pela outra.
const REGRA_ASSETS = `- You cannot create, edit or read binary assets (images, fonts, audio, video). Never import or reference an asset path that is not in the "Assets" list of the file tree — one import of a missing image breaks the WHOLE Vite build and the preview goes blank. For visuals, use inline SVG (JSX), plain CSS, or an icon package already in package.json. If the user asks for a real image you do not have, use a clearly marked inline-SVG placeholder and tell them in the summary to upload the file.`;
const REGRA_ASSETS_COM_IMAGEM = `- You cannot read or hand-write binary assets (images, fonts, audio, video), but you CAN create new images with gerar_imagem. When the user asks for an image, or the request clearly needs a real picture, create it with gerar_imagem (detailed English prompt; ".jpg" for photos, ".png"/".webp" only when transparency is needed) and then reference the saved path. Never import or reference an asset path that is not in the "Assets" list of the file tree and that you did not create in this conversation — one import of a missing image breaks the WHOLE Vite build and the preview goes blank. For simple icons and shapes, prefer inline SVG (JSX), plain CSS, or an icon package already in package.json. Do not create images the user did not ask for or clearly need — each one costs money and takes about 20 seconds; at most 4 per turn.`;

const BUILD_RULES = `Rules:
- Always read_file before editing an existing file. Never write a file you haven't read in this conversation.
- To change a file that already exists, use edit_file (replace the exact snippet). Use write_file only to CREATE a new file, or when you are genuinely rewriting almost all of an existing one. Rewriting a whole file to change a few lines is slow and risks dropping code you did not mean to touch.
- edit_file: copy "old_string" exactly as read_file returned it, and make it unique by including neighbouring lines. If it reports the snippet was not found or appears more than once, read_file again and copy from the current content — never guess.
- write_file must contain the complete final content of the file — never placeholders like "// rest unchanged".
- NEVER put code or file contents in your text. ALL code goes through write_file / edit_file — code written in text is not saved anywhere and is thrown away. Text between tool calls is at most two short sentences; do not narrate what you are about to do, just call the tool.
- FIND BEFORE YOU READ: when you do not already know which file holds what the request is about, call search_code (a visible text, a component or class name) and read only the files — or, in big files, only the line ranges — that the matches point to. Opening files one by one to look for something is slow and fills the conversation.
- Keep every response small: one focused WRITE (write_file/edit_file) per turn. READS are the exception: when you need several files, request ALL the read_file calls in the SAME turn (up to about 6) — every extra turn re-sends the whole conversation, so one-file-per-turn reading is the single most expensive habit. When creating a file longer than about 120 lines, build it in parts — write_file with the first part, then edit_file (anchored on the file's last lines) to append the remaining sections. A single huge response is cut off by the server and the whole turn is lost.
- SPLITTING INTO PARTS IS THE EXCEPTION, not the rule. One turn handles a lot: a whole feature with its database tables, RLS and screens together (e.g. "user sign-up with login", "a task list with due dates and filters", "add address and gender to the profile and show them in the form") is ONE turn — implement it directly, never split it. Call dividir_em_partes BEFORE writing anything ONLY when the request bundles 3 or more independent features (e.g. "sign-up + booking + admin dashboard + reports") or clearly needs more than about 10 files. Each part costs the user one prompt, so parts must be BIG: a complete feature, its database changes AND its UI in the same part — never split by layer ("tables" then "screens"). Prefer 2-3 parts; 5 is the maximum. If you do split, implement ONLY the first part in this turn and finish — the user starts each following part. If the part you are implementing turns out too big for one turn, call dividir_em_partes again to lay out internal sub-steps and do ALL of them in this turn.
- Never repeat a tool call that already returned the same result — the result will not change. If a read or query did not show what you expected, change the approach or move on.
- Make focused changes. Do not refactor or reformat code unrelated to the request.
- Preserve existing behavior unless the user asked to change it.
- VISUAL CHANGES (a color, text, size, spacing or position the user sees): first find the element that is actually on screen — search_code for its visible text or a distinctive class (the text may live in a translation file), and make sure the file you edit is the one that page renders (imported by that route/page), not an unused or duplicated copy. Before editing, check everything that controls the same property, because only the one that wins shows up: dark: variants and the .dark theme colors, inline style={{…}}, other classes on the same element, stylesheet rules that target it, and className/props passed by the parent. Change the source that actually wins. For the whole site's colors ("the site's green", "all the buttons"), change the theme tokens in the stylesheet instead of one component.
- Before importing any npm package not already used elsewhere in the project, read_file "package.json" and add it to "dependencies" (a recent stable version) if it's missing. Lovable installs packages listed there on sync, but an import with no matching entry breaks the preview.
${REGRA_ASSETS}
- Never assert the cause of an error you did not observe in this conversation — build, deploy and platform errors happen AFTER your turn, where you cannot see them. Inspect the relevant files, report only what you verified, present hypotheses explicitly as hypotheses, and do not edit files based on a guessed cause.
- If the request is ambiguous, pick the most reasonable interpretation and mention it in your summary.
- ATTACHED FILES (<attached_files> block): an image or text file you can see is often just a SCREENSHOT of the problem — use what it shows and do NOT save it, unless the user wants that file inside the site ("use this logo", "put this photo in the banner"). Files you cannot see (PDF, video, font, zip…) were attached to go INTO the project. To add or replace a file, read the code to find where the current one lives (the href/src/import), call salvar_anexo with that path, and fix the reference if the name changed. Never try read_file on an attached file and never re-create it with write_file. Any file you cannot see and do not save is placed under public/ automatically.
- If you changed any file, call set_commit_message before finishing.
- If the request needs no code change (a question, or something already true in the code), answer it without editing files.
- End your turn with a short summary in Brazilian Portuguese (2 to 6 sentences), written for a non-technical user: what changed and WHERE (the page and section, in words they can find on screen). Only promise they will see it when nothing else decides that: if the change shows in just one theme (light or dark), or depends on database content or an image from Lovable's CDN, say so plainly and tell them where or how to see it. No code blocks unless essential.`;

function makeBuildSystem(dbMode, sqlAutomatico = false, imagens = false, leituraDoBanco = false) {
  const db =
    dbMode === 'connected'
      ? DB_CONNECTED
      : dbMode === 'manual'
        ? dbLovableCloud(sqlAutomatico, leituraDoBanco)
        : DB_DISCONNECTED;
  const regras = imagens ? BUILD_RULES.replace(REGRA_ASSETS, REGRA_ASSETS_COM_IMAGEM) : BUILD_RULES;
  return [BUILD_INTRO, db, regras].join('\n\n');
}

// ---------- Pedido grande em partes ----------
// Dois modelos diferentes bateram no teto de 50 etapas com "cadastro +
// agendamento + painel + banco" numa frase. A saída não é freio: é a IA não
// precisar caber um sistema inteiro num run. Cada parte é um run (um prompt
// da chave), termina com commit, e a seguinte lê no GitHub o que a anterior
// escreveu — por isso as partes têm de funcionar sozinhas.

// Partes válidas: ≥2 objetos {titulo, descricao} não vazios. Os cortes de
// tamanho existem porque isto vai para a UI e para o contexto de todo run
// seguinte do plano.
function normalizarPartes(bruto) {
  if (!Array.isArray(bruto) || bruto.length < 2) return null;
  const partes = [];
  for (const p of bruto) {
    const titulo = String(p?.titulo ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const descricao = String(p?.descricao ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!titulo || !descricao) return null;
    partes.push({ titulo, descricao });
  }
  return partes;
}

function instrucaoDaParte(plano, prefixo) {
  const i = plano.atual;
  const p = plano.partes[i];
  const depois = plano.partes
    .slice(i + 1)
    .map((x, k) => `${i + k + 2}. ${x.titulo}`)
    .join('; ');
  return `${prefixo} (${plano.partes.length} parts). Implement ONLY part ${i + 1} now: "${p.titulo}" — ${p.descricao}. Make it complete and committable on its own, then call set_commit_message and finish with a short summary of this part. Do NOT start the following parts${depois ? ` (${depois})` : ''} — the user starts each one.`;
}

// Contexto de um run que continua um plano: o que já foi, o que é agora, o
// que falta. As partes feitas estão commitadas — a IA lê os arquivos.
function blocoDoPlano(plano) {
  const linhas = plano.partes.map((p, k) => {
    const marca = k < plano.atual ? '[done]' : k === plano.atual ? '[NOW]' : '[pending]';
    return `${k + 1}. ${marca} ${p.titulo} — ${p.descricao}`;
  });
  const n = plano.atual + 1;
  return [
    '<plano>',
    `Original request: ${JSON.stringify(plano.pedido)}`,
    `It was split into ${plano.partes.length} parts. Parts marked [done] are already committed in the repository — read their files if you need them.`,
    ...linhas,
    plano.ajuste
      // O usuário mandou uma mensagem própria enquanto a parte N está em
      // andamento (quase sempre um ajuste ou correção do que acabou de ser
      // feito). O pedido é o que ele escreveu — dentro da parte N.
      ? `The user sent a follow-up message while part ${n} ([NOW]) is in progress — usually a fix or an adjustment to what was just built (read the current files). Do what the user asks now, staying within part ${n}; do NOT start [pending] parts. If you changed files, call set_commit_message; finish with a short summary.`
      : `Implement ONLY part ${n} ([NOW]) in this turn. Make it complete and committable on its own, call set_commit_message, and finish with a short summary of this part. Do NOT start [pending] parts. If part ${n} is itself too big to tackle at once, call dividir_em_partes to lay out internal sub-steps and implement ALL of them in this run.`,
    '</plano>',
  ].join('\n');
}

// A tentativa anterior desta parte morreu numa trava (repetição, sem
// progresso ou teto de etapas). Repetir a mesma tentativa daria no mesmo
// erro, pago de novo — a ordem agora é dividir a parte primeiro.
function blocoDaRetentativa(plano, motivo) {
  const n = plano.atual + 1;
  return [
    '<retry>',
    `The previous attempt at part ${n} FAILED: ${motivo}.`,
    `Part ${n} did not work as one big effort. Your FIRST action: call dividir_em_partes to lay out 2-4 smaller internal sub-steps for part ${n}, then implement ALL of them in THIS run, one at a time, and commit at the end. Do not repeat the failed approach unchanged.`,
    '</retry>',
  ].join('\n');
}

// ---------- Anexos que vão para o projeto ----------
// A IA vê UMA linha por arquivo (nome, tamanho, tipo) — nunca os bytes. É o
// que deixa "troque o PDF do botão por esse" custar ~30 tokens por arquivo.
function blocoDeAnexos(anexos, planMode) {
  const linhas = anexos.map(
    (f) =>
      `- "${f.name}" (${tamanhoLegivel(f.size)}, ${f.mediaType || 'unknown type'})${
        f.vistoPelaIA === true ? ' — you can see it in this message' : ''
      }`
  );
  const vistos = anexos.some((f) => f.vistoPelaIA === true);
  const ocultos = anexos.some((f) => f.vistoPelaIA !== true);
  return [
    '<attached_files>',
    vistos
      ? 'Images and text files you can see are often just a SCREENSHOT or example showing the problem, not content for the site. Save one with salvar_anexo ONLY when the user wants that file inside the project (e.g. "use this logo", "put this photo in the banner"); otherwise just use what it shows.'
      : '',
    ocultos
      ? planMode
        ? 'Files you cannot see (PDF, video, font, zip…) were attached to be placed INTO the project (in Build mode they are saved with salvar_anexo). In the plan, say where each one would go and which code references it.'
        : 'Files you cannot see (PDF, video, font, zip…) were attached to be placed INTO the project: find the right destination by reading the code (href/src/import of the file being replaced), call salvar_anexo with that path, then fix the reference if the name changed. Any of these you do not save is placed under public/ automatically.'
      : '',
    'You cannot read attached bytes with read_file.',
    ...linhas,
    '</attached_files>',
  ]
    .filter(Boolean)
    .join('\n');
}

function tamanhoLegivel(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// "Logo Nova.PNG" -> "logo-nova.png": caminho previsível, sem espaço nem
// acento, para o fallback em public/ e para a sugestão no erro de caminho.
// O que a rodada anterior deixou além dos arquivos: por que parou (a trava,
// em inglês — "import que não resolve" é para consertar primeiro) e o SQL do
// banco. SQL aplicado não se propõe de novo (o usuário autorizaria duas
// vezes); SQL proposto volta ao cartão sozinho no fim desta rodada.
function blocoDaRodadaAnterior(t) {
  const corta = (sql) => (sql.length > 1500 ? `${sql.slice(0, 1500)}…` : sql);
  const linhas = [
    t.trava ? `The previous run for this request stopped because ${t.trava}.` : '',
    Array.isArray(t.sqlAplicados) && t.sqlAplicados.length
      ? `This SQL was already APPLIED to the live database in the previous run — do NOT propose it again:\n${corta(t.sqlAplicados.join('\n\n'))}`
      : '',
    t.sqlPendente
      ? `This SQL was already proposed and is waiting for the user to apply it; it is shown to them again at the end of this run — do NOT propose it again:\n${corta(t.sqlPendente)}`
      : '',
    Array.isArray(t.sqlRodados) && t.sqlRodados.length
      ? `This schema SQL was already EXECUTED on the database in the previous run — do NOT run it again:\n${corta(t.sqlRodados.join('\n\n'))}`
      : '',
    Array.isArray(t.lidos) && t.lidos.length
      ? `Files the previous run already examined — go straight to what you need in them (search_code, or read_file with a line range in big files) instead of exploring the project again: ${t.lidos.slice(0, 60).join(', ')}.`
      : '',
    t.mensagemDaIA ? `The previous run had described its work as: "${String(t.mensagemDaIA).slice(0, 200)}".` : '',
  ].filter(Boolean);
  return linhas.length ? `\n<previous_run>\n${linhas.join('\n')}\n</previous_run>` : '';
}

// "image.png", 2 -> "image-2.png": o Chrome dá o MESMO nome a toda imagem
// colada, e salvar_anexo por nome levava a primeira para todos os destinos.
function sufixar(nome, n) {
  const i = String(nome).lastIndexOf('.');
  return i > 0 ? `${nome.slice(0, i)}-${n}${nome.slice(i)}` : `${nome}-${n}`;
}

// Mesma ordem (as imagens chegam à IA nessa ordem, e "a segunda" tem de ser a
// segunda), nomes sem repetição — comparação sem caixa, como o salvar_anexo.
function anexosComNomeUnico(lista) {
  const usados = new Set();
  return lista.map((f) => {
    let nome = f.name;
    for (let n = 2; usados.has(nome.toLowerCase()); n++) nome = sufixar(f.name, n);
    usados.add(nome.toLowerCase());
    return nome === f.name ? f : { ...f, name: nome };
  });
}

function nomeSeguro(nome) {
  const partes = String(nome).split('.');
  const ext = partes.length > 1 ? partes.pop().toLowerCase() : '';
  const base = partes.join('.').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'arquivo';
  return ext ? `${base}.${ext}` : base;
}

// Relativo, dentro do projeto, sem truque: nada de "..", barra inicial,
// barra invertida ou caractere de controle.
// gerar_imagem: o formato sai da extensão que a IA escolheu. ".jpg" para foto
// (a mesma foto dá 68 KB em JPEG e 1,1 MB em PNG), ".png"/".webp" quando
// precisa de transparência.
const TAMANHOS_DE_IMAGEM = ['1024x1024', '1536x1024', '1024x1536'];
const MAX_IMAGENS_POR_RUN = 4; // o servidor tem o limite de verdade (4 por prompt)
function formatoDaImagem(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  return { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' }[ext] || null;
}

function caminhoDeAnexoValido(path) {
  if (!path || path.length > 300) return false;
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  const segs = path.split('/');
  return segs.every((seg) => seg && seg !== '.' && seg !== '..');
}

// Prefixo que identifica a extensão no cartão de commit que o Lovable mostra.
// Vem da marca (white label): no pacote de outra marca, o GitHub do cliente
// final não pode mostrar "GeckoAI".
export function prefixarCommit(base, prefixo = MARCA.prefixoCommit) {
  return `${prefixo}: ${base}`;
}

// O inverso, para o título do desfazer e o nome da migração. Comparação de
// texto, não regex: o prefixo é dado da marca e pode ter caractere especial.
export function semPrefixo(msg, prefixo = MARCA.prefixoCommit) {
  const s = String(msg ?? '');
  const alvo = `${prefixo}:`;
  return s.startsWith(alvo) ? s.slice(alvo.length).replace(/^\s+/, '') : s;
}

function buildCommitMessage(commitMessage, prompt) {
  const base = commitMessage || prompt.replace(/\s+/g, ' ').slice(0, 60);
  return prefixarCommit(base);
}

// Supabase externo: o que entra no arquivo de migração automático. Só
// SCHEMA — dado que o usuário pediu para mudar (update/insert) não é migração.
// Bloco DO entra: é como se cria tipo/enum "se não existir" (revisão
// adversarial — um `create type` dentro de DO ficava fora da migração).
function ehMudancaDeSchema(sql) {
  const s = String(sql).replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /(^|;)\s*(create|alter|drop|comment\s+on|grant|revoke|do)\b/i.test(s);
}

// Nome de migração em supabase/migrations/ é em UTC, como a Lovable faz: com
// o horário local (UTC-3), uma migração nossa feita até 3 h depois de uma da
// Lovable ficava ANTES dela na ordem, e `db reset` aplicaria fora de ordem.
function carimboUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// A aba do Lovable pode travar, e a chamada injetada nela não tem prazo: sem
// isto, o Cancelar não parava um pedido esperando a leitura do banco
// (revisão adversarial). Prazo vencido vira falha de acesso (quem chama
// segue sem); Cancelar vira AbortError, como em todo o resto.
function erroDeCancelamento() {
  const e = new Error('Cancelado.');
  e.name = 'AbortError';
  return e;
}
function comPrazo(promessa, signal, ms) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(erroDeCancelamento());
    let t = null;
    const aoCancelar = () => { limpar(); reject(erroDeCancelamento()); };
    const limpar = () => { clearTimeout(t); signal?.removeEventListener?.('abort', aoCancelar); };
    t = setTimeout(() => { limpar(); resolve({ erro: 'A aba do Lovable demorou demais para responder.', tipo: 'acesso' }); }, ms);
    signal?.addEventListener?.('abort', aoCancelar, { once: true });
    Promise.resolve(promessa).then((v) => { limpar(); resolve(v); }, (e) => { limpar(); reject(e); });
  });
}

// Para saber se um comando já está num arquivo de migração: sem diferença de
// espaço, quebra de linha, caixa e ponto e vírgula final.
const normalizarSql = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'migracao'
  );
}

function migrationStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

function migrationRecord(sql, message, como = 'Aplicada manualmente pelo usuário no editor de SQL do Lovable.') {
  const when = new Date().toISOString();
  return `-- ${semPrefixo(message)}\n-- ${como}\n-- Registrada por ${MARCA.nome} em ${when}\n\n${String(sql).trim()}\n`;
}

function migrationPath(message, sufixo = '') {
  return `docs/migrations/${migrationStamp()}_${slugify(semPrefixo(message))}${sufixo ? `_${sufixo}` : ''}.sql`;
}

// O rascunho foi montado sobre `base`; a ponta de agora ainda serve para
// commitar por cima? Serve se não andou, ou se andou só em OUTROS arquivos
// (a Lovable mexeu no que este envio não toca). Mudou algum dos mesmos
// arquivos — ou não dá para saber — não serve: o conteúdo inteiro que a IA
// preparou apagaria a mudança da Lovable.
async function baseAindaServe({ github, owner, repo, branch, base, caminhos, signal }) {
  if (!github.getHead) return true;
  let ponta = null;
  try {
    ponta = await github.getHead(owner, repo, branch, signal);
  } catch { ponta = null; }
  if (!ponta || ponta === base) return true;
  let mudados = null;
  try {
    mudados = (await github.arquivosMudadosEntre?.(owner, repo, base, ponta, signal)) ?? null;
  } catch { mudados = null; }
  return Boolean(mudados) && !caminhos.some((p) => mudados.has(p));
}

// O GitHub recusou o commit do fim (pendingWork com codigo 'commit'): o
// trabalho da IA estava pronto, então enviar de novo NÃO passa pela IA nem
// gasta prompt — é o mesmo commit, tentado outra vez (depois de reconectar o
// GitHub, por exemplo). Se o projeto andou desde então, recusa: commitar por
// cima apagaria o que a Lovable fez no meio — aí é Continuar, que refaz em
// cima da versão atual.
export async function enviarTrabalhoGuardado({ github, owner, repo, branch, pendingWork, signal }) {
  const staged = new Map(pendingWork?.changes || []);
  if (!pendingWork?.baseSha) {
    // Sem a ponta de partida não dá para saber se a Lovable mexeu no meio.
    throw new AgentError(
      'Não consegui confirmar se o projeto mudou desde este pedido. Toque em Continuar para a IA conferir e terminar em cima da versão atual.'
    );
  }
  if (!(await baseAindaServe({ github, owner, repo, branch, base: pendingWork.baseSha, caminhos: [...staged.keys()], signal }))) {
    throw new AgentError(
      'O projeto mudou no Lovable nesses mesmos arquivos depois disso, e enviar agora apagaria essa mudança. Toque em Continuar para a IA refazer em cima da versão atual.'
    );
  }
  const res = await github.commitChanges(
    owner, repo, branch, staged,
    `${pendingWork.message}\n\nFeito com ${MARCA.nome} a pedido do usuário.`,
    signal
  );
  if (!res) return null;
  return { sha: res.sha, url: res.url, message: pendingWork.message, files: [...staged.keys()] };
}

// Finaliza uma migração semi-automática: registra o SQL aplicado em
// docs/migrations/ e envia o commit do frontend/types. Chamado pela UI só depois
// de o usuário confirmar que rodou o SQL no editor do Lovable.
export async function commitMigration({ github, owner, repo, branch, changes, message, sql, baseSha = null, signal }) {
  const staged = new Map(changes || []);
  // O cartão pode ficar dias esperando: se a Lovable mexeu nos mesmos
  // arquivos no meio, o frontend preparado apagaria a mudança dela. (Cartão
  // antigo, sem baseSha, segue como antes.)
  if (baseSha && !(await baseAindaServe({ github, owner, repo, branch, base: baseSha, caminhos: [...staged.keys()], signal }))) {
    throw new AgentError(
      'O projeto mudou no Lovable nesses mesmos arquivos depois deste pedido, e enviar agora apagaria essa mudança. O banco já está certo: peça de novo a parte das telas para eu refazer em cima da versão atual.'
    );
  }
  const file = migrationPath(message);
  staged.set(file, { content: migrationRecord(sql, message) });
  const res = await github.commitChanges(
    owner,
    repo,
    branch,
    staged,
    `${message}\n\nFeito com ${MARCA.nome} (SQL aplicado manualmente no Lovable pelo usuário).`,
    signal
  );
  if (!res) return null;
  return { sha: res.sha, url: res.url, message, files: [...staged.keys()] };
}

/**
 * Troca UM trecho exato do arquivo, em vez de reescrevê-lo inteiro.
 *
 * É a diferença entre gastar ~200 tokens de saída e ~10.000 numa edição de
 * arquivo médio — e saída é o token mais caro. Recusa trecho ambíguo ou
 * inexistente de propósito: edição silenciosa no lugar errado é pior que erro.
 */
export function aplicarEdicao(conteudo, trecho, novo) {
  const alvo = String(trecho ?? '');
  const troca = String(novo ?? '');
  if (!alvo) throw new AgentError('edit_file com trecho vazio — isso apagaria o arquivo.');
  if (alvo === troca) throw new AgentError('edit_file com texto igual ao original: nada a mudar.');

  const primeira = conteudo.indexOf(alvo);
  if (primeira === -1) {
    throw new AgentError(
      'Trecho não encontrado no arquivo. Releia com read_file (em arquivo grande, só as linhas em volta — search_code acha onde está) e copie o texto exato (espaços e quebras de linha contam).'
    );
  }
  // indexOf em vez de split/regex: o trecho é texto literal, não padrão.
  // As linhas de cada ocorrência vão na mensagem: em arquivo grande (páginas
  // de 1.700 linhas, medido nos projetos do dono) um trecho curto se repete,
  // e sem as linhas a IA relia o arquivo INTEIRO para achar qual era.
  // A linha de cada ocorrência é contada andando para a frente (e só das 6
  // primeiras): recontar do começo a cada uma travava o painel por 16 s num
  // arquivo de 1M com um trecho curto (revisão adversarial).
  const linhas = [];
  let vezes = 0;
  let linhaAtual = 1;
  let desde = 0;
  for (let i = primeira; i !== -1; i = conteudo.indexOf(alvo, i + alvo.length)) {
    vezes++;
    if (linhas.length < 6) {
      for (let k = conteudo.indexOf('\n', desde); k !== -1 && k < i; k = conteudo.indexOf('\n', k + 1)) linhaAtual++;
      desde = i;
      linhas.push(linhaAtual);
    }
  }
  if (vezes > 1) {
    const onde = linhas.join(', ') + (vezes > 6 ? ', …' : '');
    throw new AgentError(
      `O trecho aparece ${vezes} vezes no arquivo (linhas ${onde}). Inclua as linhas ao redor para identificar só a que você quer mudar.`
    );
  }
  return conteudo.slice(0, primeira) + troca + conteudo.slice(primeira + alvo.length);
}

const PADROES_RUIDO = /^(?:node_modules|\.next|dist|build|out|coverage|\.cache)\/|\.map$|^(?:package-lock\.json|pnpm-lock\.yaml|bun\.lockb)$/i;
function ehRuidoDeBuild(path) {
  return PADROES_RUIDO.test(path);
}

export function formatTree(files, truncated) {
  // Texto e assets em seções separadas. Os assets ENTRAM na lista de
  // propósito (revisão da decisão antiga de escondê-los): a IA referencia
  // imagem em import/src/url() e, sem a lista, ela INVENTAVA o caminho — um
  // import de imagem inexistente quebra o build inteiro do Vite, o commit dá
  // sucesso e a quebra só aparece depois, no Lovable (aconteceu 2x em
  // produção). A lista é o que dá o caminho certo; a trava
  // verificarReferencias barra o caminho errado.
  // Pastas de build geradas e sourcemaps (.map, dist/, .next/, lockfiles)
  // são ignoradas para economizar milhares de tokens repetidos.
  const todos = [...files]
    .filter((f) => !ehRuidoDeBuild(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sorted = todos.filter((f) => !extIsBinary(f.path));
  const assets = todos.filter((f) => extIsBinary(f.path));

  const shown = sorted.slice(0, MAX_TREE_FILES);
  // Tamanho ao lado do arquivo grande: a IA sabe de antemão que ali se lê
  // por trecho (start_line/end_line), depois de achar a linha com search_code.
  // Só em arquivo de código/texto que é uma linha própria da árvore: nada de
  // rótulo dentro da linha do shadcn, em lockfile ou em binário que a lista
  // não conhece (um .dll de 31 MB ganhava "[31899k chars]" — revisão).
  const tamanhos = new Map(shown.map((f) => [f.path, Number(f.size) || 0]));
  const rotulo = (linha) => {
    const n = tamanhos.get(linha);
    return n >= TAMANHO_PARA_MOSTRAR && EXT_DE_TEXTO.test(linha) && !LOCKFILE.test(linha)
      ? `${linha} [${Math.round(n / 1000)}k chars]`
      : linha;
  };
  let text = colapsarMigracoes(colapsarUi(colapsarSkills(shown.map((f) => f.path)))).map(rotulo).join('\n');
  const omitted = sorted.length - shown.length;
  if (omitted > 0 || truncated) {
    text += `\n… (${omitted > 0 ? `+${omitted} arquivos` : 'lista truncada pelo GitHub'})`;
  }
  if (assets.length > 0) {
    const MAX_ASSETS = 200;
    text += `\n\nAssets (reference-only — use these exact paths in imports/src/url(); they can never be read, created or edited):\n`;
    text += assets.slice(0, MAX_ASSETS).map((f) => f.path).join('\n');
    if (assets.length > MAX_ASSETS) text += `\n… (+${assets.length - MAX_ASSETS} assets)`;
  }
  return text;
}

// A pasta src/components/ui/ do shadcn são ~50 arquivos que a IA quase nunca
// lê e que iam linha a linha em TODA chamada do laço. Viram uma linha com os
// nomes — o caminho continua reconstruível (src/components/ui/<nome>) e
// read_file/verificarReferencias seguem usando a árvore real (knownPaths).
const PASTA_UI = 'src/components/ui/';
const MIN_UI_PARA_COLAPSAR = 10;
function colapsarUi(paths) {
  const ui = paths.filter((p) => p.startsWith(PASTA_UI) && !p.slice(PASTA_UI.length).includes('/'));
  if (ui.length < MIN_UI_PARA_COLAPSAR) return paths;
  const nomes = ui.map((p) => p.slice(PASTA_UI.length));
  const linha = `${PASTA_UI} (${ui.length} shadcn/ui components — read_file "${PASTA_UI}<name>" only if you need one): ${nomes.join(' ')}`;
  const out = [];
  let posto = false;
  for (const p of paths) {
    if (ui.includes(p)) {
      if (!posto) { out.push(linha); posto = true; }
      continue;
    }
    out.push(p);
  }
  return out;
}

const TAMANHO_PARA_MOSTRAR = 20_000;
const EXT_DE_TEXTO = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|html|json|mdx?|sql|vue|svelte|toml|ya?ml|txt)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/;

// supabase/migrations/ cresce um arquivo por mudança no banco, e os nomes iam
// linha a linha em TODA chamada: no domina-link-pro eram 113 migrações, 45%
// da árvore. A IA quase nunca lê migração antiga — o banco de verdade vem do
// retrato/consulta. Viram uma linha, com as mais recentes pelo nome.
const PASTA_MIGRACOES = 'supabase/migrations/';
const MIN_MIGRACOES_PARA_COLAPSAR = 8;
function colapsarMigracoes(linhas) {
  const ehMigracao = (l) => l.startsWith(PASTA_MIGRACOES) && !l.slice(PASTA_MIGRACOES.length).includes('/');
  const migracoes = linhas.filter(ehMigracao);
  if (migracoes.length < MIN_MIGRACOES_PARA_COLAPSAR) return linhas;
  const recentes = migracoes.slice(-3).map((l) => l.slice(PASTA_MIGRACOES.length));
  const linha = `${PASTA_MIGRACOES} (${migracoes.length} migration files, history of the database — newest: ${recentes.join(', ')}; search_code or read one only if you need that history)`;
  const out = [];
  let posto = false;
  for (const l of linhas) {
    if (ehMigracao(l)) {
      if (!posto) { out.push(linha); posto = true; }
      continue;
    }
    out.push(l);
  }
  return out;
}

function extIsBinary(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXT.has(ext);
}

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Executa um prompt contra o projeto.
 * @returns {Promise<{steps: Array, summary: string, commit: object|null}>}
 */
export async function runAgent(
  {
    github,
    provider,
    apiKey,
    model,
    owner,
    repo,
    branch,
    prompt,
    attachments = null, // imagens anexadas: [{ mediaType, dataBase64 }]
    recentHistory,
    mode = 'build',
    supabase = null, // { client: Supabase, ref: string } quando o banco está conectado
    dbManual = false, // banco Lovable Cloud: a IA propõe SQL e o usuário aplica
    // Lovable Cloud com aplicação automática: (sql) => Promise<
    //   {ok:true, dados} | {erro, tipo:'banco'|'acesso'} | {cancelado:true}>.
    // A UI mostra o cartão Autorizar NO MEIO do run e aplica; o resultado
    // volta para a IA (erro do banco é corrigido na mesma conversa). Sem o
    // callback, vale o fluxo antigo: pendingMigration + "Já apliquei".
    aplicarSql = null,
    projectContext = null, // resumo do projeto (docs/CONTEXTO.md) para economizar leituras
    // Trabalho preparado por um run anterior que não terminou e NÃO foi
    // commitado ({ changes, feitos, baseSha }). Continuar custa 1 prompt e
    // sai UM commit só no fim — decisão do dono: não commitar pela metade.
    trabalhoAnterior = null,
    // Anexos que vão PARA O PROJETO (foto, PDF, vídeo, fonte…): a IA recebe
    // só nome/tamanho/tipo e escolhe o caminho com salvar_anexo; os bytes vão
    // direto para o commit. [{ name, size, mediaType, base64 }]
    projectFiles = [],
    // Pergunta ao usuário antes de rodar SQL destrutivo: (sql) => Promise<boolean>.
    // Sem ela, esse SQL é RECUSADO — ver o comentário em run_sql.
    confirmarSql = null,
    // Pedido grande em partes (ver dividir_em_partes): plano em andamento,
    // quando este run é a continuação de uma parte.
    // { pedido, partes: [{titulo, descricao, feita}], atual }
    plano = null,
    // Mostra o plano ao usuário antes de gastar: (partes) => Promise<boolean>.
    // Sem ela, dividir é RECUSADO — mesmo padrão do confirmarSql.
    confirmarPlano = null,
    // Motivo (em inglês, vindo de err.trava do run anterior) da falha da
    // tentativa anterior desta MESMA parte. Liga o modo "divida antes de
    // continuar": o contexto ganha o bloco <retry> e a IA divide a parte
    // até caber num run — regra do dono.
    parteFalhou = null,
    // Cria imagem pelo servidor (a chave da IA de imagem fica lá):
    // ({ prompt, tamanho, formato, transparente }, signal) => Promise<{ base64 }>.
    // Sem ela, gerar_imagem não existe neste run — e a regra do prompt volta
    // a ser "use SVG/CSS no lugar".
    gerarImagem = null,
    // Lovable Cloud, pela aba do Lovable (lib/lovable.js), os dois no formato
    // do aplicarSql ({ok, dados} | {erro, tipo}): LER o banco numa transação
    // que só lê (consultar_banco e o retrato do começo) e ENSAIAR um SQL antes
    // do cartão Autorizar. Sem eles, vale o de antes.
    consultarSql = null,
    ensaiarSql = null,
    // Cache do conteúdo dos arquivos por sha, entre runs (a busca baixa o
    // projeto inteiro uma vez): { get(sha), set(sha, texto) }, sync ou async.
    cacheDeArquivos = null,
    // Skills instaladas no projeto (lib/skills.js): lê o arquivo de uma skill
    // do PACOTE da extensão — (id, arquivo) => Promise<string>. O repositório
    // só marca "instalada"; o texto que a IA segue é o conferido, mesmo que
    // alguém tenha mexido na cópia do GitHub. Sem ela, lê do repositório.
    lerSkill = null,
    // false = a chave deste cliente não tem skills (plano): a pasta no
    // repositório é ignorada, como se não houvesse skill instalada.
    usarSkills = true,
  },
  onEvent,
  signal
) {
  const planMode = mode === 'plan';
  const dbConnected = Boolean(supabase);
  // 'connected' = Supabase externo (run_sql direto); 'manual' = Lovable Cloud
  // (propor_migracao + aplicação manual); 'none' = projeto sem banco.
  const dbMode = dbConnected ? 'connected' : dbManual ? 'manual' : 'none';
  const emit = (e) => {
    try {
      onEvent?.(e);
    } catch {
      /* UI não pode derrubar o agente */
    }
  };

  const steps = [];
  const step = (op, path) => {
    const s = { op, path };
    steps.push(s);
    emit({ type: 'tool', ...s });
  };

  // Ler e ensaiar pela aba do Lovable: com prazo e obedecendo o Cancelar.
  const lerBanco = typeof consultarSql === 'function'
    ? (sql, ms = 30_000) => comPrazo(consultarSql(sql), signal, ms)
    : null;
  const ensaiarNoBanco = typeof ensaiarSql === 'function'
    ? (sql) => comPrazo(ensaiarSql(sql), signal, 45_000)
    : null;

  emit({ type: 'phase', text: 'Mapeando o projeto…' });
  // A ponta de onde este run PARTE: é ela que o trabalho guardado leva como
  // baseSha. Lida no fim (como era), deixava passar um commit da Lovable feito
  // DURANTE o run — e, com o GitHub fora do ar na hora de guardar, ficava
  // nula e a conferência "o projeto mudou?" simplesmente não acontecia depois.
  let baseInicial = null;
  try {
    baseInicial = (await github.getHead?.(owner, repo, branch, signal)) || null;
  } catch { baseInicial = null; }
  const { files, truncated } = await github.getTree(owner, repo, branch, signal);
  // Dois conjuntos de propósito. `noRepositorio` é o que EXISTE no GitHub agora
  // e só ele decide se apagar vira deleção no commit. `knownPaths` é o que pode
  // ser REFERENCIADO: ganha também o que este run (ou a rodada anterior) criou
  // e ainda não foi commitado. Quando era um conjunto só, apagar um anexo salvo
  // virava sha:null fora do base_tree e o GitHub recusava o commit inteiro
  // (GitRPC::BadObjectState, run do dono em 2026-09-26).
  const noRepositorio = new Set(files.map((f) => f.path));
  const knownPaths = new Set(noRepositorio);
  // A extensão edita o GitHub, mas quem constrói e mostra é a Lovable — e ela
  // gera dois formatos de projeto com convenções opostas. Ler a forma da
  // árvore é de graça e evita a pior falha: arquivo certo no lugar que aquele
  // projeto nunca renderiza.
  const formaDoProjeto = detectarForma(files);
  // Skills do catálogo instaladas neste projeto (o SKILL.md está na árvore).
  // Pasta de fora em .agents/skills/ não entra: instrução, só do que é nosso.
  const skillsNoProjeto = usarSkills === false ? [] : skillsInstaladas(files);
  const skillsLidas = new Set(); // quais a IA carregou (vai para o diagnóstico)
  const textoDasSkills = new Map();
  // Caminho do jeito que a IA escreve (".\.agents/skills/…") cai na mesma pasta.
  const naPastaDasSkills = (p) =>
    ehCaminhoDeSkills(String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, ''));
  // Leitura dentro da pasta das skills. Só existe o que é do catálogo E está
  // instalado: pasta de outra ferramenta, ou arquivo a mais dentro de uma
  // skill nossa, é conteúdo do repositório posando de instrução — recusado.
  // Com `lerSkill`, o texto vem do pacote e NUNCA cai na cópia do GitHub
  // (qualquer um com acesso ao repositório a altera, e a IA obedece o que lê):
  // se o pacote não abrir, a IA segue o pedido sem a skill. Devolve undefined
  // só quando não há `lerSkill` — aí vale a leitura comum, do repositório.
  async function lerDaPastaDasSkills(path) {
    const sk = arquivoDeSkill(path);
    if (!sk || !skillsNoProjeto.includes(sk.id)) {
      throw new AgentError(
        `"${path}" is not part of a skill installed in this project. Ignore that folder and work from the project's own files.`
      );
    }
    if (typeof lerSkill !== 'function') return undefined;
    if (textoDasSkills.has(path)) return textoDasSkills.get(path);
    let texto = null;
    try {
      texto = await lerSkill(sk.id, sk.arquivo);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
    if (typeof texto !== 'string' || !texto.trim()) {
      throw new AgentError(
        `The skill file "${path}" could not be loaded right now. Do the request without it, using your own knowledge, and do not retry this read.`
      );
    }
    textoDasSkills.set(path, texto);
    return texto;
  }
  const recusaDeSkill = (p) =>
    `"${p}" is inside the skills folder, which is read-only and managed by the extension. A skill is a set of instructions to follow, not a project file — make the change in the project's own files.`;
  const criadosNesteRun = new Set(); // arquivos que não existiam antes deste run
  let avisouOrfaos = false;

  // Mudanças em preparação: path -> {content} | {deleted:true}
  const staged = new Map();

  // Retomada: os arquivos que o run anterior preparou entram como se esta
  // conversa os tivesse escrito — readProjectFile serve a versão preparada, e
  // o commit do fim leva tudo junto. Se o projeto andou desde então (a
  // Lovable commitou algo), o rascunho apagaria o que veio depois: descarta.
  let trabalhoDescartado = false;
  const feitosAntes = [];
  if (trabalhoAnterior?.changes?.length) {
    const pontaAgora = baseInicial;
    let andouNosMesmos = false;
    if (trabalhoAnterior.baseSha && pontaAgora && pontaAgora !== trabalhoAnterior.baseSha) {
      // Andou — mas só descarta se a Lovable mexeu em algum arquivo do
      // rascunho (ou se não dá para saber). Commit dela em outro arquivo não
      // é motivo para jogar fora rodadas pagas.
      let mudados = null;
      try {
        mudados = (await github.arquivosMudadosEntre?.(owner, repo, trabalhoAnterior.baseSha, pontaAgora, signal)) ?? null;
      } catch { mudados = null; }
      andouNosMesmos = !mudados || trabalhoAnterior.changes.some(([p]) => mudados.has(p));
    }
    if (andouNosMesmos) {
      trabalhoDescartado = true;
    } else {
      for (const [caminho, valor] of trabalhoAnterior.changes) {
        // A pasta das skills não se escreve por rascunho nenhum (nem de
        // versão antiga, nem de storage mexido).
        if (naPastaDasSkills(caminho)) continue;
        staged.set(caminho, valor);
        knownPaths.add(caminho);
        feitosAntes.push(caminho);
      }
    }
  }
  let commitMessage = null;
  let pendingSql = null; // SQL de migração proposto (modo Lovable Cloud manual)
  // Soma, não troca: a 2ª proposta manual do run apagava a 1ª (a tabela
  // sumia do cartão e o frontend que a usa era commitado sem ela). Os prompts
  // de banco exigem script que aguenta rodar duas vezes, então repetir uma
  // proposta corrigida depois da primeira continua seguro.
  // O resumo em português que a IA escreve para o cartão (propor_migracao).
  let resumoPendente = null;
  const registrarSqlManual = (sql, resumo = null) => {
    pendingSql = pendingSql && pendingSql !== sql ? `${pendingSql}\n\n${sql}` : sql;
    if (resumo) resumoPendente = resumoPendente && resumoPendente !== resumo ? `${resumoPendente} ${resumo}` : resumo;
  };
  const sqlAplicados = []; // SQL já aplicado no Lovable Cloud neste run (vai para docs/migrations/)
  // Supabase externo: mudança de SCHEMA executada com run_sql. Vira o arquivo
  // de migração no commit, escrito pela extensão — a IA escrevia à mão e
  // reescrevia a cada correção do SQL (7 edições do mesmo arquivo num pedido
  // do dono, 2026-09-27, que bateu no teto de 50 etapas).
  const sqlRodados = [];
  // Contadores do diagnóstico (record.diagnostico): o que mede se a busca,
  // a leitura por trecho e o orçamento de contexto estão funcionando.
  const contagem = { buscas: 0, consultas: 0, trechos: 0, editsFalhos: 0, erros: 0, removidos: 0 };
  // Anexos da rodada anterior vêm no trabalho guardado (a rodada 2 não
  // recebia anexo nenhum). O que já tinha sido salvo (`salvoEm`) está nos
  // arquivos do rascunho e fica de fora — a não ser que o rascunho tenha sido
  // descartado (projeto mudou): aí volta a ser anexo a salvar, senão a logo
  // pedida sumia junto com o rascunho.
  const daRodadaAnterior = (Array.isArray(trabalhoAnterior?.anexos) ? trabalhoAnterior.anexos : [])
    .filter((f) => trabalhoDescartado || !f.salvoEm)
    .map(({ salvoEm, ...f }) => ({ ...f, daRodadaAnterior: true }));
  const anexos = anexosComNomeUnico(
    [...(Array.isArray(projectFiles) ? projectFiles : []), ...daRodadaAnterior].filter((f) => f && f.name && f.base64)
  );
  // anexo (objeto) -> caminho onde entrou no projeto (pela IA ou pelo fallback)
  const anexosSalvos = new Map();
  let imagensGeradas = 0; // gerar_imagem neste run (teto MAX_IMAGENS_POR_RUN)
  let sqlExecutados = 0; // escritas no banco (o placar mostra à IA)
  // O banco da rodada anterior: SQL proposto (manual) ou já aplicado. Vale
  // mesmo com o rascunho de arquivos descartado — o banco mudou do mesmo
  // jeito, e o registro em docs/migrations/ e o "sem desfazer" dependem disso.
  if (trabalhoAnterior?.sqlPendente) registrarSqlManual(trabalhoAnterior.sqlPendente, trabalhoAnterior.resumoSqlPendente || null);
  if (Array.isArray(trabalhoAnterior?.sqlAplicados)) sqlAplicados.push(...trabalhoAnterior.sqlAplicados);
  if (Array.isArray(trabalhoAnterior?.sqlRodados)) sqlRodados.push(...trabalhoAnterior.sqlRodados);
  if (trabalhoAnterior?.sqlExecutados) sqlExecutados += Number(trabalhoAnterior.sqlExecutados) || 0;
  // Plano de partes deste run: cópia do que veio de fora (continuação) ou o
  // que a IA criar agora. Só sai daqui pelo retorno — a UI é quem persiste.
  let planoAtual = plano ? { ...plano, partes: plano.partes.map((p) => ({ ...p })) } : null;
  let dividiuNesteRun = false;

  const readCache = new Map();
  // Orçamento de contexto (ver aplicarOrcamento): arquivos cuja leitura saiu
  // da conversa — a IA não tem mais o texto deles, e o edit_file tem de dizer
  // isso em vez de "não releia" — e tudo o que a IA já examinou, que vai na
  // memória da próxima rodada (sair da conversa não é "não ter examinado").
  const leiturasRemovidas = new Set();
  const examinados = new Set();
  // Arquivo lido INTEIRO e ainda na conversa: só dele a IA pode reescrever
  // quase tudo com write_file (ver a trava em write_file).
  const lidosInteiros = new Set();
  // Sha de cada arquivo na árvore de onde o run partiu: a leitura pede o blob
  // exato (conteúdo e chave do cache andam juntos, mesmo que a Lovable
  // commite no meio do run).
  const shaDoArquivo = new Map(files.filter((f) => f.sha).map((f) => [f.path, f.sha]));
  async function readProjectFile(path) {
    if (naPastaDasSkills(path)) {
      const daSkill = await lerDaPastaDasSkills(path);
      if (daSkill !== undefined) return daSkill;
    }
    if (staged.has(path)) {
      const s = staged.get(path);
      if (s.deleted) throw new AgentError(`"${path}" foi apagado nesta sessão.`);
      if (s.base64 != null) throw new AgentError(`"${path}" é um anexo binário salvo nesta sessão e não pode ser lido como texto.`);
      return s.content;
    }
    return lerDoRepositorio(path);
  }

  // A versão do GitHub, nunca o rascunho: é a única que pode ir para o cache
  // por sha da busca. Com o rascunho lá (revisão adversarial, 2026-09-29), um
  // run seguinte achava o texto não enviado pelo sha do arquivo original — e
  // código cancelado ou desfeito voltava num commit novo.
  async function lerDoRepositorio(path) {
    if (readCache.has(path)) return readCache.get(path);
    if (extIsBinary(path)) {
      throw new AgentError(`"${path}" é um arquivo binário e não pode ser lido como texto.`);
    }
    // Pelo blob do sha da árvore (quando o cliente do GitHub sabe): o
    // conteúdo é exatamente o daquele sha, e só assim ele pode ir para o cache
    // entre runs — pelo nome do branch, um commit da Lovable no meio faria
    // conteúdo novo ficar guardado com o sha velho. Sem sha, como sempre.
    const sha = shaDoArquivo.get(path);
    const peloBlob = Boolean(sha) && typeof github.readBlob === 'function';
    let content;
    if (peloBlob && cacheDeArquivos) {
      try {
        const guardado = await cacheDeArquivos.get(sha);
        if (typeof guardado === 'string') content = guardado;
      } catch { /* cache é atalho */ }
    }
    if (content === undefined) {
      content = peloBlob
        ? await github.readBlob(owner, repo, sha, signal)
        : await github.readFile(owner, repo, branch, path, signal);
      if (peloBlob && cacheDeArquivos) {
        try { await cacheDeArquivos.set(sha, content); } catch { /* idem */ }
      }
    }
    if (content.length > MAX_FILE_CHARS_INTERNO) {
      throw new AgentError(
        `"${path}" is too large to handle (${Math.round(content.length / 1000)}k chars) — it looks generated or bundled. Change its source instead.`
      );
    }
    readCache.set(path, content);
    return content;
  }

  // read_file: inteiro até MAX_FILE_CHARS; acima disso, ou quando a IA pede,
  // por trecho de linhas. O cabeçalho do trecho fica numa linha própria, para
  // o old_string do edit_file continuar sendo copiado do texto como veio.
  async function lerParaIA(path, inicio, fim) {
    const conteudo = await readProjectFile(path);
    const linhas = conteudo.split('\n');
    const total = linhas.length;
    const pediuTrecho = inicio != null || fim != null;
    if (!pediuTrecho) {
      if (conteudo.length <= MAX_FILE_CHARS) return conteudo;
      throw new AgentError(
        `"${path}" is big (${total} lines, ${Math.round(conteudo.length / 1000)}k chars) — too much to read at once. Use search_code to find the part you need, then read_file with start_line/end_line around it (up to about ${MAX_TRECHO_CHARS / 1000}k chars per call). edit_file works on it normally.`
      );
    }
    const a = Math.max(1, Math.floor(Number(inicio) || 1));
    let b = Math.min(total, Math.floor(Number(fim) || total));
    if (a > total) throw new AgentError(`"${path}" has only ${total} lines.`);
    if (b < a) throw new AgentError('end_line must be >= start_line.');
    // Uma linha só maior que o trecho (JSON ou bundle numa linha): vem
    // cortada — sem isso ela voltava inteira, até o teto de 1M (revisão
    // adversarial: 300k chars num resultado só).
    if (linhas[a - 1].length > MAX_TRECHO_CHARS) {
      return `[line ${a} of ${total} in "${path}" is ${Math.round(linhas[a - 1].length / 1000)}k chars long — showing only its first ${MAX_TRECHO_CHARS / 1000}k; use search_code to find the part you need]\n${linhas[a - 1].slice(0, MAX_TRECHO_CHARS)}`;
    }
    let texto = linhas.slice(a - 1, b).join('\n');
    if (texto.length > MAX_TRECHO_CHARS) {
      // Corta no fim de uma linha e diz até onde veio.
      let chars = 0;
      let ultima = a - 1;
      while (ultima < b && chars + linhas[ultima].length + 1 <= MAX_TRECHO_CHARS) chars += linhas[ultima++].length + 1;
      b = Math.max(a, ultima);
      texto = linhas.slice(a - 1, b).join('\n');
    }
    return `[lines ${a}-${b} of ${total} in "${path}"${b < total ? ' — ask for more with start_line/end_line' : ''}]\n${texto}`;
  }

  // ---------- busca no código (search_code) ----------
  // O projeto inteiro é baixado uma vez por run (com cache por sha entre
  // runs, quando o painel dá um) e a busca olha a versão EM PREPARAÇÃO dos
  // arquivos que este run já mexeu.
  // Sempre do REPOSITÓRIO (lerDoRepositorio, com o cache por sha lá dentro),
  // nunca do rascunho — o rascunho entra por cima em entradasDaBusca.
  const indiceDaBusca = new Map();
  async function indexarParaBusca() {
    // Só o que ainda falta: a 1ª busca baixa tudo; as seguintes tentam de
    // novo só o que falhou (antes, um soluço de rede tirava o arquivo da
    // busca pelo run inteiro, e a IA ouvia "No matches" — revisão adversarial).
    const fila = arquivosPesquisaveis(files).filter((f) => !indiceDaBusca.has(f.path));
    if (fila.filter((f) => !readCache.has(f.path)).length > 30) {
      emit({ type: 'phase', text: 'Procurando no projeto (a primeira busca lê todos os arquivos)…' });
    }
    const falhas = [];
    // Poucos por vez: o GitHub limita rajada, e a conexão do cliente também.
    const trabalhador = async () => {
      while (fila.length) {
        const f = fila.shift();
        try {
          indiceDaBusca.set(f.path, await lerDoRepositorio(f.path));
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          falhas.push(f.path);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, fila.length || 1) }, trabalhador));
    return { mapa: indiceDaBusca, falhas };
  }

  function entradasDaBusca(mapa) {
    const out = [];
    for (const [p, texto] of mapa) {
      const st = staged.get(p);
      if (st?.deleted || st?.base64 != null) continue;
      out.push([p, typeof st?.content === 'string' ? st.content : texto]);
    }
    for (const [p, st] of staged) {
      if (!mapa.has(p) && typeof st.content === 'string') out.push([p, st.content]);
    }
    return out;
  }

  // Trava de assets: a IA não cria binário, e um import de imagem inexistente
  // quebra o build inteiro do Vite — o commit dá sucesso e a quebra só aparece
  // depois, no Lovable, parecendo culpa do GeckoAI (2x em produção). O prompt
  // pede; isto trava, na escrita, onde o erro nasce e é barato corrigir. Só
  // referência resolvível é checada (./ ../ @/ /): nome solto pode ser montado
  // dinamicamente e acusar seria falso positivo.
  const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte']);
  function resolverAsset(deArquivo, ref) {
    const limpo = ref.split('?')[0].split('#')[0];
    if (/^(https?:|data:|blob:)/i.test(limpo)) return [];
    if (limpo.startsWith('@/')) return [`src/${limpo.slice(2)}`]; // alias padrão do Vite/Lovable
    if (limpo.startsWith('/')) return [`public${limpo}`, limpo.slice(1)]; // raiz do Vite = public/
    if (limpo.startsWith('./') || limpo.startsWith('../')) {
      const out = deArquivo.split('/').slice(0, -1);
      for (const seg of limpo.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
      }
      return [out.join('/')];
    }
    return [];
  }
  function verificarReferencias(path, conteudo) {
    if (!CODE_EXT.has(path.split('.').pop()?.toLowerCase() || '')) return;
    const exts = [...BINARY_EXT].join('|');
    const re = new RegExp(
      `['"\`]([^'"\`\\s]+\\.(?:${exts}))(?:[?#][^'"\`]*)?['"\`]|url\\(\\s*([^'")\\s]+\\.(?:${exts}))\\s*\\)`,
      'gi'
    );
    const quebradas = new Set();
    for (const m of conteudo.matchAll(re)) {
      const ref = m[1] || m[2];
      const candidatos = resolverAsset(path, ref);
      if (!candidatos.length) continue;
      const existe = candidatos.some((c) => {
        const s = staged.get(c);
        if (s) return !s.deleted;
        return knownPaths.has(c);
      });
      if (!existe) quebradas.add(ref);
    }
    if (quebradas.size) {
      throw new AgentError(
        `Referenced asset(s) do not exist in the project: ${[...quebradas].join(', ')}. One missing asset breaks the whole Vite build. You cannot create binary files (images/fonts/media) — reference only assets listed in the tree, or use inline SVG, plain CSS, or an icon package already in package.json.`
      );
    }
  }

  // Travas do formato do projeto. Mesma linha do verificarReferencias acima:
  // prompt é pedido, isto é trava. Todas recusam DURANTE a conversa, onde a
  // IA corrige de graça — depois do commit o erro vira build quebrado, a
  // Lovable segue servindo a versão anterior e o usuário vê "não mudou nada".
  // `criando`: a trava de rota vale para arquivo NOVO. Editar ou apagar um
  // src/pages/ que já existe é legítimo (e apagar é até o conserto certo).
  function travaDeEscrita(path, criando = false) {
    // Skill é instrução, não arquivo do projeto: um pedido (ou um arquivo com
    // instrução injetada) não reescreve o que a IA vai obedecer depois.
    if (naPastaDasSkills(path)) throw new AgentError(recusaDeSkill(path));
    if (ehArquivoGerado(path)) {
      throw new AgentError(
        `"${path}" is generated by the project's tooling and Lovable rewrites it — editing it by hand breaks the build (src/routes/README.md says so). Change the source instead: to add a page, create the route file; to add a dependency, edit package.json.`
      );
    }
    const fora = criando ? rotaForaDoLugar(formaDoProjeto, path) : null;
    if (fora) throw new AgentError(fora);
  }

  function travaDeConteudo(path, conteudo) {
    // Preset da Lovable: o original (lido do GitHub) ou o novo o importam; sem
    // o original em mãos, a forma do projeto decide (rotas por arquivo = TanStack).
    const original = readCache.get(path);
    const usaPreset = /vite-tanstack-config/.test(String(conteudo || '')) || (original != null
      ? /vite-tanstack-config/.test(original)
      : formaDoProjeto.roteador === 'arquivos');
    if (duplicaPluginDoVite(path, conteudo, usaPreset)) {
      throw new AgentError(
        `Do not add plugins or a plugins list to "${path}": Lovable's preset already includes React, Tailwind, TanStack Start and tsconfig paths, and duplicating them breaks the app (the file says so at the top). Make the change somewhere else.`
      );
    }
    // Componente usado sem importar: a página fica EM BRANCO e o cliente vai
    // pedir socorro no chat da Lovable. Aconteceu no projeto do dono em
    // 2026-09-23 — `<Link to="/concluidas">` com o import ainda em
    // `{ createFileRoute }`; a Lovable commitou "Fixed missing link import"
    // logo depois. É por ARQUIVO (o import mora nele), então dá para recusar
    // na hora da escrita, que é onde sai barato corrigir.
    if (/\.(tsx|jsx)$/.test(path)) {
      const faltando = componentesNaoImportados(conteudo);
      if (faltando.length) {
        throw new AgentError(
          `"${path}" uses ${faltando.map((n) => `<${n}>`).join(', ')} but does not import ${faltando.length > 1 ? 'them' : 'it'}. The page would render BLANK. Add the import in this same file (for example \`import { Link } from "@tanstack/react-router"\`) and write the file again.`
        );
      }
    }
  }

  // Import que não resolve derruba o build INTEIRO e o preview fica em branco.
  // A conferência é do CONJUNTO, no fim: por arquivo ela acusaria a ordem
  // legítima de escrever a tela antes do ícone .svg que a IA ainda vai criar.
  const EXT_DE_IMPORT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);
  function importsQuebrados() {
    // Árvore truncada = knownPaths incompleto; acusar aqui recusaria import bom.
    if (truncated) return [];
    const achados = [];
    for (const [path, st] of staged) {
      if (typeof st.content !== 'string') continue;
      if (!EXT_DE_IMPORT.has(path.split('.').pop()?.toLowerCase() || '')) continue;
      const quebrados = new Set();
      for (const spec of importsDoArquivo(st.content)) {
        const candidatos = candidatosDeImport(path, spec);
        if (!candidatos.length) continue; // pacote do npm ou URL: não é caminho
        const existe = candidatos.some((c) => {
          const alvo = staged.get(c);
          if (alvo) return !alvo.deleted;
          return knownPaths.has(c) || readCache.has(c);
        });
        if (!existe) quebrados.add(spec);
      }
      if (quebrados.size) achados.push({ path, specs: [...quebrados] });
    }
    return achados;
  }

  // Arquivo de tela criado e importado por ninguém: compila, commita e o
  // usuário não vê nada. Rota em projeto de rotas por arquivo fica de fora —
  // quem liga é o roteador, não um import.
  function telasOrfas() {
    const alvos = [...criadosNesteRun].filter(
      (p) =>
        /\.(tsx|jsx)$/.test(p) &&
        !(formaDoProjeto.roteador === 'arquivos' && p.startsWith('src/routes/'))
    );
    if (!alvos.length) return [];
    const fontes = [];
    for (const [p, st] of staged) if (typeof st.content === 'string') fontes.push([p, st.content]);
    for (const [p, c] of readCache) if (!staged.has(p)) fontes.push([p, c]);
    return alvos.filter(
      (alvo) =>
        !fontes.some(
          ([p, c]) =>
            p !== alvo && importsDoArquivo(c).some((spec) => candidatosDeImport(p, spec).includes(alvo))
        )
    );
  }

  // Caminho canônico ANTES de qualquer ferramenta de arquivo. "./src/x.tsx"
  // era lido (o navegador limpa o "./" na URL) e editado, e o GitHub recusava
  // o commit INTEIRO no fim (422 "malformed path component") — com a mesma
  // edição podendo existir duas vezes no staged, com e sem "./". Caminho que
  // não dá para consertar (".." ou vazio) volta como erro para a IA, que
  // corrige de graça na mesma conversa.
  const FERRAMENTAS_DE_CAMINHO = new Set(['read_file', 'edit_file', 'write_file', 'delete_file']);
  function caminhoCanonico(bruto) {
    const p = String(bruto ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/(\.\/)+/g, '/')
      .replace(/\/$/, '');
    if (!caminhoDeAnexoValido(p)) {
      throw new AgentError(`Invalid path "${bruto}": use a path relative to the project root, like "src/App.tsx" (no "..", no leading "/").`);
    }
    return p;
  }

  async function executeTool(name, bruto) {
    const input = FERRAMENTAS_DE_CAMINHO.has(name) && bruto && typeof bruto === 'object'
      ? { ...bruto, path: caminhoCanonico(bruto.path) }
      : bruto;
    switch (name) {
      case 'read_file': {
        const trecho = input.start_line != null || input.end_line != null;
        step('read', trecho ? `${input.path}:${input.start_line ?? 1}-${input.end_line ?? 'fim'}` : input.path);
        const texto = await lerParaIA(input.path, input.start_line, input.end_line);
        if (trecho) contagem.trechos++;
        else lidosInteiros.add(input.path);
        leiturasRemovidas.delete(input.path);
        examinados.add(input.path);
        {
          const sk = arquivoDeSkill(input.path);
          if (sk && skillsNoProjeto.includes(sk.id)) {
            skillsLidas.add(sk.id);
            // A nota de adaptação a ESTE projeto chega junto com a skill (e
            // não no índice de todo pedido): onde ficam as tags neste formato,
            // "não é Next.js", "não invente depoimento"… Vai em TODA leitura
            // de texto da skill — regra de apoio e leitura por trecho também
            // (revisão da 1.12): só no SKILL.md inteiro, a nota era a primeira
            // coisa a sair da conversa pelo orçamento de contexto, e a rodada
            // de continuação (que lê por trecho) nem a recebia — justo quando
            // a IA ia aplicar o exemplo de SQL de uma regra.
            if (sk.arquivo !== 'LICENSE.txt') return `${texto}${rodapeDaSkill(sk.id, formaDoProjeto)}`;
          }
        }
        return texto;
      }
      case 'search_code': {
        const padrao = String(input.pattern ?? '');
        const pasta = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : null;
        step('search', padrao.slice(0, 80));
        let res;
        let falhas = [];
        try {
          const indice = await indexarParaBusca();
          falhas = indice.falhas;
          res = buscarNoTexto(entradasDaBusca(indice.mapa), { padrao, regex: input.regex === true, pasta });
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          throw new AgentError(String(err?.message || err));
        }
        contagem.buscas++;
        // Arquivo que não baixou não foi procurado: a IA precisa saber, senão
        // "No matches" parece "não existe" e ela cria outro componente.
        const aviso = falhas.length
          ? `\n(${falhas.length} file${falhas.length > 1 ? 's' : ''} could not be downloaded and ${falhas.length > 1 ? 'were' : 'was'} NOT searched: ${falhas.slice(0, 8).join(', ')}${falhas.length > 8 ? ', …' : ''}. Searching again retries them.)`
          : '';
        return `${formatarBusca(res, padrao, { pasta })}${aviso}`;
      }
      case 'consultar_banco': {
        if (!lerBanco || !leituraDoBanco) throw new AgentError('consultar_banco is not available in this project.');
        const q = consultaDeLeitura(input.sql);
        if (!q.ok) throw new AgentError(q.motivo);
        step('dbread', q.sql.replace(/\s+/g, ' ').slice(0, 80));
        const r = await lerBanco(q.sql);
        if (r?.ok) {
          contagem.consultas++;
          const out = JSON.stringify(linhasDaResposta(r.dados));
          return out.length > MAX_SQL_RESULT_CHARS
            ? `${out.slice(0, MAX_SQL_RESULT_CHARS)}… (truncated at ${MAX_SQL_RESULT_CHARS} chars — select fewer columns, or add WHERE/LIMIT)`
            : out;
        }
        if (r?.tipo === 'banco') throw new AgentError(`The database rejected the query: ${r.erro}`);
        throw new AgentError(
          `Could not read the database right now (${r?.erro || 'no answer from the Lovable tab'}). Continue with what the project files show; do not retry this now.`
        );
      }
      case 'edit_file': {
        if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
          throw new AgentError('edit_file exige old_string e new_string.');
        }
        // Lê da versão em preparação, se o arquivo já foi mexido neste run —
        // assim várias edições seguidas no mesmo arquivo se acumulam.
        travaDeEscrita(input.path);
        const atual = await readProjectFile(input.path);
        const novo = aplicarEdicao(atual, input.old_string, input.new_string);
        verificarReferencias(input.path, novo);
        travaDeConteudo(input.path, novo);
        staged.set(input.path, { content: novo });
        step('edit', input.path);
        // "Sem reler": no run real do dono (2026-09-16), 14 das 30 voltas eram
        // releitura do MESMO arquivo grande depois de cada edição — só custo.
        // A leitura deste arquivo saiu da conversa (orçamento de contexto):
        // "não releia" seria mentira, e a IA editaria de memória.
        if (leiturasRemovidas.has(input.path)) {
          return `OK — "${input.path}" editado (${input.old_string.length} chars trocados por ${input.new_string.length}). Your earlier read of this file was removed from the conversation to keep it fast, so you no longer have its current text: before editing it again, read only the lines around the next change (search_code gives the line numbers).`;
        }
        return `OK — "${input.path}" editado (${input.old_string.length} chars trocados por ${input.new_string.length}). The change was applied exactly as given. Do NOT read the file again: your earlier read of it is still exact except for the snippet you just replaced (now new_string), and your next edit_file works on the updated content.`;
      }
      case 'write_file': {
        if (typeof input.content !== 'string') {
          throw new AgentError('write_file sem conteúdo.');
        }
        travaDeEscrita(input.path, !knownPaths.has(input.path));
        verificarReferencias(input.path, input.content);
        travaDeConteudo(input.path, input.content);
        const existia = knownPaths.has(input.path);
        // Reescrever de memória um arquivo GRANDE que a IA não tem inteiro na
        // conversa (leu só um trecho, ou a leitura saiu pelo orçamento) perde
        // código: um de 79k virou 87 chars num teste da revisão adversarial.
        // Encolher mais da metade exige a leitura inteira; o normal é edit_file.
        if (existia && !staged.has(input.path) && noRepositorio.has(input.path) && !lidosInteiros.has(input.path)) {
          let atual = null;
          try { atual = await lerDoRepositorio(input.path); } catch { atual = null; }
          if (atual && atual.length > 20_000 && input.content.length < atual.length / 2) {
            throw new AgentError(
              `"${input.path}" has ${Math.round(atual.length / 1000)}k chars and this write_file would leave ${Math.round(input.content.length / 1000)}k — most of the file would be lost. You do not have the whole file in this conversation, so do not rewrite it from memory: change it with edit_file. If the user really wants the file replaced, read it whole first (for files over ${MAX_FILE_CHARS / 1000}k chars, use edit_file).`
            );
          }
        }
        staged.set(input.path, { content: input.content });
        if (!existia) criadosNesteRun.add(input.path);
        step(existia ? 'write' : 'create', input.path);
        return `OK — "${input.path}" staged (${input.content.length} chars).`;
      }
      case 'delete_file': {
        travaDeEscrita(input.path);
        // "Existe no repositório" é noRepositorio MAIS readCache (que só guarda
        // o que veio do GitHub): a árvore vem truncada em repositório gigante,
        // e um arquivo real fora da lista (mas que a IA leu) cairia no ramo de
        // descarte logo abaixo e teria a deleção ignorada em silêncio. NUNCA
        // knownPaths: ele inclui anexo salvo, imagem gerada e o rascunho da
        // rodada anterior, que não estão no GitHub.
        const noRepo = noRepositorio.has(input.path) || readCache.has(input.path);
        if (!noRepo && !staged.has(input.path)) {
          throw new AgentError(`"${input.path}" não existe no projeto.`);
        }
        // Arquivo que só existe NESTE run (criado e agora descartado) nunca
        // chegou ao repositório: o certo é sumir do staged. Marcar {deleted}
        // faria o commit mandar sha:null para um caminho fora do base_tree,
        // e o GitHub recusa a ÁRVORE INTEIRA com GitRPC::BadObjectState —
        // nada é commitado, e o prompt do cliente já foi consumido.
        if (noRepo) {
          staged.set(input.path, { deleted: true });
        } else {
          staged.delete(input.path);
          // Nunca existiu no GitHub: deixa de poder ser referenciado. Sem
          // isto, um import do arquivo apagado passava na conferência do fim
          // e o commit deixava o preview em branco.
          knownPaths.delete(input.path);
        }
        // Apagado não é tela órfã: sem isto o aviso de "ninguém importa" saía
        // sobre um arquivo que nem existe mais.
        criadosNesteRun.delete(input.path);
        step('delete', input.path);
        return `OK — "${input.path}" será removido no commit.`;
      }
      case 'salvar_anexo': {
        const nome = String(input.name || '').trim();
        const path = String(input.path || '').trim();
        const anexo = anexos.find((f) => f.name === nome) || anexos.find((f) => f.name.toLowerCase() === nome.toLowerCase());
        if (!anexo) {
          throw new AgentError(
            `No attached file named "${nome}". Attached files: ${anexos.map((f) => `"${f.name}"`).join(', ') || 'none'}.`
          );
        }
        if (!caminhoDeAnexoValido(path)) {
          throw new AgentError(`Invalid path "${path}": use a relative path inside the project, like "public/${nomeSeguro(anexo.name)}".`);
        }
        if (naPastaDasSkills(path)) throw new AgentError(recusaDeSkill(path));
        staged.set(path, { base64: anexo.base64, size: anexo.size });
        knownPaths.add(path); // importar/referenciar o arquivo salvo passa na trava de referências
        anexosSalvos.set(anexo, path);
        step('save', path);
        const publico = path.startsWith('public/') ? ` It is served at "/${path.slice('public/'.length)}".` : '';
        return `OK — "${anexo.name}" will be committed at "${path}".${publico} Now update any code that references it, if needed.`;
      }
      case 'gerar_imagem': {
        if (!gerarImagem) throw new AgentError('Image generation is not available here.');
        if (imagensGeradas >= MAX_IMAGENS_POR_RUN) {
          throw new AgentError(`Limit of ${MAX_IMAGENS_POR_RUN} images per request reached. Use the images already created.`);
        }
        const path = String(input.path || '').trim();
        const formato = formatoDaImagem(path);
        if (!formato || !caminhoDeAnexoValido(path)) {
          throw new AgentError(`Invalid path "${path}": use a relative path ending in .jpg, .png or .webp, like "public/images/hero.jpg".`);
        }
        if (naPastaDasSkills(path)) throw new AgentError(recusaDeSkill(path));
        const descricao = String(input.prompt || '').trim();
        if (!descricao) throw new AgentError('Describe the image in "prompt".');
        const tamanho = TAMANHOS_DE_IMAGEM.includes(input.tamanho) ? input.tamanho : '1024x1024';
        const transparente = input.fundo_transparente === true && formato !== 'jpeg';
        emit({ type: 'phase', text: 'Criando a imagem (cerca de 20 s)…' });
        let criada;
        try {
          criada = await gerarImagem({ prompt: descricao, tamanho, formato, transparente }, signal);
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          // Erro de ferramenta, não do run: sem a imagem, o resto do pedido
          // ainda vale — a IA segue com um marcador e avisa no resumo.
          throw new AgentError(
            `Image generation failed: ${err?.message || err}. Continue without this image: use an inline SVG/CSS placeholder and tell the user in the summary.`
          );
        } finally {
          emit({ type: 'phase', text: 'Analisando e aplicando mudanças…' });
        }
        const base64 = typeof criada?.base64 === 'string' ? criada.base64 : '';
        if (!base64) {
          throw new AgentError('Image generation returned no image. Continue without it: use an inline SVG/CSS placeholder and tell the user in the summary.');
        }
        const size = Math.floor((base64.length * 3) / 4);
        staged.set(path, { base64, size });
        knownPaths.add(path); // importar/referenciar a imagem passa na trava de referências
        imagensGeradas++;
        step('image', path);
        // Nunca os bytes no resultado: eles voltariam na conversa a cada volta.
        const publico = path.startsWith('public/') ? ` It is served at "/${path.slice('public/'.length)}".` : '';
        return `OK — image created (${tamanho}, ${Math.max(1, Math.round(size / 1024))} KB) and will be committed at "${path}".${publico} Now reference it in the code.`;
      }
      case 'set_commit_message': {
        // Import quebrado não tem meio-termo: o preview fica em branco. Recusa
        // até resolver — é sempre orrigível (criar o arquivo ou arrumar o
        // caminho), e a trava de repetição segura um laço eventual.
        const quebrados = importsQuebrados();
        if (quebrados.length) {
          const lista = quebrados
            .map((q) => `${q.path} -> ${q.specs.join(', ')}`)
            .join('; ');
          throw new AgentError(
            `These imports do not resolve to any file in the project: ${lista}. ONE broken import breaks the whole build and the preview goes blank, so this cannot be committed. Create the missing file, fix the path ("@/" means "src/"), or remove the import. If it is an npm package, add it to package.json instead.`
          );
        }
        // Uma vez só: avisar duas vezes viraria laço, e o teto de repetição
        // derrubaria um run que já fez trabalho bom.
        const orfas = avisouOrfaos ? [] : telasOrfas();
        if (orfas.length) {
          avisouOrfaos = true;
          const lista = orfas.map((p) => `"${p}"`).join(', ');
          const plural = orfas.length > 1;
          throw new AgentError(
            `Nothing in the project imports ${lista}, so ${plural ? 'they are' : 'it is'} never rendered: the commit would change nothing on the user's screen. Import and render ${plural ? 'them' : 'it'} from the page that should show ${plural ? 'them' : 'it'}, then call set_commit_message again. If ${plural ? 'they' : 'it'} really should not appear yet, call set_commit_message again and say that in your summary.`
          );
        }
        commitMessage = String(input.message || '').split('\n')[0].slice(0, 120);
        return 'OK.';
      }
      case 'run_sql': {
        if (!supabase) throw new AgentError('O banco de dados não está conectado.');
        const sql = String(input.sql || '').trim();
        if (!sql) throw new AgentError('run_sql sem SQL.');
        if (planMode && !isReadOnlySql(sql)) {
          throw new AgentError(
            'No modo Plan só consultas de leitura (SELECT/EXPLAIN) são permitidas.'
          );
        }
        // Destrutivo (DROP, TRUNCATE, DELETE/UPDATE sem WHERE, ALTER … DROP):
        // quem autoriza é o USUÁRIO, não a IA. Aqui o SQL roda direto no banco
        // de produção dele, e o prompt de sistema pede "nunca faça isso" — mas
        // prompt é pedido, não trava: basta a IA errar, ou um arquivo do
        // repositório trazer instrução injetada, para o dado sumir calado.
        //
        // Sem callback o padrão é RECUSAR: chamador que esqueceu de passar a
        // confirmação não pode virar permissão. O resto do SQL (inclusive
        // create/alter/insert) segue direto — gatear todo DDL tornaria o
        // trabalho normal do agente insuportável.
        if (!planMode && isDestructiveSql(sql)) {
          const liberado = confirmarSql ? await confirmarSql(sql) : false;
          if (!liberado) {
            throw new AgentError(
              'O usuário NÃO autorizou este comando destrutivo. Não tente rodá-lo de novo nem contorná-lo de outra forma; siga sem ele e explique no resumo o que ficou pendente.'
            );
          }
        }
        step('sql', sql.replace(/\s+/g, ' ').slice(0, 80));
        const rows = await supabase.client.runQuery(supabase.ref, sql, signal);
        if (!isReadOnlySql(sql)) {
          sqlExecutados++;
          if (!planMode && ehMudancaDeSchema(sql)) sqlRodados.push(sql);
        }
        const out = JSON.stringify(rows ?? []);
        return out.length > MAX_SQL_RESULT_CHARS
          ? `${out.slice(0, MAX_SQL_RESULT_CHARS)}… (resultado truncado em ${MAX_SQL_RESULT_CHARS} chars — refine a consulta com WHERE/LIMIT se precisar do resto)`
          : out;
      }
      case 'propor_migracao': {
        const sql = String(input.sql || '').trim();
        if (!sql) throw new AgentError('propor_migracao sem SQL.');
        const resumo = String(input.resumo || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
        step('migration', sql.replace(/\s+/g, ' ').slice(0, 80));
        const manual =
          'OK — migration registered. It will be shown to the user to run manually in the Lovable SQL editor. Now make the frontend/types changes with write_file and finish with set_commit_message; they are committed only after the user confirms the SQL was applied.';
        if (!aplicarSql) {
          registrarSqlManual(sql, resumo);
          return manual;
        }
        // Ensaio antes do cartão (lib/lovable.js): o SQL roda e é desfeito.
        // Erro real volta para a IA corrigir sem o leigo ver cartão nenhum —
        // antes, cada tentativa errada era um "o banco não aceitou" e mais um
        // clique em Autorizar. Inconclusivo (comando que não se ensaia, aba
        // sem resposta) segue para o cartão como sempre.
        let ensaio = null;
        if (ensaiarNoBanco) {
          emit({ type: 'phase', text: 'Conferindo o ajuste no banco antes de pedir sua autorização…' });
          try {
            ensaio = resultadoDoEnsaio(await ensaiarNoBanco(sql));
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            ensaio = { inconclusivo: true };
          }
          if (ensaio.erro) {
            throw new AgentError(
              `DRY RUN FAILED — nothing was applied and the user saw nothing. The database said: ${ensaio.erro}. Fix the SQL${leituraDoBanco ? ' (check the real schema with consultar_banco if needed)' : ''} and call propor_migracao again with the COMPLETE corrected script.`
            );
          }
        }
        // Aplicação automática: o cartão Autorizar aparece agora, e o que o
        // banco responder volta para a IA. Erro do BANCO (ordem errada,
        // coluna repetida) é dela para corrigir — antes o SQL só rodava
        // depois que ela tinha ido embora, e o erro ficava com o leigo.
        // `ensaiado`: o cartão só diz "já conferi" quando o ensaio passou.
        const r = await aplicarSql(sql, { resumo, ensaiado: ensaio?.ok === true });
        if (r?.cancelado) {
          // O usuário disse não: o run inteiro para (commitar frontend que
          // depende de tabela inexistente quebraria o app). Mesmo caminho do
          // botão Cancelar: nada no banco, nada no repositório.
          const e = new Error('Cancelado pelo usuário.');
          e.name = 'AbortError';
          throw e;
        }
        if (r?.ok) {
          sqlAplicados.push(sql);
          sqlExecutados++;
          const out = JSON.stringify(r.dados ?? null);
          const dados = out.length > MAX_SQL_RESULT_CHARS ? `${out.slice(0, MAX_SQL_RESULT_CHARS)}…` : out;
          // Conferência de acesso das tabelas criadas agora: sem RLS, os
          // dados ficam abertos a quem tiver a chave pública do site; com RLS
          // e nenhuma política, o app não lê nem grava ("os dados não
          // aparecem"). Os dois se corrigem nesta mesma conversa.
          let conferencia = '';
          const novas = tabelasCriadas(sql);
          if (lerBanco && leituraDoBanco && novas.length) {
            try {
              const c = await lerBanco(sqlConferenciaDeAcesso(novas));
              if (c?.ok) conferencia = avisoDeAcesso(linhasDaResposta(c.dados));
            } catch (err) {
              if (err?.name === 'AbortError') throw err;
            }
          }
          return `OK — SQL applied to the live database with the user's authorization. Database response: ${dados}.${conferencia ? `\n\n${conferencia}` : ''} Now make the matching frontend/types changes and finish with set_commit_message; the migration is recorded in the commit automatically.`;
        }
        if (r?.tipo === 'banco') {
          throw new AgentError(
            `The database REJECTED the SQL: ${r.erro}. Fix the SQL and call propor_migracao again with the COMPLETE corrected script — it will be shown to the user for authorization again. Some statements may already have run, so the corrected script must be safe to run again (IF NOT EXISTS; DROP POLICY IF EXISTS before CREATE POLICY).`
          );
        }
        // Falha de acesso (aba do Lovable, sessão): não é problema da IA —
        // cai na reserva manual, e o usuário aplica à mão.
        registrarSqlManual(sql, resumo);
        return manual;
      }
      case 'dividir_em_partes': {
        if (dividiuNesteRun) {
          throw new AgentError(
            'You already split this turn. Implement the current part now — do not split again.'
          );
        }
        const partes = normalizarPartes(input.partes);
        if (!partes) {
          throw new AgentError(
            'dividir_em_partes needs at least 2 parts, each with a "titulo" and a "descricao".'
          );
        }

        if (!planoAtual) {
          if (partes.length > MAX_PARTES) {
            throw new AgentError(
              `Too many parts (${partes.length}). Group them into at most ${MAX_PARTES}.`
            );
          }
          // Quem aprova gastar N prompts é o USUÁRIO, e o padrão sem callback é
          // recusar — como no confirmarSql. Ele viu a lista; se disser não, o
          // run acaba aqui (o prompt do planejamento foi consumido, e o plano
          // fica visível para ele ajustar o pedido).
          const ok = confirmarPlano ? await confirmarPlano(partes) : false;
          if (!ok) {
            const err = new AgentError(
              'Plano cancelado por você — nada foi alterado. Ajuste o pedido e envie de novo.'
            );
            err.planoRecusado = partes;
            throw err;
          }
          dividiuNesteRun = true;
          planoAtual = {
            pedido: prompt,
            partes: partes.map((p) => ({ ...p, feita: false })),
            atual: 0,
          };
          step('plano', `${partes.length} partes`);
          return instrucaoDaParte(planoAtual, 'Plan approved by the user');
        }

        // Já existe plano: a parte ATUAL ficou grande. As subetapas são
        // INTERNAS deste run — o plano do usuário NÃO muda, nada aparece na
        // UI e nada custa prompt a mais (decisão do dono, 2026-08-31: cada
        // parte do plano = 1 prompt, e o sistema não anuncia subdivisão).
        // Continuar a MESMA conversa é o que o servidor já não cobra; run
        // novo custaria. O ganho é disciplina: a IA declara as etapas e
        // executa uma por vez, sem loop.
        if (partes.length > MAX_SUBETAPAS) {
          throw new AgentError(
            `Too many sub-steps (${partes.length}). Group them into at most ${MAX_SUBETAPAS}.`
          );
        }
        dividiuNesteRun = true;
        const i = planoAtual.atual;
        const pai = planoAtual.partes[i];
        const lista = partes.map((p, k) => `${k + 1}. ${p.titulo} — ${p.descricao}`).join('\n');
        return `OK — internal sub-steps for part ${i + 1} ("${pai.titulo}"):\n${lista}\nImplement ALL of them now, in order, in THIS run. Do not stop between sub-steps and do not ask the user anything. When every sub-step is done, call set_commit_message and finish with a short summary of part ${i + 1}.`;
      }
      default:
        throw new AgentError(`Ferramenta desconhecida: ${name}`);
    }
  }

  // As instruções que a Lovable deixa no repo. A IA já as lia por conta
  // própria em parte dos runs (e o usuário pagava por essas leituras); agora
  // vêm de graça, e em todos. Falha na leitura não derruba o run.
  const docsDaLovable = [];
  for (const caminho of formaDoProjeto.docs) {
    try {
      const texto = await readProjectFile(caminho);
      if (texto) docsDaLovable.push({ path: caminho, texto: texto.slice(0, MAX_DOC_LOVABLE) });
    } catch { /* documento sumiu: o resto do contexto continua valendo */ }
  }

  // Modo escuro ligado no app: trocar só a cor clara sai no commit e ninguém
  // no escuro vê (lib/projeto.js). Poucos arquivos pequenos, em paralelo; a
  // leitura fica no cache, então a IA que abrir o mesmo arquivo depois não
  // busca de novo. Falha em qualquer um só deixa de avisar.
  //
  // Lovable Cloud com leitura: o retrato do banco DE VERDADE (uma linha por
  // tabela, com colunas e situação de acesso) entra no contexto de graça —
  // antes a IA gastava etapas descobrindo tabela por migração antiga ou pelo
  // types.ts desatualizado. Em paralelo com o tema; falha só deixa sem — e,
  // se a aba não respondeu nem ao retrato, a IA nem recebe consultar_banco
  // (gastaria voltas tentando ler um banco que não responde).
  const [textosDoTema, retrato] = await Promise.all([
    Promise.all(
      arquivosDoTema(formaDoProjeto, files).map((caminho) =>
        readProjectFile(caminho).then((texto) => ({ path: caminho, texto }), () => null)
      )
    ),
    dbMode === 'manual' && lerBanco
      ? Promise.resolve()
          .then(() => lerBanco(SQL_RESUMO_DO_BANCO, 15_000))
          .then(
            (r) => ({ ok: r?.ok === true, bloco: r?.ok ? blocoDoBanco(linhasDaResposta(r.dados)) : '' }),
            (err) => {
              if (err?.name === 'AbortError') throw err;
              return { ok: false, bloco: '' };
            }
          )
      : { ok: false, bloco: '' },
  ]);
  const leituraDoBanco = retrato.ok;
  const blocoBanco = retrato.bloco;
  const modoEscuro = detectarModoEscuro(textosDoTema.filter(Boolean), formaDoProjeto);

  const contextText = [
    `<project>`,
    `Repository: ${owner}/${repo}`,
    `Branch: ${branch}`,
    `This project is synced with Lovable (changes committed here appear in Lovable automatically).`,
    ``,
    `File tree:`,
    formatTree(files, truncated),
    `</project>`,
    `\n${blocoDoProjeto(formaDoProjeto, docsDaLovable, modoEscuro)}`,
    skillsNoProjeto.length ? `\n${blocoDeSkills(skillsNoProjeto)}` : '',
    blocoBanco ? `\n${blocoBanco}` : '',
    dbConnected && supabase.url && supabase.anonKey
      ? `\n<database>\nSupabase project URL: ${supabase.url}\nPublishable (anon) key: ${supabase.anonKey}\nThese are the real credentials of the connected project. They are public by design (RLS protects the data) and safe to hardcode in frontend code.\n</database>`
      : '',
    projectContext
      ? `\n<project_context source="docs/CONTEXTO.md">\nUse este resumo como mapa do projeto — vá direto aos arquivos citados em vez de explorar tudo. Ele pode estar um pouco desatualizado; ao editar, confirme lendo o arquivo real.\n${projectContext}\n</project_context>`
      : '',
    anexos.length ? `\n${blocoDeAnexos(anexos, planMode)}` : '',
    planoAtual ? `\n${blocoDoPlano(planoAtual)}` : '',
    planoAtual && parteFalhou ? `\n${blocoDaRetentativa(planoAtual, parteFalhou)}` : '',
    feitosAntes.length
      ? `\n<work_in_progress>\nA previous run for THIS SAME request already prepared these files, and they are NOT committed yet: ${feitosAntes
          .map((f) => `"${f}"`)
          .join(', ')}.\nread_file returns the prepared version, not the one on GitHub. Do not redo that work: check it, finish what is missing, and everything will be committed together at the end of this run.\n</work_in_progress>`
      : '',
    trabalhoDescartado
      ? `\n<work_in_progress>\nA previous run had prepared files for this request, but the project changed on Lovable in the meantime, so that work was discarded to avoid overwriting the newer version. Start from the files as they are now.\n</work_in_progress>`
      : '',
    trabalhoAnterior ? blocoDaRodadaAnterior(trabalhoAnterior) : '',
    recentHistory ? `\n<recent_changes>\n${recentHistory}\n</recent_changes>` : '',
  ].join('\n');

  emit({
    type: 'phase',
    text: planMode ? 'Analisando o projeto e montando o plano…' : 'Analisando e aplicando mudanças…',
  });

  let tools = planMode ? TOOLS.filter((t) => PLAN_TOOLS.includes(t.name)) : TOOLS;
  if (dbConnected) {
    // Supabase externo: executa direto, sem o fluxo de migração manual.
    tools = tools.filter((t) => t.name !== 'propor_migracao');
  } else {
    // Sem Supabase externo: nunca há run_sql; propor_migracao só no modo manual.
    tools = tools.filter((t) => t.name !== 'run_sql');
    if (dbMode !== 'manual') tools = tools.filter((t) => t.name !== 'propor_migracao');
  }
  // Ler o banco só no Lovable Cloud com a aba respondendo (no Supabase
  // externo, run_sql já lê).
  if (!leituraDoBanco) tools = tools.filter((t) => t.name !== 'consultar_banco');
  // salvar_anexo só existe quando há anexo de projeto neste run.
  if (!anexos.length) tools = tools.filter((t) => t.name !== 'salvar_anexo');
  // gerar_imagem só com quem crie a imagem (servidor com a criação ligada).
  if (!gerarImagem) tools = tools.filter((t) => t.name !== 'gerar_imagem');
  // Sem quem aprove o plano (e sem plano em andamento), dividir só daria
  // erro — não oferece a ferramenta em vez de gastar uma volta para recusar.
  // Rodada de continuação (sem plano) também não divide: o trabalho guardado
  // viraria a "parte 1" de um plano que o usuário nem pediu, e recusar o
  // cartão das partes derrubava a rodada. Pedido grande segue por rodadas.
  if ((!confirmarPlano && !planoAtual) || (trabalhoAnterior?.changes?.length && !planoAtual)) {
    tools = tools.filter((t) => t.name !== 'dividir_em_partes');
  }
  // As travas abaixo só sugerem dividir quando a ferramenta existe neste run.
  const podeDividir = tools.some((t) => t.name === 'dividir_em_partes');

  const session = provider.createSession({
    apiKey,
    model,
    system: planMode
      ? makePlanSystem(dbMode, leituraDoBanco)
      : makeBuildSystem(dbMode, Boolean(aplicarSql), Boolean(gerarImagem), leituraDoBanco),
    tools,
  });

  // Histórico enxuto: quando um arquivo é relido, reescrito ou apagado, as
  // interações ANTERIORES com o mesmo path no histórico ficam obsoletas — o
  // conteúdo delas é trocado por um aviso curto (session.compact). A IA relê
  // com read_file quando precisar; nada fica inacessível. Só a operação mais
  // recente de cada arquivo permanece íntegra no histórico.
  // edit_file fica FORA: compactar a leitura a cada edição apagava o arquivo
  // do histórico, e a IA — que precisa do texto exato para o próximo
  // old_string — relia o arquivo inteiro depois de CADA edição (run do dono em
  // 2026-09-26: 7 edições, 7 releituras, contexto inchando até a resposta ser
  // cortada). A leitura continua válida fora do trecho trocado, e a IA sabe o
  // que trocou; se copiar de um trecho já mudado, o aplicarEdicao recusa e
  // manda reler.
  const FILE_TOOLS = new Set(['read_file', 'write_file', 'delete_file']);
  const lastCallId = new Map(); // chave (arquivo ou SQL) -> tool_use_id da operação mais recente
  // Leitura por trecho: cada trecho tem chave própria (ler as linhas 1-200 e
  // depois 800-900 do mesmo arquivo não apaga a primeira), e uma leitura
  // inteira, reescrita ou deleção do arquivo aposenta todos os trechos dele.
  const ehTrecho = (call) => call.name === 'read_file' && (call.input?.start_line != null || call.input?.end_line != null);
  const trechosPorArquivo = new Map(); // path -> Set(tool_use_id)
  // Resultados que ainda estão inteiros na conversa (orçamento de contexto):
  // tool_use_id -> { tam, volta, rotulo, sig, lido }
  const vivos = new Map();
  const TAMANHO_MEDIDO = new Set(['read_file', 'search_code', 'consultar_banco', 'run_sql', 'write_file']);
  // Leitura por trecho conta como novidade por trecho.
  const chaveDeLeitura = (call) =>
    ehTrecho(call) ? `${call.input.path}#${call.input.start_line ?? 1}-${call.input.end_line ?? ''}` : call.input?.path;
  // Busca e consulta inéditas também são novidade (a regex entra na chave:
  // é outra busca).
  const chaveDeNovidade = (call) =>
    call.name === 'search_code'
      ? `busca:${String(call.input?.pattern ?? '')}\u0000${call.input?.path ?? ''}\u0000${call.input?.regex === true}`
      : String(call.input?.sql || '').replace(/\s+/g, ' ').trim();
  function rotuloDoResultado(call) {
    if (call.name === 'read_file') return chaveDeLeitura(call);
    if (call.name === 'write_file') return `content you wrote to ${call.input?.path}`;
    if (call.name === 'search_code') return `search "${String(call.input?.pattern ?? '').slice(0, 40)}"`;
    return 'a database query';
  }
  function chaveDeCompactacao(call) {
    if (ehTrecho(call) && call.input?.path) {
      return `trecho:${call.input.path}:${call.input.start_line ?? 1}-${call.input.end_line ?? ''}`;
    }
    if (FILE_TOOLS.has(call.name) && call.input?.path) return `arquivo:${call.input.path}`;
    // A mesma consulta repetida era reenviada inteira a cada volta — um
    // "select * from pg_proc" de 30k, 40 vezes, foi metade do custo de um run
    // travado. Só a execução mais recente de cada SQL fica íntegra.
    if ((call.name === 'run_sql' || call.name === 'consultar_banco') && typeof call.input?.sql === 'string') {
      return `sql:${call.input.sql.replace(/\s+/g, ' ').trim()}`;
    }
    if (call.name === 'search_code' && typeof call.input?.pattern === 'string') {
      return `busca:${call.input.pattern}\u0000${call.input.path ?? ''}\u0000${call.input.regex === true}`;
    }
    return null;
  }
  function compactar(ids) {
    if (!ids.size) return;
    session.compact?.(ids);
    for (const id of ids) vivos.delete(id);
  }
  // Arquivo em edição conta como usado AGORA: sem isso, a leitura de um
  // arquivo grande lida uma vez e editado a cada volta era a primeira a sair
  // da conversa — justo a que a IA está usando (revisão adversarial).
  function tocarArquivo(path, volta) {
    for (const v of vivos.values()) if (v.arquivo === path) v.volta = volta;
  }
  // Devolve o que ficou obsoleto: o que já foi enviado o provedor enxuga; o
  // que é DESTA volta (lido duas vezes na mesma resposta) quem enxuga é o laço.
  function marcarOperacao(call) {
    const chave = chaveDeCompactacao(call);
    if (!chave) return new Set();
    const obsoletos = new Set();
    const prev = lastCallId.get(chave);
    if (prev) obsoletos.add(prev);
    const path = call.input?.path;
    if (ehTrecho(call)) {
      if (!trechosPorArquivo.has(path)) trechosPorArquivo.set(path, new Set());
      trechosPorArquivo.get(path).add(call.id);
    } else if (FILE_TOOLS.has(call.name) && path && trechosPorArquivo.has(path)) {
      for (const id of trechosPorArquivo.get(path)) obsoletos.add(id);
      trechosPorArquivo.delete(path);
    }
    compactar(obsoletos);
    lastCallId.set(chave, call.id);
    return obsoletos;
  }

  // Orçamento de contexto: passou do teto, as leituras/buscas mais antigas
  // (nunca as da volta atual nem da anterior) viram aviso curto até o piso.
  // A IA pode reler ou buscar de novo — e, para não ser barrada por isso, a
  // leitura removida sai também da trava de repetição e volta a contar como
  // novidade. Devolve os rótulos do que saiu, para o placar avisar.
  function aplicarOrcamento(voltaAtual) {
    let total = 0;
    for (const v of vivos.values()) total += v.tam;
    if (total <= ORCAMENTO_CONTEXTO_ALTO) return [];
    const velhos = [...vivos.entries()]
      .filter(([, v]) => v.volta < voltaAtual - 1)
      .sort((a, b) => a[1].volta - b[1].volta || b[1].tam - a[1].tam);
    const sair = new Set();
    const rotulos = [];
    for (const [id, v] of velhos) {
      if (total <= ORCAMENTO_CONTEXTO_BAIXO) break;
      sair.add(id);
      total -= v.tam;
      rotulos.push(v.rotulo);
      if (v.sig) vistos.delete(v.sig);
      if (v.lido) lidosNesteRun.delete(v.lido);
      if (v.novidade) consultasNesteRun.delete(v.novidade);
      if (v.lido && v.arquivo) {
        leiturasRemovidas.add(v.arquivo);
        lidosInteiros.delete(v.arquivo);
      }
    }
    // Se um trecho saiu, não pode continuar marcado como vivo no arquivo.
    for (const ids of trechosPorArquivo.values()) for (const id of sair) ids.delete(id);
    for (const [chave, id] of lastCallId) if (sair.has(id)) lastCallId.delete(chave);
    compactar(sair);
    contagem.removidos += sair.size;
    return rotulos;
  }

  let result = await session.start(contextText, prompt, attachments, signal);
  let finalText = '';

  // Travas do laço. Antes delas o único freio era MAX_ITERATIONS: um modelo
  // que travasse girava 50 chamadas pagas (com o contexto crescendo a cada
  // uma) e o cliente recebia uma mensagem culpando o pedido dele. Medido em
  // produção: a mesma consulta a pg_proc repetida ~40 vezes, com dois modelos
  // diferentes. Prompt pede "não repita"; isto aqui trava.
  //
  // 1) Repetição: mesma ferramenta + mesmos argumentos + MESMO resultado. O
  //    resultado entra na conta de propósito — reler um arquivo depois de
  //    editá-lo devolve conteúdo diferente e passa. Na 2ª, a IA recebe um
  //    aviso curto no lugar do resultado (também poupa contexto); na 3ª, o
  //    run para. **read_file fica de fora**: a compactação troca a leitura
  //    anterior pelo stub "call read_file for the current version", então
  //    recusar a releitura deixava a IA sem o arquivo em lugar NENHUM — ela
  //    obedecia o stub e morria na 3ª (runs reais do dono, 2026-09-16: 4
  //    passos e 30 passos, ambos pagos, nada enviado). A releitura devolve o
  //    conteúdo com um empurrão para agir; quem segura laço de leitura é a
  //    trava 2. E quando a repetição é recusada (outras ferramentas), a
  //    saída anterior NÃO é compactada: o aviso diz "use o resultado que
  //    você já tem", e ele precisa continuar no histórico.
  // 2) Sem progresso: N voltas seguidas só lendo/consultando. Aviso em 8,
  //    parada em 16. Desligado no modo Plan, que é só leitura por definição.
  // 3) Placar: cada volta diz à IA onde ela está — e, quando falha, diz a
  //    quem lê o histórico se foi loop ou tarefa grande de verdade.
  const vistos = new Map(); // assinatura -> { saida, vezes }
  const assinatura = (call) => `${call.name}\u0000${JSON.stringify(call.input ?? {})}`;
  const PROGRESSO = new Set([
    'edit_file', 'write_file', 'delete_file', 'propor_migracao', 'set_commit_message', 'dividir_em_partes',
    'salvar_anexo', 'gerar_imagem',
  ]);
  let voltasSemNovidade = 0;
  let voltasSemEscrita = 0;
  // Houve mudança de verdade (arquivo, banco, anexo) desde o último
  // set_commit_message aceito? Só então repetir a mensagem é legítimo.
  let mudouDesdeMensagem = true;
  const lidosNesteRun = new Set(feitosAntes); // o que o run anterior já tinha visto
  const consultasNesteRun = new Set();
  // Motivo da parada, quando uma trava derruba: decidido depois do laço, onde
  // dá para guardar o trabalho em vez de jogar fora.
  let interrompido = null;
  let voltasDadas = 0;
  // Voltas em que a IA mudou algum arquivo: separa "pedido grande avançando"
  // de "girando em falso" quando o teto de etapas corta — o painel só segue
  // sozinho para a próxima rodada quando esta rodada escreveu.
  let voltasComEscrita = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      voltasDadas = i + 1;
      if (!result.toolCalls.length) {
        finalText = result.text || '';
        break;
      }

      const outputs = [];
      let escreveu = false;
      let novidade = false; // informação nova nesta volta (arquivo/consulta inédita)

      // Caminho canônico já aqui: placar, compactação, assinatura de repetição
      // e a leitura em lote abaixo usam call.input.path. O inválido segue como
      // veio e o executeTool devolve o erro à IA.
      for (const call of result.toolCalls) {
        if (FERRAMENTAS_DE_CAMINHO.has(call.name) && typeof call.input?.path === 'string') {
          try { call.input = { ...call.input, path: caminhoCanonico(call.input.path) }; } catch { /* idem */ }
        }
      }

      // Otimização de performance: se o turno pediu múltiplas leituras de arquivos,
      // dispara o carregamento de todas em paralelo para pré-aquecer o readCache.
      const leiturasEmLote = result.toolCalls.filter(
        (c) => c.name === 'read_file' && c.input?.path && caminhoDeAnexoValido(c.input.path)
      );
      if (leiturasEmLote.length > 1) {
        await Promise.all(leiturasEmLote.map((c) => readProjectFile(c.input.path).catch(() => null)));
      }

      for (const call of result.toolCalls) {
        let output;
        let isError = false;
        let executou = false;
        try {
          output = await executeTool(call.name, call.input || {});
          executou = true;
          if (call.name === 'set_commit_message') {
            // Mensagem de commit não é escrita: uma IA repetindo só ela não
            // pode parecer "trabalhando" (zerava as travas e, somando
            // "escritas", fazia a rodada seguir SOZINHA por até 6 rodadas).
          } else if (
            PROGRESSO.has(call.name) ||
            (call.name === 'run_sql' && !isReadOnlySql(String(call.input?.sql || '')))
          ) {
            escreveu = true;
            mudouDesdeMensagem = true;
          } else if (call.name === 'read_file' && call.input?.path) {
            const lido = chaveDeLeitura(call);
            if (!lidosNesteRun.has(lido)) {
              lidosNesteRun.add(lido);
              novidade = true; // arquivo (ou trecho) inédito: a IA aprendeu algo
            }
          } else if (call.name === 'run_sql' || call.name === 'consultar_banco' || call.name === 'search_code') {
            // Consulta ou busca inédita também é informação nova.
            const chaveNova = chaveDeNovidade(call);
            if (chaveNova && !consultasNesteRun.has(chaveNova)) {
              consultasNesteRun.add(chaveNova);
              novidade = true;
            }
          }
        } catch (err) {
          if (err.name === 'AbortError' || err.planoRecusado) throw err;
          output = String(err.message || err);
          isError = true;
          contagem.erros++;
          if (call.name === 'edit_file') contagem.editsFalhos++;
        }

        const chave = assinatura(call);
        const antes = vistos.get(chave);
        let recusada = false;
        // set_commit_message aceito devolve sempre o mesmo "OK": chamar de novo
        // depois de mais trabalho (escreve A, mensagem, escreve B, mensagem…)
        // é legítimo e não pode contar como laço.
        const idempotente = call.name === 'set_commit_message' && !isError && mudouDesdeMensagem;
        if (call.name === 'set_commit_message' && !isError) mudouDesdeMensagem = false;
        if (antes && antes.saida === output && !idempotente) {
          antes.vezes++;
          if (call.name === 'read_file') {
            // Conteúdo inteiro de novo (a cópia anterior vai virar stub logo
            // abaixo), só com o lembrete. `antes.saida` fica com o bruto para
            // a próxima comparação continuar valendo.
            output = `${output}\n\n[GeckoAI] You already read this file and it has not changed since. Do not read it again — use this content to make the change now (edit_file with the exact text above).`;
          } else if (antes.vezes >= REPETICOES_ABORTA) {
            const trava = `it repeated the same ${call.name} call ${antes.vezes} times with identical results`;
            if (planMode) {
              const errTrava = new AgentError(
                `A IA travou repetindo a mesma ação (${call.name}, ${antes.vezes}×) sem sair do lugar. Nada foi enviado ao seu projeto. Tente reformular o pedido, ou peça uma parte menor por vez.`
              );
              // Motivo em inglês para o run de retomada (vira o bloco <retry>
              // via record.planoFalha -> parteFalhou). A UI usa err.message.
              errTrava.trava = trava;
              throw errTrava;
            }
            // Fora do Plan, parar pela trava NÃO joga fora o que ficou pronto
            // (antes era um throw daqui de dentro, que pulava o pendingWork):
            // sai pelo pós-laço, que guarda — e sem nada guardado, morre como
            // antes. Nunca segue sozinho (não é teto): é girar em falso.
            interrompido = {
              trava,
              mensagem: `A IA travou repetindo a mesma ação (${call.name}, ${antes.vezes}×) sem sair do lugar.`,
            };
            break;
          } else if (antes.vezes >= REPETICOES_AVISO) {
            output = `[GeckoAI] You already made this exact ${call.name} call and got the same result (shown to you before). Repeating it will not change anything. Use the result you already have, change the approach, or finish.${podeDividir ? ` If ${planoAtual ? 'the current part' : 'this task'} is too big for one run, call dividir_em_partes to split it.` : ''} One more identical call ends this turn with an error.`;
            isError = true;
            recusada = true;
          }
        } else {
          vistos.set(chave, { saida: output, vezes: 1 });
        }
        // Só compacta a operação anterior quando esta foi entregue de verdade.
        if (executou && !recusada) {
          const obsoletos = marcarOperacao(call);
          // O obsoleto DESTA volta ainda não foi enviado, e o provedor só
          // enxuga o que já está no histórico: sem isto, o mesmo arquivo lido
          // duas vezes na mesma resposta ia duas vezes inteiro.
          for (const o of outputs) if (obsoletos.has(o.id)) o.output = STUB_OBSOLETO;
          if (call.name === 'edit_file' && call.input?.path) tocarArquivo(call.input.path, i);
          // Entra na conta do orçamento de contexto (o que é pequeno não
          // vale a pena tirar).
          if (TAMANHO_MEDIDO.has(call.name)) {
            const tam = call.name === 'write_file' ? String(call.input?.content ?? '').length : String(output).length;
            if (tam > 2000) {
              vivos.set(call.id, {
                tam,
                volta: i,
                rotulo: rotuloDoResultado(call),
                sig: chave,
                lido: call.name === 'read_file' ? chaveDeLeitura(call) : null,
                arquivo: call.name === 'read_file' || call.name === 'write_file' ? call.input?.path : null,
                novidade: ['search_code', 'consultar_banco', 'run_sql'].includes(call.name) ? chaveDeNovidade(call) : null,
              });
            }
          }
        }
        outputs.push({ id: call.id, name: call.name, output, isError });
      }
      if (interrompido) break; // trava de repetição (acima)

      if (!planMode) {
        voltasSemNovidade = escreveu || novidade ? 0 : voltasSemNovidade + 1;
        voltasSemEscrita = escreveu ? 0 : voltasSemEscrita + 1;
        if (escreveu) voltasComEscrita++;
        // Sem aviso de "pedido grande" na tela (decisão do dono, 2026-10-01:
        // "o usuário não precisa saber, vai executando como deve ser feito").
        // A ordem de decidir continua indo para a IA, no placar.
        if (voltasSemNovidade >= VOLTAS_SEM_NOVIDADE_ABORTA) {
          interrompido = {
            trava: `it spent ${voltasSemNovidade} turns without learning anything new`,
            mensagem: `A IA ficou ${voltasSemNovidade} etapas repetindo as mesmas consultas, sem sair do lugar.`,
          };
        } else if (voltasSemEscrita >= VOLTAS_SEM_ESCRITA_ABORTA) {
          interrompido = {
            trava: `it explored ${voltasSemEscrita} turns without changing a single file`,
            mensagem: `Este pedido é grande demais para um envio só: a IA examinou ${examinados.size} arquivos e não conseguiu começar.`,
          };
        }
        if (interrompido) break;
      }

      // Teto de etapas. Como as duas travas acima, ele NÃO joga fora o que já
      // ficou pronto: marca o motivo e sai do laço, e o pós-laço decide entre
      // guardar o trabalho (cartão "Continuar") e morrer com a mensagem de
      // sempre. Até 2026-09-23 este era o único freio que lançava o erro de
      // DENTRO do laço, pulando o pendingWork — e é justamente o teto que um
      // pedido grande alcança: run real do dono (subtarefas) parou em
      // 32 das 50 etapas com 3 arquivos prontos e a migração já aplicada no
      // banco; bater no teto ali teria descartado tudo, com o prompt cobrado.
      // No Plan não existe trabalho a guardar (é leitura por definição), então
      // lá ele continua derrubando o run.
      if (i === MAX_ITERATIONS - 1) {
        const trava = `it hit the ${MAX_ITERATIONS}-step budget without finishing`;
        if (planMode) {
          const errTrava = new AgentError(
            `A IA não concluiu em ${MAX_ITERATIONS} etapas e nada foi enviado ao seu projeto. Tente um pedido menor ou mais específico — pedidos grandes funcionam melhor em partes.`
          );
          errTrava.trava = trava;
          throw errTrava;
        }
        interrompido = {
          trava,
          mensagem: `A IA não concluiu este pedido em ${MAX_ITERATIONS} etapas.`,
          // Parou pelo TETO (não por girar em falso): o painel pode seguir
          // para a próxima rodada com o trabalho guardado.
          teto: true,
        };
        break;
      }

      // Placar (e o aviso de "sem progresso") vão colados no último resultado:
      // a sessão só aceita tool_result na resposta, não texto solto.
      const placar = [
        `Turn ${i + 1}/${MAX_ITERATIONS}`,
        `files changed: ${staged.size}`,
        `SQL executed: ${sqlExecutados}`,
        planoAtual ? `part ${planoAtual.atual + 1}/${planoAtual.partes.length}` : null,
        // A IA passa a enxergar o próprio orçamento de exploração.
        !planMode && voltasSemEscrita > 0 ? `exploring ${voltasSemEscrita}/${VOLTAS_SEM_ESCRITA_ABORTA}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const alerta =
        !planMode && voltasSemEscrita >= VOLTAS_SEM_ESCRITA_DECISAO
          ? ` — you have spent ${voltasSemEscrita} turns WITHOUT changing a single file, and this run stops at ${VOLTAS_SEM_ESCRITA_ABORTA}. Decide NOW: make the first real change with what you already know${podeDividir ? `, or call dividir_em_partes so the user approves a split before more of their prompt is spent` : ''}. Another turn of only reading gets you closer to delivering nothing.`
          : '';
      const cortada = result.cortada
        ? ' — your previous reply hit the output limit and was CUT OFF: only the calls above ran, the rest was lost. Never rewrite a whole file or send large content in one call: use edit_file with small old_string/new_string, or write a big file in parts.'
        : '';
      const removidos = aplicarOrcamento(i);
      const enxugou = removidos.length
        ? ` — to keep this conversation fast, older results were removed from it: ${removidos.slice(0, 8).join(', ')}${removidos.length > 8 ? ', …' : ''}. Search or re-read only what you still need.`
        : '';
      const ultimo = outputs[outputs.length - 1];
      ultimo.output = `${ultimo.output}\n\n[GeckoAI] ${placar}${alerta}${cortada}${enxugou}`;

      try {
        result = await session.reply(outputs, signal);
      } catch (err) {
        // O provedor não pode continuar AGORA, mas o que já foi preparado vale:
        // limite do ChatGPT do cliente, resposta cortada, e também QUALQUER
        // queda no meio — o relógio de 120 s do proxy, fluxo cortado, 5xx/546,
        // rede do celular. Até 2026-09-26 só os erros marcados `retomavel`
        // guardavam; os outros jogavam fora todas as etapas já pagas (achado
        // por seis revisores independentes). Sai pelo caminho das travas, que
        // guarda o trabalho (sem nada guardado, o erro sobe como veio). Não
        // guarda: cancelamento do usuário, chave presa em outro computador
        // (o painel precisa do botão dele) e o Plan, que é só leitura.
        if (planMode || err?.name === 'AbortError' || err?.deviceConflito) throw err;
        // A IA já tinha terminado: mensagem de commit aceita e nada mudou
        // depois dela — só faltava o resumo. Guardar o trabalho pronto atrás
        // de um "Continuar" pago seria cobrar para enviar o que já está feito:
        // segue para o commit (a conferência de imports do fim continua valendo).
        if (commitMessage && !mudouDesdeMensagem && staged.size) {
          finalText = '';
          break;
        }
        interrompido = {
          trava: `provider stopped: ${err?.codigo || err?.name || 'error'}`,
          mensagem: err?.message || 'A conexão com a IA caiu no meio do pedido.',
          erro: err,
        };
        break;
      }
    }
  } catch (err) {
    // O plano criado NESTE run morreria com o erro — e o usuário já aprovou
    // gastar nele. Vai junto, para a UI oferecer "tentar de novo".
    if (planoAtual && err && typeof err === 'object' && !err.plano) err.plano = planoAtual;
    throw err;
  }

  if (planMode) {
    return { steps, summary: finalText, commit: null, pendingMigration: null, plano: null, bancoAlterado: false };
  }

  // Escreveu algo depois do set_commit_message e quebrou um import: commitar
  // deixaria o app do cliente com a tela em branco. Não envia — mas também
  // não joga fora: o conserto costuma ser uma linha, e o trabalho pago fica
  // guardado para a continuação (que recebe o motivo) terminar.
  if (!interrompido) {
    const quebradosNoFim = importsQuebrados();
    if (quebradosNoFim.length) {
      const lista = quebradosNoFim.map((q) => `${q.path} (${q.specs.join(', ')})`).join('; ');
      interrompido = {
        trava: `it left imports that do not resolve: ${lista} — fix them first`,
        mensagem: `A IA terminou com um import que não existe no projeto (${lista}); enviar deixaria a tela em branco no Lovable.`,
      };
    }
  }

  // Diagnóstico do run, para o dono medir depois (fica no histórico do
  // cliente, como o rastro do desfazer): dá para saber se é laço ou tarefa
  // grande de verdade sem pedir DevTools a ninguém.
  const diagnostico = {
    voltas: voltasDadas,
    lidos: examinados.size,
    arquivos: staged.size,
    semEscrita: voltasSemEscrita,
    escritas: voltasComEscrita,
    trava: interrompido?.trava || null,
    // O que mede a busca, a leitura por trecho e o orçamento de contexto.
    ...contagem,
    contexto: [...vivos.values()].reduce((s, v) => s + v.tam, 0),
    // Skills que a IA carregou neste run: mede se o índice faz ela ler a
    // skill certa, e só quando o pedido é do tema.
    skills: [...skillsLidas],
  };

  // O trabalho guardado para a próxima rodada: arquivos preparados, o SQL do
  // banco (proposto ou já aplicado — sem isso a rodada 2 commitava o frontend
  // sem a migração e oferecia "desfazer" num envio que mexeu no banco) e os
  // anexos ainda não salvos (a rodada 2 não recebia anexo nenhum, e o PDF
  // pedido nunca chegava ao commit).
  async function guardarTrabalho(motivo, extra = {}) {
    emit({ type: 'phase', text: 'Guardando o que já ficou pronto…' });
    // A ponta de onde o run partiu (ver baseInicial); só sem ela, a de agora.
    let baseSha = baseInicial;
    if (!baseSha) {
      try {
        baseSha = (await github.getHead?.(owner, repo, branch, signal)) || null;
      } catch { baseSha = null; }
    }
    // TODOS os anexos, com o caminho dos já salvos: se a próxima rodada
    // descartar o rascunho (projeto mudou), o salvo volta a ser anexo.
    const todosAnexos = anexos.map((a) => {
      const { daRodadaAnterior: _r, ...f } = a;
      return anexosSalvos.has(a) ? { ...f, salvoEm: anexosSalvos.get(a) } : f;
    });
    return {
      changes: [...staged.entries()],
      feitos: [...staged.keys()],
      message: buildCommitMessage(commitMessage, prompt),
      baseSha,
      motivo,
      teto: false,
      escritas: voltasComEscrita,
      ...(pendingSql ? { sqlPendente: pendingSql } : {}),
      ...(resumoPendente ? { resumoSqlPendente: resumoPendente } : {}),
      ...(sqlAplicados.length ? { sqlAplicados: [...sqlAplicados] } : {}),
      ...(sqlRodados.length ? { sqlRodados: [...sqlRodados] } : {}),
      ...(sqlExecutados ? { sqlExecutados } : {}),
      ...(todosAnexos.length ? { anexos: todosAnexos } : {}),
      // Memória para a próxima rodada: o que esta já examinou (ela recomeçava
      // a exploração do zero e pagava de novo pelas mesmas leituras) e como a
      // IA resumiu o próprio trabalho.
      lidos: [...examinados].filter((p) => !staged.has(p)).slice(0, 60),
      ...(commitMessage ? { mensagemDaIA: commitMessage } : {}),
      ...extra,
    };
  }

  if (interrompido) {
    // Nada preparado (nem arquivo, nem SQL no banco): não há o que guardar,
    // o run morre e o projeto do cliente fica intacto.
    if (!staged.size && !pendingSql && !sqlAplicados.length && !sqlRodados.length) {
      // O provedor parou: o erro dele sobe como veio. "Peça uma parte por vez"
      // não serve para limite de assinatura — o painel usa o `codigo` e o
      // `limite` para oferecer "usar os prompts neste envio".
      if (interrompido.erro) {
        interrompido.erro.diagnostico = diagnostico;
        if (planoAtual && !interrompido.erro.plano) interrompido.erro.plano = planoAtual;
        throw interrompido.erro;
      }
      const err = new AgentError(
        `${interrompido.mensagem} Nada foi enviado ao seu projeto. Tente pedir uma parte por vez.`
      );
      err.trava = interrompido.trava;
      err.diagnostico = diagnostico;
      if (planoAtual) err.plano = planoAtual;
      throw err;
    }
    // Decisão do dono (2026-09-23): NADA vai para o GitHub pela metade. O que
    // a IA preparou fica guardado no histórico, e continuar custa 1 prompt —
    // no fim sai um commit só, com tudo junto.
    return {
      steps,
      summary: finalText,
      commit: null,
      pendingMigration: null,
      pendingWork: await guardarTrabalho(interrompido.mensagem, {
        // A rodada acabou no teto de etapas E mudou arquivos: dá para seguir
        // (o painel decide se sozinho ou pelo botão).
        teto: interrompido.teto === true,
        // Motivo mecânico (em inglês): a continuação começa por ele.
        trava: interrompido.trava,
        // Parou por causa do provedor (limite/acesso do ChatGPT do cliente,
        // resposta cortada, queda): o cartão usa o código.
        ...(interrompido.erro
          ? { codigo: interrompido.erro.codigo || null, limite: interrompido.erro.limite || null }
          : {}),
      }),
      plano: planoAtual,
      bancoAlterado: sqlExecutados > 0 || sqlAplicados.length > 0,
      diagnostico,
    };
  }

  const message = buildCommitMessage(commitMessage, prompt);
  // "Desfazer último prompt" só é oferecido para run que NÃO mexeu no banco:
  // voltar o código e deixar a tabela nova quebraria o app. Quem sabe é o
  // agente — escrita via run_sql, SQL aplicado no Lovable Cloud ou migração
  // pendente (que o usuário vai aplicar à mão).
  const bancoAlterado = sqlExecutados > 0 || sqlAplicados.length > 0;

  // A IA insistiu no commit com tela que ninguém importa: o usuário precisa
  // saber, senão abre o preview procurando o que não vai estar lá.
  const orfasNoFim = telasOrfas();
  if (orfasNoFim.length) {
    finalText = `${finalText}${finalText ? '\n\n' : ''}Atenção: ${orfasNoFim
      .map((p) => `"${p}"`)
      .join(', ')} ${orfasNoFim.length > 1 ? 'foram criados' : 'foi criado'} mas ainda não ${
      orfasNoFim.length > 1 ? 'aparecem' : 'aparece'
    } em nenhuma tela do projeto.`;
  }

  // Anexo que a IA não salvou vai para public/<nome seguro>: o usuário anexou
  // para o arquivo ENTRAR no projeto, e um run que termina sem ele seria um
  // prompt pago com o arquivo perdido. O resumo avisa onde ficou.
  // Só o que a IA NÃO vê (PDF, vídeo, fonte, zip): imagem e texto ela viu, e
  // não salvar é decisão dela — quase sempre é o print do problema, que não
  // pode ir parar no site (pedidos do dono em 2026-09-26).
  const esquecidos = anexos.filter((f) => !anexosSalvos.has(f) && f.vistoPelaIA !== true);
  if (esquecidos.length) {
    const notas = [];
    for (const f of esquecidos) {
      let path = `public/${nomeSeguro(f.name)}`;
      // Dois nomes podem virar o mesmo caminho seguro: não sobrescreve.
      for (let n = 2; staged.has(path); n++) path = `public/${sufixar(nomeSeguro(f.name), n)}`;
      staged.set(path, { base64: f.base64, size: f.size });
      anexosSalvos.set(f, path); // já está no staged: o trabalho guardado não o conta de novo
      step('save', path);
      notas.push(`"${f.name}" foi salvo automaticamente em ${path}.`);
    }
    finalText = `${finalText}${finalText ? '\n\n' : ''}${notas.join(' ')}`;
  }

  // SQL aplicado durante o run (Lovable Cloud automático): o registro vai
  // no mesmo commit, como no caminho manual — só muda o "como". Vem ANTES do
  // desvio da migração manual: com um SQL aplicado e outro caído na reserva,
  // o aplicado sumia do registro (o commit da migração manual levava só o
  // outro).
  // Registro já no rascunho (a rodada anterior montou e o GitHub recusou o
  // commit): não registra de novo — sairiam dois arquivos com o mesmo SQL.
  const registroJaNoStaged = [...staged.entries()].some(
    ([p, st]) => p.startsWith('docs/migrations/') && typeof st.content === 'string'
      && sqlAplicados.every((sql) => st.content.includes(String(sql).trim()))
  );
  if (sqlAplicados.length > 0 && !registroJaNoStaged) {
    staged.set(migrationPath(message, pendingSql ? 'aplicada' : ''), {
      content: migrationRecord(
        sqlAplicados.join('\n\n'),
        message,
        'Aplicada no Lovable Cloud pela extensão, com autorização do usuário.'
      ),
    });
  }

  // Supabase externo: o schema que a IA mudou com run_sql vira um arquivo de
  // migração em supabase/migrations/ (o lugar que a Lovable lê), escrito aqui
  // — com o SQL que de fato rodou, na ordem. Só o que ainda não está em
  // nenhum arquivo de migração do rascunho (escrito pela IA nesta rodada ou
  // na anterior, ou o nosso de um commit que o GitHub recusou): nada
  // duplicado, e nada perdido quando a IA escreveu o dela cedo e rodou mais
  // SQL depois (revisão adversarial).
  const migracoesDoRascunho = [...staged.entries()]
    .filter(([p, st]) => p.startsWith('supabase/migrations/') && !noRepositorio.has(p) && typeof st.content === 'string')
    .map(([, st]) => normalizarSql(st.content));
  const faltamNaMigracao = sqlRodados.filter((sql) => !migracoesDoRascunho.some((c) => c.includes(normalizarSql(sql))));
  if (faltamNaMigracao.length > 0) {
    staged.set(`supabase/migrations/${carimboUtc()}_${slugify(semPrefixo(message))}.sql`, {
      content: migrationRecord(
        faltamNaMigracao.map((s) => `${String(s).trim().replace(/;\s*$/, '')};`).join('\n\n'),
        message,
        'Executada no banco do projeto (Supabase) pela extensão, durante o pedido.'
      ),
    });
  }

  // Modo Lovable Cloud: há um SQL para o usuário aplicar. Não commita agora —
  // devolve a migração + as mudanças preparadas; a UI faz o handoff e, após o
  // usuário confirmar que rodou o SQL, chama commitMigration para enviar tudo.
  if (pendingSql) {
    emit({ type: 'phase', text: 'Migração pronta — aguardando você aplicar…' });
    return {
      steps,
      summary: finalText,
      commit: null,
      pendingMigration: {
        sql: pendingSql,
        ...(resumoPendente ? { resumo: resumoPendente } : {}),
        isDestructive: isDestructiveSql(pendingSql),
        message,
        changes: [...staged.entries()],
        // De onde o frontend partiu: o "Já apliquei" pode vir dias depois.
        baseSha: baseInicial,
      },
      plano: planoAtual,
      bancoAlterado: true,
    };
  }

  let commit = null;
  if (staged.size > 0) {
    emit({ type: 'phase', text: 'Enviando commit para o GitHub…' });
    // Quando chegamos aqui o trabalho da IA já foi feito E pago — um soluço
    // do GitHub (5xx, corrida de árvore 409, queda de rede, a ponta andando
    // entre ler e gravar o branch) não pode jogar o run fora. Erro que não se
    // resolve repetindo (permissão, validação) também não: o trabalho fica
    // guardado, e o cartão oferece enviar de novo sem gastar prompt.
    let result2;
    // Ponta sobre a qual a tentativa anterior montou: se ela chegou ao GitHub
    // e só a resposta se perdeu, a próxima a reconhece em vez de duplicar.
    let baseDaAnterior = null;
    for (let tentativa = 1; ; tentativa++) {
      const opcoes = baseDaAnterior ? { adotarSeFilhoDe: baseDaAnterior } : {};
      try {
        result2 = await github.commitChanges(
          owner,
          repo,
          branch,
          staged,
          `${message}\n\nFeito com ${MARCA.nome} a pedido do usuário.`,
          signal,
          opcoes
        );
        break;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // 422 "not a fast forward": alguém commitou entre ler e gravar o
        // branch; a nova tentativa relê a ponta e monta em cima dela.
        const naoFastForward = err?.status === 422 && /fast.?forward/i.test(String(err?.message || ''));
        const transitorio = err?.status == null || err.status >= 500 || err.status === 409 || naoFastForward;
        if (!transitorio || tentativa >= 3) {
          return {
            steps,
            summary: finalText,
            commit: null,
            pendingMigration: null,
            pendingWork: await guardarTrabalho(`O GitHub recusou o envio: ${err?.message || 'erro desconhecido'}`, {
              codigo: 'commit',
              status: err?.status ?? null,
              trava: `the GitHub commit failed: ${err?.message || 'unknown error'}`,
            }),
            plano: planoAtual,
            bancoAlterado,
            diagnostico,
          };
        }
        baseDaAnterior = opcoes.baseUsada || baseDaAnterior;
        emit({ type: 'phase', text: `O GitHub falhou — tentando o commit de novo (${tentativa + 1}/3)…` });
        await new Promise((r) => setTimeout(r, 1500 * tentativa));
      }
    }
    // null: só havia deleção de caminho que não existe no GitHub — nada a enviar.
    if (result2) {
      commit = {
        sha: result2.sha,
        url: result2.url,
        message,
        files: [...staged.keys()],
      };
      emit({ type: 'commit', ...commit });
    }
  }

  // O diagnóstico vai também no run que deu certo: é o que mede, com pedidos
  // reais, se a busca e o orçamento de contexto estão funcionando.
  return { steps, summary: finalText, commit, pendingMigration: null, plano: planoAtual, bancoAlterado, diagnostico };
}
