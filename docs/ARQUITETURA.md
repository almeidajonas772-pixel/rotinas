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
| Banco local | IndexedDB via Dexie 4 (`rotinas`, versão 2) | Fonte de verdade transacional, com índices e migrações; `localStorage` guarda só preferências leves de interface (prefixo `rotinas:ui:`) |
| Validação | Zod 4 em todas as escritas e no servidor | Um único esquema por entidade, mensagens em pt-BR |
| Datas | Datas civis `AAAA-MM-DD` para recorrência, sequência e métricas; Luxon para fusos | Mudança de fuso ou horário de verão não desloca o dia local |
| Offline | `vite-plugin-pwa` (Workbox, `registerType: 'prompt'`), pré-cache de JS/CSS/HTML/fontes/ícones | Abre sem internet depois da primeira visita ao build; a API nunca é cacheada |
| Camada privada | Node + Hono (`server/`), mesma origem via proxy em desenvolvimento ou `npm start` | Segredos e tokens só no servidor; o navegador nunca vê chaves |
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
- O Kai só existe com a camada privada rodando e `ANTHROPIC_API_KEY` definida. Sem isso, a interface
  diz que ele está indisponível e explica como ativar; nenhuma resposta é fabricada.
- O Google Calendar só existe com credenciais OAuth configuradas pela pessoa no Google Cloud.

## 4. Modelo de dados (IndexedDB, versão 2)

Índices em `src/db/db.ts`; esquemas Zod em `src/domain/schemas.ts`. Toda escrita passa por um
repositório em `src/db/repo-*.ts`, dentro de transação.

| Tabela | Chave e índices | Conteúdo |
| --- | --- | --- |
| `profile` | `id` (`me`) | nome opcional, fuso, objetivo principal, disponibilidade (períodos, minutos/dia, janelas), datas |
| `prefs` | `id` (`prefs`) | tema, início da semana, consentimentos versionados (`kai`, `kaiCheckins`, `kaiJournal`, `calendar`, `notifications`), notificações (canal, silêncio, dias, limite diário), recursos (check-in), senha opcional do servidor |
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
| `notificationLog` | `id`, `date` | quais lembretes já foram mostrados (idempotência e limite diário) |

**Migrações.** `version(1)` → `version(2)` adiciona `notificationLog` e completa preferências e
hábitos antigos (`src/db/migrations.ts`). A mesma função migra backups antigos na importação. Um
banco gravado por versão mais nova é recusado com mensagem clara.

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

## 7. Google Calendar (Etapa 4)

- Escopos: `calendar.freebusy` (somente livre/ocupado, sem títulos ou detalhes) e, só se a pessoa
  pedir para criar blocos, `calendar.app.created` (cria uma agenda secundária “Rotinas” e gerencia
  apenas os eventos dela). Nenhum escopo de leitura de eventos é solicitado.
- OAuth para app web: `state` aleatório de uso único (10 min), troca de código no servidor, tokens
  criptografados em repouso (AES‑256‑GCM, chave `TOKEN_ENCRYPTION_KEY`, arquivo com permissão 600).
- Escrita em duas fases: **prévia** (valida blocos, consulta conflitos e devolve um `previewId` de uso
  único válido por 10 min) e **confirmação** (`confirm: true` + `previewId`). Sem as duas, o servidor
  recusa. A interface mostra horário, duração e conflitos e pede confirmação num diálogo próprio.
- Os itens continuam nascendo na agenda do Rotinas (fonte de verdade); o evento externo fica como
  referência (`external`). Apagar no app não apaga no Google (avisado na tela).
- Desconectar revoga o token no Google e apaga o arquivo de tokens. Se o Google responder
  `invalid_grant` (acesso revogado ou expirado), o servidor apaga os tokens e o app mostra
  “não conectado”.

## 8. Segurança da camada privada

- Segredos apenas em variáveis de ambiente (`.env` fora do controle de versão; `.env.example` sem valores).
- Para métodos que alteram estado: origem precisa estar na lista permitida; corpo precisa ser JSON
  (bloqueia formulários de outros sites); senha opcional `ROTINAS_SERVER_TOKEN` comparada em tempo constante.
- Servidor escuta em `127.0.0.1` por padrão e avisa se for exposto sem senha.
- `npm start` envia cabeçalhos de segurança (CSP restritiva, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`).
- **Esta versão não passou por auditoria de segurança nem por revisão jurídica.** Antes de expor o
  servidor fora do seu computador, ou de usar o app com dados de outras pessoas, essas revisões são necessárias.

## 9. Matriz de testes

| Camada | Onde | O que prova | O que **não** prova |
| --- | --- | --- | --- |
| Domínio | `tests/unit/*` | recorrência, fuso e horário de verão, sequência, taxa, XP/nível, metas, agenda, relatórios, contexto e evidências do Kai, lembretes | — |
| Banco | `tests/db/repos.test.ts` (fake-indexeddb) | CRUD, idempotência, migração v1→v2, backup/restauração, privacidade do Diário, consentimentos, limpeza | comportamento de cotas de cada navegador |
| Servidor | `tests/server/*` | rotas do Kai com provedor dublê; OAuth/Calendar com `fetch` dublê; criptografia de tokens; limites e proteções | chamadas reais à Anthropic ou ao Google |
| Componentes | `tests/components/*` | onboarding com e sem IA, Hoje, falha honesta do Kai, Diário privado, relatório vazio, ausência de rede | — |
| Ponta a ponta | `e2e/*` (Chromium, móvel e desktop, build de produção) | primeiro uso → hábito → conclusão → recarga → histórico; offline; backup, limpeza e restauração; metas; agenda recorrente; acessibilidade (axe) e ausência de requisições externas | Kai e Google reais (o e2e roda sem a camada privada) |

Testar o Kai e o Google de verdade depende de credenciais suas (ver README, seções “Ativar o Kai” e
“Conectar o Google Calendar”).
