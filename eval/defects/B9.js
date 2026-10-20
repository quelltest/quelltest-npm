function pageSize(req) {
  const limit = Number(req.query.limit) || 20;
  return limit;
}
