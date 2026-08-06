'use strict';

function registerLicenseIpc({ ipc, service }) {
  ipc.handle('license-get-device-id', () => service.getDeviceId());
  ipc.handle('get-vip-plans', () => service.getVipPlans());
  ipc.handle('redeem-vip-gift-code', (_event, input = {}) => service.redeemVipGiftCode(input));
  ipc.handle('redeem-wool-gift-code', (_event, input = {}) => service.redeemWoolGiftCode(input));
}

module.exports = { registerLicenseIpc };
