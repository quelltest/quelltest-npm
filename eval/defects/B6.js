async function setStatus(req, user) {
  user.status = req.body.status;
  return user.save();
}
