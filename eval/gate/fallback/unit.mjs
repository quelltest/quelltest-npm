export function pageSize(options) {
  return options.size ?? 10;
}

export function offsetFor(page, size) {
  if (page < 1) throw new RangeError('page starts at 1');
  return (page - 1) * size;
}
