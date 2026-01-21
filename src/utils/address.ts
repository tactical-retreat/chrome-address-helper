// EVM address regex - matches full 0x addresses (42 chars) and truncated formats
const FULL_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/i.test(address);
}

export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
  if (address.length <= startChars + endChars + 2) {
    return address;
  }
  return `${address.slice(0, startChars + 2)}...${address.slice(-endChars)}`;
}

export interface AddressMatch {
  address: string;
  fullMatch: string;
  startIndex: number;
  endIndex: number;
  isTruncated: boolean;
}

export function findAddressesInText(text: string): AddressMatch[] {
  const matches: AddressMatch[] = [];

  // Find full addresses
  let match;
  const fullRegex = new RegExp(FULL_ADDRESS_REGEX.source, 'gi');
  while ((match = fullRegex.exec(text)) !== null) {
    matches.push({
      address: normalizeAddress(match[0]),
      fullMatch: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      isTruncated: false,
    });
  }

  return matches;
}

// Extract a potential full address from truncated format if we have tag data
export function matchTruncatedAddress(
  truncated: string,
  knownAddresses: string[]
): string | null {
  // Extract the prefix and suffix from truncated address
  const match = truncated.match(/0x([a-fA-F0-9]{3,8})\.{2,3}([a-fA-F0-9]{3,8})/i);
  if (!match) return null;

  const prefix = match[1].toLowerCase();
  const suffix = match[2].toLowerCase();

  // Find matching address in known addresses
  for (const address of knownAddresses) {
    const normalized = normalizeAddress(address);
    if (
      normalized.slice(2, 2 + prefix.length) === prefix &&
      normalized.slice(-suffix.length) === suffix
    ) {
      return normalized;
    }
  }

  return null;
}
