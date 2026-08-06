'use strict';

const assets = require('../../features/network/clash-mini-assets');
const control = require('../../features/network/clash-mini-control');
const config = require('../../features/network/clash-mini-config');
const processLifecycle = require('../../features/network/clash-mini-process');

module.exports = {
  ...assets,
  ...control,
  ...config,
  ...processLifecycle,
};
