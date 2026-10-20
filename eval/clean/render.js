function render(data) {
  return (data.items ?? []).map((item) => item.name);
}
