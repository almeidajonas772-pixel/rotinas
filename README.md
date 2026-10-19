# Rotinas

Organizador pessoal de hábitos, metas, agenda, diário e relatórios, com o assistente opcional **Kai** e
a aba **Noite** — uma sessão curta, por voz ou texto, para fechar o dia e decidir a prioridade nº 1
de amanhã. É um app para uso próprio: abre direto no seu espaço local, sem cadastro, login, planos ou
cobrança. Tudo fica no banco do seu navegador (IndexedDB) e funciona sem internet depois da primeira
visita. Kai (IA) e Google Calendar são opcionais e só funcionam com a camada privada publicada **e**
com a sua autorização explícita para cada tipo de dado.

Decisões técnicas, modelo de dados e regras de cálculo: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Sumário

- [Requisitos](#requisitos)
- [Executar no computador](#executar-no-computador)
- [Publicar na Vercel com Kai e Google (iPad e Windows)](#publicar-na-vercel-com-kai-e-google-ipad-e-windows)
- [Ativar o Kai](#ativar-o-kai)
- [Conectar o Google Calendar](#conectar-o-google-calendar)
- [A aba Noite](#a-aba-noite)
- [Uso offline e instalação como app](#uso-offline-e-instalação-como-app)
- [Backup e restauração](#backup-e-restauração)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Notificações](#notificações)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Testes e verificações](#testes-e-verificações)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Limitações conhecidas](#limitações-conhecidas)

## Requisitos

- Node.js **22.12 ou mais recente** (`node -v` para conferir) e npm — só para rodar ou testar no
  computador. Para usar o app publicado, basta um navegador.
- Navegador atual (Chrome, Edge, Firefox ou Safari). Instalação como app, notificações e voz funcionam
  melhor no Chrome/Edge.

## Executar no computador

```powershell
npm install
npm run dev:app        # só o app, 100% local, em http://127.0.0.1:5173
```

Hábitos, metas, agenda, diário, relatórios, exportação e importação funcionam sem nenhuma variável de
ambiente e sem servidor.

**Com a camada privada** (Kai e Google Calendar no seu computador):

```powershell
Copy-Item .env.example .env   # no cmd: copy .env.example .env  |  macOS/Linux: cp .env.example .env
# edite o .env e preencha apenas o que for usar
npm run dev                   # app em 5173 + camada privada em 8787 (o Vite encaminha /api)
```

**Versão compilada** (service worker e cabeçalhos de segurança): `npm run build` e `npm start`
(app + camada privada em <http://127.0.0.1:8787>; ajuste `APP_ORIGIN` e `GOOGLE_REDIRECT_URI` para a
porta 8787 no `.env`).

## Publicar na Vercel com Kai e Google (iPad e Windows)

O iPad não roda Node.js, então o app precisa estar num endereço HTTPS. Publicando pelo **GitHub**, a
Vercel entrega o app e roda a camada privada no mesmo endereço (`/api`), como uma função. Publicar
arrastando a pasta (Vercel Drop) envia **só o app** — foi por isso que Kai e Google não conectavam.

O app tem um assistente que verifica cada passo e mostra exatamente o que falta: **Mais → Conectar
Kai e Google** (ou `#/conexoes`). Resumo:

1. **Conectar o repositório ao projeto existente** (mantém o endereço e os dados já salvos em cada
   aparelho): Vercel → projeto → **Settings → Git → Connect Git Repository** → GitHub → repositório do
   Rotinas, ramo `main`. O `vercel.json` já define a build (`npm run build:vercel`), que gera o app e a
   função da camada privada (Build Output API).
2. **Armazenamento privado:** aba **Storage → Create Storage → Blob → Continue → acesso Private** e
   conecte ao projeto. A Vercel injeta a identificação do armazenamento (`BLOB_STORE_ID`) e a
   autenticação por OIDC — nenhum segredo vai para o código. Guarda, cifrados, os tokens do Google e o
   contador diário do Kai.
3. **Senha do servidor:** em **Settings → Environment Variables**, crie `ROTINAS_SERVER_TOKEN` com uma
   senha de 12 ou mais caracteres (marque **Sensitive**). Sem ela, a camada privada fica bloqueada de
   propósito. Depois, informe a mesma senha em cada aparelho (tela Conectar Kai e Google).
4. **Kai e Google:** adicione `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` (seções
   abaixo).
5. **Publicar de novo** depois de mudar variáveis: **Deployments → ⋯ → Redeploy** (variáveis só valem
   para publicações novas).

No **iPad**, abra o endereço no Safari → **Compartilhar → Adicionar à Tela de Início** e use sempre o
ícone (os dados do ícone ficam separados dos de uma aba do Safari). No **Windows**, abra o mesmo
endereço no Edge ou no Chrome e instale pelo ícone da barra de endereço.

**Cada aparelho guarda os próprios dados** (não há sincronização). Para levar seus dados de um para o
outro, exporte o backup num e importe no outro.

> Trocar `ROTINAS_SERVER_TOKEN` (sem `TOKEN_ENCRYPTION_KEY` definida) muda as chaves derivadas: a
> conexão com o Google passa a aparecer como "não conectada" e basta conectar de novo.

## Ativar o Kai

1. Crie uma chave em <https://platform.claude.com/settings/keys>, adicione créditos em
   <https://platform.claude.com/settings/billing> e **defina um limite de gasto** lá — é a proteção
   definitiva de custo. O uso da API é cobrado por consumo, separado de assinaturas do Claude.
2. Cadastre `ANTHROPIC_API_KEY` (Vercel, marcada como Sensitive; ou no `.env` local) e publique de novo.
3. No app: **Kai → Revisar e ativar o Kai**. Leia o que é enviado e autorize. Na tela **Conectar Kai e
   Google**, o botão **Testar o Kai agora** faz uma chamada real com uma frase fixa, sem dados seus.
4. Modelos padrão (conferidos na documentação oficial em outubro de 2026): `claude-haiku-5-5` para
   conversa, próximo passo e sessão da noite; `claude-sonnet-5-5` para plano inicial, revisão semanal e
   metas. Podem ser trocados em `KAI_MODEL_FAST` e `KAI_MODEL_DEEP`.
5. Proteções de custo no servidor: 10 pedidos por minuto e 80 por dia por padrão (`KAI_RATE_LIMIT_PER_MINUTE`,
   `KAI_DAILY_LIMIT`); a resposta da noite é limitada a 1.000 tokens.

Check-ins, trechos do Diário e a agenda na sessão da noite têm autorizações próprias. Desligar o Kai
revoga também essas três.

## Conectar o Google Calendar

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative a
   [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
2. Em **Google Auth Platform → Get started**: nome do app, seu e-mail, público **External**.
3. Em **Clients → Create client → Web application**, cadastre em **Authorized redirect URIs**:
   - Vercel: `https://<seu-domínio-de-produção>/api/calendar/callback` (a tela Conectar Kai e Google
     mostra o valor exato com botão de copiar);
   - no computador: `http://127.0.0.1:5173/api/calendar/callback` (`npm run dev`) e/ou
     `http://127.0.0.1:8787/api/calendar/callback` (`npm start`).
4. Copie o **Client ID** e o **Client secret** na janela de criação (o segredo não é mostrado de novo;
   dá para baixar o JSON) e cadastre `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Na Vercel, não é preciso
   `GOOGLE_REDIRECT_URI` nem `TOKEN_ENCRYPTION_KEY` (a chave é derivada da senha do servidor).
5. Em **Audience**, use **Publish app** (status *In production*). Em *Testing*, o Google emite tokens de
   renovação que expiram em 7 dias ([documentação](https://developers.google.com/identity/protocols/oauth2)).
   Como o app não passa pela verificação do Google, a tela de autorização mostra o aviso de app não
   verificado; em **Avançado**, continue — é o seu próprio app. Apps não verificados ficam limitados a
   100 usuários novos ([ajuda do Google](https://support.google.com/cloud/answer/7454865)), o que não afeta
   o uso pessoal.
6. No app: **Calendário externo → Autorizar** e escolha o nível. A autorização abre numa aba (no iPad
   instalado, numa folha do Safari); ao terminar, volte ao Rotinas — a tela atualiza sozinha.

Níveis de acesso (cada um pedido só quando você escolhe):

| Nível | Escopo | O que permite |
| --- | --- | --- |
| Disponibilidade | `calendar.freebusy` | horários ocupados, sem títulos |
| Ver meus eventos | `calendar.events.owned.readonly` | título, horário e cor dos eventos da agenda principal (Noite e planejador) — só leitura |
| Criar blocos | `calendar.app.created` | cria a agenda "Rotinas" e mexe apenas nos eventos dela, sempre com prévia e confirmação |

Para desconectar: **Desconectar e revogar** (revoga no Google e apaga os tokens). Também é possível
revogar em <https://myaccount.google.com/permissions>.

## A aba Noite

Todas as noites, abra **Noite** (ou toque no convite que aparece em **Hoje** depois das 18h):

- **Resumo calculado no aparelho:** hábitos de hoje (e o que ainda dá tempo), XP do dia, agenda de
  amanhã (Rotinas + Google, se a leitura de eventos estiver conectada), janelas livres, provas e prazos
  dos próximos 7 dias (detectados pelo título, com aviso de que podem errar) e ritmo das metas.
  Funciona mesmo sem o Kai: o app lê esse resumo em voz alta, sem IA e sem rede.
- **Sessão com o Kai:** toque na esfera. O Kai abre com o essencial do dia, faz uma pergunta por vez e
  propõe até 3 decisões para amanhã (bloco numa janela livre, tarefa, ajuste de hábito). Nada é criado
  sem o seu toque em **Criar…**; tudo pode ser desfeito. As referências citadas mostram a evidência
  calculada pelo app.
- **Prioridade nº 1 de amanhã:** escreva, dite ou aceite a sugestão. No dia seguinte ela aparece no
  topo de **Hoje**, e na noite seguinte o app pergunta se foi cumprida.
- **Voz:** a leitura usa as vozes do aparelho (sem enviar nada). Falar pelo microfone exige a
  autorização **Conversa por voz**: o navegador pode enviar o áudio ao serviço de reconhecimento do
  fabricante (Google no Chrome, Microsoft no Edge, Apple no Safari). No **Windows** (Chrome/Edge) a
  conversa por voz funciona direto na esfera. No **iPad com o app instalado na Tela de Início**, o
  Safari não libera o reconhecimento de fala para apps instalados: use o microfone do teclado no campo
  de texto — a resposta continua sendo lida em voz alta.
- **Cores do Google:** se você pinta provas e prazos com cores próprias no Google Agenda (por exemplo,
  laranja para avaliações e vermelho para prazos do Moodle), marque essas cores em **Noite → Ajustes da
  noite**: eventos delas entram no radar mesmo sem palavras-chave no título. Aulas, reforços e blocos de
  estudo nunca entram.
- **Lembrete da noite** (opcional): notificação local no horário escolhido, com o app aberto.
- A conversa fica só no aparelho (entra no backup e pode ser apagada em **Recomeçar**).

## Uso offline e instalação como app

- O service worker guarda o app no primeiro acesso; depois disso ele abre e registra conclusões sem
  internet. Kai e calendário externo mostram "sem conexão" em vez de tentar a rede.
- Quando há uma versão nova, o app mostra **Atualizar agora** — nada é trocado sem você pedir.
- O app pede ao navegador armazenamento persistente; o estado aparece em **Configurações → Seus dados**.

## Backup e restauração

- **Exportar:** Configurações → Seus dados → **Exportar backup (JSON)** (completo) ou **versão legível
  (Markdown)**. Inclui prioridades do dia e sessões da noite.
- **Restaurar:** Configurações → Seus dados → **Importar backup** (mostra o conteúdo, pede confirmação
  e substitui os dados atuais). Backups de versões antigas são migrados.
- **O backup não é criptografado** e inclui o Diário: guarde o arquivo em local seguro.
- Ficam fora do backup: tokens do Google (só no servidor), a senha do servidor, eventos lidos do Google,
  o registro de lembretes já mostrados e o estado de conexão das integrações.

## Variáveis de ambiente

Nenhuma é necessária para o uso local. Todas ficam **somente no servidor** (`.env` no computador ou
Environment Variables na Vercel). Modelo comentado em [`.env.example`](.env.example).

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `ROTINAS_SERVER_TOKEN` | Senha da camada privada — **obrigatória na Vercel** (12+ caracteres); também deriva as chaves de cifra e assinatura | vazia (no computador, opcional) |
| `ANTHROPIC_API_KEY` | Liga o Kai | vazia (Kai desativado) |
| `KAI_MODEL_FAST`, `KAI_MODEL_DEEP` | Modelos | `claude-haiku-5-5`, `claude-sonnet-5-5` |
| `KAI_RATE_LIMIT_PER_MINUTE`, `KAI_DAILY_LIMIT` | Limites de uso | `10`, `80` |
| `KAI_MAX_OUTPUT_TOKENS`, `KAI_TIMEOUT_MS` | Tamanho máximo da resposta e tempo limite | `2000`, `45000` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Cliente OAuth do Google | vazias (integração desativada) |
| `GOOGLE_REDIRECT_URI` | Retorno do OAuth | na Vercel: `https://<domínio de produção>/api/calendar/callback` |
| `TOKEN_ENCRYPTION_KEY` | Chave própria (32 bytes base64) para cifrar os tokens | derivada da senha, se houver |
| `BLOB_STORE_ID` | Armazenamento privado (injetado pela Vercel ao conectar o Blob) | — |
| `ROTINAS_SERVER_HOST`, `ROTINAS_SERVER_PORT`, `APP_ORIGIN`, `GOOGLE_TOKEN_FILE` | Só no computador | `127.0.0.1`, `8787`, `http://127.0.0.1:5173`, `.data/google-calendar.enc` |

## Notificações

- Desligadas por padrão. Ative em **Configurações → Notificações → Lembretes locais**; o navegador
  pede permissão. Depois, ligue o lembrete em cada hábito e, se quiser, o **Lembrete da noite**.
- Os lembretes são notificações **locais** e aparecem enquanto o app está aberto (aba ou app
  instalado). Não há push com o app fechado. WhatsApp não faz parte do app.

## Privacidade e segurança

- **No aparelho por padrão.** Nada sai do navegador sem uma autorização específica e revogável: Kai,
  check-ins no Kai, Diário no Kai, agenda no Kai, Google Calendar, conversa por voz e notificações têm
  controles separados, com data e versão do texto. Se o texto de uma autorização muda, ela fica
  desligada até você revisar. A tela **Privacidade** mostra o que fica e o que pode sair.
- **Contexto mínimo para o Kai.** Objetivo, disponibilidade, hábitos com referências curtas (`h1`…),
  agregados, metas; na noite, os números do dia e horários dos hábitos de amanhã. Títulos da agenda
  (inclusive do Google) só com a autorização própria. Nunca vão nome, observações, áudio ou ids internos.
- **Segredos só no servidor.** Chaves vivem nas variáveis de ambiente; tokens OAuth ficam cifrados
  (AES-256-GCM) no Blob privado (Vercel) ou em `.data/` (computador). O navegador nunca recebe chaves
  ou tokens.
- **Proteções da camada privada:** senha obrigatória na nuvem (comparação em tempo constante e
  bloqueio após 10 tentativas erradas em 10 minutos); checagem de origem e JSON obrigatório em
  chamadas que alteram estado; `state` do OAuth assinado e de uso único; escrita no Google só com
  prévia assinada, os mesmos blocos e confirmação (repetir não duplica); limites de taxa; logs só
  técnicos; cabeçalhos de segurança (CSP restritiva, microfone liberado só para o próprio site).
- **Prompt injection:** regras só no *system prompt*; dados como JSON marcado como não confiável; sem
  ferramentas; resposta presa a um esquema e validada no servidor; referências inexistentes descartadas.
- **Esta versão não passou por auditoria de segurança nem por revisão jurídica** e não alega
  conformidade com normas. Antes de usar com dados de outras pessoas, faça essas revisões.

## Testes e verificações

```powershell
npm test                          # unidade, banco (IndexedDB simulado), camada privada e componentes
npx playwright install chromium   # uma vez, antes do primeiro teste e2e
npm run test:e2e                  # build de produção + Chromium em viewport móvel e desktop
npm run lint
npm run typecheck
npm run build:vercel              # gera .vercel/output (app + função) como na Vercel
```

- **Locais, automatizados:** regras de domínio (inclusive o resumo da noite, provas/prazos, janelas
  livres e voz), banco e migrações (v1→v3), backup, consentimentos e versões de texto, componentes
  (Noite com e sem Kai, assistente de conexão) e fluxos no navegador, com acessibilidade (axe-core) e
  verificação de que **nenhuma requisição** é feita sem autorização.
- **Com dublês:** rotas do Kai (inclusive a sessão da noite) com provedor falso; OAuth/Calendar com
  respostas falsas do Google; modo nuvem (senha, origem atrás do proxy, Blob, assinaturas).
- **Não testado contra serviços reais:** Anthropic, Google OAuth/Calendar, Vercel Blob e o
  reconhecimento de fala de cada navegador. Isso depende das suas credenciais e aparelhos.

## Estrutura do projeto

```text
src/
  app/          raiz, rotas (HashRouter; telas secundárias sob demanda), layout e contexto
  components/   interface base: botões, formulários, diálogos, avisos, gráficos acessíveis
  db/           IndexedDB (Dexie): esquema versionado, migrações, repositórios, backup, hooks
  domain/       regras puras: datas e fusos, recorrência, sequência, métricas, XP, metas, agenda,
                relatórios, contexto do Kai, resumo da noite, plano de lembretes
  features/     telas: onboarding, Hoje, Noite, Hábitos, Metas, Agenda, Relatórios, Diário, Kai,
                Calendário externo, Conectar Kai e Google, Configurações e Privacidade
  lib/          rede (único ponto de saída, com checagem de consentimento), PWA, notificações, voz
  styles/       tokens de design (claro/escuro), base e componentes
shared/         contratos validados entre app e camada privada (Kai e calendário)
server/         camada privada: Hono, adaptador Anthropic, OAuth/Calendar, armazenamento, proteções;
                entradas para Node (server/node.ts) e Vercel (server/vercel.ts)
scripts/        build da função para a Vercel e pacote estático
tests/          unidade, banco, servidor e componentes (Vitest)
e2e/            fluxos no navegador (Playwright + axe-core)
docs/           arquitetura e decisões
```

## Limitações conhecidas

- Kai, Google e Blob foram testados com dublês; o primeiro uso real deve ser acompanhado pela tela
  **Conectar Kai e Google** (que testa o Kai de verdade).
- No iPad com o app instalado, o reconhecimento de fala do navegador não está disponível (limitação do
  Safari para apps da Tela de Início); use o ditado do teclado.
- A leitura de eventos cobre a agenda principal da conta Google (não agendas assinadas de terceiros).
- Detecção de provas e prazos é por palavras do título: pode deixar passar ou marcar algo a mais.
- Lembretes só aparecem com o app aberto; não há push em segundo plano.
- Sem sincronização entre aparelhos; a estratégia é backup manual. O backup não é criptografado.
- Recorrência de hábitos: diária ou por dias da semana. Agenda: diária ou semanal.
- Itens criados no Google a partir do app não são apagados lá quando apagados no app (a tela avisa).
- Na nuvem, o limite por minuto do Kai vale por instância da função; o teto diário fica no Blob e o
  limite de gasto do Console da Anthropic é o teto definitivo.
- Interface só em português do Brasil. Os testes automáticos rodam no Chromium; o Safari do iPad não
  foi testado automaticamente.
