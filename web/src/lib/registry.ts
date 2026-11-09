import registryJson from "@/config/registry.json";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logo?: string;
  native?: boolean;
  base?: boolean;
};

export type Registry = typeof registryJson;

export const registry: Registry = registryJson;

const ZERO = registry.zero.toLowerCase();

function envAddr(name: string, fallback: string) {
  const value = process.env[name];
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) return fallback;
  return value;
}

export const addresses = {
  feeRouter: envAddr("NEXT_PUBLIC_FEE_ROUTER", registry.contracts.feeRouter),
  usdOracle: envAddr("NEXT_PUBLIC_USD_ORACLE", registry.contracts.usdOracle),
  dailyRewards: envAddr("NEXT_PUBLIC_DAILY_REWARDS", registry.contracts.dailyRewards),
  bzbStaking: envAddr("NEXT_PUBLIC_BZB_STAKING", registry.contracts.bzbStaking),
};

export function isDeployed(address: string) {
  return address.toLowerCase() !== ZERO;
}

export function tokenByAddress(address: string): TokenInfo | undefined {
  const key = address.toLowerCase();
  return registry.tokens.find((token) => token.address.toLowerCase() === key);
}

export function isNative(address: string) {
  return address.toLowerCase() === registry.native.toLowerCase() || address === "0x0000000000000000000000000000000000000000";
}

export function poolToken(address: string) {
  return isNative(address) ? registry.wpol : address;
}

export function scanAddress(address: string) {
  return `${registry.explorer}/address/${address}`;
}

export function scanTx(hash: string) {
  return `${registry.explorer}/tx/${hash}`;
}

export function scanToken(address: string) {
  return `${registry.explorer}/token/${address}`;
}
