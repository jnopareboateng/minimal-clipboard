const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const robot = require('robotjs'); // added for simulating paste keystroke
const activeWin = require('active-win'); // diagnostics & focus tracking
const { spawn } = require('child_process');

// Disable GPU acceleration to prevent GPU errors
app.disableHardwareAcceleration();

// Add command line switches for better compatibility
app.commandLine.appendSwitch('--disable-gpu');
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--disable-software-rasterizer');

// Initialize persistent storage
const store = new Store();

// Settings and defaults
const DEFAULT_SETTINGS = {
  maxHistory: 20,
  thumbWidth: 320,
  singleClickAction: 'copy', // 'copy' | 'paste' | 'none'
  rememberPosition: true,
  hotkey: null // null means use platform default
};
let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));

// Reset invalid hotkey to empty string (will use default)
if (settings.hotkey && !/^[\x00-\x7F]*$/.test(settings.hotkey)) {
  console.warn('Invalid hotkey detected, resetting to default:', settings.hotkey);
  settings.hotkey = null;
  store.set('settings', settings);
}

let mainWindow = null;
let backdropWindow = null;
let clipboardHistory = [];
let imageStoreDir = null;
function getMaxHistory() {
  const v = Number(settings.maxHistory);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_SETTINGS.maxHistory;
}
let lastActiveWindow = null; // store window info before overlay shows
let pasteSessionCompleted = false; // guard to prevent repeated pastes

// Track pending paste retry timers so we can cancel if needed
let pendingPasteTimers = [];

function clearPendingPasteTimers() {
  pendingPasteTimers.forEach(t => clearTimeout(t));
  pendingPasteTimers = [];
}

function simulatePasteKeystroke(attempt, totalAttempts) {
  try {
    const platform = process.platform;
    const modifier = platform === 'darwin' ? 'command' : 'control';
    robot.keyTap('v', modifier);
    console.log(`[paste] Sent keystroke attempt ${attempt + 1}/${totalAttempts}`);
  } catch (e) {
    console.error('[paste] Failed to simulate keystroke attempt', attempt + 1, e?.message || e);
  }
}

// Attempt multiple delayed keystrokes to improve chance target app has refocused
function schedulePasteRetries() {
  // Tuned delays (ms); first is short, others give time for window focus to return
  const delays = process.platform === 'win32'
    ? [140, 260, 420, 650] // Windows often slower to refocus
    : process.platform === 'darwin'
      ? [60, 140, 260]     // macOS usually refocuses fast
      : [120, 240, 400];   // Linux middle ground

  console.log('[paste] Scheduling keystroke attempts at delays:', delays.join(', '));
  delays.forEach((d, idx) => {
    const timer = setTimeout(() => simulatePasteKeystroke(idx, delays.length), d);
    pendingPasteTimers.push(timer);
  });

  // After final attempt on Windows, trigger fallback via PowerShell SendKeys if still not pasted
  if (process.platform === 'win32') {
    const lastDelay = delays[delays.length - 1] + 180;
    const fallbackTimer = setTimeout(() => {
      console.log('[paste] Executing Windows PowerShell fallback SendKeys ^v');
      try {
        const ps = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { windowsHide: true });
        ps.on('error', err => console.error('[paste] PowerShell fallback error', err));
      } catch (e) {
        console.error('[paste] Failed to spawn PowerShell fallback', e);
      }
    }, lastDelay);
    pendingPasteTimers.push(fallbackTimer);
  }

  // After final attempt on macOS, trigger AppleScript fallback if needed
  if (process.platform === 'darwin') {
    const lastDelay = delays[delays.length - 1] + 180;
    const fallbackTimer = setTimeout(() => {
      console.log('[paste] Executing macOS AppleScript fallback keystroke ⌘V');
      try {
        const osa = spawn('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}']);
        osa.on('error', err => console.error('[paste] AppleScript fallback error', err));
      } catch (e) {
        console.error('[paste] Failed to spawn AppleScript fallback', e);
      }
    }, lastDelay);
    pendingPasteTimers.push(fallbackTimer);
  }

  // Diagnostic: log active window after some key timepoints
  [120, 300, 600, 900].forEach(t => {
    const diagTimer = setTimeout(() => {
      activeWin().then(info => {
        console.log(`[focus] t+${t}ms active window:`, info ? `${info.owner.name} | ${info.title}` : 'unknown');
      }).catch(()=>{});
    }, t);
    pendingPasteTimers.push(diagTimer);
  });
}

// Platform-specific default hotkey
const getDefaultHotkey = () => {
  const platform = process.platform;
  if (platform === 'darwin') return 'Cmd+Shift+V'; // macOS
  if (platform === 'win32') return 'Ctrl+Shift+V';      // Windows (Win+V)
  return 'Ctrl+Shift+V';                           // Linux
};

function getEffectiveHotkey() {
  return settings.hotkey || getDefaultHotkey();
}

// Helpers to manage overlay visibility
function hideOverlayWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.hide(); } catch (_) {}
  }
  if (backdropWindow && !backdropWindow.isDestroyed()) {
    try { backdropWindow.hide(); } catch (_) {}
  }
}

function showOverlayWindows() {
  if (backdropWindow && !backdropWindow.isDestroyed()) {
    backdropWindow.show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Show and focus the window properly
    mainWindow.show();
    try { mainWindow.moveTop(); } catch (_) {}
    try { mainWindow.focus(); } catch (_) {}
    
    // Send reset-ui event after a short delay to ensure window is focused
    setTimeout(() => {
      try { mainWindow.webContents.send('reset-ui'); } catch (_) {}
    }, 50);
  }
}

// Create the clipboard overlay window(s)
const createWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Create transparent backdrop that captures outside clicks
  backdropWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    focusable: true,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: false
    }
  });

  try { backdropWindow.setAlwaysOnTop(true, 'floating'); } catch (_) {}
  backdropWindow.loadFile(path.join(__dirname, 'backdrop.html'));

  // Create the visible overlay window
  // Try to restore position
  let startX = width - 420;
  let startY = 100;
  if (settings.rememberPosition) {
    const savedBounds = store.get('windowBounds');
    if (savedBounds && typeof savedBounds.x === 'number' && typeof savedBounds.y === 'number') {
      startX = savedBounds.x;
      startY = savedBounds.y;
    }
  }

  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    x: startX,  // Position near right edge (or restored)
    y: startY,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    // Allow the window to be focusable so that clicking outside triggers a blur event.
    // We'll show it without focusing (showInactive) to keep the previous app active on open.
  focusable: true,
    movable: true,
  acceptFirstMouse: true,
  icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: false
    }
  });
  try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}

  // Prevent windows from showing in taskbar on Windows
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(true);
    backdropWindow.setSkipTaskbar(true);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  // Open DevTools for debugging
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Hide overlay when it loses focus
  // Delay hiding on blur to allow click events (e.g., paste) to be processed
  mainWindow.on('blur', () => {
    setTimeout(() => {
      // Only hide if the window is still not focused
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        hideOverlayWindows();
      }
    }, 150);
  });

  // Persist position if enabled
  const persistBounds = () => {
    if (settings.rememberPosition && mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      store.set('windowBounds', { x: b.x, y: b.y });
    }
  };
  mainWindow.on('move', persistBounds);
};

// Monitor clipboard changes
let lastClipboardSignature = '';
const monitorClipboard = () => {
  setInterval(() => {
    try {
      // Prefer image if available; otherwise fall back to non-empty text
      const img = clipboard.readImage();
      const hasImage = img && !img.isEmpty();

      if (hasImage) {
        const size = img.getSize();
        const signature = `image:${size.width}x${size.height}`; // avoid heavy encoding in the polling loop
        if (signature !== lastClipboardSignature) {
          lastClipboardSignature = signature;
          // Persist full-resolution image once per new image
          ensureImageStoreDir();
          const pngBuffer = img.toPNG();
          const { id, filePath } = saveImagePng(pngBuffer);
          // Build a lightweight thumbnail for UI
          const maxThumbWidth = getThumbWidth();
          const thumb = img.resize({ width: Math.min(maxThumbWidth, size.width) });
          const thumbDataUrl = thumb.toDataURL();
          addToHistory({
            type: 'image',
            id,
            filePath,
            width: size.width,
            height: size.height,
            thumbDataUrl,
            signature
          });
        }
        return; // do not process text if image present
      }

      const currentText = clipboard.readText();
      const signature = `text:${currentText}`;
      if (currentText && currentText.trim() !== '' && signature !== lastClipboardSignature) {
        lastClipboardSignature = signature;
        addToHistory({ type: 'text', text: currentText });
      }
    } catch (e) {
      console.warn('[clipboard] Monitor error:', e?.message || e);
    }
  }, 500); // Check every 500ms
};

// Add item to clipboard history (supports text and image)
const addToHistory = (item) => {
  if (!item) return;
  if (item.type === 'text') {
    console.log('Adding to history (text):', item.text.substring(0, 50) + '...');
    // Remove duplicate texts
    clipboardHistory = clipboardHistory.filter(h => !(h.type === 'text' && h.text === item.text));
    clipboardHistory.unshift({ type: 'text', text: item.text, timestamp: Date.now() });
  } else if (item.type === 'image') {
    const sizeLabel = `${item.width}x${item.height}`;
    console.log('Adding to history (image):', sizeLabel);
    // Remove duplicate images by signature if available, else by dimensions
    clipboardHistory = clipboardHistory.filter(h => {
      if (h.type !== 'image') return true;
      if (item.signature && h.signature) return h.signature !== item.signature;
      return !(h.width === item.width && h.height === item.height);
    });
    clipboardHistory.unshift({
      type: 'image',
      id: item.id,
      filePath: item.filePath,
      width: item.width,
      height: item.height,
      thumbDataUrl: item.thumbDataUrl,
      signature: item.signature,
      timestamp: Date.now()
    });
  } else {
    return;
  }

  // Limit history size
  if (clipboardHistory.length > getMaxHistory()) {
    const toRemove = clipboardHistory.slice(getMaxHistory());
    // Clean up image files for removed entries
    toRemove.forEach(i => { if (i.type === 'image' && i.filePath) deleteFileQuiet(i.filePath); });
    clipboardHistory = clipboardHistory.slice(0, getMaxHistory());
  }

  // Save to persistent storage
  store.set('clipboardHistory', clipboardHistory);

  // Send to renderer if window exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendHistoryToRenderer();
  }
};

// Load saved clipboard history
const loadHistory = () => {
  const saved = store.get('clipboardHistory', []);
  clipboardHistory = Array.isArray(saved) ? saved : [];
};

function ensureImageStoreDir() {
  if (!imageStoreDir) {
    imageStoreDir = path.join(app.getPath('userData'), 'images');
  }
  try { fs.mkdirSync(imageStoreDir, { recursive: true }); } catch (_) {}
}

function saveImagePng(pngBuffer) {
  ensureImageStoreDir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = path.join(imageStoreDir, `${id}.png`);
  try {
    fs.writeFileSync(filePath, pngBuffer);
  } catch (e) {
    console.error('[image] Failed to write image file', e?.message || e);
  }
  return { id, filePath };
}

function deleteFileQuiet(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function sendHistoryToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const lightweight = clipboardHistory.map(i => {
    if (i.type === 'image') {
      return { type: 'image', id: i.id, width: i.width, height: i.height, thumbDataUrl: i.thumbDataUrl, timestamp: i.timestamp };
    }
    return { type: 'text', text: i.text, timestamp: i.timestamp };
  });
  mainWindow.webContents.send('clipboard-updated', lightweight);
}

// App event handlers
app.whenReady().then(() => {
  createWindow();
  loadHistory();
  monitorClipboard();
  
  // Register global shortcut
  const hotkey = getEffectiveHotkey();
  try {
    const registered = globalShortcut.register(hotkey, () => {
      if (!mainWindow) return;
      console.log('Hotkey pressed!'); // Debug output
      if (mainWindow.isVisible()) {
        console.log('Hiding window');
        hideOverlayWindows();
      } else {
        activeWin().then(info => {
          lastActiveWindow = info;
          console.log('[focus] Captured last active window:', info ? `${info.owner.name} | ${info.title}` : 'unknown');
        }).catch(e => {
          const summary = (e && (e.stdout || e.message)) ? (e.stdout || e.message) : String(e);
          const trimmed = typeof summary === 'string' && summary.trim ? summary.trim() : summary;
          console.warn('[focus] Failed to get active window:', trimmed);
        });
        console.log('Showing window');
        sendHistoryToRenderer();
        showOverlayWindows();
      }
    });
    
    if (!registered) {
      console.warn(`Failed to register global shortcut: ${hotkey}`);
    } else {
      console.log(`Successfully registered hotkey: ${hotkey}`);
    }
  } catch (error) {
    console.error(`Error registering hotkey ${hotkey}:`, error);
  }
  
  console.log(`Minimal Clipboard started. Press ${hotkey} to open.`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
});

// IPC handlers
ipcMain.handle('paste-item', (event, payload) => {
  const isString = typeof payload === 'string';
  const isTextObj = payload && payload.type === 'text' && typeof payload.text === 'string';
  const isImageObj = payload && payload.type === 'image' && typeof payload.dataUrl === 'string';
  const isImageIdObj = payload && payload.type === 'image' && typeof payload.id === 'string';

  if (!isString && !isTextObj && !isImageObj && !isImageIdObj) return false;

  if (isString || isTextObj) {
    const text = isString ? payload : payload.text;
    console.log('Paste request received (text) with length:', text?.length);
    clipboard.writeText(text || '');
  } else if (isImageObj) {
    console.log('Paste request received (image by dataUrl)');
    try {
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      clipboard.writeImage(image);
    } catch (e) {
      console.error('[paste] Failed to write image to clipboard', e?.message || e);
      return false;
    }
  } else if (isImageIdObj) {
    console.log('Paste request received (image by id)');
    const imgItem = clipboardHistory.find(i => i.type === 'image' && i.id === payload.id);
    if (!imgItem || !imgItem.filePath) return false;
    try {
      const buffer = fs.readFileSync(imgItem.filePath);
      const image = nativeImage.createFromBuffer(buffer);
      clipboard.writeImage(image);
    } catch (e) {
      console.error('[paste] Failed to read/write image by id', e?.message || e);
      return false;
    }
  }
  pasteSessionCompleted = false; // reset guard for new session

  // Hide our overlay FIRST so the previously focused app regains focus.
  //    (Original order sent the key stroke while our window still had focus.)
  // Hide overlay (both windows) so that previous app regains focus
  hideOverlayWindows();

  // Cancel any previous pending attempts (user may have re-opened quickly)
  clearPendingPasteTimers();

  // Schedule multiple attempts
  schedulePasteRetries();

  return true;
});

// Copy item to clipboard without pasting
ipcMain.handle('copy-item', (event, payload) => {
  const isString = typeof payload === 'string';
  const isTextObj = payload && payload.type === 'text' && typeof payload.text === 'string';
  const isImageObj = payload && payload.type === 'image' && typeof payload.dataUrl === 'string';
  const isImageIdObj = payload && payload.type === 'image' && typeof payload.id === 'string';

  if (!isString && !isTextObj && !isImageObj && !isImageIdObj) return false;

  try {
    if (isString || isTextObj) {
      const text = isString ? payload : payload.text;
      clipboard.writeText(text || '');
      return true;
    }
    if (isImageObj) {
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      clipboard.writeImage(image);
      return true;
    }
    if (isImageIdObj) {
      const imgItem = clipboardHistory.find(i => i.type === 'image' && i.id === payload.id);
      if (!imgItem || !imgItem.filePath) return false;
      const buffer = fs.readFileSync(imgItem.filePath);
      const image = nativeImage.createFromBuffer(buffer);
      clipboard.writeImage(image);
      return true;
    }
  } catch (e) {
    console.error('[copy] Failed to write to clipboard', e?.message || e);
    return false;
  }
});

ipcMain.handle('clear-history', () => {
  clipboardHistory = [];
  store.delete('clipboardHistory');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard-updated', clipboardHistory);
  }
});

ipcMain.handle('get-platform', () => {
    return process.platform;
  });

  ipcMain.handle('get-data-location', () => {
    return app.getPath('userData');
  });

// Hide overlay on outside click from backdrop
ipcMain.handle('hide-overlay', () => {
  hideOverlayWindows();
});

// Show/hide backdrop for settings modal
ipcMain.handle('set-backdrop-visible', (event, visible) => {
  if (backdropWindow && !backdropWindow.isDestroyed()) {
    if (visible) {
      backdropWindow.show();
    } else {
      backdropWindow.hide();
    }
  }
});

// Settings IPC
ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle('update-settings', (event, partial) => {
  if (!partial || typeof partial !== 'object') return settings;
  const prevHotkey = getEffectiveHotkey();
  settings = Object.assign({}, settings, partial);
  store.set('settings', settings);

  // Re-register hotkey if changed
  const newHotkey = getEffectiveHotkey();
  if (newHotkey !== prevHotkey) {
    try {
      globalShortcut.unregister(prevHotkey);
    } catch (_) {}
    
    try {
      const ok = globalShortcut.register(newHotkey, () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          hideOverlayWindows();
        } else {
          console.log('Hotkey pressed!');
          activeWin().then(info => { lastActiveWindow = info; }).catch(()=>{});
          sendHistoryToRenderer();
          showOverlayWindows();
        }
      });
      
      if (!ok) {
        console.warn('[settings] Failed to register new hotkey:', newHotkey);
        // Revert to old hotkey
        try {
          globalShortcut.register(prevHotkey, () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) {
              hideOverlayWindows();
            } else {
              console.log('Hotkey pressed!');
              activeWin().then(info => { lastActiveWindow = info; }).catch(()=>{});
              sendHistoryToRenderer();
              showOverlayWindows();
            }
          });
        } catch (revertError) {
          console.error('[settings] Failed to revert to old hotkey:', revertError);
        }
      }
    } catch (error) {
      console.error('[settings] Error registering hotkey:', newHotkey, error);
      // Revert to old hotkey
      try {
        globalShortcut.register(prevHotkey, () => {
          if (!mainWindow) return;
          if (mainWindow.isVisible()) {
            hideOverlayWindows();
          } else {
            console.log('Hotkey pressed!');
            activeWin().then(info => { lastActiveWindow = info; }).catch(()=>{});
            sendHistoryToRenderer();
            showOverlayWindows();
          }
        });
      } catch (revertError) {
        console.error('[settings] Failed to revert to old hotkey:', revertError);
      }
    }
  }

  // Trim history if max reduced
  if (clipboardHistory.length > getMaxHistory()) {
    const toRemove = clipboardHistory.slice(getMaxHistory());
    toRemove.forEach(i => { if (i.type === 'image' && i.filePath) deleteFileQuiet(i.filePath); });
    clipboardHistory = clipboardHistory.slice(0, getMaxHistory());
  }

  return settings;
});

ipcMain.handle('get-hotkey', () => {
  return getEffectiveHotkey();
});

function getThumbWidth() {
  const v = Number(settings.thumbWidth);
  return Number.isFinite(v) && v >= 60 ? Math.floor(v) : DEFAULT_SETTINGS.thumbWidth;
}