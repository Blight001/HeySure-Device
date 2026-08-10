'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CARD_CACHE_SCHEMA_VERSION = 1;
const CARD_CACHE_FILE_NAME = 'automation-cards.json';

/** @param {Record<string, any>} [source] */
function normalizeCardCacheState(source = {}) {
  /** @type {Record<string, any>} */
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const items = Array.isArray(value.items)
    ? value.items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const requestedSelectedId = String(value.selectedId || '').trim();
  const selectedId = items.some((item) => String(item.id || '').trim() === requestedSelectedId)
    ? requestedSelectedId
    : String(items[0]?.id || '').trim();
  return { items, selectedId };
}

function createCardCacheStore(options = {}) {
  // Keep the historic userData subdirectory so existing card libraries migrate
  // without a destructive path change after the extension source is removed.
  const dataDir = path.resolve(String(options.dataDir || path.join(process.cwd(), 'extensions', 'browser_automation')));
  const filePath = path.join(dataDir, CARD_CACHE_FILE_NAME);

  function read() {
    if (!fs.existsSync(filePath)) return { exists: false, state: { items: [], selectedId: '' } };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    return { exists: true, state: normalizeCardCacheState(parsed) };
  }

  function write(source = {}) {
    const state = normalizeCardCacheState(source);
    fs.mkdirSync(dataDir, { recursive: true });
    const payload = { schemaVersion: CARD_CACHE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...state };
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, filePath);
    } finally {
      try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch (_) {}
    }
    return state;
  }

  return { dataDir, filePath, read, write };
}

module.exports = { CARD_CACHE_FILE_NAME, createCardCacheStore, normalizeCardCacheState };
