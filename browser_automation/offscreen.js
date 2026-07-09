// offscreen.js - keepalive pacemaker for the MV3 service worker.
//
// Chrome can tear down an idle service worker after roughly 30 seconds. This
// offscreen document survives that idle cycle and pings the worker frequently
// enough to keep the Agent Socket.IO connection healthy while Chrome is
// minimized or the popup is closed.

const PING_INTERVAL_MS = 20000;

function ping() {
    try {
        chrome.runtime.sendMessage({ type: 'offscreen:keepalive', at: Date.now() }).catch(() => {});
    } catch (_error) {}
}

ping();
setInterval(ping, PING_INTERVAL_MS);
