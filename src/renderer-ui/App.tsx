import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TextItem = {
  type: 'text';
  text: string;
  timestamp: number;
};

type ImageItem = {
  type: 'image';
  id: string;
  width?: number;
  height?: number;
  thumbDataUrl?: string | null;
  thumbPath?: string | null;
  timestamp: number;
};

type ClipboardItem = TextItem | ImageItem;

type Settings = {
  maxHistory: number;
  thumbWidth: number;
  rememberPosition: boolean;
  autoStart: boolean;
  hotkey: string | null;
};

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: any[]) => void) => void;
  removeListener: (channel: string, listener: (...args: any[]) => void) => void;
};

const ipcRenderer: IpcRendererLike | null = (() => {
  const w = window as any;
  if (typeof w?.require !== 'function') return null;
  try {
    const electron = w.require('electron');
    return electron?.ipcRenderer ?? null;
  } catch {
    return null;
  }
})();

function timeAgo(timestamp: number) {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 45_000) return 'Just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function itemPreview(item: ClipboardItem) {
  if (item.type === 'text') return item.text;
  return 'Image';
}

function itemMeta(item: ClipboardItem) {
  if (item.type === 'image') {
    const dims = item.width && item.height ? `${item.width}×${item.height}` : 'Image';
    return `${dims} • ${timeAgo(item.timestamp)}`;
  }
  return timeAgo(item.timestamp);
}

function useHotkey() {
  const [hotkey, setHotkey] = useState('');

  useEffect(() => {
    let alive = true;
    if (!ipcRenderer) return;
    ipcRenderer.invoke('get-hotkey').then((value) => {
      if (!alive) return;
      if (typeof value === 'string' && value.trim()) setHotkey(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return hotkey;
}

function ImageThumb({ item }: { item: ImageItem }) {
  const [src, setSrc] = useState<string | null>(item.thumbDataUrl ?? null);

  useEffect(() => {
    let cancelled = false;
    if (item.thumbDataUrl) {
      setSrc(item.thumbDataUrl);
      return;
    }
    if (!ipcRenderer || !item.thumbPath) return;
    ipcRenderer.invoke('load-thumbnail', item.thumbPath).then((dataUrl) => {
      if (cancelled) return;
      if (typeof dataUrl === 'string') setSrc(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.thumbDataUrl, item.thumbPath]);

  if (!src) {
    return <div className="thumb-placeholder" aria-hidden="true" />;
  }

  return <img className="thumb" src={src} alt="Clipboard item" />;
}

export default function App() {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isCapturingHotkey, setIsCapturingHotkey] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const hotkey = useHotkey();

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleUpdate = (_event: unknown, nextItems: ClipboardItem[]) => {
      setItems(Array.isArray(nextItems) ? nextItems : []);
    };

    const handleReset = () => {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };

    ipcRenderer.on('clipboard-updated', handleUpdate);
    ipcRenderer.on('reset-ui', handleReset);

    return () => {
      ipcRenderer.removeListener('clipboard-updated', handleUpdate);
      ipcRenderer.removeListener('reset-ui', handleReset);
    };
  }, []);

  useEffect(() => {
    if (!ipcRenderer) return;
    ipcRenderer.invoke('get-settings').then((value) => {
      if (!value || typeof value !== 'object') return;
      const v = value as Settings;
      setSettings({
        maxHistory: Number(v.maxHistory) || 20,
        thumbWidth: Number(v.thumbWidth) || 320,
        rememberPosition: !!v.rememberPosition,
        autoStart: v.autoStart !== false,
        hotkey: typeof v.hotkey === 'string' ? v.hotkey : null
      });
    });
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, []);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      if (item.type === 'text') {
        return item.text.toLowerCase().includes(q);
      }
      const dims = item.width && item.height ? `${item.width}x${item.height}` : '';
      return dims.includes(q);
    });
  }, [items, query]);

  const pasteItem = useCallback((item: ClipboardItem) => {
    if (!ipcRenderer) return;
    if (item.type === 'text') {
      ipcRenderer.invoke('paste-item', { type: 'text', text: item.text });
    } else {
      ipcRenderer.invoke('paste-item', { type: 'image', id: item.id });
    }
  }, []);

  const copyItem = useCallback((item: ClipboardItem) => {
    if (!ipcRenderer) return;
    if (item.type === 'text') {
      ipcRenderer.invoke('copy-item', { type: 'text', text: item.text });
    } else {
      ipcRenderer.invoke('copy-item', { type: 'image', id: item.id });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        ipcRenderer?.invoke('hide-overlay');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredItems.length === 0) return;
        setActiveIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredItems.length === 0) return;
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = filteredItems[activeIndex];
        if (item) pasteItem(item);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filteredItems, activeIndex, pasteItem]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

  const clearHistory = async () => {
    await ipcRenderer?.invoke('clear-history');
  };

  const openSettings = () => {
    setIsSettingsOpen(true);
    setIsCapturingHotkey(false);
  };

  const closeSettings = () => {
    setIsSettingsOpen(false);
    setIsCapturingHotkey(false);
  };

  const saveSettings = async () => {
    if (!settings) return;
    await ipcRenderer?.invoke('save-settings', settings);
    const updatedHotkey = await ipcRenderer?.invoke('get-hotkey');
    if (typeof updatedHotkey === 'string') {
      setSettings((prev) => (prev ? { ...prev, hotkey: updatedHotkey } : prev));
    }
    closeSettings();
  };

  const handleHotkeyKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isCapturingHotkey) return;
    event.preventDefault();

    const keys: string[] = [];
    if (event.metaKey || event.ctrlKey) keys.push(event.metaKey ? 'Cmd' : 'Ctrl');
    if (event.altKey) keys.push('Alt');
    if (event.shiftKey) keys.push('Shift');

    const validKeys: Record<string, string> = {
      Enter: 'Return',
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right'
    };

    if (event.key && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
      let keyName = event.key;
      if (validKeys[event.key]) {
        keyName = validKeys[event.key];
      } else if (event.key.length === 1) {
        keyName = event.key.toUpperCase();
      } else {
        return;
      }

      keys.push(keyName);
      const hotkeyValue = keys.join('+');
      setSettings((prev) => (prev ? { ...prev, hotkey: hotkeyValue } : prev));
      setIsCapturingHotkey(false);
    }
  };

  const resetHotkey = async () => {
    const platform = await ipcRenderer?.invoke('get-platform');
    const fallback = platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V';
    setSettings((prev) => (prev ? { ...prev, hotkey: fallback } : prev));
    setIsCapturingHotkey(false);
  };

  return (
    <div className="app">
      <header className="titlebar drag">
        <div className="title-group">
          <div className="orb" aria-hidden="true" />
          {hotkey ? <div className="pill no-drag">{hotkey}</div> : null}
        </div>
        <div className="actions no-drag">
          <button className="ghost" onClick={openSettings}>
            Settings
          </button>
          <button className="ghost" onClick={clearHistory}>
            Clear
          </button>
        </div>
      </header>

      <div className="search-row no-drag">
        <div className="search-field">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clipboard"
          />
        </div>
        <div className="count">{filteredItems.length}</div>
      </div>

      <main className="list">
        {filteredItems.length === 0 ? (
          <div className="empty">
            <div className="empty-title">Nothing here yet</div>
            <div className="empty-body">Copy something and it will appear instantly.</div>
          </div>
        ) : (
          filteredItems.map((item, index) => (
            <div
              key={item.type === 'text' ? `${item.timestamp}-${index}` : item.id}
              className={`item ${index === activeIndex ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => pasteItem(item)}
            >
              {item.type === 'image' ? (
                <ImageThumb item={item} />
              ) : (
                <div className="text-icon" aria-hidden="true">
                  “
                </div>
              )}
                <div className="content">
                  <div className="preview">{itemPreview(item)}</div>
                  <div className="meta">{itemMeta(item)}</div>
                </div>
              <button
                className="copy"
                onClick={(event) => {
                  event.stopPropagation();
                  copyItem(item);
                }}
                aria-label="Copy to clipboard"
              >
                Copy
              </button>
            </div>
          ))
        )}
      </main>

      <footer className="footer">
        <span>Enter to paste</span>
        <span>Esc to close</span>
      </footer>

      {isSettingsOpen && settings ? (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-title">Settings</div>
            <label className="field">
              <span>Max history</span>
              <input
                type="number"
                min={5}
                max={200}
                value={settings.maxHistory}
                onChange={(event) =>
                  setSettings((prev) =>
                    prev ? { ...prev, maxHistory: Number(event.target.value) } : prev
                  )
                }
              />
            </label>
            <label className="field">
              <span>Thumbnail width</span>
              <input
                type="number"
                min={60}
                max={600}
                value={settings.thumbWidth}
                onChange={(event) =>
                  setSettings((prev) =>
                    prev ? { ...prev, thumbWidth: Number(event.target.value) } : prev
                  )
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.rememberPosition}
                onChange={(event) =>
                  setSettings((prev) =>
                    prev ? { ...prev, rememberPosition: event.target.checked } : prev
                  )
                }
              />
              Remember window position
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(event) =>
                  setSettings((prev) =>
                    prev ? { ...prev, autoStart: event.target.checked } : prev
                  )
                }
              />
              Start at login
            </label>
            <label className="field">
              <span>Hotkey</span>
              <div className="hotkey-row">
                <input
                  value={settings.hotkey ?? ''}
                  placeholder="Click to set"
                  readOnly
                  onClick={() => setIsCapturingHotkey(true)}
                  onKeyDown={handleHotkeyKeyDown}
                  className={isCapturingHotkey ? 'hotkey-capture' : undefined}
                />
                <button className="ghost" onClick={resetHotkey}>
                  Reset
                </button>
              </div>
            </label>
            <div className="modal-actions">
              <button className="ghost" onClick={closeSettings}>
                Cancel
              </button>
              <button className="ghost primary" onClick={saveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
