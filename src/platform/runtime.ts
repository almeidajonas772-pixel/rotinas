/**
 * Em que ambiente o Rotinas está rodando.
 *
 * - `web`: o app publicado como site (Vercel ou computador). Dados no IndexedDB do navegador;
 *   Kai e Google passam pela camada privada (servidor) em /api.
 * - `claude`: o app publicado como artifact dentro do Claude (claude.ai). Não há servidor:
 *   o Kai usa o plano do Claude da própria pessoa (capacidade `sample`), o Google Agenda usa o
 *   conector do Claude (capacidade `mcp`) e os dados ficam guardados na área privada da pessoa
 *   neste artifact (capacidade `db`), com uma cópia local no IndexedDB.
 *
 * O ambiente é decidido no build (`vite build --mode claude`). Os testes podem trocá-lo.
 */

export type Runtime = 'web' | 'claude';

function initialRuntime(): Runtime {
  // Substituído no build (vite.config.ts, modo `claude`). Sem optional chaining, para a troca funcionar.
  return import.meta.env.VITE_ROTINAS_RUNTIME === 'claude' ? 'claude' : 'web';
}

let current: Runtime = initialRuntime();

export function getRuntime(): Runtime {
  return current;
}

export function isClaudeRuntime(): boolean {
  return current === 'claude';
}

/** Só para testes: simula o ambiente do Claude (ou volta ao web). */
export function setRuntimeForTests(runtime: Runtime): void {
  current = runtime;
}
