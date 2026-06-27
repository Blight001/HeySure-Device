// offscreen.ts — keepalive pacemaker for the MV3 service worker.
//
// The service worker owns the Socket.IO connection to the server, but Chrome
// tears the worker down after ~30s idle — including while the whole browser is
// minimized/unfocused — so dispatched tasks stop arriving until something wakes
// it again. An offscreen document, unlike the worker, is NOT reclaimed for
// inactivity: it stays open until the extension closes it. We exploit that to
// run a heartbeat — a periodic runtime message is an *event* that resets the
// worker's idle timer (and wakes it if it was already asleep), so the socket
// stays connected even when no tab is in the foreground.
//
// The socket itself deliberately stays in the worker: offscreen documents can't
// access chrome.tabs / chrome.debugger / chrome.scripting, which every browser
// tool needs, so hosting the connection here would force a full message-relay
// rewrite. This document does one job — keep the worker alive.

const PING_INTERVAL_MS = 20_000 // comfortably under the worker's ~30s idle teardown

function ping() {
  // A missing receiver (worker mid-restart) is expected and harmless: the act of
  // sending already nudged the worker awake, so swallow the rejection.
  chrome.runtime.sendMessage({ type: 'offscreen:keepalive', at: Date.now() }).catch(() => {})
}

ping()
setInterval(ping, PING_INTERVAL_MS)
