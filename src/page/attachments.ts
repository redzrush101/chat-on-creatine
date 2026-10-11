import { composerForm } from './dom';

const FILE_INPUT = 'input[type="file"]';
const UPLOAD_BUSY = '[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]';

async function waitForFileInput(files: File[], timeoutMs: number): Promise<HTMLInputElement | null> {
  const deadline = Date.now() + timeoutMs;
  const images = files.every((file) => file.type.startsWith('image/'));
  do {
    const form = composerForm() ?? document;
    const inputs = [...form.querySelectorAll<HTMLInputElement>(FILE_INPUT)].filter((input) => !input.disabled);
    const input = inputs.find((candidate) => (images ? candidate.accept.includes('image') : !candidate.accept)) ?? inputs[0];
    if (input) return input;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

/**
 * Attaches files through the composer's own file input and waits until every upload has finished
 * (no progress markers, send enabled). Resolves false on a missing input or a timeout.
 */
export async function attachFiles(files: File[], timeoutMs = 120_000): Promise<boolean> {
  // ChatGPT mounts the editor before its upload controls during initial hydration.
  const input = await waitForFileInput(files, Math.min(timeoutMs, 15_000));
  if (!input) return false;

  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Done when every file has a tile and nothing in the composer is still uploading. The send
  // button is no evidence here: with tiles present it is not reliably identifiable.
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 300));
  while (Date.now() < deadline) {
    const current = composerForm();
    const labels = [...(current?.querySelectorAll<HTMLElement>('button[aria-label]') ?? [])].map((b) => b.getAttribute('aria-label') ?? '');
    // ChatGPT renames repeat uploads ("notes(1).txt"), so match on the name without extension.
    const tiled = files.every((file) => labels.some((label) => label.includes(file.name.replace(/\.[^.]*$/, ''))));
    const busy = current?.querySelector(UPLOAD_BUSY) != null;
    if (tiled && !busy) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

