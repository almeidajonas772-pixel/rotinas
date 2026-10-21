import { describe, expect, it } from 'vitest';
import { SyncEngine, type SyncDoc } from '../../src/sync/engine';
import { canonicalJson, recordHash } from '../../src/sync/hash';
import { defaultDocId, mergeFromSync, projectForSync } from '../../src/sync/layout';
import { MemoryLocal, MemoryRemote, MemoryShadow, settle } from '../fixtures/sync-memory';
import { testCompletion, testHabit, testJournal, testPrefs, testProfile } from '../fixtures/builders';

interface Device {
  local: MemoryLocal;
  shadow: MemoryShadow;
  engine: SyncEngine;
  clock: { t: number };
}

function device(remote: MemoryRemote, options: { local?: MemoryLocal; shadow?: MemoryShadow; t?: number; maxDocBytes?: number; schemaVersion?: number; retryMs?: number } = {}): Device {
  const clock = { t: options.t ?? 1_000_000 };
  const local = options.local ?? new MemoryLocal();
  const shadow = options.shadow ?? new MemoryShadow();
  const engine = new SyncEngine({
    local,
    remote,
    shadow,
    schemaVersion: options.schemaVersion ?? 3,
    now: () => clock.t,
    debounceMs: 5,
    retryMs: options.retryMs ?? 40,
    maxDocBytes: options.maxDocBytes,
  });
  return { local, shadow, engine, clock };
}

async function boot(d: Device): Promise<void> {
  await d.engine.start();
  expect(await d.engine.whenReady(2000)).toBe(true);
  await d.engine.flush();
}

async function step(...devices: Device[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await settle(15);
    for (const d of devices) await d.engine.flush();
  }
}

describe('sincronização pelo armazenamento do Claude', () => {
  it('um aparelho envia o que já tinha e um aparelho novo recebe tudo antes de mostrar a tela', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    a.local.put('profile', testProfile({ name: 'Leo' }));
    a.local.put('habits', testHabit({ id: 'h-ler', title: 'Ler 10 páginas' }));
    a.local.put('completions', testCompletion('h-ler', '2026-10-20'));
    await boot(a);
    await step(a);
    expect(remote.records('habits').get('h-ler')?.d?.title).toBe('Ler 10 páginas');
    expect(remote.records('completions').get('h-ler|2026-10-20')?.d?.status).toBe('done');
    expect(remote.docs.has('meta')).toBe(true);

    const b = device(remote, { t: 2_000_000 });
    const writesBefore = remote.writes.length;
    await boot(b);
    expect(b.local.get('profile', 'me')?.name).toBe('Leo');
    expect(b.local.get('habits', 'h-ler')?.title).toBe('Ler 10 páginas');
    expect(b.local.get('completions', 'h-ler|2026-10-20')).toBeTruthy();
    // XP é recalculado depois de receber conclusões.
    expect(b.local.afterApply.some((t) => t.has('completions'))).toBe(true);
    await step(b);
    // O aparelho novo não reenvia o que acabou de receber.
    expect(remote.writes.length).toBe(writesBefore);
  });

  it('mudanças e exclusões feitas num aparelho chegam ao outro', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    const b = device(remote, { t: 1_000_000 });
    await boot(a);
    await boot(b);
    a.clock.t = 1_100_000;
    a.local.put('habits', testHabit({ id: 'h1', title: 'Correr' }));
    await step(a, b);
    expect(b.local.get('habits', 'h1')?.title).toBe('Correr');

    b.clock.t = 1_200_000;
    b.local.put('habits', testHabit({ id: 'h1', title: 'Correr 20 min' }));
    await step(a, b);
    expect(a.local.get('habits', 'h1')?.title).toBe('Correr 20 min');

    a.clock.t = 1_300_000;
    a.local.remove('habits', 'h1');
    await step(a, b);
    expect(b.local.get('habits', 'h1')).toBeUndefined();
    expect(remote.records('habits').get('h1')?.d).toBeNull();
  });

  it('em mudanças simultâneas no mesmo registro, a mais recente vence (sem ficar repetindo envios)', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    const b = device(remote);
    await boot(a);
    await boot(b);
    a.local.put('habits', testHabit({ id: 'h1', title: 'Original' }));
    await step(a, b);
    b.engine.stop();
    // Os dois editam enquanto B está desligado; B editou depois.
    a.clock.t = 2_000_000;
    a.local.put('habits', testHabit({ id: 'h1', title: 'Versão do iPad' }));
    await step(a);
    const b2 = device(remote, { local: b.local, shadow: b.shadow, t: 3_000_000 });
    b2.local.put('habits', testHabit({ id: 'h1', title: 'Versão do computador' }));
    await boot(b2);
    await step(a, b2);
    expect(remote.records('habits').get('h1')?.d?.title).toBe('Versão do computador');
    expect(a.local.get('habits', 'h1')?.title).toBe('Versão do computador');
    const writes = remote.writes.length;
    await step(a, b2);
    expect(remote.writes.length).toBe(writes);
  });

  it('preferências: a senha do servidor e a voz escolhida ficam só no aparelho', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    const b = device(remote);
    const prefsA = testPrefs({ theme: 'dark', server: { accessToken: 'segredo-do-servidor' } });
    a.local.put('prefs', { ...prefsA, nightly: { ...prefsA.nightly, voiceURI: 'voz-do-ipad' } });
    await boot(a);
    await step(a);
    const stored = remote.records('prefs').get('prefs')?.d as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('segredo-do-servidor');
    expect(JSON.stringify(stored)).not.toContain('voz-do-ipad');
    expect(stored.theme).toBe('dark');

    const prefsB = testPrefs({ server: { accessToken: 'senha-do-pc' } });
    b.local.put('prefs', { ...prefsB, nightly: { ...prefsB.nightly, voiceURI: 'voz-do-pc' } });
    // B nunca sincronizou: o que veio do armazenamento (mais recente) vence nos campos compartilhados.
    b.clock.t = 500_000;
    await boot(b);
    await step(a, b);
    const local = b.local.get('prefs', 'prefs') as Record<string, unknown> & { nightly: { voiceURI?: string }; server: { accessToken?: string } };
    expect(local.theme).toBe('dark');
    expect(local.nightly.voiceURI).toBe('voz-do-pc');
    expect(local.server.accessToken).toBe('senha-do-pc');
    const writes = remote.writes.length;
    await step(a, b);
    // Sem pingue-pongue entre aparelhos com vozes diferentes.
    expect(remote.writes.length).toBe(writes);
  });

  it('registros com formato inválido vindos do armazenamento são ignorados', async () => {
    const remote = new MemoryRemote();
    const bad: SyncDoc = { v: 1, t: 'habits', r: { x: { m: 5, d: { id: 'x', title: '' } } } };
    remote.docs.set('c~habits', bad);
    const b = device(remote);
    await boot(b);
    expect(b.local.get('habits', 'x')).toBeUndefined();
    expect(b.engine.getStatus().invalid).toBe(1);
  });

  it('um pacote grande demais tira o maior registro para um pacote só dele', async () => {
    const remote = new MemoryRemote();
    const a = device(remote, { maxDocBytes: 4000 });
    await boot(a);
    // Dois registros que caem no mesmo pacote padrão.
    const docOf = (id: string, date: string) => defaultDocId('journal', id, { date });
    const first = 'j0';
    let second = 'j1';
    for (let i = 1; docOf(second, '2026-10-21') !== docOf(first, '2026-10-20'); i++) second = `j${i}`;
    a.local.put('journal', testJournal({ id: first, date: '2026-10-20', text: 'a'.repeat(3000) }));
    a.local.put('journal', testJournal({ id: second, date: '2026-10-21', text: 'b'.repeat(2500) }));
    await step(a);
    const all = remote.records('journal');
    expect(all.get(first)?.d).toBeTruthy();
    expect(all.get(second)?.d).toBeTruthy();
    expect([...remote.docs.keys()].some((id) => id.startsWith('s~journal~'))).toBe(true);
    for (const [id, doc] of remote.docs) if (id !== 'meta') expect(JSON.stringify(doc).length).toBeLessThanOrEqual(4000);
  });

  it('um registro que não cabe nem sozinho fica só no aparelho e o app avisa', async () => {
    const remote = new MemoryRemote();
    const a = device(remote, { maxDocBytes: 1500 });
    await boot(a);
    a.local.put('journal', testJournal({ id: 'j1', date: '2026-10-20', text: 'x'.repeat(4000) }));
    await step(a);
    expect(remote.records('journal').size).toBe(0);
    expect(a.engine.getStatus().unsyncable).toBe(1);
  });

  it('"Apagar tudo" limpa o armazenamento e os outros aparelhos apagam a cópia deles', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    const b = device(remote);
    a.local.put('habits', testHabit({ id: 'h1' }));
    await boot(a);
    await boot(b);
    await step(a, b);
    expect(b.local.get('habits', 'h1')).toBeTruthy();
    a.clock.t = 9_000_000;
    await a.engine.wipeEverything();
    expect(a.local.get('habits', 'h1')).toBeUndefined();
    expect([...remote.docs.keys()]).toEqual(['meta']);
    await step(a, b);
    expect(b.local.get('habits', 'h1')).toBeUndefined();
    // E nada volta depois.
    await step(a, b);
    expect(remote.records('habits').size).toBe(0);
  });

  it('dados gravados por uma versão mais nova do app bloqueiam o envio', async () => {
    const remote = new MemoryRemote();
    remote.docs.set('meta', { v: 1, schema: 99, updatedAt: '2026-10-20T00:00:00Z' });
    const a = device(remote);
    a.local.put('habits', testHabit({ id: 'h1' }));
    await boot(a);
    await step(a);
    expect(remote.records('habits').size).toBe(0);
    expect(a.engine.getStatus().state).toBe('blocked');
  });

  it('depois de fechar e abrir de novo, só o que mudou é enviado', async () => {
    const remote = new MemoryRemote();
    const a = device(remote);
    a.local.put('habits', testHabit({ id: 'h1' }));
    a.local.put('habits', testHabit({ id: 'h2' }));
    await boot(a);
    await step(a);
    a.engine.stop();
    a.local.put('habits', testHabit({ id: 'h2', title: 'Mudado offline' }));
    const writes = remote.writes.length;
    const again = device(remote, { local: a.local, shadow: a.shadow, t: 5_000_000 });
    await boot(again);
    await step(again);
    expect(remote.writes.length).toBe(writes + 1);
    expect(remote.records('habits').get('h2')?.d?.title).toBe('Mudado offline');
    expect(remote.records('habits').get('h1')?.m).toBe(1_000_000);
  });

  it('uma falha temporária do armazenamento é tentada de novo sozinha', async () => {
    const remote = new MemoryRemote();
    const a = device(remote, { retryMs: 250 });
    await boot(a);
    remote.failNext = { code: 'unavailable', message: 'instável' };
    a.local.put('habits', testHabit({ id: 'h1' }));
    await step(a);
    expect(a.engine.getStatus().state).toBe('error');
    expect(remote.records('habits').size).toBe(0);
    await settle(300);
    await a.engine.flush();
    expect(remote.records('habits').get('h1')?.d).toBeTruthy();
    expect(a.engine.getStatus().state).toBe('synced');
  });
});

describe('formato dos pacotes', () => {
  it('agrupa por tabela e período, com nomes aceitos pelo armazenamento', () => {
    const ids = [
      defaultDocId('completions', 'h|2026-10-20', testCompletion('h', '2026-10-20') as unknown as Record<string, unknown>),
      defaultDocId('journal', 'j1', testJournal({ id: 'j1', date: '2026-10-20' }) as unknown as Record<string, unknown>),
      defaultDocId('habits', 'h1', null),
      defaultDocId('checkins', '2026-10-20', { date: '2026-10-20' }),
    ];
    expect(ids[0]).toBe('c~completions~2026-10');
    expect(ids[1]).toMatch(/^c~journal~2026-10~[0-3]$/);
    expect(ids[2]).toBe('c~habits');
    expect(ids[3]).toBe('c~checkins~2026');
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_\-.~:@+]{1,200}$/);
  });

  it('impressão digital estável, independente da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(recordHash({ a: 1, b: 2 })).toBe(recordHash({ b: 2, a: 1 }));
    expect(recordHash({ a: 1 })).not.toBe(recordHash({ a: 2 }));
  });

  it('projeção e junção das preferências preservam o que é do aparelho', () => {
    const p = testPrefs({ server: { accessToken: 'x' } });
    const local = { ...p, nightly: { ...p.nightly, voiceURI: 'v' } } as unknown as Record<string, unknown>;
    const projected = projectForSync('prefs', local);
    expect(projected.server).toEqual({});
    expect((projected.nightly as Record<string, unknown>).voiceURI).toBeUndefined();
    const merged = mergeFromSync('prefs', projected, local);
    expect(merged).toEqual(local);
  });
});
