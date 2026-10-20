export async function total(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return 0;
    const body = await r.json();
    return body.total ?? 0;
  } catch {
    return 0;
  }
}
