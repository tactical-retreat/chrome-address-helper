// Options page script

async function initializeOptions() {
  await loadStats();
}

async function loadStats() {
  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (stats) {
    document.getElementById('totalTags')!.textContent = stats.totalTags.toLocaleString();
    document.getElementById('uniqueAddresses')!.textContent = stats.uniqueAddresses.toLocaleString();
    document.getElementById('sourceCount')!.textContent = Object.keys(stats.sourceBreakdown).length.toString();

    // Populate source list
    const sourceList = document.getElementById('sourceList')!;
    sourceList.innerHTML = '';

    for (const [source, count] of Object.entries(stats.sourceBreakdown)) {
      const item = document.createElement('div');
      item.className = 'source-item';
      item.innerHTML = `
        <span class="source-name">${escapeHtml(source)}</span>
        <span class="source-count">${(count as number).toLocaleString()} tags</span>
      `;
      sourceList.appendChild(item);
    }
  }
}

function showMessage(text: string, type: 'success' | 'error') {
  const message = document.getElementById('message')!;
  message.textContent = text;
  message.className = `message ${type}`;
  setTimeout(() => {
    message.className = 'message';
  }, 5000);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// CSV File Upload
document.getElementById('csvFileInput')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  document.getElementById('fileName')!.textContent = file.name;

  try {
    const content = await file.text();
    const response = await chrome.runtime.sendMessage({
      type: 'IMPORT_CSV',
      csv: content,
      source: file.name,
    });

    showMessage(`Successfully imported ${response.count} tags from ${file.name}`, 'success');
    await loadStats();
  } catch (error) {
    showMessage(`Failed to import: ${(error as Error).message}`, 'error');
  }
});

// CSV URL Load
document.getElementById('loadUrlBtn')!.addEventListener('click', async () => {
  const input = document.getElementById('csvUrlInput') as HTMLInputElement;
  const url = input.value.trim();
  if (!url) {
    showMessage('Please enter a URL', 'error');
    return;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.text();

    const source = new URL(url).pathname.split('/').pop() || url;
    const result = await chrome.runtime.sendMessage({
      type: 'IMPORT_CSV',
      csv: content,
      source,
    });

    showMessage(`Successfully imported ${result.count} tags from URL`, 'success');
    input.value = '';
    await loadStats();
  } catch (error) {
    showMessage(`Failed to load URL: ${(error as Error).message}`, 'error');
  }
});

// Export Arkham Tags
document.getElementById('exportArkhamBtn')!.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_ARKHAM_TAGS' });
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;

  if (response.count === 0) {
    output.value = '# No Arkham tags found. Import from Arkham first.';
  } else {
    output.value = response.csv;
  }
  showMessage(`Exported ${response.count} Arkham tags`, 'success');
});

// Export SnowScan Tags
document.getElementById('exportSnowscanBtn')!.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_SNOWSCAN_TAGS' });
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;

  if (response.count === 0) {
    output.value = '# No SnowScan tags found. Import from SnowScan first.';
  } else {
    output.value = response.csv;
  }
  showMessage(`Exported ${response.count} SnowScan tags`, 'success');
});

// Export All Tags
document.getElementById('exportAllBtn')!.addEventListener('click', async () => {
  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  // For now, just show stats. Full export would need backend support
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
  output.value = `# Total: ${stats.totalTags} tags across ${stats.uniqueAddresses} addresses\n`;
  output.value += `# Sources:\n`;
  for (const [source, count] of Object.entries(stats.sourceBreakdown)) {
    output.value += `#   ${source}: ${count}\n`;
  }
  output.value += `\n# Use individual source exports for full CSV data.`;
});

// Copy to Clipboard
document.getElementById('copyExportBtn')!.addEventListener('click', async () => {
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
  if (output.value) {
    await navigator.clipboard.writeText(output.value);
    showMessage('Copied to clipboard!', 'success');
  }
});

initializeOptions();
