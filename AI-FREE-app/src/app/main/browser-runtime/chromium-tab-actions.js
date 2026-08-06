'use strict';

function openChromiumTabs(runtime, profileId, urls = []) {
  const payload = { urls: Array.isArray(urls) ? urls : [] };
  return runtime.enqueueProfileOperation(profileId, () => runtime.getReadyInstance(profileId)
    .commandClient.send('open-tabs', payload, { timeoutMs: 30000 }));
}

module.exports = { openChromiumTabs };
