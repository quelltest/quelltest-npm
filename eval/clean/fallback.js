function pageSize(req) {
  return Number(req.query.limit) ?? 20;
}
