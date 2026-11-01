import { DomainError } from './errors.js';

export const FILE_EDITOR_MAX_BYTES = 1024 * 1024;
export type FileEditorAvailability = 'text' | 'binary' | 'too_large' | 'unavailable';
export interface EditorFileMetadata {
  name: string;
  mimetype?: string;
  size?: number;
  is_file?: boolean;
  is_symlink?: boolean;
}

const binaryExtensions = new Set([
  'jar',
  'war',
  'ear',
  'class',
  'zip',
  'gz',
  'gzip',
  'tgz',
  'tar',
  'bz2',
  'tbz',
  'tbz2',
  'xz',
  'txz',
  'lz',
  'lzma',
  'zst',
  'zstd',
  '7z',
  'rar',
  'br',
  'mrpack',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'icns',
  'tif',
  'tiff',
  'heic',
  'psd',
  'pdf',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'm4a',
  'm4v',
  'ogg',
  'oga',
  'ogv',
  'opus',
  'wav',
  'flac',
  'aac',
  'avi',
  'mov',
  'mkv',
  'webm',
  'mpeg',
  'mpg',
  'dat',
  'dat_old',
  'mca',
  'mcr',
  'mcc',
  'schematic',
  'schem',
  'litematic',
  'nbt',
  'db',
  'sqlite',
  'sqlite3',
  'db3',
  'db-wal',
  'db-shm',
  'sqlite-wal',
  'sqlite-shm',
  'sqlite3-wal',
  'sqlite3-shm',
  'ldb',
  'sst',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'wasm',
  'pyc',
  'pyo',
  'o',
  'a',
  'iso',
  'img',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
]);
const binaryMimeTypes = new Set([
  'application/java-archive',
  'application/x-java-archive',
  'application/java-vm',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-bzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/zstd',
  'application/pdf',
  'application/wasm',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-sqlite3',
  'application/vnd.sqlite3',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

/** Metadata is an early exclusion, not proof that unknown file contents are text. */
export function fileEditorAvailability(file: EditorFileMetadata): FileEditorAvailability {
  if (file.is_file === false || file.is_symlink || !file.name) return 'unavailable';
  const name = file.name.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
  const mime = file.mimetype?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    binaryExtensions.has(extension) ||
    binaryMimeTypes.has(mime) ||
    /^(?:audio|video|font)\//.test(mime) ||
    (mime.startsWith('image/') && mime !== 'image/svg+xml') ||
    mime.startsWith('application/vnd.openxmlformats-officedocument.') ||
    mime.startsWith('application/vnd.oasis.opendocument.')
  )
    return 'binary';
  if (file.size !== undefined && (!Number.isFinite(file.size) || file.size < 0))
    return 'unavailable';
  return file.size !== undefined && file.size > FILE_EDITOR_MAX_BYTES ? 'too_large' : 'text';
}

/** Bounded strict UTF-8. No format-specific binary editor or lossy transcoding is supported. */
export function decodeEditableText(bytes: Uint8Array): string {
  if (bytes.byteLength > FILE_EDITOR_MAX_BYTES) throw new DomainError('validation_failed', 413);
  let text: string;
  try {
    // Keep the BOM in the editable string so saving cannot silently remove it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DomainError('file_not_editable');
  }
  // Preserve ordinary Unicode and horizontal/vertical text whitespace (TAB/LF/VT/FF/CR/NEL).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly detect binary control characters.
  if (/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u.test(text))
    throw new DomainError('file_not_editable');
  // Some binary formats have ASCII-compatible headers; UTF-8 validity alone is insufficient.
  if (
    text.startsWith('%PDF-') ||
    text.startsWith('SQLite format 3') ||
    (text.startsWith('RIFF') && /^(?:WAVE|WEBP|AVI )$/.test(text.slice(8, 12))) ||
    (text.startsWith('OggS') && bytes.length >= 27) ||
    (bytes.length >= 512 && text.slice(257, 262) === 'ustar')
  )
    throw new DomainError('file_not_editable');
  return text;
}
