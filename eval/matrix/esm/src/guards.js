export function clampAge(age) {
  if (age < 0) throw new RangeError('age must not be negative');
  return age;
}
