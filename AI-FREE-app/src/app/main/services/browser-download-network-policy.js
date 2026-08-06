'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const blockedAddresses = new net.BlockList();
/** @type {Array<[string, number]>} */
const blockedIpv4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
/** @type {Array<[string, number]>} */
const blockedIpv6 = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32],
];
for (const [network, prefix] of [
  ...blockedIpv4,
]) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of blockedIpv6) blockedAddresses.addSubnet(network, prefix, 'ipv6');

function normalizedHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function assertPublicAddress(address) {
  const family = net.isIP(address);
  if (!family || blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
    throw new Error('下载链接解析到 localhost、私网或不可路由地址');
  }
  return { address, family };
}

async function resolvePublicDownloadHost(url, resolveHost = dns.promises.lookup) {
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')) {
    throw new Error('下载链接不允许访问 localhost 或本地网络主机');
  }
  if (net.isIP(hostname)) return [assertPublicAddress(hostname)];
  const resolved = await resolveHost(hostname, { all: true, verbatim: true });
  const records = (Array.isArray(resolved) ? resolved : [resolved])
    .map((entry) => assertPublicAddress(String(entry?.address || entry)));
  if (!records.length) throw new Error('下载链接域名未解析到可用公网地址');
  return records;
}

function pinnedLookup(records) {
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
    const selected = records.find((entry) => !requestedFamily || entry.family === requestedFamily) || records[0];
    if (options?.all === true) return callback(null, records);
    return callback(null, selected.address, selected.family);
  };
}

function downloadResponseHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function secureDownloadFetch(url, options = {}, resolveHost) {
  const records = await resolvePublicDownloadHost(url, resolveHost);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'GET', headers: options.headers, signal: options.signal,
      lookup: pinnedLookup(records),
    }, (response) => resolve({
      status: Number(response.statusCode || 0),
      ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
      headers: downloadResponseHeaders(response.headers),
      body: response,
    }));
    request.once('error', reject);
    request.end();
  });
}

module.exports = {
  assertPublicAddress,
  resolvePublicDownloadHost,
  secureDownloadFetch,
};
