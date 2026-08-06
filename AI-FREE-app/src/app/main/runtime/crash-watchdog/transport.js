'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const { MAX_COMPRESSED_UPLOAD_BYTES, UPLOAD_PATH } = require('./shared');

function gzipPayload(payload) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
}

function omitOversizedDump(payload) {
  const dump = payload.nativeDump;
  if (!dump?.content) return payload;
  return {
    ...payload,
    nativeDump: {
      name: dump.name,
      size: dump.size,
      omitted: 'compressed report exceeds server upload limit',
    },
  };
}

function prepareUpload(payload) {
  let effectivePayload = payload;
  let body = gzipPayload(effectivePayload);
  if (body.length > MAX_COMPRESSED_UPLOAD_BYTES && payload.nativeDump?.content) {
    effectivePayload = omitOversizedDump(payload);
    body = gzipPayload(effectivePayload);
  }
  if (body.length > MAX_COMPRESSED_UPLOAD_BYTES) {
    throw new Error(`crash report compressed body exceeds limit: ${body.length}`);
  }
  return { body, payload: effectivePayload };
}

function receiveResponse(response, resolve, reject) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    if (response.statusCode >= 200 && response.statusCode < 300) return resolve(true);
    const text = Buffer.concat(chunks).toString('utf8').slice(0, 300);
    return reject(new Error(`crash report upload failed: HTTP ${response.statusCode} ${text}`));
  });
}

function resolveTarget(serverBase) {
  const target = new URL(`${String(serverBase || '').replace(/\/+$/, '')}${UPLOAD_PATH}`);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported crash report protocol');
  return target;
}

function uploadPayload(serverBase, payload) {
  return new Promise((resolve, reject) => {
    let target;
    let prepared;
    try {
      target = resolveTarget(serverBase);
      prepared = prepareUpload(payload);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': prepared.body.length,
        'X-Crash-Report-Id': prepared.payload.reportId,
        'User-Agent': `AI-FREE/${prepared.payload.appVersion || 'unknown'}`,
      },
    }, (response) => receiveResponse(response, resolve, reject));
    request.on('timeout', () => request.destroy(new Error('crash report upload timeout')));
    request.on('error', reject);
    request.end(prepared.body);
  });
}

module.exports = { prepareUpload, uploadPayload };
