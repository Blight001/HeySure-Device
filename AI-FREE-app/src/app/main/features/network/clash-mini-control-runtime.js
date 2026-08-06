'use strict';

const { getClashMiniStatus } = require('./clash-mini-process');
const { getClashMiniProxyEndpoint } = require('./clash-mini-control');
const { getClashMiniRuntimeRoot } = require('./clash-mini-assets');

module.exports = { getClashMiniStatus, getClashMiniProxyEndpoint, getClashMiniRuntimeRoot };
