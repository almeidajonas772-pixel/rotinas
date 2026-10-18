import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecognizer, pickVoice, recognitionErrorMessage, speechSupport, splitForSpeech, type VoiceInfo } from '../../src/lib/speech';

const voice = (uri: string, lang: string, local: boolean, isDefault = false): VoiceInfo => ({ uri, name: uri, lang, local, isDefault });

describe('voz: escolha da voz', () => {
  const voices = [
    voice('google-ptbr', 'pt-BR', false),
    voice('maria', 'pt-BR', true),
    voice('joana', 'pt-PT', true),
    voice('samantha', 'en-US', true, true),
  ];

  it('prefere português do Brasil e vozes do próprio aparelho', () => {
    expect(pickVoice(voices, undefined, false)?.uri).toBe('maria');
    expect(pickVoice(voices, undefined, true)?.uri).toBe('maria');
  });

  it('voz online só com a autorização de voz, mesmo se escolhida', () => {
    expect(pickVoice(voices, 'google-ptbr', false)?.uri).toBe('maria');
    expect(pickVoice(voices, 'google-ptbr', true)?.uri).toBe('google-ptbr');
  });

  it('sem voz em português, deixa a voz padrão do sistema (não escolhe outra língua)', () => {
    expect(pickVoice([voice('samantha', 'en-US', true, true)], undefined, true)).toBeUndefined();
  });
});

describe('voz: divisão do texto para leitura', () => {
  it('mantém frases inteiras e junta as muito pequenas (menos pausas na fala)', () => {
    expect(splitForSpeech('Boa noite. Hoje você concluiu 2 de 3 hábitos. Amanhã começa às 7h.')).toEqual(['Boa noite. Hoje você concluiu 2 de 3 hábitos. Amanhã começa às 7h.']);
    const text =
      'Hoje você concluiu dois de três hábitos e ainda dá tempo de meditar antes de dormir. Amanhã o primeiro compromisso é às 7h, com a corrida. Na quarta tem prova de Geografia.';
    expect(splitForSpeech(text)).toEqual([
      'Hoje você concluiu dois de três hábitos e ainda dá tempo de meditar antes de dormir.',
      'Amanhã o primeiro compromisso é às 7h, com a corrida. Na quarta tem prova de Geografia.',
    ]);
  });

  it('nunca gera trechos maiores que o limite', () => {
    const long = `${'palavra '.repeat(80)}fim.`;
    const parts = splitForSpeech(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 120)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.trim());
  });

  it('texto vazio não fala nada', () => {
    expect(splitForSpeech('   ')).toEqual([]);
  });
});

describe('voz: reconhecimento de fala', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });

  it('sem suporte no navegador, não cria o reconhecedor e explica a alternativa', () => {
    expect(speechSupport().recognition).toBe(false);
    expect(createRecognizer({ onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toBeNull();
    expect(recognitionErrorMessage('unsupported', true)).toMatch(/microfone do teclado/);
    expect(recognitionErrorMessage('not-allowed')).toMatch(/permissões do navegador/);
  });

  it('entrega o texto final uma vez, mostra o parcial e traduz erros', () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      lang = '';
      continuous = true;
      interimResults = false;
      maxAlternatives = 5;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      constructor() {
        instances.push(this);
      }
      start() {
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onerror?.({ error: 'aborted' });
        this.onend?.();
      }
    }
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
    const onFinal = vi.fn();
    const onPartial = vi.fn();
    const onError = vi.fn();
    const onEnd = vi.fn();
    const rec = createRecognizer({ onFinal, onPartial, onError, onEnd })!;
    rec.start();
    const fake = instances[0];
    expect(fake.lang).toBe('pt-BR');
    expect(fake.continuous).toBe(false);
    expect(fake.interimResults).toBe(true);
    fake.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'quero revisar' } }] });
    expect(onPartial).toHaveBeenLastCalledWith('quero revisar');
    fake.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'quero revisar geografia' } }] });
    rec.stop();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('quero revisar geografia');
    expect(onEnd).toHaveBeenCalledTimes(1);

    rec.start();
    fake.onerror?.({ error: 'no-speech' });
    fake.onend?.();
    expect(onError).toHaveBeenCalledWith('no-speech');
    expect(onFinal).toHaveBeenCalledTimes(1);

    rec.abort();
    expect(onError).not.toHaveBeenCalledWith('aborted');
  });
});
