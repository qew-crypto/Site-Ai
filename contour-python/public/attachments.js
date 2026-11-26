import { icon, node } from './format.js';
import { binaryType, MAX_FILES, MAX_FILE_NAME, MAX_FILE_TEXT, MAX_BINARY_BYTES, MAX_CONTEXT_BINARY_DATA } from './attachment-policy.js';

const textExtension = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|log|xml|html?|css|m?js|tsx?|py|sql|sh|toml|ini|rs|go|java|kt|rb|php|cpp|c|h|cs)$/i;

async function readAttachment(file) {
  if (!file.size) throw new Error('Файл пуст.');
  if (file.size > MAX_BINARY_BYTES) throw new Error('Размер файла превышает 1 МБ.');
  const name = file.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, MAX_FILE_NAME) || 'Вложение';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = binaryType(bytes);
  if (mime) return { name, mime, data: bytes.toBase64?.() ?? btoa(Array.from({ length: Math.ceil(bytes.length / 8192) }, (_, i) => String.fromCharCode(...bytes.subarray(i * 8192, (i + 1) * 8192))).join('')) };
  if (!textExtension.test(name) && !file.type.startsWith('text/')) throw new Error('Формат не поддерживается. Выбери текстовый файл, PNG, JPEG, WebP или PDF.');
  let data;
  try { data = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Текстовый файл должен быть в кодировке UTF-8.'); }
  if (!data.trim() || data.includes('\0')) throw new Error('Файл не содержит читаемого текста.');
  if (data.length > MAX_FILE_TEXT) throw new Error('В текстовом файле больше 20 000 символов.');
  return { name, mime: 'text/plain', data };
}

export function attachmentsUI({ composer, input, button, tray, notice }) {
  let files = [], busy = false, revision = 0;

  function paint(focusIndex) {
    tray.replaceChildren();
    tray.hidden = !files.length && !busy;
    if (files.length) tray.append(node('p', 'attachment-hint', 'Вложения отправятся провайдеру вместе с сообщением.'));
    const list = node('ul', 'attachment-list');
    tray.append(list);
    for (const [index, file] of files.entries()) {
      const item = node('li', 'attachment-chip');
      const label = node('span', '', file.name);
      label.title = file.name;
      const remove = node('button', 'icon-btn attachment-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Убрать вложение: ${file.name}`);
      remove.append(icon('close'));
      remove.addEventListener('click', () => { files.splice(index, 1); paint(index); });
      item.append(icon('file'), label, remove);
      list.append(item);
    }
    if (busy) tray.append(node('p', 'attachment-hint', 'Читаю файлы…'));
    button.setAttribute('aria-busy', String(busy));
    if (focusIndex !== undefined) (list.children[Math.min(focusIndex, files.length - 1)]?.lastElementChild ?? button).focus();
  }

  async function add(incoming) {
    if (busy) { notice('Дождись, пока прочитаются файлы.', true); return; }
    const version = revision;
    let overflow = false, error = '';
    busy = true;
    paint();
    try {
      for (const file of incoming) {
        if (files.length >= MAX_FILES) { overflow = true; break; }
        try {
          const attachment = await readAttachment(file);
          if (version !== revision) return;
          const binarySize = files.reduce((sum, item) => sum + (item.mime === 'text/plain' ? 0 : item.data.length), 0);
          if (attachment.mime !== 'text/plain' && binarySize + attachment.data.length > MAX_CONTEXT_BINARY_DATA) {
            throw new Error('Общий размер изображений и PDF превысил 2 МБ.');
          }
          files.push(attachment);
        } catch (failure) { error = failure.message; }
        if (version !== revision) return;
      }
      if (error || overflow) notice(error || 'К сообщению можно прикрепить не больше трёх файлов.', true);
    } finally {
      if (version === revision) { busy = false; paint(); }
    }
  }

  button.addEventListener('click', () => { if (!busy) input.click(); });
  input.addEventListener('change', () => {
    const selected = Array.from(input.files);
    input.value = '';
    if (selected.length) add(selected);
  });
  composer.addEventListener('paste', event => {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length) { event.preventDefault(); add(pasted); }
  });
  const isFileDrag = event => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  composer.addEventListener('dragover', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    composer.classList.add('file-drag');
  });
  composer.addEventListener('dragleave', event => {
    if (!composer.contains(event.relatedTarget)) composer.classList.remove('file-drag');
  });
  composer.addEventListener('drop', event => {
    composer.classList.remove('file-drag');
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length) add(dropped);
  });
  return {
    get files() { return files.slice(); },
    get busy() { return busy; },
    set(next) { revision++; busy = false; files = next.slice(); paint(); },
  };
}
