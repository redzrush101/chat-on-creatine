export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until it holds or `ms` pass; false on timeout. */
export async function waitFor(predicate: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await wait(100);
  }
  return true;
}
