import type { KvStore } from '../storage';

/**
 * Teto diário persistente de pedidos ao Kai (útil na nuvem, onde cada instância tem sua memória).
 * Guarda só uma contagem por dia, sem conteúdo. Se o armazenamento falhar, o pedido segue:
 * o limite em memória continua valendo e o teto de gasto definitivo fica no Console da Anthropic.
 */
export interface DailyCounter {
  take(day: string, limit: number): Promise<boolean>;
}

export class KvDailyCounter implements DailyCounter {
  constructor(
    private kv: KvStore,
    private key = 'kai-usage.json',
  ) {}

  async take(day: string, limit: number): Promise<boolean> {
    try {
      const raw = await this.kv.get(this.key);
      let state = raw ? (JSON.parse(raw) as { day?: string; count?: number }) : null;
      if (!state || state.day !== day || typeof state.count !== 'number') state = { day, count: 0 };
      if ((state.count ?? 0) >= limit) return false;
      await this.kv.set(this.key, JSON.stringify({ day, count: (state.count ?? 0) + 1 }));
      return true;
    } catch {
      return true;
    }
  }
}
