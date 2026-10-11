import { useState } from 'react';
import type { JSX } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Copy, ExternalLink, File as FileIcon, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FileEntry } from '@shared/types';
import { invoke } from '../lib/bridge';
import { basename, relativeTo } from '../lib/format';
import { useCopy } from '../lib/hooks';
import { CodeViewer } from './CodeViewer';
import { Empty, formatBytes, Notice, useAction, useLoaded } from './common';

export function FilesTab({ rootDir }: { rootDir: string | null }): JSX.Element {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  if (!rootDir) {
    return <Empty title="No folder for this chat">Approve a project folder in Settings to browse its files.</Empty>;
  }
  if (openFile) {
    return <FileViewer rootDir={rootDir} path={openFile} onBack={() => setOpenFile(null)} />;
  }
  return (
    <div className="wp-files">
      <div className="wp-toolbar">
        <span className="wp-path" title={rootDir}>
          {basename(rootDir)}
        </span>
        <span className="wp-spacer" />
        <button type="button" className="wp-btn is-ghost" aria-label="Refresh files" onClick={() => setGeneration((value) => value + 1)}>
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <div className="wp-tree" role="tree" aria-label="Project files">
        <DirList key={generation} dir={rootDir} depth={0} onOpen={setOpenFile} />
      </div>
    </div>
  );
}

/** Lazily loaded children of one folder; sub-folders load when they are expanded. */
function DirList({ dir, depth, onOpen }: { dir: string; depth: number; onOpen(path: string): void }): JSX.Element {
  const { value: entries, error } = useLoaded(dir, () => invoke('files:list', dir));

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!entries) return <div className="wp-tree-status" style={{ paddingLeft: 8 + depth * 14 }}>Loading…</div>;
  if (entries.length === 0) return <div className="wp-tree-status" style={{ paddingLeft: 8 + depth * 14 }}>Empty folder</div>;

  return (
    <ul className="wp-tree-list" role="group">
      {entries.map((entry) => (
        <TreeRow key={entry.path} entry={entry} depth={depth} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeRow({ entry, depth, onOpen }: { entry: FileEntry; depth: number; onOpen(path: string): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const isDir = entry.kind === 'dir';
  const Chevron = open ? ChevronDown : ChevronRight;
  const Glyph = isDir ? (open ? FolderOpen : Folder) : FileIcon;
  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined}>
      <button
        type="button"
        className="wp-tree-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={entry.path}
        onClick={() => (isDir ? setOpen(!open) : onOpen(entry.path))}
      >
        {isDir ? <Chevron size={13} aria-hidden /> : <span className="wp-tree-indent" />}
        <Glyph size={14} aria-hidden className={isDir ? 'wp-tree-glyph is-dir' : 'wp-tree-glyph'} />
        <span className="wp-tree-name">{entry.name}</span>
      </button>
      {isDir && open && <DirList dir={entry.path} depth={depth + 1} onOpen={onOpen} />}
    </li>
  );
}

function FileViewer({ rootDir, path, onBack }: { rootDir: string; path: string; onBack(): void }): JSX.Element {
  const { value: file, error: loadError } = useLoaded(path, () => invoke('files:read', path));
  const [actionError, runAction] = useAction();
  const [copied, copy] = useCopy();

  let body: JSX.Element;
  if (loadError) body = <Notice tone="error">{loadError}</Notice>;
  else if (!file) body = <div className="wp-tree-status">Loading…</div>;
  else if (file.binary) body = <Notice>Binary file ({formatBytes(file.size)}). It is not shown.</Notice>;
  else if (file.text === null) body = <Notice>This file is too large to show ({formatBytes(file.size)}).</Notice>;
  else
    body = (
      <>
        {file.truncated && <Notice>Showing the start of the file.</Notice>}
        <CodeViewer name={basename(path)} text={file.text} />
      </>
    );

  return (
    <div className="wp-viewer">
      <div className="wp-toolbar">
        <button type="button" className="wp-btn is-ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Files
        </button>
        <span className="wp-path" title={path}>
          {relativeTo(rootDir, path)}
        </span>
        <span className="wp-spacer" />
        <button type="button" className="wp-btn is-ghost" aria-label="Reveal in folder" onClick={() => void runAction(() => invoke('app:revealPath', path))}>
          <ExternalLink size={14} aria-hidden />
        </button>
        <button type="button" className="wp-btn is-ghost" onClick={() => copy(path)}>
          <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy path'}
        </button>
      </div>
      {actionError && <Notice tone="error">{actionError}</Notice>}
      <div className="wp-viewer-body">{body}</div>
    </div>
  );
}
