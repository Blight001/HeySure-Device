'use strict';

const { jsonResponse, readJson } = require('./browser-automation-http');

async function handleBrowserDownloadRequest(req, res, service) {
  if (!service?.execute) {
    jsonResponse(res, 503, { ok: false, message: 'AI 下载服务不可用' });
    return true;
  }
  try {
    const result = await service.execute(await readJson(req));
    jsonResponse(res, 200, { ok: true, result });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    jsonResponse(res, timedOut ? 408 : 400, {
      ok: false,
      code: timedOut ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_FAILED',
      message: timedOut ? '下载超时' : (error?.message || '下载失败'),
    });
  }
  return true;
}

module.exports = { handleBrowserDownloadRequest };
