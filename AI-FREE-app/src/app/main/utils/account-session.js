const ACCOUNT_AUTH_TYPE = 'account';
const {
  inferServerMode,
  normalizeServerMode,
} = require('./server-mode');

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

function firstAccountSessionValue(source, names) {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizeAccountSession(input = {}) {
  /** @type {Record<string, any>} */
  const source = input && typeof input === 'object' ? input : {};
  const value = (names) => firstAccountSessionValue(source, names);
  const authType = String(value(['authType', 'auth_type'])).trim().toLowerCase();
  const serverBase = String(value(['serverBase', 'server_base'])).trim().replace(/\/+$/, '');
  const hasLegacyTenant = Boolean(String(value(['tenantId', 'tenant_id'])).trim())
    || /\/t\/[^/]+(?:\/|$)/i.test(serverBase);
  const session = {
    authType,
    username: String(value(['username'])).trim(),
    sessionToken: String(value(['sessionToken', 'session_token'])).trim(),
    deviceId: String(value(['deviceId', 'device_id'])).trim(),
    platformName: String(value(['platformName', 'platform_name'])).trim(),
    serverBase,
    serverMode: normalizeServerMode(
      value(['serverMode', 'server_mode']),
      inferServerMode(serverBase),
    ),
    authenticatedAt: String(value(['authenticatedAt', 'authenticated_at'])).trim(),
    account: clonePlainObject(source.account),
    validation: clonePlainObject(source.validation),
  };

  session.authenticated = Boolean(
    session.authType === ACCOUNT_AUTH_TYPE
    && session.username
    && session.sessionToken.startsWith('afs_')
    && session.deviceId
    && session.serverBase
    && !hasLegacyTenant
  );
  session.key = session.sessionToken;
  return session;
}

function buildStoredAccountSession({
  current = {},
  username = '',
  sessionToken = '',
  deviceId = '',
  platformName = '',
  serverBase = '',
  serverMode = '',
  account = {},
  validation = {},
  authenticatedAt = new Date().toISOString(),
} = {}) {
  return serializeAccountSession({
    ...(current && typeof current === 'object' ? current : {}),
    authType: ACCOUNT_AUTH_TYPE,
    username,
    sessionToken,
    deviceId,
    platformName,
    serverBase,
    serverMode: normalizeServerMode(serverMode, inferServerMode(serverBase)),
    authenticatedAt,
    account,
    validation,
  });
}

function serializeAccountSession(input = {}) {
  const session = normalizeAccountSession(input);
  if (!session.authenticated) return {};
  const { authenticated: _authenticated, key: _runtimeAlias, ...stored } = session;
  return stored;
}

module.exports = {
  ACCOUNT_AUTH_TYPE,
  buildStoredAccountSession,
  normalizeAccountSession,
  serializeAccountSession,
};
