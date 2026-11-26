export const MAX_FILES = 3;
export const MAX_FILE_NAME = 160;
export const MAX_FILE_TEXT = 20_000;
export const MAX_BINARY_BYTES = 1024 * 1024;
export const MAX_BINARY_DATA = 4 * Math.ceil(MAX_BINARY_BYTES / 3);
export const MAX_CONTEXT_BINARY_DATA = 2 * MAX_BINARY_DATA;
export const MAX_CONTEXT_TEXT = 80_000;
export const MAX_MESSAGE_TEXT = 30_000;

export function binaryType(bytes) {
  const has = (offset, ...signature) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (has(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (has(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (has(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

export function fileText(name, text) {
  return `Прикреплённый файл ${JSON.stringify(name)} (содержимое):\n${text}`;
}
