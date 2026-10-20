const jwt = require('jsonwebtoken');
function authenticate(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  return payload.sub;
}
