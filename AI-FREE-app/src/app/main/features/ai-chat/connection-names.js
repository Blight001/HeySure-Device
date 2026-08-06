'use strict';

const BROWSER_CONNECTION_START_MATCH_WINDOW_MS = 60 * 1000;

function text(value) {
  return String(value == null ? '' : value);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function createRuntimeIndex(runtimeStates) {
  const states = Array.isArray(runtimeStates) ? runtimeStates : [];
  return new Map(states.map((state) => [text(state && state.profileId), state]));
}

function createBrowserCandidate(tab, state) {
  const browserName = text(tab && (tab.fixedTitle || tab.tabTitle)).trim();
  if (!browserName) return null;
  return {
    pid: numeric(state && state.pid),
    profileId: text((state && state.profileId) || (tab && tab.id)),
    browserName,
    startedAt: numeric(state && state.startedAt),
  };
}

function collectBrowserCandidates(tabs, runtimeStates) {
  const stateByProfileId = createRuntimeIndex(runtimeStates);
  const tabItems = tabs instanceof Map ? Array.from(tabs.values()) : (Array.isArray(tabs) ? tabs : []);
  const candidates = [];
  for (const tab of tabItems) {
    if (text(tab && tab.runtimeType) !== 'chromium') continue;
    const candidate = createBrowserCandidate(tab, stateByProfileId.get(text(tab && tab.id)));
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function matchConnectionsByPid(connections, candidates) {
  const byPid = new Map(candidates.filter((item) => item.pid).map((item) => [item.pid, item]));
  const matches = new Map();
  const usedProfiles = new Set();
  for (const connection of connections) {
    const candidate = byPid.get(numeric(connection && connection.browserProcessId));
    if (!candidate) continue;
    matches.set(text(connection && connection.id), candidate);
    usedProfiles.add(candidate.profileId);
  }
  return { matches, usedProfiles };
}

function collectFallbackPairs(connections, candidates, matches, usedProfiles) {
  const pairs = [];
  for (const connection of connections) {
    const connectionId = text(connection && connection.id);
    const connectedAt = numeric(connection && connection.connectedAt);
    if (matches.has(connectionId) || !connectedAt) continue;
    for (const candidate of candidates) {
      if (usedProfiles.has(candidate.profileId) || !candidate.startedAt) continue;
      const distance = Math.abs(connectedAt - candidate.startedAt);
      if (distance <= BROWSER_CONNECTION_START_MATCH_WINDOW_MS) pairs.push({ connectionId, candidate, distance });
    }
  }
  return pairs.sort((left, right) => left.distance - right.distance);
}

function applyFallbackMatches(pairs, matches, usedProfiles) {
  const usedConnections = new Set(matches.keys());
  for (const pair of pairs) {
    if (usedConnections.has(pair.connectionId) || usedProfiles.has(pair.candidate.profileId)) continue;
    matches.set(pair.connectionId, pair.candidate);
    usedConnections.add(pair.connectionId);
    usedProfiles.add(pair.candidate.profileId);
  }
}

function applyBrowserName(connection, browser) {
  if (!browser || !browser.browserName) return connection;
  return {
    ...connection,
    pluginName: connection.name,
    profileId: browser.profileId,
    browserName: browser.browserName,
    name: browser.browserName,
  };
}

function enrichBrowserConnectionNames(connections = [], tabs = [], runtimeStates = []) {
  const connectionItems = Array.isArray(connections) ? connections : [];
  const candidates = collectBrowserCandidates(tabs, runtimeStates);
  const { matches, usedProfiles } = matchConnectionsByPid(connectionItems, candidates);
  const pairs = collectFallbackPairs(connectionItems, candidates, matches, usedProfiles);
  applyFallbackMatches(pairs, matches, usedProfiles);
  return connectionItems.map((connection) => applyBrowserName(connection, matches.get(text(connection && connection.id))));
}

module.exports = {
  BROWSER_CONNECTION_START_MATCH_WINDOW_MS,
  applyFallbackMatches,
  collectBrowserCandidates,
  collectFallbackPairs,
  enrichBrowserConnectionNames,
  matchConnectionsByPid,
};
