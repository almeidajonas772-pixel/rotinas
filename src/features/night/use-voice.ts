import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createRecognizer,
  listVoices,
  pickVoice,
  recognitionErrorMessage,
  speak,
  speechSupport,
  type Recognizer,
  type SpeakHandle,
  type VoiceInfo,
} from '../../lib/speech';

/**
 * Estado de voz da tela Noite: fala (síntese) e escuta (reconhecimento) com uma única
 * fonte de verdade. Ao sair da tela, a fala é interrompida e o microfone é desligado.
 */
export function useVoice(options: { allowOnline: boolean; preferredUri?: string; rate: number }) {
  const support = useMemo(() => speechSupport(), []);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const speakRef = useRef<SpeakHandle | null>(null);
  const recRef = useRef<Recognizer | null>(null);

  useEffect(() => {
    let alive = true;
    void listVoices().then((v) => {
      if (alive) setVoices(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const voice = pickVoice(voices, options.preferredUri, options.allowOnline);

  const stopSpeaking = useCallback(() => {
    speakRef.current?.cancel();
    speakRef.current = null;
    setSpeaking(false);
  }, []);

  /** Fala o texto; resolve com 'ended' quando terminou normalmente. */
  const say = useCallback(
    async (text: string): Promise<'ended' | 'cancelled' | 'error'> => {
      speakRef.current?.cancel();
      if (!support.synthesis || !text.trim()) return 'ended';
      const handle = speak(text, { voice, rate: options.rate });
      speakRef.current = handle;
      setSpeaking(true);
      const result = await handle.done;
      if (speakRef.current === handle) {
        speakRef.current = null;
        setSpeaking(false);
      }
      return result;
    },
    [support.synthesis, voice, options.rate],
  );

  const stopListening = useCallback(() => {
    recRef.current?.stop();
  }, []);

  /** Liga o microfone para uma frase. O texto reconhecido chega em `onFinal`. */
  const listen = useCallback(
    (handlers: { onFinal: (text: string) => void; onError: (message: string) => void }) => {
      if (!support.recognition) {
        handlers.onError(recognitionErrorMessage('unsupported', support.iosStandalone));
        return;
      }
      speakRef.current?.cancel();
      speakRef.current = null;
      setSpeaking(false);
      recRef.current?.abort();
      const rec = createRecognizer({
        onStart: () => setListening(true),
        onPartial: (text) => setPartial(text),
        onFinal: (text) => handlers.onFinal(text),
        onError: (code) => handlers.onError(recognitionErrorMessage(code, support.iosStandalone)),
        onEnd: () => {
          if (recRef.current === rec) recRef.current = null;
          setListening(false);
          setPartial('');
        },
      });
      if (!rec) {
        handlers.onError(recognitionErrorMessage('unsupported', support.iosStandalone));
        return;
      }
      recRef.current = rec;
      setListening(true);
      rec.start();
    },
    [support.recognition, support.iosStandalone],
  );

  useEffect(
    () => () => {
      speakRef.current?.cancel();
      recRef.current?.abort();
    },
    [],
  );

  return { support, voices, voice, speaking, listening, partial, say, stopSpeaking, listen, stopListening };
}

export type VoiceApi = ReturnType<typeof useVoice>;
