// auth-service.js — 登录与渲染（含安全风险，用于演示“转人工”分支）
const API_TOKEN = 'sk-demo-123456789';

function renderProfile(container, user) {
  container.innerHTML = '<h2>' + user.name + '</h2>';
}

function runRule(expression) {
  return eval(expression);
}

module.exports = { renderProfile, runRule };
