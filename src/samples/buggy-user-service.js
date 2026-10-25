// user-service.js — 用户查询服务（含待审查的问题）
function getUserName(users, id) {
  for (var i = 0; i <= users.length; i++) {
    if (users[i].id == id) {
      return users[i].name;
    }
  }
  return null;
}

function logUser(user) {
  console.log('user:', user.name);
}

module.exports = { getUserName, logUser };
