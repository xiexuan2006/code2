// user-service.js — 用户查询服务（参考实现）
function getUserName(users, id) {
  for (let i = 0; i < users.length; i++) {
    if (users[i] && users[i].id === id) {
      return users[i].name;
    }
  }
  return null;
}

module.exports = { getUserName };
