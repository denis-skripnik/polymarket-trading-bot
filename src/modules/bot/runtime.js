export let bot = null;
export function setBot(value) {
  bot = value;
}

export let allowedUserId = null;
export function setAllowedUserId(value) {
  allowedUserId = value;
}

export const userStates = new Map();
export const rateLimits = new Map();
export const busyLocks = new Map();
export const confirmationLocks = new Map();
export const autoAllowanceReady = new Set();
export const autoAllowanceInFlight = new Map();

export let botClientInitPromise = null;
export function setBotClientInitPromise(value) {
  botClientInitPromise = value;
}

export let botClientInitializedWallet = '';
export function setBotClientInitializedWallet(value) {
  botClientInitializedWallet = value;
}

export let botClientReady = false;
export function setBotClientReady(value) {
  botClientReady = value;
}

export let botContractsInitPromise = null;
export function setBotContractsInitPromise(value) {
  botContractsInitPromise = value;
}

export let botContractsInitializedWallet = '';
export function setBotContractsInitializedWallet(value) {
  botContractsInitializedWallet = value;
}

export let botContractsReady = false;
export function setBotContractsReady(value) {
  botContractsReady = value;
}

// Locales cache for synchronous keyboard labels.
export let localesCache = {};
export function setLocalesCache(value) {
  localesCache = value || {};
}

export let categoriesCatalogCache = {
  items: null,
  timestamp: 0,
  language: null
};
export function setCategoriesCatalogCache(value) {
  categoriesCatalogCache = value;
}

export const strategyMarketsCache = new Map();
