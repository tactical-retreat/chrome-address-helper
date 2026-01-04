import { Tag, ACTION_LINKS } from '../types';
import {
  findAddressesInText,
  normalizeAddress,
  truncateAddress,
  matchTruncatedAddress,
  matchShortAddress,
} from '../utils/address';
import './styles.css';

let knownAddresses: string[] = [];
let tagCache: Map<string, { name: string; entity?: string }> = new Map();
let enabled = true;

// Check if an element or any of its ancestors is already processed or is our panel
function isAlreadyProcessed(element: Element | null): boolean {
  while (element) {
    if (
      element.classList.contains('wt-processed') ||
      element.classList.contains('wt-address-wrapper') ||
      element.classList.contains('wt-address-text') ||
      element.classList.contains('wt-indicator') ||
      element.classList.contains('wt-control-panel') ||
      element.classList.contains('wt-control-panel-bridge') ||
      element.classList.contains('wt-panel-header') ||
      element.classList.contains('wt-panel-address')
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

// Initialize content script
async function initialize() {
  console.log('[WalletTagger] Content script loaded');

  // Get all tags with their data from background
  const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_TAGS_DATA' });
  if (response?.tags) {
    tagCache = new Map(Object.entries(response.tags));
    knownAddresses = Array.from(tagCache.keys());
    console.log(`[WalletTagger] Loaded ${knownAddresses.length} tagged addresses`);
  }

  // Get settings
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  enabled = settings?.enabled ?? true;

  if (enabled) {
    // Initial scan
    scanPage();

    // Watch for dynamic content
    observeDOM();

    // Check for special pages
    handleSpecialPages();
  }
}

function scanPage() {
  if (!enabled) return;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip script and style tags
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tagName = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'textarea', 'input'].includes(tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip already processed - check ancestors too
        if (isAlreadyProcessed(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const nodesToProcess: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node as Text);
  }

  for (const textNode of nodesToProcess) {
    processTextNode(textNode);
  }
}

function processTextNode(textNode: Text) {
  const text = textNode.textContent || '';
  const matches = findAddressesInText(text);

  if (matches.length === 0) {
    // Check for truncated addresses if we have known addresses
    if (knownAddresses.length > 0) {
      processTruncatedAddresses(textNode);
    }
    return;
  }

  // Process found addresses
  const parent = textNode.parentElement;
  if (!parent) return;

  // Mark as processed
  parent.classList.add('wt-processed');

  // Create wrapper for the processed content
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const match of matches) {
    // Add text before match
    if (match.startIndex > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.startIndex)));
    }

    // Create address element
    const addressEl = createAddressElement(match.address, match.fullMatch);
    fragment.appendChild(addressEl);

    lastIndex = match.endIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  // Replace text node with processed content
  parent.replaceChild(fragment, textNode);
}

function processTruncatedAddresses(textNode: Text) {
  const text = textNode.textContent || '';
  const parent = textNode.parentElement;

  // Skip if already processed
  if (!parent || isAlreadyProcessed(parent)) return;

  // Skip if this is inside a tx/transaction link (tx hashes, not addresses)
  const closestLink = parent.closest('a');
  const href = closestLink?.getAttribute('href') || '';
  if (href.includes('/tx/') || href.includes('/transaction/')) return;

  // First, try to find full address in element attributes (title, data-*, href, etc.)
  const fullAddress = findAddressInAttributes(parent);
  if (fullAddress && text.includes('0x')) {
    // The text contains a truncated address and we found the full one in attributes
    const truncatedMatch = text.match(/0x[a-fA-F0-9]{2,10}(\.{2,3})[a-fA-F0-9]{2,10}|0x[a-fA-F0-9]{4,8}/i);
    if (truncatedMatch) {
      wrapWithAddressElement(textNode, truncatedMatch.index!, truncatedMatch[0].length, fullAddress);
      return;
    }
  }

  // Fallback: try to match truncated format against known addresses
  const truncatedRegex = /0x[a-fA-F0-9]{2,10}\.{2,3}[a-fA-F0-9]{2,10}/gi;
  let truncMatch;

  while ((truncMatch = truncatedRegex.exec(text)) !== null) {
    const matched = matchTruncatedAddress(truncMatch[0], knownAddresses);
    if (matched) {
      wrapWithAddressElement(textNode, truncMatch.index, truncMatch[0].length, matched);
      return;
    }
  }

  // Check for short format (0x923)
  const shortRegex = /\(0x[a-fA-F0-9]{3,6}\)/gi;
  let shortMatch;

  while ((shortMatch = shortRegex.exec(text)) !== null) {
    const matched = matchShortAddress(shortMatch[0], knownAddresses);
    if (matched) {
      wrapWithAddressElement(textNode, shortMatch.index, shortMatch[0].length, matched);
      return;
    }
  }
}

// Look for full address in element attributes (title, data-*, href, etc.)
function findAddressInAttributes(element: Element | null): string | null {
  const addressRegex = /0x[a-fA-F0-9]{40}/i;

  while (element && element !== document.body) {
    // Check common attributes that might contain the full address
    const attributesToCheck = [
      element.getAttribute('title'),
      element.getAttribute('data-address'),
      element.getAttribute('data-original-title'),
      element.getAttribute('data-clipboard-text'),
      element.getAttribute('data-bs-title'),
    ];

    for (const attr of attributesToCheck) {
      if (attr) {
        const match = attr.match(addressRegex);
        if (match) {
          return normalizeAddress(match[0]);
        }
      }
    }

    // Check href (common in block explorers: /address/0x...)
    // But skip tx/transaction links - those are tx hashes, not addresses
    const href = element.getAttribute('href');
    if (href && !href.includes('/tx/') && !href.includes('/transaction/')) {
      const match = href.match(addressRegex);
      if (match) {
        return normalizeAddress(match[0]);
      }
    }

    // Also check all data-* attributes
    for (const attr of element.getAttributeNames()) {
      if (attr.startsWith('data-')) {
        const value = element.getAttribute(attr);
        if (value) {
          const match = value.match(addressRegex);
          if (match) {
            return normalizeAddress(match[0]);
          }
        }
      }
    }

    element = element.parentElement;
  }

  return null;
}

function wrapWithAddressElement(
  textNode: Text,
  startIndex: number,
  length: number,
  fullAddress: string
) {
  const text = textNode.textContent || '';
  const parent = textNode.parentElement;
  if (!parent) return;

  parent.classList.add('wt-processed');

  const fragment = document.createDocumentFragment();

  // Text before
  if (startIndex > 0) {
    fragment.appendChild(document.createTextNode(text.slice(0, startIndex)));
  }

  // Address element
  const displayText = text.slice(startIndex, startIndex + length);
  const addressEl = createAddressElement(fullAddress, displayText);
  fragment.appendChild(addressEl);

  // Text after
  if (startIndex + length < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(startIndex + length)));
  }

  parent.replaceChild(fragment, textNode);
}

function createAddressElement(address: string, displayText: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'wt-address-wrapper';
  wrapper.dataset.address = address;

  const normalizedAddr = normalizeAddress(address);
  const tagData = tagCache.get(normalizedAddr);

  if (tagData) {
    wrapper.classList.add('wt-has-tag');

    // Show tag name
    const tagLabel = document.createElement('span');
    tagLabel.className = 'wt-tag-label';
    tagLabel.textContent = tagData.name;
    wrapper.appendChild(tagLabel);

    // Show short address in parentheses
    const shortAddr = document.createElement('span');
    shortAddr.className = 'wt-tag-short-address';
    shortAddr.textContent = ` (${address.slice(0, 6)})`;
    wrapper.appendChild(shortAddr);
  } else {
    // No tag - just show the original display text
    const textSpan = document.createElement('span');
    textSpan.className = 'wt-address-text';
    textSpan.textContent = displayText;
    wrapper.appendChild(textSpan);
  }

  // Add hover listener
  wrapper.addEventListener('mouseenter', (e) => showControlPanel(e, address));
  wrapper.addEventListener('mouseleave', hideControlPanelDelayed);

  return wrapper;
}

let controlPanel: HTMLElement | null = null;
let controlPanelBridge: HTMLElement | null = null;
let hideTimeout: number | null = null;
let showTimeout: number | null = null;
let currentPanelAddress: string | null = null;
let pendingShowAddress: string | null = null;

function showControlPanel(event: MouseEvent, address: string) {
  // If we're already showing this address's panel, just cancel any hide
  if (currentPanelAddress === address && controlPanel) {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    return;
  }

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // Cancel any pending show
  if (showTimeout) {
    clearTimeout(showTimeout);
    showTimeout = null;
  }

  // Store event data for delayed show
  const targetElement = event.target as HTMLElement;
  pendingShowAddress = address;

  // Delay before showing popup (300ms)
  showTimeout = window.setTimeout(() => {
    if (pendingShowAddress !== address) return; // Address changed, abort
    showControlPanelNow(targetElement, address);
  }, 300);
}

async function showControlPanelNow(target: HTMLElement, address: string) {
  // Get tags for this address
  const response = await chrome.runtime.sendMessage({ type: 'GET_TAGS', address });
  const tags: Tag[] = response?.tags || [];

  // Remove existing panel and bridge
  if (controlPanel) {
    controlPanel.remove();
  }
  if (controlPanelBridge) {
    controlPanelBridge.remove();
  }

  currentPanelAddress = address;

  // Create panel
  controlPanel = document.createElement('div');
  controlPanel.className = 'wt-control-panel';

  // Position near the element
  const rect = target.getBoundingClientRect();
  controlPanel.style.position = 'fixed';
  controlPanel.style.left = `${rect.left - 10}px`;
  controlPanel.style.top = `${rect.bottom}px`;  // No gap
  controlPanel.style.zIndex = '999999';
  controlPanel.style.paddingTop = '8px';  // Visual gap via padding instead

  // Create invisible bridge that overlaps trigger and panel
  controlPanelBridge = document.createElement('div');
  controlPanelBridge.className = 'wt-control-panel-bridge';
  // Bridge only covers gap between link bottom and panel, not the link itself
  // This allows the link to remain clickable
  controlPanelBridge.style.cssText = `
    position: fixed;
    left: ${rect.left - 20}px;
    top: ${rect.bottom}px;
    width: ${rect.width + 40}px;
    height: 15px;
    z-index: 999998;
    background: transparent;
    pointer-events: auto;
  `;
  controlPanelBridge.addEventListener('mouseenter', () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  });
  controlPanelBridge.addEventListener('mouseleave', hideControlPanelDelayed);
  document.body.appendChild(controlPanelBridge);

  // Header with address
  const header = document.createElement('div');
  header.className = 'wt-panel-header';

  const addressText = document.createElement('span');
  addressText.className = 'wt-panel-address';
  addressText.textContent = truncateAddress(address, 10, 8);
  addressText.title = address;
  header.appendChild(addressText);

  const copyAddressBtn = createCopyButton(address, 'Copy address');
  header.appendChild(copyAddressBtn);

  controlPanel.appendChild(header);

  // Tags section
  if (tags.length > 0) {
    const tagsSection = document.createElement('div');
    tagsSection.className = 'wt-panel-tags';

    for (const tag of tags) {
      const tagEl = document.createElement('div');
      tagEl.className = 'wt-panel-tag';

      const tagName = document.createElement('span');
      tagName.className = 'wt-tag-name';
      tagName.textContent = tag.entity ? `${tag.entity}: ${tag.name}` : tag.name;
      tagEl.appendChild(tagName);

      const tagSource = document.createElement('span');
      tagSource.className = 'wt-tag-source';
      tagSource.textContent = `(${tag.source})`;
      tagEl.appendChild(tagSource);

      const copyTagBtn = createCopyButton(tag.name, 'Copy tag');
      tagEl.appendChild(copyTagBtn);

      tagsSection.appendChild(tagEl);
    }

    controlPanel.appendChild(tagsSection);
  } else {
    // No tags - show input form to add a new tag
    const addTagSection = document.createElement('div');
    addTagSection.className = 'wt-panel-add-tag';
    addTagSection.style.cssText = 'padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.1);';

    const inputWrapper = document.createElement('div');
    inputWrapper.style.cssText = 'display: flex; gap: 6px; align-items: center;';

    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.placeholder = 'Enter tag name...';
    tagInput.className = 'wt-tag-input';
    tagInput.style.cssText = `
      flex: 1;
      padding: 6px 8px;
      background: #2a2a4e;
      border: 1px solid #3a3a5a;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 12px;
      outline: none;
    `;
    tagInput.addEventListener('focus', () => {
      tagInput.style.borderColor = '#4ade80';
    });
    tagInput.addEventListener('blur', () => {
      tagInput.style.borderColor = '#3a3a5a';
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾';
    saveBtn.title = 'Save tag';
    saveBtn.style.cssText = `
      padding: 6px 10px;
      background: #4ade80;
      border: none;
      border-radius: 4px;
      color: #1a1a2e;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.2s;
    `;
    saveBtn.addEventListener('mouseenter', () => {
      saveBtn.style.background = '#3bc970';
    });
    saveBtn.addEventListener('mouseleave', () => {
      saveBtn.style.background = '#4ade80';
    });

    const saveTag = async () => {
      const tagName = tagInput.value.trim();
      if (!tagName) return;

      saveBtn.textContent = '⏳';
      saveBtn.disabled = true;

      try {
        await chrome.runtime.sendMessage({
          type: 'ADD_EXTENSION_TAG',
          address: address,
          name: tagName,
        });
        
        // Show success feedback
        saveBtn.textContent = '✓';
        setTimeout(() => {
          // Close the panel - it will reopen with the new tag
          if (controlPanel) {
            controlPanel.remove();
            controlPanel = null;
          }
          if (controlPanelBridge) {
            controlPanelBridge.remove();
            controlPanelBridge = null;
          }
        }, 500);
      } catch (error) {
        console.error('[WalletTagger] Failed to save tag:', error);
        saveBtn.textContent = '❌';
        saveBtn.disabled = false;
        setTimeout(() => {
          saveBtn.textContent = '💾';
        }, 2000);
      }
    };

    saveBtn.addEventListener('click', saveTag);
    tagInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        saveTag();
      }
    });

    inputWrapper.appendChild(tagInput);
    inputWrapper.appendChild(saveBtn);
    addTagSection.appendChild(inputWrapper);

    controlPanel.appendChild(addTagSection);

    // Auto-focus the input after a brief delay
    setTimeout(() => tagInput.focus(), 100);
  }

  // Actions section
  const actionsSection = document.createElement('div');
  actionsSection.className = 'wt-panel-actions';

  for (const action of ACTION_LINKS) {
    const actionBtn = document.createElement('a');
    actionBtn.className = 'wt-action-btn';
    actionBtn.href = action.urlTemplate.replace('{address}', address);
    actionBtn.target = '_blank';
    actionBtn.rel = 'noopener noreferrer';
    actionBtn.title = action.name;

    const icon = document.createElement('img');
    icon.src = chrome.runtime.getURL(`icons/${action.iconFile}`);
    icon.alt = action.name;
    icon.className = 'wt-action-icon';
    actionBtn.appendChild(icon);

    actionsSection.appendChild(actionBtn);
  }

  controlPanel.appendChild(actionsSection);

  // Keep panel open when hovering over it
  controlPanel.addEventListener('mouseenter', () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  });
  controlPanel.addEventListener('mouseleave', hideControlPanelDelayed);

  document.body.appendChild(controlPanel);

  // Adjust position if panel goes off screen
  const panelRect = controlPanel.getBoundingClientRect();
  if (panelRect.right > window.innerWidth) {
    controlPanel.style.left = `${window.innerWidth - panelRect.width - 10}px`;
  }
  if (panelRect.bottom > window.innerHeight) {
    controlPanel.style.top = `${rect.top - panelRect.height - 5}px`;
  }
}

function hideControlPanelDelayed() {
  hideTimeout = window.setTimeout(() => {
    if (controlPanel) {
      controlPanel.remove();
      controlPanel = null;
    }
    if (controlPanelBridge) {
      controlPanelBridge.remove();
      controlPanelBridge = null;
    }
    currentPanelAddress = null;
  }, 500);  // Delay to allow moving to panel
}

function createCopyButton(text: string, title: string): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'wt-copy-btn';
  btn.title = title;
  btn.textContent = '📋';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓';
    setTimeout(() => {
      btn.textContent = '📋';
    }, 1000);
  });
  return btn;
}

function observeDOM() {
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      // Debounce scanning
      clearTimeout(scanDebounce);
      scanDebounce = window.setTimeout(scanPage, 500);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

let scanDebounce: number;

// Handle special pages (Arkham labels import)
function handleSpecialPages() {
  const hostname = window.location.hostname;

  if (hostname === 'intel.arkm.com') {
    // Add hover controls to Arkham's existing address elements
    setTimeout(handleArkhamAddresses, 1000);

    // Also observe for dynamically loaded content
    const arkhamObserver = new MutationObserver(() => {
      handleArkhamAddresses();
    });
    arkhamObserver.observe(document.body, { childList: true, subtree: true });

    // Show import button only on labels page
    if (window.location.pathname === '/labels') {
      handleArkhamLabelsPage();
    }
  }

  if (hostname === 'snowscan.xyz') {
    // Show import button only on mynotes_address page
    if (window.location.pathname === '/mynotes_address') {
      handleSnowscanNotesPage();
    }
  }

  if (hostname === 'dexscreener.com') {
    // Handle Dexscreener address links
    setTimeout(handleDexscreenerAddresses, 1000);

    const dexObserver = new MutationObserver(() => {
      handleDexscreenerAddresses();
    });
    dexObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function handleArkhamLabelsPage() {
  console.log('[WalletTagger] Detected Arkham labels page');
  setTimeout(addArkhamImportButton, 2000);
}

function handleArkhamAddresses() {
  // Inject CSS to hide Arkham's popups (only once)
  if (!document.getElementById('wt-arkham-popup-blocker')) {
    const style = document.createElement('style');
    style.id = 'wt-arkham-popup-blocker';
    style.textContent = `
      /* Hide Arkham's hover popups - but not our panel */
      [data-radix-popper-content-wrapper]:not(.wt-control-panel),
      [data-floating-ui-portal]:not(.wt-control-panel),
      [data-radix-portal]:not(.wt-control-panel),
      div[style*="position: absolute"][style*="left:"]:not(.wt-control-panel):not(.wt-control-panel-bridge):has(a[href*="/explorer/"]),
      div[style*="position: fixed"][style*="left:"]:not(.wt-control-panel):not(.wt-control-panel-bridge):has(a[href*="/explorer/"]) {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);

    // Also use MutationObserver as backup to remove popups
    const popupObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Skip our own elements
            if (node.classList.contains('wt-control-panel') ||
                node.classList.contains('wt-control-panel-bridge') ||
                node.closest('.wt-control-panel')) {
              continue;
            }
            // Arkham uses radix/floating-ui for popups
            if (
              node.hasAttribute('data-radix-popper-content-wrapper') ||
              node.hasAttribute('data-floating-ui-portal') ||
              node.hasAttribute('data-radix-portal') ||
              node.querySelector?.('[data-radix-popper-content-wrapper]') ||
              node.querySelector?.('[data-radix-portal]')
            ) {
              node.remove();
            }
          }
        }
      }
    });
    popupObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Find Arkham's address links that haven't been processed (exclude our own panel)
  const addressLinks = document.querySelectorAll('a[href*="/explorer/address/0x"]:not(.wt-arkham-processed):not(.wt-action-btn)');

  for (const link of addressLinks) {
    link.classList.add('wt-arkham-processed');

    // Extract address from href
    const href = link.getAttribute('href') || '';
    const match = href.match(/0x[a-fA-F0-9]{40}/i);
    if (!match) continue;

    const address = normalizeAddress(match[0]);

    // Add our hover controls
    link.addEventListener('mouseenter', (e) => showControlPanel(e as MouseEvent, address));
    link.addEventListener('mouseleave', hideControlPanelDelayed);

    // Check if we have our own tag for this address
    const tagData = tagCache.get(address);
    if (tagData) {
      // Just add green highlight - Arkham already shows labels, hover popup shows our tag details
      (link as HTMLElement).style.cssText += `
        background: rgba(74, 222, 128, 0.15) !important;
        border: 1px dashed #4ade80 !important;
        border-radius: 4px !important;
        padding: 2px 4px !important;
      `;
    }
  }
}

// Close control panel when clicking elsewhere
document.addEventListener('click', (e) => {
  if (controlPanel && !controlPanel.contains(e.target as Node)) {
    const target = e.target as Element;
    if (!target.closest('.wt-arkham-indicator') && !target.closest('.wt-control-panel-bridge')) {
      controlPanel.remove();
      controlPanel = null;
      if (controlPanelBridge) {
        controlPanelBridge.remove();
        controlPanelBridge = null;
      }
      currentPanelAddress = null;
    }
  }
});

function handleDexscreenerAddresses() {
  // Handle all Dexscreener table types
  handleDexTransactionsTable();
  handleDexGridTables();
}

// Cache grid templates per table type
const dexGridTemplates: Map<string, string> = new Map();

/**
 * Find a header row by looking for specific column names
 */
function findHeaderByColumns(columnNames: string[]): HTMLElement | null {
  // Check table headers (Transactions tab)
  const tableHeaders = document.querySelectorAll('tr');
  for (const tr of tableHeaders) {
    const ths = tr.querySelectorAll('th');
    if (ths.length >= columnNames.length) {
      const texts = Array.from(ths).map(th => th.textContent?.trim().toLowerCase() || '');
      if (columnNames.every(col => texts.some(t => t.includes(col.toLowerCase())))) {
        return tr as HTMLElement;
      }
    }
  }

  // Check div-based grids (Top Traders, Holders, LP tabs)
  const divs = document.querySelectorAll('div');
  for (const div of divs) {
    const style = getComputedStyle(div);
    if (style.display === 'grid' && div.children.length >= columnNames.length) {
      const texts = Array.from(div.children).map(c => c.textContent?.trim().toLowerCase() || '');
      if (columnNames.every(col => texts.some(t => t.includes(col.toLowerCase())))) {
        return div as HTMLElement;
      }
    }
  }

  return null;
}

/**
 * Handle Transactions table (uses <table> with <tr>/<th>/<td>)
 */
function handleDexTransactionsTable() {
  // Find Transactions header by column names
  const headerTr = findHeaderByColumns(['date', 'type', 'maker', 'txn']) as HTMLTableRowElement;
  if (!headerTr) return;

  const ths = headerTr.querySelectorAll('th');
  if (ths.length < 8) return;

  // Add TAG header at the end if not already present
  if (!headerTr.classList.contains('wt-tag-col-added')) {
    // Get current grid and modify it - add TAG column at end
    const currentGrid = getComputedStyle(headerTr).gridTemplateColumns;
    const cols = currentGrid.split(/\s+/);

    // Shrink some columns to make room for TAG (140px)
    // Columns 2,3,4,5 are typically USD, ARENA, WAVAX, Price - shrink by ~35px each
    for (const idx of [2, 3, 4, 5]) {
      const val = parseFloat(cols[idx]);
      if (!isNaN(val) && val > 100) {
        cols[idx] = (val - 35) + 'px';
      }
    }

    cols.push('140px');
    const newGrid = cols.join(' ');
    dexGridTemplates.set('transactions', newGrid);
    headerTr.style.gridTemplateColumns = newGrid;

    // Add TAG header at the end
    const tagTh = document.createElement('th');
    tagTh.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; padding: 0 4px;';
    tagTh.innerHTML = '<span style="color: #4ade80; font-size: 11px; font-weight: 600;">TAG</span>';
    headerTr.appendChild(tagTh);

    headerTr.classList.add('wt-tag-col-added');
  }

  // Always process new unprocessed data rows
  const addressLinks = document.querySelectorAll<HTMLAnchorElement>('td a[href*="/address/0x"]:not(.wt-dex-processed)');
  for (const link of addressLinks) {
    processTransactionRow(link);
  }
}

function processTransactionRow(link: HTMLAnchorElement) {
  link.classList.add('wt-dex-processed');

  const href = link.getAttribute('href') || '';
  const match = href.match(/0x[a-fA-F0-9]{40}/i);
  if (!match) return;

  const address = normalizeAddress(match[0]);
  const td = link.closest('td') as HTMLTableCellElement;
  if (!td || td.classList.contains('wt-tag-col-added')) return;

  // Apply grid template
  const gridTemplate = dexGridTemplates.get('transactions');
  if (gridTemplate) {
    td.style.gridTemplateColumns = gridTemplate;
  }

  // Create and append tag cell at the end
  const tagData = tagCache.get(address);
  const tagCell = createTagCell(address, tagData?.name);
  td.appendChild(tagCell);
  td.classList.add('wt-tag-col-added');
}

/**
 * Handle div-based grid tables (Top Traders, Holders, Liquidity Providers)
 */
function handleDexGridTables() {
  // Define table types by their column signatures
  const tableTypes = [
    { name: 'toptraders', columns: ['rank', 'maker', 'bought', 'sold'] },
    { name: 'holders', columns: ['rank', 'address', '%', 'amount', 'value'] },
    { name: 'lp', columns: ['rank', 'address', '%', 'amount', 'txns'] },
  ];

  for (const tableType of tableTypes) {
    const header = findHeaderByColumns(tableType.columns);
    if (!header) continue;
    if (header.tagName === 'TR') continue; // Skip table rows, handled separately

    processGridTable(header, tableType.name);
  }
}

function processGridTable(header: HTMLElement, tableName: string) {
  const headerChildren = Array.from(header.children);

  // Add TAG header at the end if not already present
  if (!header.classList.contains('wt-tag-col-added')) {
    // Modify grid template - add TAG column at the end
    const currentGrid = getComputedStyle(header).gridTemplateColumns;
    const cols = currentGrid.split(/\s+/);

    // Shrink larger columns to make room for TAG (140px)
    // Find columns > 120px and shrink them proportionally
    let totalToShrink = 140;
    const shrinkableIdxs = cols.map((col, i) => ({ i, val: parseFloat(col) }))
      .filter(c => !isNaN(c.val) && c.val > 120)
      .map(c => c.i);

    if (shrinkableIdxs.length > 0) {
      const shrinkPer = totalToShrink / shrinkableIdxs.length;
      for (const idx of shrinkableIdxs) {
        const val = parseFloat(cols[idx]);
        cols[idx] = (val - shrinkPer) + 'px';
      }
    }

    cols.push('140px');
    const newGrid = cols.join(' ');
    dexGridTemplates.set(tableName, newGrid);
    header.style.gridTemplateColumns = newGrid;

    // Add TAG header at the end
    const tagHeader = document.createElement('div');
    tagHeader.style.cssText = 'display: flex; align-items: center; padding: 0 4px;';
    tagHeader.innerHTML = '<span style="color: #4ade80; font-size: 11px; font-weight: 600;">TAG</span>';
    header.appendChild(tagHeader);

    header.classList.add('wt-tag-col-added');
  }

  // Find and process data rows (siblings with same grid structure)
  const container = header.parentElement;
  if (!container) return;

  const rows = Array.from(container.children).filter(row => {
    if (row === header || row.classList.contains('wt-tag-col-added')) return false;
    const style = getComputedStyle(row);
    return style.display === 'grid' && row.children.length >= headerChildren.length - 1; // -1 because header now has TAG
  });

  for (const row of rows) {
    processGridRow(row as HTMLElement, tableName);
  }
}

function processGridRow(row: HTMLElement, tableName: string) {
  if (row.classList.contains('wt-tag-col-added')) return;

  // Find address in this row - look for explorer link
  const explorerLink = row.querySelector('a[href*="/address/0x"]') as HTMLAnchorElement;
  if (!explorerLink) return;

  const href = explorerLink.getAttribute('href') || '';
  const match = href.match(/0x[a-fA-F0-9]{40}/i);
  if (!match) return;

  const address = normalizeAddress(match[0]);

  // Apply grid template
  const gridTemplate = dexGridTemplates.get(tableName);
  if (gridTemplate) {
    row.style.gridTemplateColumns = gridTemplate;
  }

  // Create and append tag cell at the end
  const tagData = tagCache.get(address);
  const tagCell = createTagCell(address, tagData?.name);
  row.appendChild(tagCell);

  row.classList.add('wt-tag-col-added');
}

function createTagCell(address: string, tagName: string | undefined): HTMLElement {
  const tagCell = document.createElement('div');
  tagCell.className = 'wt-tag-cell';
  tagCell.style.cssText = 'display: flex; align-items: center; padding: 0 4px; min-width: 0; overflow: hidden; cursor: pointer;';

  if (tagName) {
    tagCell.innerHTML = `<span style="color: #4ade80; font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${tagName}">${tagName}</span>`;
  }

  // Add hover listeners for control panel
  tagCell.addEventListener('mouseenter', (e) => showControlPanel(e as MouseEvent, address));
  tagCell.addEventListener('mouseleave', hideControlPanelDelayed);

  return tagCell;
}

function addArkhamImportButton() {
  // Check if button already exists
  if (document.getElementById('wt-arkham-import')) return;

  const btn = document.createElement('button');
  btn.id = 'wt-arkham-import';
  btn.className = 'wt-arkham-import-btn';
  btn.textContent = '📥 Import to Wallet Tagger';
  btn.addEventListener('click', importArkhamLabels);

  // Add to page - try to find a good position
  const container = document.querySelector('main') || document.body;
  btn.style.position = 'fixed';
  btn.style.bottom = '20px';
  btn.style.right = '20px';
  btn.style.zIndex = '999999';
  container.appendChild(btn);
}

async function importArkhamLabels() {
  const btn = document.getElementById('wt-arkham-import') as HTMLButtonElement;
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Importing...';

  try {
    // Fetch labels from Arkham API (uses page cookies for auth)
    const tags = await fetchArkhamLabels();

    if (tags.length === 0) {
      btn.textContent = '❌ No labels found';
      setTimeout(() => {
        btn.textContent = '📥 Import to Wallet Tagger';
        btn.disabled = false;
      }, 2000);
      return;
    }

    // Send to background for storage
    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_ARKHAM_TAGS',
      tags,
    });

    btn.textContent = `✓ Imported ${response.count} labels`;
    setTimeout(() => {
      btn.textContent = '📥 Import to Wallet Tagger';
      btn.disabled = false;
    }, 3000);
  } catch (error) {
    console.error('[WalletTagger] Arkham import failed:', error);
    btn.textContent = '❌ Import failed';
    setTimeout(() => {
      btn.textContent = '📥 Import to Wallet Tagger';
      btn.disabled = false;
    }, 2000);
  }
}

async function fetchArkhamLabels(): Promise<Tag[]> {
  // Use a map to dedupe by address, preferring labels over entity-only entries
  const tagMap = new Map<string, Tag>();

  // Fetch entities first (so labels can override)
  const entitiesResponse = await fetch('https://api.arkm.com/user/entities', {
    credentials: 'include',
  });

  if (entitiesResponse.ok) {
    const entitiesData = await entitiesResponse.json();
    let entityCount = 0;
    for (const entity of entitiesData) {
      const evmAddresses = entity.addresses?.evm || [];
      for (const address of evmAddresses) {
        const normalized = address.toLowerCase();
        tagMap.set(normalized, {
          address: normalized,
          name: entity.name,
          entity: entity.name,
          source: 'arkham',
        });
        entityCount++;
      }
    }
    console.log(`[WalletTagger] Fetched ${entityCount} addresses from entities`);
  }

  // Fetch individual labels (these override/augment entity entries)
  const labelsResponse = await fetch('https://api.arkm.com/user/labels', {
    credentials: 'include',
  });

  if (labelsResponse.ok) {
    const labelsData = await labelsResponse.json();
    let labelCount = 0;
    for (const item of labelsData) {
      if (item.chainType === 'evm') {
        const normalized = item.address.toLowerCase();
        const existing = tagMap.get(normalized);
        tagMap.set(normalized, {
          address: normalized,
          name: item.name,
          entity: existing?.entity, // Keep entity if address was in an entity
          source: 'arkham',
        });
        labelCount++;
      }
    }
    console.log(`[WalletTagger] Fetched ${labelCount} individual labels`);
  }

  const tags = Array.from(tagMap.values());

  if (tags.length === 0) {
    throw new Error('No labels or entities found');
  }

  console.log(`[WalletTagger] Total unique addresses: ${tags.length}`);
  return tags;
}

function handleSnowscanNotesPage() {
  console.log('[WalletTagger] Detected SnowScan notes page');
  setTimeout(addSnowscanImportButton, 2000);
}

function addSnowscanImportButton() {
  // Check if button already exists
  if (document.getElementById('wt-snowscan-import')) return;

  const btn = document.createElement('button');
  btn.id = 'wt-snowscan-import';
  btn.className = 'wt-arkham-import-btn';
  btn.textContent = '📥 Import to Wallet Tagger';
  btn.addEventListener('click', importSnowscanNotes);

  // Add to page - try to find a good position
  const container = document.querySelector('main') || document.body;
  btn.style.position = 'fixed';
  btn.style.bottom = '20px';
  btn.style.right = '20px';
  btn.style.zIndex = '999999';
  container.appendChild(btn);
}

async function importSnowscanNotes() {
  const btn = document.getElementById('wt-snowscan-import') as HTMLButtonElement;
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Importing...';

  try {
    // Scrape notes from SnowScan page (with pagination)
    const tags = await fetchSnowscanNotes();

    console.log(`[WalletTagger] Scraped ${tags.length} tags, now sending to background...`);

    if (tags.length === 0) {
      btn.textContent = '❌ No notes found';
      setTimeout(() => {
        btn.textContent = '📥 Import to Wallet Tagger';
        btn.disabled = false;
      }, 2000);
      return;
    }

    // Send to background for storage
    console.log('[WalletTagger] Sending IMPORT_SNOWSCAN_TAGS message...');
    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_SNOWSCAN_TAGS',
      tags,
    });

    console.log('[WalletTagger] Got response from background:', response);

    if (response && response.count !== undefined) {
      btn.textContent = `✓ Imported ${response.count} notes`;
      console.log(`[WalletTagger] Successfully imported ${response.count} notes`);
    } else {
      console.error('[WalletTagger] Invalid response from background:', response);
      throw new Error('Invalid response from background script');
    }

    setTimeout(() => {
      btn.textContent = '📥 Import to Wallet Tagger';
      btn.disabled = false;
    }, 3000);
  } catch (error) {
    console.error('[WalletTagger] SnowScan import failed:', error);
    btn.textContent = '❌ Import failed';
    setTimeout(() => {
      btn.textContent = '📥 Import to Wallet Tagger';
      btn.disabled = false;
    }, 2000);
  }
}

async function fetchSnowscanNotes(): Promise<Tag[]> {
  const tags: Tag[] = [];
  const addressRegex = /0x[a-fA-F0-9]{40}/i;
  
  let currentPage = 1;
  let hasMorePages = true;

  console.log('[WalletTagger] Starting SnowScan notes scraping...');

  try {
    while (hasMorePages) {
      console.log(`[WalletTagger] Fetching page ${currentPage}...`);
      
      // Fetch the page
      const url = currentPage === 1 
        ? 'https://snowscan.xyz/mynotes_address'
        : `https://snowscan.xyz/mynotes_address?p=${currentPage}`;
      
      const response = await fetch(url, {
        credentials: 'include',
      });

      if (!response.ok) {
        console.error(`[WalletTagger] Failed to fetch page ${currentPage}: ${response.status}`);
        break;
      }

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Look for the table containing address notes
      // SnowScan uses a card with a table inside
      const rows = doc.querySelectorAll('table tbody tr');
      
      console.log(`[WalletTagger] Found ${rows.length} rows on page ${currentPage}`);
      
      if (rows.length === 0) {
        console.log('[WalletTagger] No rows found on this page');
        hasMorePages = false;
        break;
      }

      let pageCount = 0;
      for (const row of rows) {
        try {
          // Look for address links in the row
          const addressLink = row.querySelector('a[href*="/address/0x"]');
          if (!addressLink) {
            console.log('[WalletTagger] Row has no address link, skipping');
            continue;
          }

          const href = addressLink.getAttribute('href') || '';
          const addressMatch = href.match(addressRegex);
          if (!addressMatch) {
            console.log('[WalletTagger] Could not extract address from href:', href);
            continue;
          }

          const address = normalizeAddress(addressMatch[0]);

          // Look for the name tag in the same row
          // The structure varies, but the name tag is usually in a cell before or after the address
          const cells = Array.from(row.querySelectorAll('td'));
          let nameTag = '';

          // Strategy 1: Look for a cell with data-toggle="tooltip" or title attribute (common in Etherscan/SnowScan)
          for (const cell of cells) {
            const title = cell.getAttribute('title') || cell.getAttribute('data-original-title');
            if (title && title.length > 0 && title.length < 100 && !title.match(/^0x/)) {
              nameTag = title;
              break;
            }
          }

          // Strategy 2: If no title found, look at cell text content
          if (!nameTag) {
            for (let i = 0; i < cells.length; i++) {
              const cell = cells[i];
              const cellText = cell.textContent?.trim() || '';
              
              // Skip empty cells, address cells, and cells with only whitespace/symbols
              if (!cellText || cellText.match(/^0x[a-fA-F0-9]/i) || cellText.match(/^[\s.…—-]*$/)) {
                continue;
              }
              
              // Skip cells that are clearly action buttons or UI elements
              if (cellText.match(/^(edit|delete|view|copy|close|save|cancel)$/i)) {
                continue;
              }

              // Skip cells with just icons or very short meaningless text
              if (cellText.length < 2) {
                continue;
              }

              // This cell likely contains the name tag
              // Take only the first line if there are multiple lines
              nameTag = cellText.split('\n')[0].trim();
              if (nameTag.length > 0 && nameTag.length < 100) {
                console.log(`[WalletTagger] Found name tag in cell ${i}: "${nameTag}" for ${address.slice(0, 10)}...`);
                break;
              }
            }
          }

          if (nameTag) {
            tags.push({
              address,
              name: nameTag,
              source: 'snowscan',
            });
            pageCount++;
          } else {
            console.log(`[WalletTagger] No name tag found for address ${address.slice(0, 10)}...`);
          }
        } catch (rowError) {
          console.error('[WalletTagger] Error processing row:', rowError);
        }
      }

      console.log(`[WalletTagger] Extracted ${pageCount} addresses with tags from page ${currentPage}`);

      // Check if there's a next page
      // Look for pagination controls
      const paginationLinks = doc.querySelectorAll('.pagination a, a.page-link');
      
      console.log(`[WalletTagger] Found ${paginationLinks.length} pagination links`);
      
      // Check if we can find a "Next" button or a higher page number
      let foundNextPage = false;
      for (const link of paginationLinks) {
        const linkText = link.textContent?.trim() || '';
        const linkHref = link.getAttribute('href') || '';
        
        if (linkText.toLowerCase().includes('next') || linkHref.includes(`p=${currentPage + 1}`)) {
          foundNextPage = true;
          console.log(`[WalletTagger] Found next page link: ${linkText} / ${linkHref}`);
          break;
        }
      }

      // Only continue if we found items on this page AND there's a next page
      if (foundNextPage && pageCount > 0) {
        currentPage++;
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log(`[WalletTagger] No more pages (foundNextPage: ${foundNextPage}, pageCount: ${pageCount})`);
        hasMorePages = false;
      }

      // Safety limit to avoid infinite loops
      if (currentPage > 100) {
        console.log('[WalletTagger] Reached page limit (100)');
        hasMorePages = false;
      }
    }

    console.log(`[WalletTagger] Total SnowScan addresses scraped: ${tags.length}`);

    if (tags.length === 0) {
      throw new Error('No address notes found. Make sure you are logged in to SnowScan and have created private name tags.');
    }

    return tags;
  } catch (error) {
    console.error('[WalletTagger] Error in fetchSnowscanNotes:', error);
    throw error;
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TAGS_UPDATED') {
    // Refresh tag cache and rescan
    chrome.runtime.sendMessage({ type: 'GET_ALL_TAGS_DATA' }).then((response) => {
      if (response?.tags) {
        tagCache = new Map(Object.entries(response.tags));
        knownAddresses = Array.from(tagCache.keys());

        // Remove existing markers and rescan
        document.querySelectorAll('.wt-processed').forEach((el) => {
          el.classList.remove('wt-processed');
        });
        document.querySelectorAll('.wt-address-wrapper').forEach((el) => {
          // Restore original address from data attribute
          const address = el.getAttribute('data-address') || '';
          el.replaceWith(document.createTextNode(address));
        });
        scanPage();
      }
    });
  }
});

// Initialize
initialize();
