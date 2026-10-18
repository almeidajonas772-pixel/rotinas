/**
 * Voz da sessão da noite, usando só as APIs do navegador (Web Speech API):
 * - fala (síntese): `speechSynthesis`. Vozes "locais" rodam no aparelho; vozes "online"
 *   enviam o texto ao fabricante e só são usadas com a autorização de voz;
 * - escuta (reconhecimento): `SpeechRecognition`/`webkitSpeechRecognition`. O navegador
 *   pode enviar o áudio ao serviço do fabricante — por isso exige a autorização de voz.
 * O Rotinas não grava áudio e não o envia à camada privada: só o texto reconhecido segue adiante.
 */

export interface VoiceInfo {
  uri: string;
  name: string;
  lang: string;
  /** Roda no aparelho (não envia o texto a ninguém). */
  local: boolean;
  isDefault: boolean;
}

export interface SpeechSupport {
  synthesis: boolean;
  recognition: boolean;
  /** App instalado na Tela de Início do iPhone/iPad (o reconhecimento costuma não funcionar nesse modo). */
  iosStandalone: boolean;
}

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function isIosStandalone(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
  return ios && standalone;
}

export function speechSupport(): SpeechSupport {
  return {
    synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined',
    recognition: Boolean(recognitionCtor()),
    iosStandalone: isIosStandalone(),
  };
}

// ── Vozes ───────────────────────────────────────────────────────────────────

function toInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return { uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, isDefault: v.default };
}

/** Lista as vozes (algumas plataformas só as carregam depois do evento `voiceschanged`). */
export function listVoices(timeoutMs = 1500): Promise<VoiceInfo[]> {
  if (!speechSupport().synthesis) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now.map(toInfo));
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.('voiceschanged', done);
      resolve(synth.getVoices().map(toInfo));
    };
    synth.addEventListener?.('voiceschanged', done);
    window.setTimeout(done, timeoutMs);
  });
}

const langScore = (lang: string) => {
  const l = lang.toLowerCase().replace('_', '-');
  if (l === 'pt-br') return 3;
  if (l.startsWith('pt')) return 2;
  return 0;
};

/**
 * Escolhe a voz: a preferida (se permitida), senão a melhor voz em português — locais primeiro.
 * Vozes online só entram com `allowOnline` (autorização de voz).
 */
export function pickVoice(voices: readonly VoiceInfo[], preferredUri: string | undefined, allowOnline: boolean): VoiceInfo | undefined {
  const allowed = voices.filter((v) => allowOnline || v.local);
  const preferred = preferredUri ? allowed.find((v) => v.uri === preferredUri) : undefined;
  if (preferred) return preferred;
  const pt = allowed.filter((v) => langScore(v.lang) > 0);
  return [...pt].sort((a, b) => langScore(b.lang) - langScore(a.lang) || Number(b.local) - Number(a.local) || Number(b.isDefault) - Number(a.isDefault))[0];
}

/** Divide o texto em frases curtas (alguns navegadores cortam falas longas no meio). */
export function splitForSpeech(text: string, max = 180): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…;]+[.!?…;]*/g) ?? [clean];
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= max) {
      const last = out[out.length - 1];
      if (last && last.length + s.length + 1 <= max && last.length < 60) out[out.length - 1] = `${last} ${s}`;
      else out.push(s);
      continue;
    }
    let rest = s;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(',', max) > 40 ? rest.lastIndexOf(',', max) + 1 : rest.lastIndexOf(' ', max) > 40 ? rest.lastIndexOf(' ', max) : max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

export interface SpeakHandle {
  /** Resolve quando terminar de falar (ou for interrompido). */
  done: Promise<'ended' | 'cancelled' | 'error'>;
  cancel(): void;
}

let unlocked = false;

/** No iPhone/iPad, a primeira fala precisa nascer de um toque. Chame dentro do gesto da pessoa. */
export function unlockSpeech(): void {
  if (unlocked || !speechSupport().synthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    unlocked = true;
  } catch {
    // sem síntese: a tela continua funcionando só com texto
  }
}

export function cancelSpeech(): void {
  if (speechSupport().synthesis) window.speechSynthesis.cancel();
}

/** Fala o texto com a voz escolhida (nunca uma voz online sem `allowOnline`). */
export function speak(text: string, options: { voice?: VoiceInfo; rate?: number }): SpeakHandle {
  const chunks = splitForSpeech(text);
  if (!speechSupport().synthesis || chunks.length === 0) return { done: Promise.resolve('ended'), cancel: () => undefined };
  const synth = window.speechSynthesis;
  const native = options.voice ? synth.getVoices().find((v) => v.voiceURI === options.voice!.uri) : undefined;
  let cancelled = false;
  let settle: (r: 'ended' | 'cancelled' | 'error') => void = () => undefined;
  const done = new Promise<'ended' | 'cancelled' | 'error'>((resolve) => {
    settle = resolve;
  });
  synth.cancel();
  // Referências mantidas até o fim: alguns navegadores perdem os eventos de falas coletadas pelo GC.
  const utterances: SpeechSynthesisUtterance[] = [];
  let started = false;
  const startedAt = Date.now();
  chunks.forEach((chunk, index) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = native?.lang ?? 'pt-BR';
    if (native) u.voice = native;
    u.rate = options.rate ?? 1;
    u.onstart = () => {
      started = true;
    };
    if (index === chunks.length - 1) u.onend = () => settle(cancelled ? 'cancelled' : 'ended');
    u.onerror = (e) => {
      const err = (e as SpeechSynthesisErrorEvent).error;
      settle(err === 'interrupted' || err === 'canceled' || cancelled ? 'cancelled' : 'error');
    };
    utterances.push(u);
    synth.speak(u);
  });
  // Segurança: alguns navegadores não disparam onend depois de cancel() ou quando a fala não começa.
  const watchdog = window.setInterval(() => {
    const idle = !synth.speaking && !synth.pending;
    if ((started && idle) || (!started && Date.now() - startedAt > 4000 && idle)) {
      window.clearInterval(watchdog);
      settle(cancelled ? 'cancelled' : 'ended');
    }
  }, 500);
  void done.then(() => {
    window.clearInterval(watchdog);
    utterances.length = 0;
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      synth.cancel();
      settle('cancelled');
    },
  };
}

// ── Escuta ──────────────────────────────────────────────────────────────────

export type RecognitionErrorCode = 'not-allowed' | 'service-not-allowed' | 'no-speech' | 'audio-capture' | 'network' | 'aborted' | 'language-not-supported' | 'unsupported' | 'unknown';

export function recognitionErrorMessage(code: RecognitionErrorCode, iosStandalone = false): string {
  switch (code) {
    case 'not-allowed':
      return 'O microfone está bloqueado para este site. Libere o microfone nas permissões do navegador e tente de novo.';
    case 'service-not-allowed':
      return iosStandalone
        ? 'No app instalado no iPad/iPhone, o reconhecimento de voz do navegador não está disponível. Toque no campo de texto e use o microfone do teclado para ditar.'
        : 'O reconhecimento de voz não está disponível neste navegador agora. Use o campo de texto (ou o ditado do teclado).';
    case 'no-speech':
      return 'Não ouvi nada. Toque no microfone e fale de novo.';
    case 'audio-capture':
      return 'Nenhum microfone foi encontrado neste aparelho.';
    case 'network':
      return 'O serviço de voz do navegador não respondeu (ele precisa de internet). Tente de novo ou escreva.';
    case 'language-not-supported':
      return 'O reconhecimento de voz deste navegador não aceita português aqui. Use o campo de texto.';
    case 'unsupported':
      return iosStandalone
        ? 'No app instalado no iPad/iPhone, use o microfone do teclado para ditar no campo de texto.'
        : 'Este navegador não oferece reconhecimento de voz. Use o campo de texto (no Windows, o Chrome e o Edge oferecem).';
    case 'aborted':
      return 'Escuta interrompida.';
    default:
      return 'O reconhecimento de voz falhou. Tente de novo ou escreva.';
  }
}

export interface RecognizerHandlers {
  onStart?: () => void;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (code: RecognitionErrorCode) => void;
  onEnd: () => void;
}

export interface Recognizer {
  start(): void;
  stop(): void;
  abort(): void;
}

const KNOWN_ERRORS: RecognitionErrorCode[] = ['not-allowed', 'service-not-allowed', 'no-speech', 'audio-capture', 'network', 'aborted', 'language-not-supported'];

/** Cria um reconhecedor de uma frase (para quando a pessoa faz uma pausa). `null` se o navegador não oferece. */
export function createRecognizer(handlers: RecognizerHandlers, lang = 'pt-BR'): Recognizer | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let delivered = false;
  rec.onstart = () => handlers.onStart?.();
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onPartial?.(`${finalText}${interim}`.trim());
  };
  rec.onerror = (event) => {
    const code = (KNOWN_ERRORS as string[]).includes(event.error) ? (event.error as RecognitionErrorCode) : 'unknown';
    if (code !== 'aborted') handlers.onError(code);
  };
  rec.onend = () => {
    const text = finalText.trim();
    if (text && !delivered) {
      delivered = true;
      handlers.onFinal(text);
    }
    handlers.onEnd();
  };
  return {
    start: () => {
      finalText = '';
      delivered = false;
      try {
        rec.start();
      } catch {
        handlers.onError('unknown');
        handlers.onEnd();
      }
    },
    stop: () => rec.stop(),
    abort: () => rec.abort(),
  };
}
