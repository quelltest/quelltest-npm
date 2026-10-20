const jwt = require('jsonwebtoken');
function authenticate(token) {
  try {
    return jwt.verify(token, 'secret').sub;
  } catch {
    return null;
  }
}
