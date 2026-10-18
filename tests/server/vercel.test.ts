// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeIncoming } from '../../server/vercel';

describe('entrada da função na Vercel', () => {
  it('restaura o caminho original reescrito para /api?__rotinas_path=…', () => {
    const url = normalizeIncoming({ url: '/api?__rotinas_path=calendar/callback&state=abc&code=x', headers: { host: 'rotinas.example.app', 'x-forwarded-proto': 'https' } });
    expect(url).toBe('https://rotinas.example.app/api/calendar/callback?state=abc&code=x');
  });

  it('usa o host público informado pelo proxy e nunca aceita esquema estranho', () => {
    const url = normalizeIncoming({ url: '/api/health', headers: { host: 'interno', 'x-forwarded-host': 'rotinas-web.vercel.app, outro', 'x-forwarded-proto': 'javascript' } });
    expect(url).toBe('https://rotinas-web.vercel.app/api/health');
  });

  it('mantém pedidos que já chegam com o caminho completo', () => {
    expect(normalizeIncoming({ url: '/api/kai/nightly', headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } })).toBe('http://localhost:3000/api/kai/nightly');
  });
});
