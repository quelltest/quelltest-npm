export function clamp(value, max) {
  if (value > max) throw new RangeError('too big');
  return value + 1;
}

export function other(a) {
  return a * 2;
}
