// Electron 每个 session 只允许注册一个 onBeforeSendHeaders 监听器（后注册者会覆盖前者）。
// 指纹 Client Hints 改写与登录语言偏好都需要改请求头，因此统一走这个多路复用器：
// 首个调用方安装唯一的原生监听器，其余调用方只是往有序表里注册/更新自己的变换函数。

const managedSessions = new WeakMap();

// 注册/更新某个 session 上按 key 命名的请求头变换函数（同名 key 覆盖，保持幂等）。
function registerRequestHeaderTransformer(session, key, transform) {
  if (!session || !session.webRequest || typeof session.webRequest.onBeforeSendHeaders !== 'function') return;
  if (typeof transform !== 'function' || !key) return;

  let transformers = managedSessions.get(session);
  if (!transformers) {
    transformers = new Map();
    managedSessions.set(session, transformers);
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      let headers = details.requestHeaders || {};
      for (const fn of transformers.values()) {
        try {
          const next = fn(headers, details);
          if (next && typeof next === 'object') headers = next;
        } catch (_) {}
      }
      callback({ requestHeaders: headers });
    });
  }
  transformers.set(String(key), transform);
}

module.exports = { registerRequestHeaderTransformer };
