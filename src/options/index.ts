// Options page script
import { parseZipFile } from '../utils/zipParser';
import JSZip from 'jszip';

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
        <div class="source-actions">
          <span class="source-count">${(count as number).toLocaleString()} tags</span>
          <button class="btn edit-source-btn" data-source="${escapeHtml(source)}" title="Edit tags in this source">✏️</button>
          <button class="btn btn-danger remove-source-btn" data-source="${escapeHtml(source)}" title="Remove all tags from this source">✕</button>
        </div>
      `;
      sourceList.appendChild(item);
      
      // Add event listeners
      const editBtn = item.querySelector('.edit-source-btn') as HTMLButtonElement;
      const removeBtn = item.querySelector('.remove-source-btn') as HTMLButtonElement;
      
      editBtn.addEventListener('click', () => editSource(source));
      removeBtn.addEventListener('click', () => removeSource(source));
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

async function editSource(source: string) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EXPORT_SOURCE',
      source: source,
    });

    const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
    output.value = response.csv;
    output.readOnly = false;
    output.placeholder = `Editing ${source} - Format: address,name (with header row)`;
    
    // Show save button and change export section
    showEditMode(source);
    
    // Scroll to the textarea so user can see where to edit
    output.scrollIntoView({ behavior: 'smooth', block: 'center' });
    output.focus();
    
    showMessage(`Loaded ${response.count} tags from ${source} for editing`, 'success');
  } catch (error) {
    showMessage(`Failed to load source for editing: ${(error as Error).message}`, 'error');
  }
}

async function removeSource(source: string) {
  const confirmed = confirm(`Are you sure you want to remove all tags from "${source}"? This action cannot be undone.`);
  if (!confirmed) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'REMOVE_SOURCE',
      source: source,
    });

    showMessage(`Successfully removed ${response.count} tags from ${source}`, 'success');
    await loadStats(); // Refresh the statistics
  } catch (error) {
    showMessage(`Failed to remove source: ${(error as Error).message}`, 'error');
  }
}

function showEditMode(source: string) {
  const exportSection = document.querySelector('.export-section') as HTMLElement;
  exportSection.innerHTML = `
    <button class="btn" id="saveEditBtn">💾 Save Changes</button>
    <button class="btn" id="cancelEditBtn">❌ Cancel</button>
    <button class="btn" id="exportArkhamBtn" style="opacity: 0.5;" disabled>Export Arkham Tags</button>
    <button class="btn" id="exportAllBtn" style="opacity: 0.5;" disabled>Export All Tags (ZIP)</button>
  `;
  
  // Add event listeners for save and cancel
  document.getElementById('saveEditBtn')!.addEventListener('click', () => saveSourceEdit(source));
  document.getElementById('cancelEditBtn')!.addEventListener('click', () => cancelEdit());
}

function showNormalMode() {
  const exportSection = document.querySelector('.export-section') as HTMLElement;
  exportSection.innerHTML = `
    <button class="btn" id="exportArkhamBtn">Export Arkham Tags</button>
    <button class="btn" id="exportAllBtn">Export All Tags (ZIP)</button>
  `;
  
  // Re-add the original event listeners
  document.getElementById('exportArkhamBtn')!.addEventListener('click', exportArkhamTags);
  document.getElementById('exportAllBtn')!.addEventListener('click', exportAllTags);
  
  // Reset textarea
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
  output.readOnly = true;
  output.placeholder = 'Exported CSV will appear here...';
  output.value = '';
}

async function saveSourceEdit(source: string) {
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
  const csvContent = output.value;
  
  if (!csvContent.trim()) {
    showMessage('Cannot save empty content', 'error');
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'UPDATE_SOURCE',
      source: source,
      csv: csvContent,
    });
    
    showMessage(`Successfully updated ${response.count} tags in ${source}`, 'success');
    await loadStats(); // Refresh the statistics
    showNormalMode();
  } catch (error) {
    showMessage(`Failed to save changes: ${(error as Error).message}`, 'error');
  }
}

function cancelEdit() {
  showNormalMode();
  showMessage('Edit cancelled', 'success');
}

async function downloadZipFile(sourceFiles: { [source: string]: string }, filename: string) {
  const zip = new JSZip();
  
  // Add each source as a CSV file in the zip
  for (const [source, csvContent] of Object.entries(sourceFiles)) {
    // Clean up source name for filename
    const cleanSource = source.replace(/[^a-zA-Z0-9_-]/g, '_');
    zip.file(`${cleanSource}.csv`, csvContent);
  }
  
  // Generate the zip file
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  
  // Create download link
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSV File Upload
document.getElementById('csvFileInput')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  document.getElementById('fileName')!.textContent = file.name;

  try {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const tags = await parseZipFile(file, file.name);
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_TAGS',
        tags: tags,
      });

      const count = response?.count ?? 'unknown number of';
      showMessage(`Successfully imported ${count} tags from ${file.name}`, 'success');
    } else {
      const content = await file.text();
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_CSV',
        csv: content,
        source: file.name,
      });

      showMessage(`Successfully imported ${response.count} tags from ${file.name}`, 'success');
    }
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

// Extract export functions for reuse
async function exportArkhamTags() {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_ARKHAM_TAGS' });
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;

  if (response.count === 0) {
    output.value = '# No Arkham tags found. Import from Arkham first.';
  } else {
    output.value = response.csv;
  }
  showMessage(`Exported ${response.count} Arkham tags`, 'success');
}

async function exportAllTags() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_ALL_SOURCES' });
    
    // Show export summary in textarea
    const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
    output.value = `# Exported ${response.totalTags} tags from ${response.sourceCount} sources to ZIP file\n\n`;
    output.value += `# Sources included:\n`;
    for (const [source, csvContent] of Object.entries(response.sourceFiles)) {
      const lineCount = (csvContent as string).split('\n').length - 1; // -1 for header
      output.value += `#   ${source}: ${lineCount} tags\n`;
    }
    output.value += `\n# ZIP file downloaded as: all-tags.zip`;
    
    await downloadZipFile(response.sourceFiles, 'all-tags.zip');
    showMessage(`Successfully exported ${response.totalTags} tags from ${response.sourceCount} sources`, 'success');
  } catch (error) {
    showMessage(`Failed to export: ${(error as Error).message}`, 'error');
  }
}

// Export Arkham Tags
document.getElementById('exportArkhamBtn')!.addEventListener('click', exportArkhamTags);

// Export All Tags
document.getElementById('exportAllBtn')!.addEventListener('click', exportAllTags);

// Copy to Clipboard
document.getElementById('copyExportBtn')!.addEventListener('click', async () => {
  const output = document.getElementById('exportOutput') as HTMLTextAreaElement;
  if (output.value) {
    await navigator.clipboard.writeText(output.value);
    showMessage('Copied to clipboard!', 'success');
  }
});

initializeOptions();
