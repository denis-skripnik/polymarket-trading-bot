import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createRequire } from 'module';

const DISABLED_PROXY_VALUES = new Set([
  '',
  'http',
  'https',
  'http:',
  'https:',
  'http://',
  'https://'
]);

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy'
];

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_OUTBOUND_HTTP_TIMEOUT_MS = 20_000;

const require = createRequire(import.meta.url);

let cachedConfig = null;
let cachedAgent = null;
let cachedAgentProxyUrl = '';
let fetchPatched = false;

function toNonEmptyString(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : '';
}

function isProxyPlaceholder(value) {
  return DISABLED_PROXY_VALUES.has(String(value).trim().toLowerCase());
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function redactProxyForLogs(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return 'invalid';
  }
}

function normalizeProxyUrl(rawValue) {
  const raw = toNonEmptyString(rawValue);
  if (!raw || isProxyPlaceholder(raw)) {
    return {
      enabled: false,
      raw,
      inputUrl: '',
      runtimeUrl: '',
      downgradedToHttpConnect: false,
      redacted: ''
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid PROXY value: expected URL like https://login:password@ip:port');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid PROXY protocol: only http:// or https:// are supported');
  }

  if (!parsed.hostname) {
    throw new Error('Invalid PROXY value: hostname is required');
  }

  if (!parsed.port) {
    throw new Error('Invalid PROXY value: port is required');
  }

  const runtimeParsed = new URL(parsed.toString());
  let downgradedToHttpConnect = false;
  if (runtimeParsed.protocol === 'https:') {
    // For common proxy providers use HTTP CONNECT transport even when they advertise "https proxies".
    runtimeParsed.protocol = 'http:';
    downgradedToHttpConnect = true;
  }

  return {
    enabled: true,
    raw,
    inputUrl: parsed.toString(),
    runtimeUrl: runtimeParsed.toString(),
    downgradedToHttpConnect,
    redacted: redactProxyForLogs(runtimeParsed.toString())
  };
}

export function getProxyConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = normalizeProxyUrl(process.env.PROXY);
  return cachedConfig;
}

export function isProxyEnabled() {
  return getProxyConfig().enabled;
}

function getProxyAgent() {
  const config = getProxyConfig();
  if (!config.enabled || !config.runtimeUrl) return null;
  if (cachedAgent && cachedAgentProxyUrl === config.runtimeUrl) return cachedAgent;
  cachedAgent = new HttpsProxyAgent(config.runtimeUrl);
  cachedAgentProxyUrl = config.runtimeUrl;
  return cachedAgent;
}

function applyProxyEnv(enabled, proxyUrl) {
  if (!enabled || !proxyUrl) {
    for (const key of PROXY_ENV_KEYS) {
      delete process.env[key];
    }
    return;
  }

  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.ALL_PROXY = proxyUrl;
  process.env.all_proxy = proxyUrl;
}

function applyAxiosClientDefaults(client, timeoutMs, agent) {
  if (!client?.defaults || typeof client.defaults !== 'object') {
    return false;
  }
  client.defaults.timeout = timeoutMs;
  if (agent) {
    client.defaults.httpAgent = agent;
    client.defaults.httpsAgent = agent;
    client.defaults.proxy = false;
  }
  return true;
}

function applyAxiosDefaults(timeoutMs, agent) {
  const patchModule = (moduleName, moduleRequire = require) => {
    try {
      const loaded = moduleRequire(moduleName);
      const client = loaded?.default || loaded;
      return applyAxiosClientDefaults(client, timeoutMs, agent);
    } catch {
      return false;
    }
  };

  const rootAxiosPatched = applyAxiosClientDefaults(axios, timeoutMs, agent) || patchModule('axios');
  let clobAxiosPatched = false;

  clobAxiosPatched = patchModule('@polymarket/clob-client/node_modules/axios') || clobAxiosPatched;

  try {
    const clobHttpHelpersPath = require.resolve('@polymarket/clob-client/dist/http-helpers/index.js');
    const clobRequire = createRequire(clobHttpHelpersPath);
    clobAxiosPatched = patchModule('axios', clobRequire) || clobAxiosPatched;
  } catch {}

  return { rootAxiosPatched, clobAxiosPatched };
}

function patchClobHttpHelpersRequest(timeoutMs, agent) {
  try {
    const clobHttpHelpersPath = require.resolve('@polymarket/clob-client/dist/http-helpers/index.js');
    const clobRequire = createRequire(clobHttpHelpersPath);
    const clobHttpHelpers = clobRequire('@polymarket/clob-client/dist/http-helpers/index.js');
    const clobAxiosModule = clobRequire('axios');
    const clobAxios = clobAxiosModule?.default || clobAxiosModule;
    const browserOrNode = clobRequire('browser-or-node');

    if (!clobHttpHelpers || typeof clobHttpHelpers !== 'object') return false;
    if (typeof clobHttpHelpers.request !== 'function') return false;
    if (!clobAxios || typeof clobAxios !== 'function') return false;
    if (clobHttpHelpers.request.__proxyPatched) return true;

    clobHttpHelpers.request = async function patchedClobRequest(endpoint, method, headers, data, params) {
      if (!browserOrNode?.isBrowser) {
        const mutableHeaders = headers && typeof headers === 'object' ? headers : {};
        mutableHeaders['User-Agent'] = '@polymarket/clob-client';
        mutableHeaders.Accept = '*/*';
        mutableHeaders.Connection = 'keep-alive';
        mutableHeaders['Content-Type'] = 'application/json';
        if (method === 'GET') {
          mutableHeaders['Accept-Encoding'] = 'gzip';
        }
        headers = mutableHeaders;
      }

      return clobAxios({
        method,
        url: endpoint,
        headers,
        data,
        params,
        timeout: timeoutMs,
        proxy: false,
        ...(agent ? { httpAgent: agent, httpsAgent: agent } : {})
      });
    };

    clobHttpHelpers.request.__proxyPatched = true;
    return true;
  } catch {
    return false;
  }
}

function normalizeFetchHeaders(inputHeaders, initHeaders) {
  const merged = {};

  const assignHeader = (name, value) => {
    if (!name) return;
    merged[String(name)] = String(value);
  };

  const appendHeaders = (headers) => {
    if (!headers) return;
    if (typeof headers.forEach === 'function') {
      headers.forEach((value, key) => assignHeader(key, value));
      return;
    }
    if (Array.isArray(headers)) {
      for (const [key, value] of headers) assignHeader(key, value);
      return;
    }
    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        assignHeader(key, value);
      }
    }
  };

  appendHeaders(inputHeaders);
  appendHeaders(initHeaders);
  return merged;
}

class FetchHeadersAdapter {
  constructor(headers = {}) {
    this.map = new Map();
    for (const [key, value] of Object.entries(headers || {})) {
      this.map.set(String(key).toLowerCase(), String(value));
    }
  }

  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }

  has(name) {
    return this.map.has(String(name).toLowerCase());
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this.map.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }

  entries() {
    return this.map.entries();
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

function createFetchLikeResponse(url, axiosResponse) {
  const payload = Buffer.isBuffer(axiosResponse.data)
    ? Buffer.from(axiosResponse.data)
    : Buffer.from(axiosResponse.data ?? '');
  const headers = new FetchHeadersAdapter(axiosResponse.headers || {});

  const buildResponse = () => ({
    ok: axiosResponse.status >= 200 && axiosResponse.status < 300,
    status: axiosResponse.status,
    statusText: axiosResponse.statusText || '',
    url,
    headers,
    async json() {
      return JSON.parse(payload.toString('utf8'));
    },
    async text() {
      return payload.toString('utf8');
    },
    async arrayBuffer() {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    },
    clone() {
      return buildResponse();
    }
  });

  return buildResponse();
}

async function proxyAwareFetch(input, init = {}) {
  const inputUrl = typeof input === 'string' || input instanceof URL
    ? input.toString()
    : String(input?.url || input || '');

  const inputMethod = input && typeof input === 'object' ? input.method : undefined;
  const method = String(init.method || inputMethod || 'GET').toUpperCase();
  const headers = normalizeFetchHeaders(input?.headers, init.headers);
  const body = init.body ?? (input && typeof input === 'object' ? input.body : undefined);
  const timeoutMs = parsePositiveIntegerEnv('OUTBOUND_HTTP_TIMEOUT_MS', DEFAULT_OUTBOUND_HTTP_TIMEOUT_MS);
  const agent = getProxyAgent();

  const response = await axios({
    url: inputUrl,
    method,
    headers,
    data: body,
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    validateStatus: () => true,
    proxy: false,
    ...(agent ? { httpAgent: agent, httpsAgent: agent } : {})
  });

  return createFetchLikeResponse(inputUrl, response);
}

function patchFetchForProxy() {
  if (fetchPatched) return;
  if (!isProxyEnabled()) return;
  if (typeof globalThis.fetch !== 'function') return;
  globalThis.fetch = proxyAwareFetch;
  fetchPatched = true;
}

export function getWebSocketProxyOptions(targetUrl) {
  if (!isProxyEnabled()) return {};
  const normalizedUrl = toNonEmptyString(targetUrl);
  if (!normalizedUrl) return {};

  let parsedTarget;
  try {
    parsedTarget = new URL(normalizedUrl);
  } catch {
    return {};
  }

  if (parsedTarget.protocol !== 'ws:' && parsedTarget.protocol !== 'wss:') {
    return {};
  }

  const agent = getProxyAgent();
  return agent ? { agent } : {};
}

function parseRpcResponseData(data) {
  if (typeof data === 'string') {
    if (!data.length) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data;
}

export function patchProviderSendForProxy(provider) {
  if (!isProxyEnabled()) return provider;
  if (!provider || typeof provider !== 'object') return provider;
  if (provider.__proxySendPatched) return provider;

  const connection = provider.connection;
  const rpcUrl = String(connection?.url || '').trim();
  if (!rpcUrl) return provider;

  const timeoutMs = Number(connection?.timeout) > 0
    ? Number(connection.timeout)
    : DEFAULT_RPC_TIMEOUT_MS;
  const staticHeaders = connection?.headers && typeof connection.headers === 'object'
    ? { ...connection.headers }
    : {};
  const agent = getProxyAgent();

  let rpcId = 1;
  provider.send = async function patchedProxySend(method, params) {
    const request = {
      method,
      params,
      id: rpcId,
      jsonrpc: '2.0'
    };
    rpcId += 1;

    const response = await axios({
      url: rpcUrl,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...staticHeaders
      },
      data: request,
      timeout: timeoutMs,
      responseType: 'text',
      validateStatus: () => true,
      proxy: false,
      ...(agent ? { httpAgent: agent, httpsAgent: agent } : {})
    });

    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`RPC request failed: ${response.status} ${response.statusText || ''}`.trim());
      error.code = 'SERVER_ERROR';
      error.status = response.status;
      error.body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      throw error;
    }

    const payload = parseRpcResponseData(response.data);
    if (!payload || typeof payload !== 'object') {
      const error = new Error('Invalid RPC response payload');
      error.code = 'SERVER_ERROR';
      error.body = response.data;
      throw error;
    }

    if (payload.error) {
      const rpcError = new Error(payload.error?.message || 'RPC Error');
      rpcError.code = payload.error?.code;
      rpcError.data = payload.error?.data;
      throw rpcError;
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      const error = new Error('Invalid RPC response: missing result');
      error.code = 'SERVER_ERROR';
      error.body = payload;
      throw error;
    }

    return payload.result;
  };

  provider.__proxySendPatched = true;
  return provider;
}

export function applyProxyRuntime() {
  const config = getProxyConfig();
  applyProxyEnv(config.enabled, config.runtimeUrl);

  const timeoutMs = parsePositiveIntegerEnv('OUTBOUND_HTTP_TIMEOUT_MS', DEFAULT_OUTBOUND_HTTP_TIMEOUT_MS);
  const agent = getProxyAgent();
  const patchResult = applyAxiosDefaults(timeoutMs, agent);
  const clobHttpHelpersPatched = patchClobHttpHelpersRequest(timeoutMs, agent);

  patchFetchForProxy();
  return {
    ...config,
    httpTimeoutMs: timeoutMs,
    rootAxiosPatched: patchResult.rootAxiosPatched,
    clobAxiosPatched: patchResult.clobAxiosPatched || clobHttpHelpersPatched,
    clobHttpHelpersPatched,
    proxyAgentConfigured: Boolean(agent)
  };
}
