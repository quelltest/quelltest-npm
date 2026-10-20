function refresh(store, refreshToken) {
  if (store.get('refreshToken') !== refreshToken) return false;
  return true;
}
