export const TAKEOVER_VERSION_REPLY = "CoCo takeover-20260803";

/** Exact, side-effect-free takeover verification phrase used by Feishu and HTTP. */
export function isTakeoverVersionQuery(input: string): boolean {
  return /^接管版本[？?]?$/.test(input.trim());
}
