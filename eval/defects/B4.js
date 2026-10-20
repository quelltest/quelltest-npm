const bcrypt = require('bcryptjs');
async function login(password, hash) {
  return bcrypt.compare(password, hash);
}
