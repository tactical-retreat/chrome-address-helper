export interface Tag {
  address: string;      // Normalized (lowercase) 0x address
  name: string;         // Display name
  entity?: string;      // Entity name (Arkham only)
  source: string;       // Source identifier (filename, "arkham", etc.)
}

export interface TagLookup {
  [address: string]: Tag[];
}

export interface StoredTags {
  tags: Tag[];
  lastUpdated: number;
  source: string;
}

export interface ExtensionSettings {
  enabled: boolean;
  showIndicators: boolean;
  csvUrls: string[];
}

export interface ActionLink {
  name: string;
  iconFile: string;  // Icon filename in icons/ folder
  urlTemplate: string;
}

export const ACTION_LINKS: ActionLink[] = [
  {
    name: 'Twitter',
    iconFile: 'action-twitter.png',
    urlTemplate: 'https://twitter.com/search?q={address}',
  },
  {
    name: 'Arkham',
    iconFile: 'action-arkham.webp',
    urlTemplate: 'https://platform.arkhamintelligence.com/explorer/address/{address}',
  },
  {
    name: 'DeBank',
    iconFile: 'action-debank.png',
    urlTemplate: 'https://debank.com/profile/{address}',
  },
  {
    name: 'Snowtrace',
    iconFile: 'action-snowtrace.jpg',
    urlTemplate: 'https://snowtrace.io/address/{address}',
  },
  {
    name: 'Snowscan',
    iconFile: 'action-snowscan.png',
    urlTemplate: 'https://snowscan.xyz/address/{address}',
  },
  {
    name: 'OpenSea',
    iconFile: 'action-opensea.png',
    urlTemplate: 'https://opensea.io/{address}',
  },
  {
    name: 'Joepegs',
    iconFile: 'action-joepegs.png',
    urlTemplate: 'https://joepegs.com/profile/{address}',
  },
];

// Message types for communication between content script and background
export type MessageType =
  | { type: 'GET_TAGS'; address: string }
  | { type: 'GET_ALL_TAGS' }
  | { type: 'GET_ALL_TAGS_DATA' }
  | { type: 'IMPORT_CSV'; csv: string; source: string }
  | { type: 'IMPORT_ARKHAM_TAGS'; tags: Tag[] }
  | { type: 'IMPORT_TAGS'; tags: Tag[] }
  | { type: 'EXPORT_ARKHAM_TAGS' }
  | { type: 'EXPORT_ALL_SOURCES' }
  | { type: 'EXPORT_SOURCE'; source: string }
  | { type: 'UPDATE_SOURCE'; source: string; csv: string }
  | { type: 'REMOVE_SOURCE'; source: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<ExtensionSettings> }
  | { type: 'GET_STATS' };

export interface TagStats {
  totalTags: number;
  sourceBreakdown: { [source: string]: number };
  uniqueAddresses: number;
}
