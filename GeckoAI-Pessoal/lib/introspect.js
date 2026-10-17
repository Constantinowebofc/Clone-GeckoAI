// Introspeção do banco (Lovable Cloud): um único SELECT, 100% leitura, que o
// usuário roda no editor de SQL do Lovable. O resultado (um JSON) vira o retrato
// do schema em docs/DB_SCHEMA.json — é assim que a IA entende o banco de verdade
// sem precisar de acesso direto (que o Lovable Cloud não fornece).

export const INTROSPECT_SQL = `select jsonb_pretty(jsonb_build_object(
  'gerado_em', now(),

  'tabelas', (
    select coalesce(jsonb_agg(x.obj order by x.obj->>'tabela'), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'tabela', c.table_name,
        'colunas', jsonb_agg(jsonb_build_object(
          'nome', c.column_name,
          'tipo', c.data_type,
          'tipo_udt', c.udt_name,
          'nulo', c.is_nullable,
          'default', c.column_default
        ) order by c.ordinal_position)
      ) as obj
      from information_schema.columns c
      where c.table_schema = 'public'
      group by c.table_name
    ) x
  ),

  'chaves_primarias', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', tc.table_name, 'coluna', kcu.column_name) order by tc.table_name), '[]'::jsonb)
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
  ),

  'chaves_estrangeiras', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', tc.table_name,
      'coluna', kcu.column_name,
      'referencia', ccu.table_name || '.' || ccu.column_name) order by tc.table_name), '[]'::jsonb)
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  ),

  'rls_ativo', (
    select coalesce(jsonb_object_agg(c.relname, c.relrowsecurity), '{}'::jsonb)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ),

  'policies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', tablename,
      'policy', policyname,
      'permissiva', permissive,
      'roles', roles,
      'comando', cmd,
      'using', qual,
      'with_check', with_check) order by tablename, policyname), '[]'::jsonb)
    from pg_policies
    where schemaname = 'public'
  ),

  'enums', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'nome', t.typname,
      'valores', (select jsonb_agg(e.enumlabel order by e.enumsortorder)
                  from pg_enum e where e.enumtypid = t.oid)) order by t.typname), '[]'::jsonb)
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and n.nspname = 'public'
  ),

  'funcoes', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'nome', p.proname,
      'argumentos', pg_get_function_arguments(p.oid),
      'retorno', pg_get_function_result(p.oid),
      'definicao', pg_get_functiondef(p.oid)) order by p.proname), '[]'::jsonb)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  ),

  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tabela', event_object_table,
      'trigger', trigger_name,
      'quando', action_timing,
      'evento', event_manipulation,
      'acao', action_statement) order by event_object_table, trigger_name), '[]'::jsonb)
    from information_schema.triggers
    where trigger_schema = 'public'
  ),

  'triggers_auth_users', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'trigger', trigger_name,
      'quando', action_timing,
      'evento', event_manipulation,
      'acao', action_statement) order by trigger_name), '[]'::jsonb)
    from information_schema.triggers
    where event_object_schema = 'auth' and event_object_table = 'users'
  ),

  'contagem_linhas', (
    select coalesce(jsonb_object_agg(relname, n_live_tup), '{}'::jsonb)
    from pg_stat_user_tables
    where schemaname = 'public'
  )
));`;

// Aceita o valor colado pelo usuário — o JSON puro OU o conteúdo do CSV exportado
// (que embrulha a célula em aspas e duplica as aspas internas). Devolve o JSON
// já validado e formatado, pronto para virar docs/DB_SCHEMA.json.
// A mesma consulta, sem a formatação do jsonb_pretty, para o retrato
// AUTOMÁTICO pela aba do Lovable (lib/lovable.js). A API corta resposta
// grande, e sem os espaços cabe bem mais banco; resposta cortada não passa no
// parseSchemaPaste e o painel cai no passo a passo manual.
export const INTROSPECT_SQL_COMPACTO = INTROSPECT_SQL
  .replace(/^select jsonb_pretty\(/, 'select (')
  .replace(/\)\);\s*$/, '))::text as retrato');

export function parseSchemaPaste(raw) {
  // Tira BOM (arquivos CSV às vezes têm) e espaços das bordas.
  let t = String(raw || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('Cole o resultado do SQL (o JSON) antes de salvar.');

  // Remove o cabeçalho "jsonb_pretty" quando o CSV veio com ele (primeira linha).
  const lines = t.split(/\r?\n/);
  if (
    lines.length > 1 &&
    lines[0].trim().replace(/^"|"$/g, '').toLowerCase() === 'jsonb_pretty'
  ) {
    t = lines.slice(1).join('\n').trim();
  }

  // Célula de CSV: vem entre aspas duplas, com aspas internas duplicadas ("").
  if (t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).replace(/""/g, '"').trim();
  }

  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    throw new Error(
      'Não reconheci um JSON válido. Cole o valor da coluna "jsonb_pretty" (ou o conteúdo do CSV exportado).'
    );
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('O conteúdo colado não parece o retrato do schema.');
  }
  return JSON.stringify(obj, null, 2);
}
