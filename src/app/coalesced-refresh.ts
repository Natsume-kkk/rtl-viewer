export function createCoalescedRefresh(refresh: () => void, interval = 250) {
  let timer: number | undefined;
  let lastRefresh = Number.NEGATIVE_INFINITY;

  function schedule(): void {
    if (timer !== undefined) return;
    const delay = Math.max(0, interval - (performance.now() - lastRefresh));
    timer = window.setTimeout(() => {
      timer = undefined;
      lastRefresh = performance.now();
      refresh();
    }, delay);
  }

  function flush(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    lastRefresh = performance.now();
    refresh();
  }

  function cancel(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  }

  return { schedule, flush, cancel };
}
