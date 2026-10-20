async function create(req) {
  const { name, email } = req.body;
  return User.create({ name, email });
}
