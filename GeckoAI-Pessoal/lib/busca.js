// GeckoAI — busca no código do projeto (ferramenta search_code).
//
// Sem busca, a IA só conseguia ABRIR arquivos inteiros: num projeto grande,
// descobrir ONDE mora o que o cliente pediu virava caça arquivo por arquivo,
// e cada arquivo aberto ficava na conversa até o fim do pedido (reenviado a
// cada etapa). Clientes relataram "depois que o projeto cresce ela não
// consegue fazer algumas coisas" (2026-09-29); medido no domina-link-pro
// (412 arquivos): um pedido médio passava de ~13 mil para ~110 mil tokens por
// etapa só explorando. Com a busca, a IA acha "arquivo:linha" e lê só o que
// importa.
//
// Nada aqui usa `chrome.*` nem rede: o agente baixa os arquivos (com cache) e
// entrega o texto pronto.

// Código e texto que a IA procura. SVG fica de fora: é desenho, não texto, e
// um só pode ter centenas de KB de coordenadas.
const EXT_PESQUISAVEL = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|html|json|mdx?|sql|toml|ya?ml|txt|vue|svelte)$/i;
// Gerado, empacotado ou de build: ninguém edita, e casaria em tudo. As skills
// instaladas (.agents/skills/, lib/skills.js) são instrução, não código do
// projeto: só a de performance são 52 arquivos a baixar, e "sitemap" ou
// "useState" casaria nelas em toda busca.
const IGNORAR =
  /^(?:node_modules|dist|build|out|coverage|\.next|\.cache|\.agents\/skills)\/|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|\.min\.(?:js|css)$|\.map$|\.gen\.(?:ts|tsx|js)$/i;

export const MAX_BYTES_PESQUISAVEL = 400_000;
export const MAX_ARQUIVOS_PESQUISAVEIS = 1000;
export const MAX_ACHADOS = 40;
const MAX_CHARS_LINHA = 180;

/**
 * Os arquivos que entram na busca, com `src/` primeiro (é onde mora quase
 * tudo que o cliente vê) e um teto para repositório gigante.
 * @param {{path:string, size?:number, sha?:string}[]} files
 */
export function arquivosPesquisaveis(files) {
  const ok = (files || []).filter(
    (f) =>
      f?.path &&
      EXT_PESQUISAVEL.test(f.path) &&
      !IGNORAR.test(f.path) &&
      !(Number(f.size) > MAX_BYTES_PESQUISAVEL)
  );
  const peso = (p) => (p.startsWith('src/') ? 0 : p.startsWith('supabase/') ? 1 : 2);
  return ok
    .sort((a, b) => peso(a.path) - peso(b.path) || a.path.localeCompare(b.path))
    .slice(0, MAX_ARQUIVOS_PESQUISAVEIS);
}

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_LINHA_REGEX = 2000;

// "path" do jeito que a IA escreve: "./src", "src/**", "src/*.tsx", "." e
// "*" viram prefixo de pasta ("src/", ou nenhum) — como glob, davam zero
// achados e a IA ouvia "No matches".
function prefixoDaPasta(pasta) {
  if (!pasta) return '';
  const p = String(pasta).trim().replace(/^\.?\/+/, '').replace(/[*?[{].*$/, '');
  return p === '.' ? '' : p;
}

/** Linha curta em volta do achado: linha minificada de 5 mil chars não entra inteira. */
function recortar(linha, inicio) {
  const t = linha.replace(/\s+$/, '');
  if (t.length <= MAX_CHARS_LINHA) return t.trim();
  const de = Math.max(0, inicio - 60);
  return `${de > 0 ? '…' : ''}${t.slice(de, de + MAX_CHARS_LINHA).trim()}…`;
}

/**
 * Procura `padrao` em cada [path, texto]. Sem diferença de maiúsculas; texto
 * literal por padrão (o cliente fala "o texto Fale conosco", não regex).
 * @param {Iterable<[string, string]>} entradas
 * @returns {{achados:{path:string, linha:number, texto:string}[], total:number, porArquivo:Map<string, number>}}
 */
export function buscarNoTexto(entradas, { padrao, regex = false, pasta = null, max = MAX_ACHADOS } = {}) {
  const termo = String(padrao ?? '');
  if (!termo.trim()) throw new Error('search_code needs a non-empty "pattern".');
  let re;
  try {
    re = new RegExp(regex ? termo : escaparRegex(termo), 'i');
  } catch (e) {
    throw new Error(`Invalid regex "${termo}": ${e.message}. Search the literal text instead (regex: false).`);
  }
  const prefixo = prefixoDaPasta(pasta);
  const achados = [];
  const porArquivo = new Map();
  let total = 0;
  for (const [path, texto] of entradas) {
    if (prefixo && !path.startsWith(prefixo)) continue;
    if (typeof texto !== 'string') continue;
    const linhas = texto.split('\n');
    for (let i = 0; i < linhas.length; i++) {
      // Regex da IA numa linha enorme (CSS/JS minificado) pode levar minutos
      // com o painel travado (".*a.*b" numa linha de 97k — revisão
      // adversarial): só o começo dela. O texto literal é linear e vê tudo.
      const linha = regex && linhas[i].length > MAX_LINHA_REGEX ? linhas[i].slice(0, MAX_LINHA_REGEX) : linhas[i];
      const m = re.exec(linha);
      if (!m) continue;
      total++;
      porArquivo.set(path, (porArquivo.get(path) || 0) + 1);
      if (achados.length < max) achados.push({ path, linha: i + 1, texto: recortar(linhas[i], m.index) });
    }
  }
  return { achados, total, porArquivo };
}

/** O que volta para a IA: "arquivo:linha: texto", e o resto resumido por arquivo. */
export function formatarBusca(res, padrao, { pasta = null } = {}) {
  const onde = pasta ? ` under "${pasta}"` : '';
  if (!res.total) {
    return `No matches for "${padrao}"${onde}. Try a shorter or different term. Visible text may come from a translation file (i18n/locales), from the database, or be split across JSX lines.`;
  }
  const cab = `${res.total} match${res.total > 1 ? 'es' : ''} in ${res.porArquivo.size} file${res.porArquivo.size > 1 ? 's' : ''} for "${padrao}"${onde}:`;
  const linhas = res.achados.map((a) => `${a.path}:${a.linha}: ${a.texto}`);
  const mostrados = new Map();
  for (const a of res.achados) mostrados.set(a.path, (mostrados.get(a.path) || 0) + 1);
  const resto = [...res.porArquivo]
    .map(([p, n]) => [p, n - (mostrados.get(p) || 0)])
    .filter(([, n]) => n > 0);
  const rodape = resto.length
    ? `\n… +${res.total - res.achados.length} more: ${resto.slice(0, 15).map(([p, n]) => `${p} (${n})`).join(', ')}${resto.length > 15 ? ', …' : ''}. Narrow it with "path" or a more specific pattern.`
    : '';
  return `${cab}\n${linhas.join('\n')}${rodape}\nThen read_file only what you need (use start_line/end_line around these lines in big files).`;
}
