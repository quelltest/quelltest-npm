async function search(req) {
  const q = req.query.q;
  return User.find({ name: { $regex: q, $options: 'i' } });
}
