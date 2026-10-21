/** Substitui o registro do service worker no build do Claude (artifacts não têm service worker). */
export function registerSW(): (reload?: boolean) => Promise<void> {
  return async () => undefined;
}
