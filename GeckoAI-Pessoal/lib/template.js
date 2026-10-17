// Template do "projeto do zero": Vite + React + Tailwind, pronto para a Vercel
// detectar e buildar. Arquivos estáticos e determinísticos — o esqueleto não
// gasta IA; o primeiro prompt do usuário já trabalha em cima dele.

import { MARCA } from './marca.js';

// Nome de repositório seguro: minúsculas, sem acento, só [a-z0-9._-].
export function normalizeProjectName(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 90);
}

// "cafe-do-joao" -> "Cafe Do Joao" (título para o HTML e o hero).
export function displayName(name) {
  return String(name || '')
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function templateFiles(projectName) {
  const title = displayName(projectName) || 'Meu Projeto';
  return new Map([
    ['package.json', pkgJson(projectName)],
    ['vite.config.js', VITE_CONFIG],
    ['index.html', indexHtml(title)],
    ['.gitignore', GITIGNORE],
    ['src/main.jsx', MAIN_JSX],
    ['src/index.css', INDEX_CSS],
    ['src/App.jsx', appJsx(title)],
    ['docs/CONTEXTO.md', contextoMd(title)],
    ['README.md', readmeMd(title)],
  ]);
}

function pkgJson(name) {
  return JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' },
      devDependencies: {
        '@tailwindcss/vite': '^4.1.0',
        '@vitejs/plugin-react': '^4.5.0',
        tailwindcss: '^4.1.0',
        vite: '^6.3.0',
      },
    },
    null,
    2
  ) + '\n';
}

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`;

function indexHtml(title) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;
}

const GITIGNORE = `node_modules
dist
.env
.env.*
*.local
.DS_Store
`;

const MAIN_JSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`;

const INDEX_CSS = `@import "tailwindcss";
`;

function appJsx(title) {
  return `export default function App() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-xl text-center space-y-6">
        <span className="inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1 text-sm text-emerald-400">
          Projeto no ar
        </span>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">${title}</h1>
        <p className="text-lg text-zinc-400">
          Seu projeto está pronto. Volte ao painel do ${MARCA.nome} e descreva a
          primeira mudança — cada prompt vira um commit, e o site se atualiza
          sozinho.
        </p>
      </div>
    </main>
  );
}
`;
}

function contextoMd(title) {
  return `# Contexto do projeto — ${title}

## Stack
- Vite + React 19 + Tailwind CSS 4 (plugin @tailwindcss/vite).
- Build: \`vite build\` → pasta \`dist\`. Publicado na Vercel (todo push no branch principal vira deploy).

## Estrutura
- \`index.html\` — casca da página (título do site aqui).
- \`src/main.jsx\` — entrypoint React.
- \`src/App.jsx\` — página única atual (hero inicial).
- \`src/index.css\` — só o \`@import "tailwindcss"\`; estilos via classes utilitárias.

## Convenções
- Estilo com classes Tailwind direto no JSX; tema escuro (zinc) com acento emerald.
- Componentes novos em \`src/components/\` (criar a pasta quando precisar).
- Páginas novas: instalar \`react-router-dom\` no package.json e criar \`src/pages/\`.
`;
}

function readmeMd(title) {
  return `# ${title}

Criado com ${MARCA.nome} — cada prompt vira um commit.

## Rodar localmente
\`\`\`bash
npm install
npm run dev
\`\`\`

Publicado na Vercel: todo push no branch principal vira um deploy.
`;
}
