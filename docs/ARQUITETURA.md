# Rotinas — arquitetura, decisões e premissas

Documento técnico do app pessoal **Rotinas** (assistente opcional **Kai**). Complementa o
[README](../README.md), que cobre execução, backup e ativação dos recursos opcionais.

## 1. Inventário inicial (Etapa 0)

- O projeto recebido continha apenas `vite.config.ts` (Vite + React + `vite-plugin-pwa`, proxy `/api`
  para `127.0.0.1:8787`) e `index.html`. Os dois arquivos foram **mantidos sem alteração** e o restante
  foi construído sobre eles.
- `sources/Relatorio_IA_Aplicativo_Rotinas_2026.docx` é referência somente leitura (arquivo com
  permissão 444). Dele vieram apenas direções de produto (rastreamento simples, planejamento com
  tempo disponível, check-ins e análises periódicas sem excesso, IA como apoio à decisão, IA atrás de
  camada privada, privacidade por padrão). Preços, percentuais, comparações e nomes de modelos do
  relatório **não** foram usados como fatos nem como texto do app.

## 2. Decisões técnicas

| Tema | Decisão | Motivo |
| --- | --- | --- |
| App | PWA React 19 + TypeScript 6, Vite 8, `react-router` 7 com `HashRouter` | Base já existente; o hash evita configuração de servidor para rotas e funciona offline com o service worker |
| Banco local | IndexedDB via Dexie 4 (`rotinas`, versão 3) | Fonte de verdade transacional, com índices e migrações; `localStorage` guarda só preferências leves de interface (prefixo `rotinas:ui:`) |
| Validação | Zod 4 em todas as escritas e no servidor | Um único esquema por entidade, mensagens em pt-BR |
| Datas | Datas civis `AAAA-MM-DD` para recorrência, sequência e métricas; Luxon para fusos | Mudança de fuso ou horário de verão não desloca o dia local |
| Offline | `vite-plugin-pwa` (Workbox, `registerType: 'prompt'`), pré-cache de JS/CSS/HTML/fontes/ícones | Abre sem internet depois da primeira visita ao build; a API nunca é cacheada |
| Camada privada | Node + Hono (`server/`), sempre na mesma origem do app: proxy em desenvolvimento, `npm start` no computador ou função da Vercel (`server/vercel.ts`, Build Output API) | Segredos e tokens só no servidor; o navegador nunca vê chaves |
| Armazenamento do servidor | Vercel Blob **privado** (OIDC, sem segredo no código) na nuvem; arquivo com permissão 600 no computador | Tokens do Google cifrados e contador diário do Kai sobrevivem entre execuções da função |
| Voz | Web Speech API do navegador (síntese e reconhecimento), sem serviço extra | Zero custo e zero chave nova; vozes locais por padrão; reconhecimento só com autorização própria |
| IA | Um adaptador real: Anthropic (`@anthropic-ai/sdk`), saída estruturada por JSON Schema | Pedido do prompt; modelos configuráveis no servidor |
| Calendário | Google Calendar por OAuth 2.0 para app web, chamadas REST via `fetch` | Sem SDK pesado; escopos mínimos verificáveis |
| Gráficos | SVG próprio (`src/components/charts.tsx`) com legenda, unidade, método e tabela alternativa | Controle total de acessibilidade e de estados vazios |
| Testes | Vitest (jsdom + fake-indexeddb), Testing Library, Playwright + axe-core | Unidade, banco, servidor, componentes e ponta a ponta |

## 3. Premissas registradas

- Um único usuário, um navegador: não há contas, login, cobrança, administração nem sincronização em nuvem.
- Idioma da interface: português do Brasil (único idioma disponível; o campo existe no onboarding).
- O "hoje" de tudo é calculado no fuso do perfil (`todayInZone`), não no fuso do sistema.
- Recorrências implementadas: hábito diário ou em dias da semana (com versões de agenda ao editar);
  itens da agenda com repetição diária ou semanal (intervalo, fim por data ou por contagem). Outras
  recorrências (mensal, anual) **não** foram implementadas; o tipo de agenda (`kind`) é extensível.
- Lembretes são notificações locais do navegador disparadas enquanto o app (aba ou PWA instalado)
  está aberto. Push com o app fechado exigiria um serviço de push e servidor sempre ligado — fora do escopo.
- O Kai só existe com a camada privada publicada e `ANTHROPIC_API_KEY` definida. Sem isso, a interface
  diz exatamente o que falta (tela Conectar Kai e Google); nenhuma resposta é fabricada.
- O Google Calendar só existe com credenciais OAuth configuradas pela pessoa no Google Cloud.
- A "noite" de um dia vai até 04:00 do dia seguinte: quem fecha o dia depois da meia-noite continua
  fechando o dia anterior (`nightDateFor`).

## 4. Modelo de dados (IndexedDB, versão 3)

Índices em `src/db/db.ts`; esquemas Zod em `src/domain/schemas.ts`. Toda escrita passa por um
repositório em `src/db/repo-*.ts`, dentro de transação.

| Tabela | Chave e índices | Conteúdo |
| --- | --- | --- |
| `profile` | `id` (`me`) | nome opcional, fuso, objetivo principal, disponibilidade (períodos, minutos/dia, janelas), datas |
| `prefs` | `id` (`prefs`) | tema, início da semana, consentimentos versionados (`kai`, `kaiCheckins`, `kaiJournal`, `kaiAgenda`, `calendar`, `voice`, `notifications`), notificações (canal, silêncio, dias, limite diário), recursos (check-in), senha do servidor, noite (lembrete, voz, velocidade, conversa contínua) |
| `habits` | `id`, `status`, `order`, `goalId` | título, intenção, categoria, `scheduleHistory` (versões com data de início), `pauses`, horário/janela, duração, lembrete, XP, primeiro passo, meta |
| `completions` | `id` = `hábito\|data`, `habitId`, `scheduledDate`, `[habitId+scheduledDate]` | estado `done`/`skipped`, horário real, fuso no momento do registro, observação, XP gravado, origem (`manual`; o valor `calendar` está reservado — nesta versão nenhuma integração cria conclusões) |
| `agendaItems` | `id`, `seriesKind`, `[seriesKind+date]`, `kind`, `habitId`, `goalId` | tipo (`task`, `event`, `habit`), título, data, dia inteiro ou início/fim, fuso do item, recorrência, exceções por ocorrência, meta, origem (`manual`, `proposal`, `kai`), referência externa |
| `agendaCompletions` | `id` = `item\|data original`, `itemId`, `occurrenceDate` | conclusão de tarefa/evento por ocorrência e XP gravado |
| `checkins` | `date` | humor e energia (1–5, opcionais) e nota |
| `journal` | `id`, `&date` (único) | texto livre, "o que fiz", "o que funcionou", "o que melhorar", "próximo passo", vínculos (hábitos, metas, agenda), `kaiAccess` por entrada |
| `goals` | `id`, `horizon`, `status`, `parentId` | horizonte (`year`, `month`, `week`, `day`), período, regra de progresso, meta‑pai opcional, conclusão |
| `goalProgress` | `id`, `goalId`, `createdAt` | atualizações manuais (marcadas como manuais na interface) |
| `progressEvents` | `id`, `type`, `refId`, `localDate` | XP derivado: `habit:<conclusão>`, `agenda:<conclusão>`, `goal:<meta>` |
| `kaiInsights` / `kaiConversations` | `id`, `kind`/`updatedAt`, `createdAt` | resultados estruturados do Kai com período, categorias de dados enviados, modelo, estado |
| `integrations` | `id` | provedor, estado, escopos, data de autorização — **sem tokens** |
| `notificationLog` | `id`, `date` | quais lembretes já foram mostrados (`habit_reminder`, `night_reminder`): idempotência e limite diário |
| `dayPlans` | `date` | prioridade nº 1 do dia (texto, origem manual/voz/Kai) e resultado (cumprida ou não) |
| `nightSessions` | `id` (= data), `date`, `updatedAt` | conversa da noite (até 120 falas), propostas do Kai com estado (pendente, aceita, dispensada, item criado) e evidências descritas pelo app |

**Migrações.** `version(1)` → `version(2)` adiciona `notificationLog` e completa preferências e
hábitos antigos; `version(3)` adiciona `dayPlans` e `nightSessions`, as preferências da noite e as
autorizações `kaiAgenda` e `voice` (desligadas). As mesmas funções migram backups antigos na
importação. Um banco gravado por versão mais nova é recusado com mensagem clara.

**Versão do texto de cada autorização.** `CONSENT_VERSIONS` (`src/db/defaults.ts`) guarda a versão
vigente de cada texto. Uma autorização concedida para um texto anterior não é apagada do banco, mas
o app a enxerga desligada (`effectivePrefs`, com `outdated: true`) até a pessoa revisar o texto novo.
Nesta versão mudaram `kai` (inclui a sessão da noite) e `calendar` (inclui a leitura de eventos).

## 5. Regras de cálculo (determinísticas e testadas)

- **Ocorrência prevista**: o hábito está ativo, a data é ≥ início, não está pausado nem arquivado e
  a versão de agenda vigente naquele dia inclui o dia da semana.
- **Conclusão idempotente**: a chave `hábito|data` impede duplicar; repetir a ação não soma de novo.
  Não é possível registrar no futuro nem em dia sem ocorrência prevista.
- **Taxa de conclusão** = concluídas ÷ (concluídas + perdidas). Puladas ficam fora; a ocorrência de
  hoje só conta depois de registrada ou quando o dia termina.
- **Sequência (streak)**: percorre somente ocorrências previstas. Concluída soma; pulada é neutra;
  prevista sem registro em dia passado zera; hoje em aberto não quebra. Dias sem ocorrência não contam.
- **XP e nível**: só eventos reais. Nível `L` exige `50·L·(L−1)` XP acumulado. O XP da conclusão é
  gravado no momento (editar o XP do hábito depois não reescreve o passado). Desfazer remove o evento.
  Na abertura do app, uma verificação compara os eventos com as fontes e reconstrói se divergirem.
- **Progresso de metas** (regra explícita por meta): conclusão manual; valor manual (último valor
  informado, identificado como manual); itens vinculados (conclusões reais de hábitos e tarefas ligados
  à meta, opcionalmente das metas filhas); metas filhas concluídas. Sem regra de itens vinculados,
  hábitos ligados aparecem como apoio, mas **não** mudam o progresso.
- **Metas filhas**: só aceitam pai de horizonte mais longo com período que se cruza; sem ciclos.

## 6. Kai (Etapa 3)

Fluxo de uma chamada:

1. A tela monta o contexto **no aparelho** (`src/domain/kai-context.ts`): objetivo e disponibilidade,
   hábitos com referências curtas (`h1`, `h2`…), agregados do período (previstas, concluídas,
   puladas, perdidas, em aberto, taxa, sequência), metas (`g1`…). **Não vão**: nome, observações,
   ids internos, agenda detalhada. Check-ins só com o recurso ligado e a autorização `kaiCheckins`.
   Diário só com a autorização `kaiJournal` **e** a entrada permitida, no máximo 600 caracteres por
   entrada e 7 entradas. O mapa `h1 → id real` fica no aparelho.
2. `src/lib/api.ts` é o único ponto de rede: sem consentimento, lança erro antes de qualquer `fetch`.
3. O servidor (`server/kai/routes.ts`) valida o pedido (Zod), aplica limiares de dados mínimos
   (revisão semanal: ≥ 7 ocorrências encerradas e ≥ 5 dias com hábitos previstos; observação sobre
   um hábito: ≥ 4 ocorrências encerradas), limita a taxa (por minuto e teto diário) e só então chama
   o provedor.
4. O provedor recebe instruções fixas no *system prompt* e os dados como JSON não confiável dentro de
   marcadores (com `<` e `>` escapados), sem ferramentas, com resposta presa a um JSON Schema.
5. A resposta é ajustada aos limites que o provedor não impõe (listas longas cortadas, referências
   fora do formato descartadas), validada pelo esquema completo e pós-processada (referências que não
   existem no contexto são removidas; o período da revisão é sempre o pedido). Falha em qualquer etapa
   → erro explícito na tela; **nada é inventado**.
6. No aparelho, cada observação da revisão mostra a evidência calculada **localmente** a partir dos
   registros citados (ex.: “Ler: 4 de 13 ocorrências previstas concluídas (31%), de 04/10 a 17/10”).

Modelos por configuração do servidor: `KAI_MODEL_FAST` (conversa, próximo passo) e `KAI_MODEL_DEEP`
(plano inicial, revisão semanal, divisão de metas). Logs técnicos: rota, status, duração, modelo e
contagem de tokens — nunca o conteúdo. Crise, saúde, medicamentos e finanças: o *system prompt*
proíbe aconselhamento especializado, a resposta marca `supportNotice` e a interface mostra CVV (188)
e SAMU (192).

### 6.1 Sessão da noite

- `src/domain/nightly.ts` calcula no aparelho o **resumo da noite** (função pura, testada): hábitos de
  hoje com estado e "ainda dá tempo", XP do dia, tarefas de hoje, agenda de amanhã (Rotinas + eventos do
  Google convertidos para o fuso do perfil), horários dos hábitos de amanhã, **janelas livres** (janelas
  de disponibilidade menos compromissos com horário), primeiro compromisso, **radar de provas e
  prazos** dos próximos 7 dias (palavras do título, sem acentos; inclui siglas locais como “AGI”),
  ritmo das metas (progresso atual × esperado para os dias já passados) e sinais factuais.
- Sem o Kai, o app lê esse resumo em voz alta (`nightSpeech`), sem IA e sem rede.
- Com o Kai, `src/domain/nightly-kai.ts` monta `NightlyContext`: números do dia e referências curtas;
  itens de agenda viram `t1` (hoje), `a1` (amanhã) e `u1` (próximos dias) **só com a autorização
  `kaiAgenda`**; sem ela, sinais que citam a agenda são omitidos. O check-in de hoje só entra com a
  autorização de check-ins. O nome nunca vai.
- `POST /api/kai/nightly` usa o modelo rápido (até 1.000 tokens), histórico de até 16 falas e um
  roteiro próprio: fala curta para síntese de voz, uma pergunta por vez, até 3 propostas com
  referências. O servidor descarta referências inexistentes, só mantém horário de `bloco_amanha` que
  caiba numa janela livre enviada e não sobreponha a agenda (senão vira `tarefa_amanha`, sem horário).
- Aceitar uma proposta cria o item na agenda do Rotinas (origem `kai`) e guarda o id para desfazer.
  A prioridade nº 1 vai para `dayPlans` do dia seguinte e aparece em Hoje; na noite seguinte, o resumo
  pergunta se foi cumprida (`lastPriority`).

### 6.2 Voz

- `src/lib/speech.ts`: síntese com escolha de voz (português do Brasil, vozes locais primeiro; vozes
  online só com a autorização `voice`), texto dividido em frases curtas e "destravamento" no primeiro
  toque (iOS); reconhecimento de uma frase por vez (`continuous = false`, parciais na tela).
- O reconhecimento exige a autorização `voice`, porque o navegador pode enviar o áudio ao fabricante.
  O Rotinas não grava áudio; só o texto reconhecido segue (e só vai ao Kai com a autorização do Kai).
- Apps instalados na Tela de Início do iPad/iPhone não têm reconhecimento de fala do navegador
  (WebKit, bug 225298): a tela detecta e orienta usar o ditado do teclado. A síntese continua.
- `Permissions-Policy: microphone=(self)` libera o microfone só para o próprio site.

## 7. Google Calendar (Etapa 4)

- Escopos, pedidos só quando a pessoa escolhe: `calendar.freebusy` (livre/ocupado), opcionalmente
  `calendar.events.owned.readonly` (título, horário, cor e disponibilidade dos eventos da agenda
  principal — o servidor pede só esses campos ao Google, nunca descrição, local ou participantes) e,
  para criar blocos, `calendar.app.created` (agenda secundária “Rotinas”). `include_granted_scopes`
  soma as permissões.
- OAuth para app web, sem estado em memória entre execuções (necessário na função da Vercel):
  `state` **assinado** (HMAC, 10 min) e de uso único por instância; troca de código no servidor; tokens
  cifrados em repouso (AES‑256‑GCM) no Blob privado ou em arquivo. A autorização abre numa aba/folha
  própria (link preparado com antecedência, sem bloqueio de pop-up); a página de retorno não redireciona
  e o app atualiza o estado quando volta ao primeiro plano.
- Escrita em duas fases: **prévia** (valida blocos, consulta conflitos e devolve um comprovante
  assinado, válido por 10 min e preso ao hash dos blocos) e **confirmação** (`confirm: true` + o
  comprovante + os mesmos blocos). Cada evento recebe um id determinístico derivado do comprovante:
  confirmar de novo (ex.: resposta perdida) não duplica, e uma falha parcial é completada sem duplicar.
- Os itens continuam nascendo na agenda do Rotinas (fonte de verdade); o evento externo fica como
  referência (`external`). Apagar no app não apaga no Google (avisado na tela).
- Desconectar revoga o token no Google e apaga o arquivo de tokens. Se o Google responder
  `invalid_grant` (acesso revogado ou expirado), o servidor apaga os tokens e o app mostra
  “não conectado”.

## 8. Segurança da camada privada

- Segredos apenas em variáveis de ambiente (`.env` fora do controle de versão; na Vercel, variáveis
  marcadas como Sensitive). `.env.example` sem valores.
- **Na nuvem a senha é obrigatória**: sem `ROTINAS_SERVER_TOKEN` (12+ caracteres) todas as rotas
  respondem `server_locked`, exceto o retorno do OAuth (que também se recusa a concluir). Comparação em
  tempo constante; 10 tentativas erradas em 10 minutos bloqueiam o endereço por 10 minutos.
- Sem `TOKEN_ENCRYPTION_KEY`, as chaves de cifra e de assinatura são derivadas da senha (scrypt +
  HMAC com rótulos distintos). Trocar a senha invalida os tokens guardados (o Google aparece como
  desconectado e basta reconectar).
- Para métodos que alteram estado: a origem precisa ser a do próprio site (lista permitida ou mesmo
  host atrás do proxy) e o corpo precisa ser JSON (bloqueia formulários de outros sites).
- Cabeçalhos de segurança no `npm start` e na Vercel (mesma fonte, `shared/security-headers.ts`): CSP
  restritiva, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `COOP` e
  `Permissions-Policy` (câmera e localização bloqueadas; microfone só no próprio site).
- **Esta versão não passou por auditoria de segurança nem por revisão jurídica.** Antes de expor o
  servidor fora do seu computador, ou de usar o app com dados de outras pessoas, essas revisões são necessárias.

## 9. Matriz de testes

| Camada | Onde | O que prova | O que **não** prova |
| --- | --- | --- | --- |
| Domínio | `tests/unit/*` | recorrência, fuso e horário de verão, sequência, taxa, XP/nível, metas, agenda, relatórios, contexto e evidências do Kai, lembretes | — |
| Domínio (noite e voz) | `tests/unit/nightly.test.ts`, `tests/unit/speech.test.ts` | resumo da noite, virada depois da meia-noite, janelas livres, eventos do Google em fuso local, provas e prazos, ritmo de metas, fala do app, dados enviados com e sem autorização da agenda, lembrete da noite, escolha de voz e reconhecimento | vozes e reconhecimento reais de cada navegador |
| Banco | `tests/db/repos.test.ts` (fake-indexeddb) | CRUD, idempotência, migrações v1→v3 e v2→v3, versões de texto das autorizações, prioridade do dia, sessões da noite, backup/restauração, privacidade do Diário, consentimentos, limpeza | comportamento de cotas de cada navegador |
| Servidor | `tests/server/*` | rotas do Kai (inclusive a noite) com provedor dublê; OAuth/Calendar com `fetch` dublê (state assinado, eventos, prévia e confirmação idempotentes, falha parcial, `invalid_grant`); modo nuvem (senha, bloqueio, origem atrás do proxy, Blob); assinaturas; entrada da Vercel | chamadas reais à Anthropic, ao Google ou ao Blob |
| Componentes | `tests/components/*` | onboarding com e sem IA, Hoje (prioridade do dia), Noite sem e com Kai (dados enviados, proposta aceita, prioridade), assistente de conexão, falha honesta do Kai, Diário privado, relatório vazio, ausência de rede | — |
| Ponta a ponta | `e2e/*` (Chromium, móvel e desktop, build de produção) | primeiro uso → hábito → conclusão → recarga → histórico; offline; backup, limpeza e restauração; metas; agenda recorrente; acessibilidade (axe) e ausência de requisições externas | Kai e Google reais (o e2e roda sem a camada privada) |

Testar o Kai e o Google de verdade depende de credenciais suas (ver README, seções “Ativar o Kai” e
“Conectar o Google Calendar”). A tela **Conectar Kai e Google** faz um teste real do Kai, sem dados pessoais.

## 10. Publicação na Vercel

- `vercel.json` manda a Vercel rodar `npm run build:vercel`: `vite build` gera o app e
  `scripts/build-vercel.mjs` monta `.vercel/output` (Build Output API v3) com o app estático, a função
  `api.func` (Node 22, um arquivo empacotado com esbuild) e as rotas (cabeçalhos, arquivos estáticos e
  `/api/*` → função, preservando o caminho original).
- A função cria o app Hono uma vez por instância e lê a configuração das variáveis do projeto;
  `VERCEL=1` liga o modo nuvem. O domínio de produção (`VERCEL_PROJECT_PRODUCTION_URL`) define a origem
  aceita e o endereço de retorno do Google.
- Limites: o limite por minuto do Kai vale por instância; o teto diário fica no Blob (falha aberta se o
  armazenamento não responder — o limite de gasto do Console é o teto definitivo).

## 11. Rotinas dentro do Claude (sem custo extra)

Motivo: a única parte paga era o Kai pela API da Anthropic (e, para o Google, um projeto próprio no
Google Cloud). Dentro do Claude, o app usa as capacidades da plataforma de artifacts (contrato 0.2.87):

- **Ambiente** (`src/platform/runtime.ts`): `vite build --mode claude` define `VITE_ROTINAS_RUNTIME`;
  o mesmo código decide entre `web` e `claude`. `scripts/build-claude.mjs` monta uma página só com
  JS, CSS e fontes embutidos (o artifact recebe apenas o conteúdo; a plataforma acrescenta o esqueleto).
- **Kai** (`src/platform/kai-claude.ts`): capacidade `sample`, sem system prompt controlado pela página.
  As regras do Kai vão no início da mensagem, os dados do app entram como JSON escapado dentro de tags
  (marcados como dados) e o formato pedido é o JSON Schema de saída. A resposta passa pelos mesmos
  `fitToSchema`, validação Zod e `postprocess` da camada privada (`shared/kai-core.ts`). `cache: false`
  (é uma conversa), níveis `quick`/`default`, limite de 10 pedidos/minuto e erros da plataforma
  traduzidos (`describeSampleFailure`).
- **Google** (`src/platform/calendar-claude.ts`): capacidade `mcp`, conector `Google Calendar`.
  Leituras com `cache: false`; de cada evento ficam só título, horários, dia inteiro, ocupado e cor.
  Eventos criados pelo app levam a marca “Criado pelo app Rotinas” na descrição e são excluídos das
  leituras (já estão na agenda do app). Escrita só com prévia em memória (10 min, mesmos blocos) e
  confirmação; destino: agenda “Rotinas” se existir (`list_calendars`), senão a principal, em amarelo.
  Escritas nunca levam `AbortSignal` (o resultado ficaria incerto). Lembrete da noite: evento diário
  (`RRULE:FREQ=DAILY`), livre, com notificação popup na hora.
- **Dados** (`src/platform/cloud-sync.ts`, `src/sync/`): capacidade `db`, coleção privada
  `data/users/<id>` (id de `user.id()`). Cópia local no IndexedDB (ou em memória, se o navegador
  bloquear); registros agrupados em pacotes por tabela e período (`layout.ts`), cada um com data de
  modificação; o mais recente vence, exclusões viram marcas (180 dias), pacotes grandes são divididos
  e um registro maior que o limite fica só no aparelho (avisado na tela). Uma “sombra” local guarda o
  que já foi sincronizado para detectar mudanças sem reenviar tudo. O documento `meta` traz a versão do
  esquema (versão mais nova bloqueia a escrita) e a marca de “Apagar tudo”, que os outros aparelhos
  aplicam ao abrir. Preferências só do aparelho (senha do servidor, voz escolhida) não sobem.
- **Autorizações**: textos próprios do modo Claude (`CLAUDE_CONSENT_TEXTS`) com versões a partir de
  101, então uma autorização dada no site não vale dentro do Claude, nem o contrário.
- **Limites da plataforma**: sem service worker, notificações e microfone; downloads passam pela
  confirmação do Claude; o tema “do sistema” segue o tema do Claude.
- **Testes**: `tests/unit/{kai-claude,calendar-claude,sync-engine}.test.ts` e `e2e-claude/`, que
  carrega a página publicada dentro do esqueleto do artifact com um `window.claude` simulado (dois
  contextos do navegador como dois aparelhos, compartilhando o mesmo armazenamento).
