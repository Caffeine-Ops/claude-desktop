import { localCodeRelativePath, normalizeLocalCodePath } from './creation-context';

interface DropZoneProps {
  label: string;
  prompt: string;
  helper?: string;
  accept?: string;
  names: string[];
  directory?: boolean;
  onBrowseFolder?: () => void;
  onRemoveName?: (name: string) => void;
  onFiles: (names: string[], files: File[]) => void;
}
interface WebkitFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface WebkitFileSystemFileEntry extends WebkitFileSystemEntry {
  isFile: true;
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
}
interface WebkitFileSystemDirectoryEntry extends WebkitFileSystemEntry {
  isDirectory: true;
  createReader: () => {
    readEntries: (
      success: (entries: WebkitFileSystemEntry[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
}

export function DropZone({
  label,
  prompt,
  helper,
  accept,
  names,
  directory,
  onBrowseFolder,
  onRemoveName,
  onFiles,
}: DropZoneProps) {
  function readFiles(files: FileList | File[] | null) {
    const nextFiles = Array.from(files ?? []);
    const nextNames = nextFiles.map((file) => localCodeRelativePath(file));
    if (nextNames.length > 0) onFiles(nextNames, nextFiles);
  }
  async function readDrop(dataTransfer: DataTransfer) {
    const nextFiles = await filesFromDataTransfer(dataTransfer);
    readFiles(nextFiles);
  }
  const directoryProps = directory ? ({ webkitdirectory: '', directory: '' } as Record<string, string>) : {};

  return (
    <div className="ds-resource-row">
      <strong>{label}</strong>
      <div className="ds-drop-zone-wrap">
        <label
          className="ds-drop-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void readDrop(event.dataTransfer);
          }}
        >
          <input
            className="ds-hidden-input"
            type="file"
            multiple
            accept={accept}
            onChange={(event) => readFiles(event.target.files)}
            {...directoryProps}
          />
          <span>{names.length > 0 && !onRemoveName ? names.join(', ') : prompt}</span>
        </label>
        {onBrowseFolder ? (
          <button type="button" className="ghost" onClick={onBrowseFolder}>
            Browse folder
          </button>
        ) : null}
      </div>
      {names.length > 0 && onRemoveName ? (
        <div className="ds-local-code-list" aria-label={`${label} selections`}>
          {names.map((name) => (
            <span key={name}>
              {name}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemoveName(name)}>
                x
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {helper ? <p>{helper}</p> : null}
    </div>
  );
}

async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => {
      const getter = (item as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
      return getter?.call(item) ?? null;
    })
    .filter(isWebkitFileSystemEntry);
  if (entries.length === 0) return Array.from(dataTransfer.files ?? []);
  const droppedFiles = await Promise.all(entries.map((entry) => filesFromEntry(entry, entry.name)));
  const flattened = droppedFiles.flat();
  return flattened.length > 0 ? flattened : Array.from(dataTransfer.files ?? []);
}

function isWebkitFileSystemEntry(entry: unknown): entry is WebkitFileSystemEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<WebkitFileSystemEntry>;
  return (
    typeof candidate.name === 'string'
    && typeof candidate.isFile === 'boolean'
    && typeof candidate.isDirectory === 'boolean'
  );
}

async function filesFromEntry(entry: WebkitFileSystemEntry, relativePath: string): Promise<File[]> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as WebkitFileSystemFileEntry);
    return [withRelativePath(file, relativePath)];
  }
  if (!entry.isDirectory) return [];
  const children = await readAllDirectoryEntries(entry as WebkitFileSystemDirectoryEntry);
  const nested = await Promise.all(
    children.map((child) => filesFromEntry(child, `${relativePath}/${child.name}`)),
  );
  return nested.flat();
}

function fileFromEntry(entry: WebkitFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readAllDirectoryEntries(entry: WebkitFileSystemDirectoryEntry): Promise<WebkitFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: WebkitFileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    function readNextBatch() {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readNextBatch();
      }, reject);
    }
    readNextBatch();
  });
}

function withRelativePath(file: File, relativePath: string): File {
  const currentPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (currentPath) return file;
  Object.defineProperty(file, 'webkitRelativePath', {
    value: normalizeLocalCodePath(relativePath),
    configurable: true,
  });
  return file;
}
