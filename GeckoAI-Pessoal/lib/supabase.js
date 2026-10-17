// Cliente da Management API do Supabase (token pessoal de acesso).
// Permite listar os projetos da conta e executar SQL no Postgres do projeto —
// é assim que o GeckoAI altera o banco de dados quando conectado.

const API = 'https://api.supabase.com/v1';

export class SupabaseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
  }
}

function friendly(status, data) {
  const apiMsg = data?.message;
  if (status === 401) return 'Sua conexão com o Supabase expirou. Conecte de novo em Configurações.';
  if (status === 403) return 'A conta conectada do Supabase não tem acesso a este projeto.';
  if (status === 404) return 'Projeto não encontrado na conta conectada do Supabase.';
  if (status === 429) return 'Limite de requisições do Supabase atingido. Tente em instantes.';
  if (status >= 500) return 'Erro temporário na API do Supabase. Tente novamente.';
  return apiMsg || `Erro na API do Supabase (${status}).`;
}

export class Supabase {
  constructor(token) {
    this.token = token;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new SupabaseError(friendly(res.status, data), res.status);
    return data;
  }

  // Projetos da conta: [{ id (ref), name, ... }]
  listProjects(signal) {
    return this.request('/projects', { signal });
  }

  // Organizações da conta: [{ id, name }].
  listOrganizations(signal) {
    return this.request('/organizations', { signal });
  }

  // Cria um projeto novo na conta do usuário. Devolve { id } — o id É o ref.
  // Região padrão: São Paulo. O projeto demora ~1-2 min para ficar pronto
  // (acompanhar com getProjectStatus até 'ACTIVE_HEALTHY').
  createProject({ name, organizationId, dbPass, region = 'sa-east-1' }, signal) {
    return this.request('/projects', {
      method: 'POST',
      signal,
      body: { name, organization_id: organizationId, db_pass: dbPass, region },
    });
  }

  // Status do projeto: 'COMING_UP' | 'ACTIVE_HEALTHY' | ... (ou null).
  async getProjectStatus(ref, signal) {
    const p = await this.request(`/projects/${encodeURIComponent(ref)}`, { signal });
    return p?.status || null;
  }

  // Executa SQL no Postgres do projeto. Retorna as linhas (SELECT) ou [] (DDL).
  runQuery(ref, sql, signal) {
    return this.request(`/projects/${encodeURIComponent(ref)}/database/query`, {
      method: 'POST',
      signal,
      body: { query: sql },
    });
  }

  // Credenciais PÚBLICAS do projeto para o frontend: URL + chave anon/publishable.
  // Nunca retorna a chave secreta (service role) — só o que é seguro commitar (RLS protege).
  async getPublicCredentials(ref, signal) {
    const keys = await this.request(
      `/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`,
      { signal }
    );
    const list = Array.isArray(keys) ? keys : [];
    const pick =
      list.find((k) => k.type === 'publishable') ||
      list.find((k) => k.name === 'anon' && k.type !== 'secret');
    if (!pick?.api_key) {
      throw new SupabaseError('Não encontrei a chave pública (anon) deste projeto.', 404);
    }
    return { url: `https://${ref}.supabase.co`, anonKey: pick.api_key };
  }
}

// O campo da extensão espera o token PESSOAL da Management API (sbp_...).
// Chaves do projeto (anon/service role, formato JWT) não servem aqui.
export function isManagementToken(token) {
  return /^sbp_[A-Za-z0-9_]{20,}$/.test(String(token || '').trim());
}

// Uma consulta é somente-leitura? (usado para travar o modo Plan)
export function isReadOnlySql(sql) {
  const s = String(sql)
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .toLowerCase();
  if (!/^(select|with|show|explain)\b/.test(s)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(s);
}

// Contém algum comando destrutivo? (usado para avisar antes de aplicar uma
// migração: DROP, TRUNCATE, DELETE/UPDATE sem WHERE, ALTER ... DROP ...).
// Heurística conservadora: na dúvida, prefere avisar.
export function isDestructiveSql(sql) {
  const clean = String(sql)
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const raw of clean.split(';')) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    // Só o que APAGA DADOS. A lista antiga incluía policy/index/trigger/
    // view, e com isso o padrão idempotente normal — "drop policy if
    // exists X; create policy X" — disparava "pode apagar dados" numa
    // migração de rotina. Alarme que toca à toa é alarme que o usuário
    // aprende a ignorar, e num produto para leigo ele só assusta. Objeto
    // recriado na linha seguinte (policy, índice, gatilho, visão, função,
    // constraint) não perde uma linha de dado sequer.
    if (/\bdrop\s+(table|schema|database)\b/.test(s)) return true;
    if (/\balter\s+table\b[\s\S]*\bdrop\s+column\b/.test(s)) return true;
    if (/\btruncate\b/.test(s)) return true;
    if (/^(delete|update)\b/.test(s) && !/\bwhere\b/.test(s)) return true;
  }
  return false;
}
