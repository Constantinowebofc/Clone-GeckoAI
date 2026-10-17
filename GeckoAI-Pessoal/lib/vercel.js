// Cliente da API da Vercel (token pessoal do usuário — fica só neste navegador,
// como o token do GitHub). Usado para: criar o projeto ligado ao repositório,
// descobrir o projeto de um repositório e acompanhar o último deploy (preview).

const API = 'https://api.vercel.com';

export class VercelError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VercelError';
    this.status = status;
  }
}

function friendly(status, data) {
  const apiMsg = data?.error?.message;
  if (status === 401 || status === 403)
    return 'Sua conexão com a Vercel expirou. Conecte de novo em Configurações.';
  if (status === 404) return 'Projeto não encontrado na conta conectada da Vercel.';
  if (status === 429) return 'Limite de requisições da Vercel atingido. Tente em instantes.';
  if (status >= 500) return 'Erro temporário na API da Vercel. Tente novamente.';
  return apiMsg || `Erro na API da Vercel (${status}).`;
}

export class Vercel {
  constructor(token, teamId = null) {
    this.token = token;
    // Integração instalada num TIME da Vercel: a API só enxerga os projetos
    // do time se toda chamada levar o teamId. Instalação pessoal: null.
    this.teamId = teamId;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const url = new URL(`${API}${path}`);
    if (this.teamId) url.searchParams.set('teamId', this.teamId);
    const res = await fetch(url.toString(), {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new VercelError(friendly(res.status, data), res.status);
    return data;
  }

  // Valida o token e identifica a conta. -> { user: { username, ... } }
  getUser(signal) {
    return this.request('/v2/user', { signal });
  }

  // Projeto da Vercel ligado a um repositório do GitHub (ou null).
  async findProjectByRepo(fullName, signal) {
    const repoUrl = encodeURIComponent(`https://github.com/${fullName}`);
    const data = await this.request(`/v9/projects?repoUrl=${repoUrl}`, { signal });
    return data?.projects?.[0] || null;
  }

  // Cria um projeto ligado ao repositório — todo push vira deploy automático.
  // Exige o app do GitHub da Vercel instalado na conta com acesso ao repo;
  // sem ele a API recusa e o fluxo cai no import manual (vercel.com/new).
  createProject(name, repoFullName, signal) {
    return this.request('/v10/projects', {
      method: 'POST',
      signal,
      body: {
        name,
        framework: 'vite',
        gitRepository: { type: 'github', repo: repoFullName },
      },
    });
  }

  // Último deploy de produção: { uid, state, url, createdAt } ou null.
  // state: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED'.
  async latestDeployment(projectId, signal) {
    const data = await this.request(
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1`,
      { signal }
    );
    const d = data?.deployments?.[0];
    if (!d) return null;
    return {
      uid: d.uid,
      state: d.state || d.readyState || null,
      url: d.url ? `https://${d.url}` : null,
      createdAt: d.createdAt ?? 0,
    };
  }
}

// Domínio padrão (estável) do site publicado.
export function defaultSiteUrl(projectName) {
  return `https://${projectName}.vercel.app`;
}
