async function createUser(req) {
  return User.create(req.body);
}
