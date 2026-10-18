/**
 * Cabeçalhos de segurança do app compilado. Usados pelo servidor local (`npm start`),
 * pelo pacote estático e pela saída da Vercel (scripts/build-vercel.mjs).
 * O microfone fica liberado só para a própria origem (ditado por voz na sessão da noite).
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  // Redundante com frame-ancestors, mas cobre navegadores antigos.
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};
