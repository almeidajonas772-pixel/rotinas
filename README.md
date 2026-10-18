# Rotinas

Organizador pessoal de hábitos, metas, agenda, diário e relatórios, com o assistente opcional **Kai**.
É um app para uso próprio: abre direto no seu espaço local, sem cadastro, login, planos ou cobrança.
Tudo fica no banco do seu navegador (IndexedDB) e funciona sem internet depois da primeira visita.
Kai (IA) e Google Calendar são opcionais e só funcionam com a camada privada configurada **e** com a
sua autorização explícita para cada tipo de dado.

Decisões técnicas, modelo de dados e regras de cálculo: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Sumário

- [Requisitos](#requisitos)
- [Executar](#executar)
- [Uso offline e instalação como app](#uso-offline-e-instalação-como-app)
- [Usar no iPad e no Windows (publicar o app)](#usar-no-ipad-e-no-windows-publicar-o-app)
- [Backup e restauração](#backup-e-restauração)
- [Testes e verificações](#testes-e-verificações)
- [Variáveis de ambiente (só para recursos opcionais)](#variáveis-de-ambiente-só-para-recursos-opcionais)
- [Ativar o Kai](#ativar-o-kai)
- [Conectar o Google Calendar](#conectar-o-google-calendar)
- [Notificações](#notificações)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Limitações conhecidas](#limitações-conhecidas)

## Requisitos

- Node.js **22.12 ou mais recente** (`node -v` para conferir) e npm.
- Windows, macOS ou Linux. Os comandos abaixo funcionam no PowerShell; no macOS/Linux use o terminal normalmente.
- Navegador atual (Chrome, Edge, Firefox ou Safari). Instalação como app e notificações funcionam melhor no Chrome/Edge.

## Executar

Na pasta do projeto:

```powershell
npm install
npm run dev:app
```

Abra <http://127.0.0.1:5173>. Isso é tudo para usar o app **100% local**: hábitos, metas, agenda,
diário, relatórios, exportação e importação funcionam sem nenhuma variável de ambiente e sem servidor.

**Com a camada privada** (necessária só para Kai e Google Calendar):

```powershell
Copy-Item .env.example .env   # no cmd: copy .env.example .env  |  macOS/Linux: cp .env.example .env
# edite o .env e preencha apenas o que for usar
npm run dev                   # app em 5173 + camada privada em 8787 (o Vite encaminha /api)
```

**Versão compilada, como no dia a dia** (com service worker e cabeçalhos de segurança):

```powershell
npm run build
npm start                     # app + camada privada em http://127.0.0.1:8787
```

Com `npm start`, ajuste no `.env`: `APP_ORIGIN=http://127.0.0.1:8787` e, se usar Google,
`GOOGLE_REDIRECT_URI=http://127.0.0.1:8787/api/calendar/callback`.
`npm run preview` serve só o app compilado em <http://127.0.0.1:4173> (sem Kai/Google, a menos que a
camada privada esteja rodando em 8787).

## Uso offline e instalação como app

- Na versão compilada (`npm start` ou `npm run preview`), o service worker guarda o app no primeiro
  acesso. Depois disso ele abre e registra conclusões sem internet. Em `npm run dev:app` não há
  service worker (comportamento normal do modo de desenvolvimento).
- Os dados são gravados no IndexedDB com ou sem conexão. Sem internet, a barra superior avisa; Kai e
  calendário externo mostram "sem conexão" em vez de tentar a rede.
- Quando há uma versão nova, o app mostra **Atualizar agora** — nada é trocado sem você pedir.
- Para instalar: no Chrome/Edge, use o ícone de instalação na barra de endereço (ou menu → "Instalar Rotinas").
- O app pede ao navegador armazenamento persistente (para não ser limpo automaticamente). O estado
  aparece em **Configurações → Seus dados**.

## Usar no iPad e no Windows (publicar o app)

O iPad não roda Node.js, então o app precisa estar num endereço HTTPS. Como o Rotinas é só um conjunto
de arquivos estáticos e os dados ficam no aparelho, um host estático gratuito basta: o host entrega o
app, mas nunca recebe seus hábitos, metas ou diário.

1. **Gerar o pacote:** `npm run package:web` cria `release/rotinas-web` (app compilado + `vercel.json`
   com cabeçalhos de segurança).
2. **Publicar:** com sua conta da Vercel aberta, vá a <https://vercel.com/drop>, arraste a pasta (ou o
   `.zip` dela), dê o nome `rotinas` e clique em **Deploy**. Anote o endereço `https://….vercel.app`.
   Esse endereço é a "casa" dos seus dados em cada aparelho: use sempre o mesmo.
3. **iPad** (iPadOS 16.4 ou mais recente): abra o endereço no Safari → **Compartilhar** → **Adicionar à
   Tela de Início**. Depois, abra **sempre pelo ícone**: é ele que permite notificações, e os dados do
   ícone podem ficar separados dos de uma aba do Safari.
4. **Windows:** abra o mesmo endereço no Edge ou no Chrome e use o ícone de instalação na barra de
   endereço (no Edge também em ⋯ → Aplicativos → Instalar este site como um aplicativo). Não precisa de
   Node.js para o uso diário.
5. **Atualizar sem trocar de endereço:** um novo "drop" cria outro projeto, com outro endereço (e dados
   separados). Para publicar uma versão nova no mesmo endereço, rode `npx vercel --prod` dentro de
   `release/rotinas-web` e vincule ao projeto `rotinas` existente, ou conecte o projeto a um repositório
   Git (o `vercel.json` da raiz já tem o comando de build).

**Cada aparelho guarda os próprios dados** (não há sincronização). Para levar seus dados de um para o
outro, exporte o backup num e importe no outro — a importação substitui tudo no destino. No iPad, use
**Compartilhar backup → Salvar em Arquivos** (ou iCloud Drive) para guardar o arquivo.

Na versão publicada, Kai e Google Calendar aparecem como indisponíveis: eles dependem da camada
privada, que roda no seu computador (`npm start`) e ainda não está publicada.

## Backup e restauração

Os dados existem só neste navegador. Faça backup com frequência (por exemplo, toda semana e sempre
antes de limpar dados, trocar de navegador ou de computador).

- **Exportar:** Configurações → Seus dados → **Exportar backup (JSON)** (completo, para restaurar) ou
  **Exportar versão legível (Markdown)** (para ler ou guardar).
- **Restaurar:** Configurações → Seus dados → **Importar backup** (mostra o conteúdo, pede
  confirmação e substitui os dados atuais) ou, numa instalação nova, **Restaurar um backup** na tela
  de boas-vindas. Backups de versões antigas são migrados; arquivos inválidos ou de versão mais nova
  são recusados com o motivo. XP e níveis são recalculados a partir do histórico importado.
- **O backup não é criptografado** e inclui o Diário: guarde o arquivo em local seguro.
- Ficam fora do backup: tokens do Google (estão só no servidor), a senha do servidor privado, o
  registro de lembretes já mostrados e o estado de conexão das integrações.
- **Apagar tudo:** Configurações → Seus dados → **Apagar tudo** (exige digitar `APAGAR`; a tela
  oferece exportar antes).

## Testes e verificações

```powershell
npm test                          # unidade, banco (IndexedDB simulado), camada privada e componentes
npx playwright install chromium   # uma vez, antes do primeiro teste e2e
npm run test:e2e                  # build de produção + Chromium em viewport móvel e desktop
npm run lint
npm run typecheck
npm run check                     # lint + tipos + testes + build
```

O e2e reaproveita um servidor que já esteja em `127.0.0.1:4173`; feche previews antigos antes para
não testar uma build desatualizada. `PW_CHROMIUM_PATH` permite apontar um Chromium já instalado.

**O que os testes cobrem (e o que não cobrem):**

- **Locais, automatizados:** regras de domínio, banco e migrações, backup/restauração, consentimentos
  e privacidade do Diário, componentes, e fluxos completos no navegador (primeiro uso, hábito,
  conclusão, recarga, histórico, offline, metas, agenda recorrente, backup e limpeza), além de
  acessibilidade com axe-core e verificação de que **nenhuma requisição externa** é feita com Kai e
  integrações desligados.
- **Com dublês (provedores simulados nos testes):** as rotas do Kai com um provedor falso e o fluxo
  OAuth/Calendar com respostas falsas do Google. Eles provam o contrato e as proteções da camada
  privada, **não** a integração real.
- **Não testado contra serviços reais:** a API da Anthropic e o Google OAuth/Calendar de verdade.
  Isso depende de você configurar credenciais (seções abaixo).

## Variáveis de ambiente (só para recursos opcionais)

Nenhuma é necessária para o uso local. Todas ficam **somente no servidor** (arquivo `.env`, que não
deve ser versionado). Modelo completo e comentado em [`.env.example`](.env.example).

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `ROTINAS_SERVER_HOST`, `ROTINAS_SERVER_PORT` | Endereço da camada privada | `127.0.0.1`, `8787` |
| `APP_ORIGIN` | Origem do app (checagem de origem e retorno do OAuth) | `http://127.0.0.1:5173` |
| `ROTINAS_SERVER_TOKEN` | Senha opcional da sua camada privada (recomendada se ela ficar acessível fora deste computador) | vazia |
| `ANTHROPIC_API_KEY` | Liga o Kai | vazia (Kai desativado) |
| `KAI_MODEL_FAST`, `KAI_MODEL_DEEP` | Modelos para conversa/próximo passo e para plano/revisão/metas | `claude-haiku-5-5`, `claude-sonnet-5-5` |
| `KAI_RATE_LIMIT_PER_MINUTE`, `KAI_DAILY_LIMIT` | Limites de uso (proteção de custo) | `6`, `60` |
| `KAI_MAX_OUTPUT_TOKENS`, `KAI_TIMEOUT_MS` | Tamanho máximo da resposta e tempo limite | `2000`, `45000` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Cliente OAuth do Google | vazias (integração desativada) |
| `TOKEN_ENCRYPTION_KEY` | Chave (32 bytes em base64) que criptografa os tokens do Google no servidor | vazia |
| `GOOGLE_TOKEN_FILE` | Onde os tokens criptografados ficam | `.data/google-calendar.enc` |

Se você definir `ROTINAS_SERVER_TOKEN`, informe o mesmo valor em **Configurações → Servidor
privado → Senha do servidor**. Ela não é a chave da Anthropic nem do Google.

## Ativar o Kai

1. Crie uma chave de API no Console da Anthropic (<https://console.anthropic.com>). O uso da API é
   cobrado por consumo, separado de assinaturas do Claude; confira preços e limites na página oficial
   antes de ativar.
2. No `.env`: `ANTHROPIC_API_KEY=...`. Os modelos padrão podem ser trocados em `KAI_MODEL_FAST` e
   `KAI_MODEL_DEEP` (os IDs padrão foram conferidos na documentação oficial da Anthropic em outubro de 2026).
3. Rode `npm run dev` (ou `npm run build` e `npm start`).
4. No app: **Kai → Revisar e ativar o Kai**. Leia o que é enviado e autorize. Check-ins e trechos do
   Diário têm autorizações próprias em **Configurações → Autorizações** (e cada entrada do Diário pode
   ser bloqueada individualmente).
5. A tela do Kai deve mostrar **Kai pronto** com os modelos em uso. Se mostrar "Kai indisponível", a
   mensagem diz o motivo (chave ausente, servidor parado, senha errada).

Para desligar: botão **Desativar Kai** na tela do Kai ou o interruptor em Configurações → Autorizações.
Revogar interrompe todos os envios futuros; o histórico do Kai pode ser apagado na aba Histórico.

## Conectar o Google Calendar

1. No Google Cloud Console (<https://console.cloud.google.com>), crie um projeto e ative a
   **Google Calendar API**.
2. Configure a tela de consentimento OAuth como **Externo** e adicione seu e-mail como usuário de
   teste. Escopos usados pelo app: `https://www.googleapis.com/auth/calendar.freebusy` (só livre/ocupado)
   e, se quiser que o app crie blocos, `https://www.googleapis.com/auth/calendar.app.created` (cria uma
   agenda "Rotinas" e mexe apenas nos eventos dela).
3. Em **Credenciais**, crie um "ID do cliente OAuth" do tipo **Aplicativo da Web** com o URI de
   redirecionamento autorizado **idêntico** ao do `.env`: `http://127.0.0.1:5173/api/calendar/callback`
   (com `npm run dev`) e/ou `http://127.0.0.1:8787/api/calendar/callback` (com `npm start`).
4. No `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` e uma chave gerada com:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   em `TOKEN_ENCRYPTION_KEY`. Reinicie o servidor.
5. No app: **Calendário externo** → **Autorizar uso do calendário externo** → **Conectar só
   disponibilidade**. Para o app criar blocos, use **Permitir criar blocos confirmados**. Toda criação
   mostra uma prévia (horário, duração e conflitos) e só acontece depois de **Confirmar e criar**.
6. Para desconectar: **Desconectar e revogar** (revoga no Google e apaga os tokens do servidor). Você
   também pode revogar em <https://myaccount.google.com/permissions>.

Com a tela de consentimento em modo **Teste**, o Google informa que os tokens de renovação expiram em
7 dias ([documentação do Google](https://developers.google.com/identity/protocols/oauth2)); o app passa
a mostrar "não conectado" e basta conectar de novo. Publicar o app OAuth evita isso, mas pode exigir
verificação pelo Google para esses escopos.

## Notificações

- Desligadas por padrão. Ative em **Configurações → Notificações → Lembretes locais**; o navegador
  pede permissão. Depois, ligue o lembrete em cada hábito (campo **Lembrete** no editor).
- Controles: janela de silêncio, dias permitidos, máximo por dia, desligar por hábito ou tudo de uma vez.
- Se a permissão for negada, a tela explica como liberar nas configurações do site no navegador.
- Os lembretes são notificações **locais** e aparecem enquanto o app está aberto (aba ou app instalado).
  Não há push com o app fechado (exigiria um serviço de push e um servidor sempre ligado). WhatsApp não
  faz parte do app.

## Privacidade e segurança

- **No aparelho por padrão.** Nada sai do navegador sem uma autorização específica e revogável:
  coaching por IA, check-ins no Kai, Diário no Kai, Google Calendar e notificações têm controles
  separados (com data e versão registradas). A tela **Privacidade** (em **Mais**, ou pelo link em
  Configurações → Autorizações) mostra o que fica no aparelho e o que seria enviado a cada provedor.
- **Contexto mínimo para o Kai.** Vão o objetivo, a disponibilidade, os hábitos com referências
  curtas (`h1`, `g1`…), agregados do período e — só com as autorizações próprias — notas de check-in e
  trechos do Diário (até 600 caracteres por entrada). Não vão nome, observações nem identificadores internos.
- **Segredos só no servidor.** Chave da Anthropic e credenciais do Google vivem no `.env`; os tokens
  OAuth ficam criptografados (AES-256-GCM) em `.data/`, fora do controle de versão. O navegador nunca
  recebe chaves ou tokens.
- **Proteções da camada privada:** escuta em `127.0.0.1` por padrão; checagem de origem e exigência
  de JSON em chamadas que alteram estado; senha opcional; limite de taxa; logs só técnicos (rota,
  status, duração, modelo, contagem de tokens — nunca conteúdo); cabeçalhos de segurança no `npm start`.
- **Prompt injection:** as regras do Kai ficam só nas instruções do sistema; seus dados vão como JSON
  marcado como não confiável; o Kai não tem ferramentas; a resposta precisa seguir um esquema e é
  validada no servidor.
- **Esta versão não passou por auditoria de segurança nem por revisão jurídica**, e não alega
  conformidade com normas ou certificações. Antes de expor o servidor fora do seu computador ou de
  usar o app com dados de outras pessoas, faça essas revisões.

## Estrutura do projeto

```text
src/
  app/          raiz, rotas (HashRouter), layout e contexto (perfil, fuso, "hoje")
  components/   interface base: botões, formulários, diálogos, avisos, gráficos acessíveis
  db/           IndexedDB (Dexie): esquema versionado, migrações, repositórios, backup, hooks
  domain/       regras puras: datas civis e fusos, recorrência, sequência, métricas, XP, metas,
                agenda, relatórios, contexto e evidências do Kai, plano de lembretes
  features/     telas: onboarding, Hoje, Hábitos, Metas, Agenda, Relatórios, Diário, Kai,
                Calendário externo, Configurações e Privacidade
  lib/          rede (único ponto de saída, com checagem de consentimento), PWA, notificações
  styles/       tokens de design (claro/escuro), base e componentes
shared/         contratos validados entre app e camada privada (Kai e calendário)
server/         camada privada opcional: Hono, adaptador Anthropic, OAuth/Calendar, proteções
tests/          unidade, banco, servidor e componentes (Vitest)
e2e/            fluxos no navegador (Playwright + axe-core)
sources/        material de referência (somente leitura)
docs/           arquitetura e decisões
```

## Limitações conhecidas

Estas limitações continuam existindo nesta versão:

- Kai e Google Calendar foram testados só com dublês locais; ainda não foram exercitados com
  credenciais reais. O primeiro uso real deve ser acompanhado (ver seções de ativação).
- Lembretes só aparecem com o app aberto; não há push em segundo plano.
- Sem sincronização entre aparelhos ou navegadores (fora do escopo); a estratégia é backup manual.
- O backup JSON não é criptografado.
- Recorrência de hábitos: diária ou por dias da semana. Agenda: diária ou semanal (com intervalo e
  fim por data ou contagem). Recorrência mensal/anual não foi implementada.
- Itens da agenda criados no Google a partir do app não são apagados no Google quando apagados no app
  (a tela avisa); não há sincronização de volta (eventos externos só entram como "ocupado").
- O limite de taxa do Kai fica em memória e reinicia junto com o servidor.
- Interface só em português do Brasil; o formato visual dos campos de data segue o navegador.
- Os testes automáticos rodam no Chromium (Chrome/Edge). O Safari do iPad não foi testado automaticamente;
  a compatibilidade foi revisada recurso por recurso, mas só um uso real no iPad confirma.
- O pacote JavaScript principal tem cerca de 0,9 MB (aprox. 270 KB com gzip), sem divisão por rota.
