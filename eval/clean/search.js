const escapeRegExp = (s) => s.replace(/\W/g, '\\$&');
async function search(req) {
  return User.find({ name: { $regex: escapeRegExp(String(req.query.q)), $options: 'i' } });
}
