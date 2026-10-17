// Cliente da API REST do GitHub (autenticação via Personal Access Token).

import { MARCA } from './marca.js';

const API = 'https://api.github.com';
// Quantos blobs o commit cria ao mesmo tempo (ver commitChanges). Um run
// comum tem poucos arquivos e vai de uma vez.
const BLOBS_POR_VEZ = 8;

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export class GitHub {
  constructor(token) {
    this.token = token;
    // Escopos do token clássico, capturados do cabeçalho x-oauth-scopes que o
    // GitHub devolve em toda resposta. Token fine-grained NÃO manda o
    // cabeçalho — fica null, que significa "desconhecido", não "sem escopo".
    this.oauthScopes = null;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      signal,
      // Sem cache HTTP. O GitHub responde `Cache-Control: private, max-age=60`
      // e o Chrome obedece no fetch: por até 60 s depois de um commit, a ponta
      // do branch vinha da consulta ANTERIOR ao commit. O desfazer comparava
      // com ela e acusava "o projeto mudou" em 9 ms (visto no teste do dono,
      // 2026-09-13), e um segundo envio em menos de um minuto partiria de base
      // velha. Estado do repositório tem de ser sempre o de agora.
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const escopos = res.headers.get('x-oauth-scopes');
    if (escopos !== null) this.oauthScopes = escopos;

    if (res.status === 204) return null;

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* corpo vazio */
    }

    if (!res.ok) {
      const msg =
        res.status === 401
          ? 'Sua conexão com o GitHub expirou. Conecte de novo em Configurações.'
          : res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
            ? 'Limite de requisições do GitHub atingido. Tente novamente em alguns minutos.'
            : res.status === 404
              ? 'Recurso não encontrado no GitHub (confira a conexão em Configurações).'
              : (data && data.message) || `Erro do GitHub (${res.status}).`;
      throw new GitHubError(msg, res.status);
    }
    return data;
  }

  // ---- Conta ----

  getUser() {
    return this.request('/user');
  }

  async getUserCached() {
    if (!this._user) this._user = await this.getUser();
    return this._user;
  }

  // O token clássico tem este escopo? true/false — ou null quando não dá para
  // saber (token fine-grained não expõe escopos). A UI usa para explicar uma
  // lista de repositórios vazia: sem `repo`, o GitHub só mostra os públicos.
  temEscopo(escopo) {
    if (this.oauthScopes == null) return null;
    return this.oauthScopes.split(',').map((s) => s.trim()).includes(escopo);
  }

  // Repositórios da conta, mais recentes primeiro (até 300).
  async listRepos() {
    const all = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.request(
        `/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`
      );
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  // Cria um repositório na conta do usuário, já com o commit inicial
  // (auto_init) — o commit atômico precisa de um commit-base para existir.
  createRepo(name, { isPrivate = true, description = '' } = {}, signal) {
    return this.request('/user/repos', {
      method: 'POST',
      signal,
      body: {
        name,
        private: isPrivate,
        description,
        auto_init: true,
        has_wiki: false,
        has_projects: false,
      },
    });
  }

  listBranches(owner, repo) {
    return this.request(`/repos/${owner}/${repo}/branches?per_page=100`);
  }

  getRepo(owner, repo) {
    return this.request(`/repos/${owner}/${repo}`);
  }

  // ---- Leitura do projeto ----

  // Árvore completa de arquivos do branch. Retorna { files: [{path, size}], truncated }.
  async getTree(owner, repo, branch, signal) {
    const data = await this.request(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { signal }
    );
    const files = (data.tree || [])
      .filter((e) => e.type === 'blob')
      // sha: chave do cache da busca no código (mesmo conteúdo, mesmo sha).
      .map((e) => ({ path: e.path, size: e.size ?? 0, ...(e.sha ? { sha: e.sha } : {}) }));
    return { files, truncated: Boolean(data.truncated) };
  }

  async readFile(owner, repo, branch, path, signal) {
    const data = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      { signal }
    );
    if (Array.isArray(data)) {
      throw new GitHubError(`"${path}" é um diretório, não um arquivo.`, 400);
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new GitHubError(`Não foi possível ler o conteúdo de "${path}".`, 500);
    }
    return decodeBase64Utf8(data.content);
  }

  // Conteúdo EXATO de um sha da árvore (o agente lê assim quando sabe o sha):
  // é o que deixa o cache da busca guardar por sha sem risco de conteúdo de
  // outra versão — pelo nome do branch, um commit no meio mudaria o conteúdo.
  async readBlob(owner, repo, sha, signal) {
    const data = await this.request(`/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`, { signal });
    if (data?.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new GitHubError('Não foi possível ler o conteúdo do arquivo.', 500);
    }
    return decodeBase64Utf8(data.content);
  }

  // Ponta do branch agora. Usado para guardar trabalho preparado e não
  // commitado: se a ponta mudou quando o usuário for continuar, o projeto
  // andou (a Lovable commitou algo) e o rascunho apagaria o que veio depois.
  async getHead(owner, repo, branch, signal) {
    const ref = await this.request(
      `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
      { signal }
    );
    return ref?.object?.sha || null;
  }

  // ---- Escrita: um único commit atômico com todas as mudanças ----
  // changes: Map<path, {content: string} | {base64: string} | {deleted: true}>
  // Devolve {sha, url}, ou null quando não sobra nada a enviar (só deleções de
  // caminhos que não existem, ou conteúdo igual ao que já está lá) — nenhum
  // commit vazio é criado.
  // `opts`: quem tenta de novo (o laço do agente) recebe em `opts.baseUsada`
  // a ponta sobre a qual esta tentativa montou, e passa na seguinte como
  // `adotarSeFilhoDe`. Só assim a ponta atual pode ser reconhecida como a
  // tentativa anterior que chegou lá (o GitHub gravou e a resposta se perdeu)
  // — sem essa prova, "mesma árvore e mesma mensagem" também casava com o
  // envio ANTERIOR do usuário, e o desfazer deste apagaria aquele.
  async commitChanges(owner, repo, branch, changes, message, signal, opts = {}) {
    const ref = await this.request(
      `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
      { signal }
    );
    const baseCommitSha = ref.object.sha;
    opts.baseUsada = baseCommitSha;

    const baseCommit = await this.request(
      `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`,
      { signal }
    );
    const tentativaAnteriorChegou = () =>
      Boolean(opts.adotarSeFilhoDe)
      && baseCommit.parents?.[0]?.sha === opts.adotarSeFilhoDe
      && baseCommit.message === message;
    const aPonta = () => ({ sha: baseCommitSha, url: `https://github.com/${owner}/${repo}/commit/${baseCommitSha}` });

    // sha:null num caminho que NÃO está na árvore-base faz o GitHub recusar a
    // árvore inteira com GitRPC::BadObjectState — nada é commitado e o trabalho
    // pago do run se perde (2026-08-30 e 2026-09-26, dois caminhos diferentes
    // até aqui). Apagar o que não existe é nada: sai da lista. Árvore
    // truncada (repositório gigante) não diz o que existe — aí vai como veio.
    let naBase = null;
    if ([...changes.values()].some((c) => c.deleted)) {
      const base = await this.request(
        `/repos/${owner}/${repo}/git/trees/${baseCommit.tree.sha}?recursive=1`,
        { signal }
      );
      if (!base?.truncated) {
        naBase = new Set((base?.tree || []).filter((e) => e.type === 'blob').map((e) => e.path));
      }
    }

    const entriesToCreate = [];
    const treeEntries = [];
    for (const [path, change] of changes) {
      if (change.deleted) {
        if (naBase && !naBase.has(path)) continue;
        treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
      } else {
        entriesToCreate.push({ path, change });
      }
    }
    if (!treeEntries.length && !entriesToCreate.length) return tentativaAnteriorChegou() ? aPonta() : null;

    // `opts.textoNaArvore` (instalar uma skill, lib/skills.js — dezenas de
    // arquivos de texto num commit só): o texto vai DENTRO da entrada da
    // árvore (`content`), e o próprio GitHub grava o blob. A instalação da
    // maior skill cai de 53 escritas para 3; com um blob por arquivo, as cinco
    // skills em seguida encostavam no limite de escritas por minuto do GitHub,
    // e o commit de um pedido PAGO logo depois podia ser recusado. Só quem
    // pede usa: o commit de um run comum segue pelo caminho de sempre.
    const naArvore = (change) =>
      opts.textoNaArvore === true && change.base64 == null && typeof change.content === 'string' && change.content.length > 0;

    // Os demais viram blobs, em paralelo mas no máximo BLOBS_POR_VEZ ao mesmo
    // tempo. No primeiro erro ninguém começa outro envio: insistir é o que
    // prolonga um limite do GitHub (e nada fica pela metade — sem árvore não
    // há commit).
    const created = new Array(entriesToCreate.length);
    const fila = [];
    entriesToCreate.forEach(({ path, change }, i) => {
      if (naArvore(change)) created[i] = { path, mode: '100644', type: 'blob', content: change.content };
      else fila.push(i);
    });
    let proximo = 0;
    let falhou = false;
    const criar = async () => {
      while (!falhou && proximo < fila.length) {
        const i = fila[proximo++];
        const { path, change } = entriesToCreate[i];
        try {
          const blob = await this.request(`/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST',
            signal,
            body: change.base64 != null
              ? { content: change.base64, encoding: 'base64' }
              : { content: change.content, encoding: 'utf-8' },
          });
          created[i] = { path, mode: '100644', type: 'blob', sha: blob.sha };
        } catch (err) {
          falhou = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOBS_POR_VEZ, fila.length) }, criar));
    treeEntries.push(...created);

    const newTree = await this.request(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      signal,
      body: { base_tree: baseCommit.tree.sha, tree: treeEntries },
    });

    // A árvore não mudou: nada de commit vazio. Se a ponta é a nossa
    // tentativa anterior (ver `opts`), devolve ela em vez de duplicar.
    if (newTree?.sha && newTree.sha === baseCommit.tree.sha) {
      return tentativaAnteriorChegou() ? aPonta() : null;
    }

    // Autor "GeckoAI" identifica a extensão no Lovable e no GitHub;
    // o committer continua sendo a conta do usuário (dona do token).
    const author = { name: MARCA.nome, email: MARCA.emailAutor };
    let committer;
    try {
      const u = await this.getUserCached();
      committer = {
        name: u.name || u.login,
        email: u.email || `${u.id}+${u.login}@users.noreply.github.com`,
      };
    } catch {
      committer = undefined;
    }

    const newCommit = await this.request(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      signal,
      body: {
        message,
        tree: newTree.sha,
        parents: [baseCommitSha],
        author,
        ...(committer ? { committer } : {}),
      },
    });

    await this.request(
      `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`,
      { method: 'PATCH', signal, body: { sha: newCommit.sha } }
    );

    return {
      sha: newCommit.sha,
      url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
    };
  }

  // Arquivos que mudaram entre dois commits (a Lovable commitou depois do
  // rascunho?). null quando não dá para saber — a comparação é cortada acima
  // de 300 arquivos, e quem chama trata "não sei" como "mudou".
  async arquivosMudadosEntre(owner, repo, base, head, signal) {
    const d = await this.request(`/repos/${owner}/${repo}/compare/${base}...${head}`, { signal });
    const lista = Array.isArray(d?.files) ? d.files : null;
    if (!lista || lista.length >= 300) return null;
    const nomes = new Set();
    for (const f of lista) {
      if (f.filename) nomes.add(f.filename);
      if (f.previous_filename) nomes.add(f.previous_filename);
    }
    return nomes;
  }

  // "Desfazer último prompt": um commit NOVO cuja árvore é a do PAI do commit
  // desfeito — o projeto volta ao que era antes daquele envio. Nunca reescreve
  // histórico (force push confunde o Lovable, que sincroniza por commits
  // novos). Só age se `sha` ainda é a ponta do branch: mudança feita depois
  // (no Lovable, à mão) não é nossa para desfazer — recusa com 409.
  async revertCommit(owner, repo, branch, sha, message, signal) {
    const refPath = `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;
    const ref = await this.request(refPath, { signal });
    if (ref.object?.sha !== sha) {
      throw new GitHubError('O projeto mudou depois deste envio, então ele não pode mais ser desfeito.', 409);
    }
    const commit = await this.request(`/repos/${owner}/${repo}/git/commits/${sha}`, { signal });
    const paiSha = commit.parents?.[0]?.sha;
    if (!paiSha) {
      throw new GitHubError('Este é o primeiro envio do projeto e não pode ser desfeito.', 400);
    }
    const pai = await this.request(`/repos/${owner}/${repo}/git/commits/${paiSha}`, { signal });

    // Mesmas assinaturas do commitChanges: autor GeckoAI, committer = usuário.
    const author = { name: MARCA.nome, email: MARCA.emailAutor };
    let committer;
    try {
      const u = await this.getUserCached();
      committer = {
        name: u.name || u.login,
        email: u.email || `${u.id}+${u.login}@users.noreply.github.com`,
      };
    } catch {
      committer = undefined;
    }

    const novo = await this.request(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      signal,
      body: {
        message,
        tree: pai.tree.sha,
        parents: [sha],
        author,
        ...(committer ? { committer } : {}),
      },
    });
    await this.request(
      `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`,
      { method: 'PATCH', signal, body: { sha: novo.sha } }
    );
    return { sha: novo.sha, url: `https://github.com/${owner}/${repo}/commit/${novo.sha}` };
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
