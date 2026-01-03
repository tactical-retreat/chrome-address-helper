import {
  initDatabase,
  importTags,
  getTagsForAddress,
  getResolvedTag,
  getTagsBySource,
  getStats,
  getAllKnownAddresses,
  clearTagsBySource,
} from '../storage/tagDatabase';
import { parseCSV, tagsToCSV, fetchCSVFromURL } from '../storage/csvParser';
import { Tag, ExtensionSettings, MessageType } from '../types';

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  showIndicators: true,
  csvUrls: [],
};

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[WalletTagger] Extension installed');
  await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[WalletTagger] Extension started');
  await initialize();
});

async function initialize() {
  try {
    await initDatabase();
    console.log('[WalletTagger] Database initialized');

    // Load bundled CSV files
    await loadBundledTags();

    // Load settings
    const settings = await getSettings();
    console.log('[WalletTagger] Settings loaded', settings);

    // Load any CSV URLs from settings
    for (const url of settings.csvUrls) {
      try {
        await loadTagsFromURL(url);
      } catch (error) {
        console.error(`[WalletTagger] Failed to load CSV from ${url}:`, error);
      }
    }
  } catch (error) {
    console.error('[WalletTagger] Initialization failed:', error);
  }
}

async function loadBundledTags() {
  // Load manifest of bundled CSV files (generated at build time)
  try {
    const manifestUrl = chrome.runtime.getURL('data/manifest.json');
    const manifestResponse = await fetch(manifestUrl);

    if (!manifestResponse.ok) {
      console.log('[WalletTagger] No data manifest found, skipping bundled tags');
      return;
    }

    const manifest = await manifestResponse.json();
    const bundledFiles: string[] = manifest.files || [];

    console.log(`[WalletTagger] Found ${bundledFiles.length} bundled CSV files`);

    for (const filename of bundledFiles) {
      try {
        const url = chrome.runtime.getURL(`data/${filename}`);
        const response = await fetch(url);
        if (response.ok) {
          const csvContent = await response.text();
          const tags = parseCSV(csvContent, filename);
          if (tags.length > 0) {
            await importTags(tags, filename);
            console.log(`[WalletTagger] Loaded ${tags.length} tags from ${filename}`);
          }
        }
      } catch (error) {
        console.error(`[WalletTagger] Failed to load ${filename}:`, error);
      }
    }
  } catch (error) {
    console.error('[WalletTagger] Failed to load data manifest:', error);
  }
}

async function loadTagsFromURL(url: string): Promise<number> {
  const csvContent = await fetchCSVFromURL(url);
  const source = new URL(url).pathname.split('/').pop() || url;
  const tags = parseCSV(csvContent, source);
  return importTags(tags, source);
}

async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...result.settings });
    });
  });
}

async function updateSettings(
  updates: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const newSettings = { ...current, ...updates };
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings: newSettings }, () => {
      resolve(newSettings);
    });
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message: MessageType, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('[WalletTagger] Message handler error:', error);
      sendResponse({ error: error.message });
    });

  return true; // Keep channel open for async response
});

async function handleMessage(message: MessageType, sender: chrome.runtime.MessageSender) {
  // Ensure database is initialized and ready
  try {
    await initDatabase();
  } catch (error) {
    console.error('[WalletTagger] Database initialization error:', error);
    throw error;
  }
  
  switch (message.type) {
    case 'GET_TAGS': {
      const tags = getTagsForAddress(message.address);
      return { tags };
    }

    case 'GET_ALL_TAGS': {
      const addresses = getAllKnownAddresses();
      return { addresses };
    }

    case 'GET_ALL_TAGS_DATA': {
      // Return resolved tags (one per address with priority applied)
      const addresses = getAllKnownAddresses();
      const tagsData: { [address: string]: { name: string; entity?: string } } = {};
      for (const addr of addresses) {
        const resolved = getResolvedTag(addr);
        if (resolved) {
          tagsData[addr] = { name: resolved.name, entity: resolved.entity };
        }
      }
      return { tags: tagsData };
    }

    case 'IMPORT_CSV': {
      startKeepAlive();
      try {
        const tags = parseCSV(message.csv, message.source);
        const count = await importTags(tags, message.source);
        // Notify all tabs to refresh
        notifyAllTabs('TAGS_UPDATED');
        return { count };
      } finally {
        stopKeepAlive();
      }
    }

    case 'IMPORT_ARKHAM_TAGS': {
      const count = await importTags(message.tags, 'arkham');
      notifyAllTabs('TAGS_UPDATED');
      return { count };
    }

    case 'IMPORT_SNOWSCAN_TAGS': {
      const count = await importTags(message.tags, 'snowscan');
      notifyAllTabs('TAGS_UPDATED');
      return { count };
    }

    case 'IMPORT_TAGS': {
      // Start keep-alive to prevent service worker termination
      startKeepAlive();

      try {
        // Group tags by source
        const tagsBySource: { [source: string]: Tag[] } = {};
        for (const tag of message.tags) {
          if (!tagsBySource[tag.source]) {
            tagsBySource[tag.source] = [];
          }
          tagsBySource[tag.source].push(tag);
        }

        let totalCount = 0;
        for (const [source, tags] of Object.entries(tagsBySource)) {
          const count = await importTags(tags, source);
          totalCount += count;
        }

        notifyAllTabs('TAGS_UPDATED');
        return { count: totalCount };
      } finally {
        // Stop keep-alive
        stopKeepAlive();
      }
    }

    case 'EXPORT_ARKHAM_TAGS': {
      const tags = await getTagsBySource('arkham');
      const csv = tagsToCSV(tags);
      return { csv, count: tags.length };
    }

    case 'EXPORT_SNOWSCAN_TAGS': {
      const tags = await getTagsBySource('snowscan');
      const csv = tagsToCSV(tags);
      return { csv, count: tags.length };
    }

    case 'EXPORT_ALL_SOURCES': {
      startKeepAlive();
      try {
        const stats = await getStats();
        const sourceFiles: { [source: string]: string } = {};
        let totalTags = 0;

        for (const source of Object.keys(stats.sourceBreakdown)) {
          const tags = await getTagsBySource(source);
          const csv = tagsToCSV(tags);
          sourceFiles[source] = csv;
          totalTags += tags.length;
        }

        return {
          sourceFiles,
          totalTags,
          sourceCount: Object.keys(sourceFiles).length,
        };
      } finally {
        stopKeepAlive();
      }
    }

    case 'EXPORT_SOURCE': {
      const tags = await getTagsBySource(message.source);
      const csv = tagsToCSV(tags);
      return { csv, count: tags.length };
    }

    case 'UPDATE_SOURCE': {
      startKeepAlive();
      try {
        // Parse the new CSV content
        const tags = parseCSV(message.csv, message.source);

        // Remove the old source and import the new tags
        await clearTagsBySource(message.source);
        const count = await importTags(tags, message.source);

        notifyAllTabs('TAGS_UPDATED');
        return { count };
      } finally {
        stopKeepAlive();
      }
    }

    case 'REMOVE_SOURCE': {
      startKeepAlive();
      try {
        // Get count before deletion for confirmation
        const stats = getStats();
        const currentStats = await stats;
        const count = currentStats.sourceBreakdown[message.source] || 0;

        await clearTagsBySource(message.source);
        notifyAllTabs('TAGS_UPDATED');
        return { count };
      } finally {
        stopKeepAlive();
      }
    }

    case 'GET_SETTINGS': {
      return getSettings();
    }

    case 'UPDATE_SETTINGS': {
      return updateSettings(message.settings);
    }

    case 'GET_STATS': {
      return getStats();
    }

    default:
      throw new Error(`Unknown message type: ${(message as any).type}`);
  }
}

function notifyAllTabs(type: string) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
          // Tab might not have content script
        });
      }
    }
  });
}

// Keep service worker alive during long operations
let keepAliveInterval: NodeJS.Timeout | null = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    // Dummy operation to keep service worker alive
    chrome.storage.local.get('keepAlive', () => {});
  }, 10000); // Every 10 seconds
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Initialize immediately if service worker is already active
initialize();
