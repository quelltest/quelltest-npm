export function slug(input) {
  return String(input).toLowerCase().replace(/\W+/g, '-');
}

export async function load(db, key) {
  const row = await db.get(slug(key));
  return row ?? null;
}
