# Gecko Pessoal

Edição pessoal da extensão, preparada a partir do pacote GeckoAI 1.12.0 fornecido pelo usuário. Usa API de IA própria e tokens pessoais para GitHub, Supabase e Vercel. Nenhuma credencial real está incluída.

## Baixar e instalar

1. Clique no botão verde **Code** e depois em **Download ZIP**.
2. Extraia o ZIP no seu computador.
3. Abra `chrome://extensions` (Chrome) ou `edge://extensions` (Edge).
4. Ative **Modo do desenvolvedor** e clique em **Carregar sem compactação**.
5. Dentro da pasta extraída, selecione **GeckoAI-Pessoal**, onde está `manifest.json`.
6. Abra **Gecko Pessoal — API própria** e configure sua chave de API e seu token do GitHub.

Não é necessário instalar Node.js, npm ou executar build para carregar a extensão.

Para OpenAI: URL `https://api.openai.com/v1`, modelo inicial `gpt-4.1-mini`. Crie a chave em https://platform.openai.com/api-keys e configure saldo/cobrança da API. A assinatura ChatGPT não inclui créditos de API. Cole credenciais apenas na extensão, nunca neste repositório.

[Instruções completas, credenciais e limitações](GeckoAI-Pessoal/LEIA-ME.md)

## Validação

13 testes automatizados passaram, incluindo o agente nos modos Plan/Build e o adaptador de ferramentas. A interface também foi testada com APIs de navegador e serviços simulados. Isso não comprova autenticação com contas reais. O carregamento da extensão precisa ser conferido no navegador do usuário; o Chromium do ambiente de preparação bloqueia extensões por política gerenciada.

O cliente não depende do proxy, OAuth ou licença do GeckoAI original. Geração de imagens pelo proxy original não está incluída. O código do REA utilizado na análise não faz parte deste pacote de instalação.
