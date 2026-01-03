import { Tag } from '../types';
import { parseCSV } from '../storage/csvParser';
import JSZip from 'jszip';

export async function extractZipFile(file: File): Promise<{ content: string; filename: string }[]> {
  const zip = new JSZip();
  const zipData = await zip.loadAsync(file);
  const results: { content: string; filename: string }[] = [];
  
  for (const [filename, zipEntry] of Object.entries(zipData.files)) {
    const entry = zipEntry as JSZip.JSZipObject;
    if (!entry.dir && filename.toLowerCase().endsWith('.csv')) {
      const content = await entry.async('text');
      results.push({ content, filename });
    }
  }
  
  return results;
}

export async function parseZipFile(file: File, source: string): Promise<Tag[]> {
  const csvFiles = await extractZipFile(file);
  const allTags: Tag[] = [];
  
  for (const csvFile of csvFiles) {
    const fileSource = `${source}/${csvFile.filename}`;
    const tags = parseCSV(csvFile.content, fileSource);
    allTags.push(...tags);
  }
  
  return allTags;
}