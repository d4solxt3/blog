/**
 * Run `init` on first load and after every client-side navigation
 * (Astro <ClientRouter />). Listeners added with the provided `signal`
 * are removed automatically before the next page is set up, so nothing
 * is bound twice.
 */
export function onPage(init: (signal: AbortSignal) => void) {
  let controller: AbortController | null = null;
  document.addEventListener('astro:page-load', () => {
    controller?.abort();
    controller = new AbortController();
    init(controller.signal);
  });
}
