# Gecko Pessoal — versão 1.12.1

Edição pessoal a partir dos arquivos GeckoAI 1.12.0 enviados pelo usuário. O cliente usa uma API compatível com OpenAI Chat Completions diretamente, sem `gecko-proxy`, `gecko-oauth` ou licença do serviço original. A cópia original permanece na pasta irmã `GeckoAI`.

## Instalar no Chrome ou Edge

1. Baixe e extraia `GeckoAI-Pessoal-v1.12.1.zip`. Não selecione o ZIP ao carregar a extensão.
2. Abra `chrome://extensions` (Chrome) ou `edge://extensions` (Edge).
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta `GeckoAI-Pessoal` que contém `manifest.json`.
5. Confirme que aparece **Gecko Pessoal — API própria** e fixe o ícone da extensão, se desejar.
6. Abra a extensão pelo ícone. A instalação original do GeckoAI é separada: chaves e conexões não são transferidas.

Não é necessário npm, Node.js, servidor local ou build para usar a extensão no navegador. Para atualizar esta edição, substitua os arquivos na mesma pasta de instalação e clique em **Recarregar** em `chrome://extensions`. Mudar a pasta pode mudar o ID e o armazenamento da instalação.

## 1. Conectar sua IA

Para OpenAI:

- Crie uma chave em <https://platform.openai.com/api-keys> e habilite cobrança/créditos na sua conta da API.
- A assinatura ChatGPT Plus/Pro não fornece saldo da API.
- Cole a chave no campo **Chave da API de IA**, dentro da extensão. Não envie a chave em conversas.
- URL: `https://api.openai.com/v1`.
- Modelo inicial: `gpt-4.1-mini`. Você pode informar outro modelo disponível na sua conta e compatível com Chat Completions e chamadas de ferramentas.
- Clique em **Conectar API** e permita o acesso ao domínio escolhido quando o Chrome solicitar.

A conexão confere sua autenticação e se o modelo aparece em `/models`; a disponibilidade para geração e o saldo precisam ser confirmados pelo primeiro pedido real. Cada pedido pode realizar várias chamadas de API. Partes adicionais pedem confirmação; os custos são os do seu provedor. Não há cota de licença do GeckoAI.

Outros provedores: informe a URL base que oferece `/models` e `/chat/completions`, o modelo e a chave correspondente. APIs que oferecem apenas `/responses` ou `/messages` não são compatíveis com este adaptador.

O suporte opcional ao Ollama usa `http://localhost:11434/v1` e o nome exato de um modelo instalado que suporte ferramentas. Não foi instalado ou validado um modelo local nesta máquina. Configure a aceitação da origem da extensão no seu Ollama conforme a documentação dele, se necessário.

## 2. Conectar o GitHub (necessário para editar seus projetos)

1. Na extensão, clique em **Conectar GitHub**.
2. Use **Criar token no GitHub**, ou abra <https://github.com/settings/personal-access-tokens/new>.
3. Crie um token fine-grained, com validade e acesso apenas aos repositórios em que você deseja trabalhar.
4. Para ler e alterar código: **Contents — Read and write** e **Metadata — Read**. Organizações podem exigir aprovação do token. Criar repositórios ou alterar workflows exige permissões adicionais próprias dessas operações.
5. Cole o token na caixa da extensão e conecte. Ela valida a conta e lista os repositórios acessíveis.

A extensão conserva a lógica original de Plan/Build, leitura, edição e commit. Um envio no modo Build pode escrever no repositório selecionado. Teste primeiro em um repositório seu de desenvolvimento.

## 3. Supabase e Vercel (opcionais)

Abra a engrenagem **Configurações**:

- **Supabase:** crie um token pessoal em <https://supabase.com/dashboard/account/tokens>. Use **Conectar** na linha Supabase e cole o token. Ele é validado pela Management API. Uma chave anon/publishable do projeto não substitui esse token. Conectar a conta não identifica automaticamente todo banco: o projeto precisa ser selecionado ou corresponder à configuração do repositório.
- **Vercel:** crie um token em <https://vercel.com/account/tokens> e conecte na linha Vercel. A conta e as permissões precisam alcançar o projeto/time desejado. Deploys reais não foram executados nesta preparação.
- **ChatGPT:** a integração experimental que já existia no pacote foi mantida, mas não foi conectada nem validada com uma conta real. Ela não é necessária quando você usa a API própria.

Os tokens pessoais não são renovados pelo servidor original. Se expirarem ou forem revogados, conecte de novo com um token válido.

## Credenciais e permissões

- Nenhuma licença original, chave de API ou token real está embutido neste pacote.
- As credenciais que você inserir ficam em `chrome.storage.local`, na instalação da extensão. Isso é armazenamento local do navegador, não um cofre independente nem criptografia própria do aplicativo.
- A chave de IA é enviada ao endereço de API que você escolher; cada token de serviço vai à sua API oficial. O domínio da API requer concessão de permissão no clique de conexão.
- Ao mudar a URL da API nas Configurações, o campo da chave é limpo: informe a credencial correspondente ao novo destino.
- A cópia mantém a restrição do storage a contextos confiáveis no service worker. Scripts de conteúdo usam mensagens para obter estado da integração.
- Prompts e arquivos necessários à análise são enviados ao provedor de IA. Ações de GitHub, banco e deploy seguem as integrações que você habilitar.
- Não copie o perfil do navegador, nem exporte o storage com tokens para compartilhar a extensão.

## O que foi verificado

- 13 testes Node, incluindo o agente existente em Plan e Build, conversão de tool calls, anexo de imagem, resposta truncada, cancelamento e falhas de autenticação.
- Teste de interface no Chromium com APIs `chrome.*` e respostas HTTP simuladas: configurar IA, conectar as três contas, listar repositórios, salvar/reabrir configurações e preservar a configuração após credencial inválida.
- Verificação de sintaxe e referências locais de scripts, estilos, fontes e manifesto.

Esses testes não demonstram autenticação com suas contas. Não foram executados pedidos pagos, commits, SQL ou deploys reais. O Chromium da nuvem bloqueia instalação de extensões por política gerenciada; portanto o carregamento nativo e as interações na Lovable precisam ser conferidos na sua instalação local. Geração de imagens pelo proxy original não está disponível nesta edição.

## Desenvolvimento

Os testes não têm dependências externas:

```sh
npm test
```

A interface foi preservada; somente as conexões, o provedor de IA, as permissões e os textos da edição pessoal foram adaptados. Os termos de terceiros incluídos em `skills/` e nas fontes foram preservados.
