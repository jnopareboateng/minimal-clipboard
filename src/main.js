const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Initialize persistent storage
const store = new Store();

let mainWindow = null;
let clipboardHistory = [];
const MAX_HISTORY = 20; // Keep last 20 items

// Platform-specific hotkey
const getHotkey = () => {
  const platform = process.platform;
  if (platform === 'darwin') return 'Cmd+Shift+V'; // macOS
  if (platform === 'win32') return 'Ctrl+Shift+V';      // Windows (Win+V)
  return 'Ctrl+Shift+V';                           // Linux
};

// Create the clipboard overlay window
const createWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    x: width - 420,  // Position near right edge
    y: 100,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));

  // Hide window when it loses focus
  mainWindow.on('blur', () => {
    mainWindow.hide();
  });
};

// Monitor clipboard changes
let lastClipboardText = clipboard.readText();
const monitorClipboard = () => {
  setInterval(() => {
    const currentText = clipboard.readText();
    if (currentText !== lastClipboardText && currentText.trim() !== '') {
      lastClipboardText = currentText;
      addToHistory(currentText);
    }
  }, 500); // Check every 500ms
};

// Add item to clipboard history
const addToHistory = (text) => {
  // Remove duplicates
  clipboardHistory = clipboardHistory.filter(item => item.text !== text);
  
  // Add to beginning
  clipboardHistory.unshift({
    text: text,
    timestamp: Date.now()
  });
  
  // Limit history size
  if (clipboardHistory.length > MAX_HISTORY) {
    clipboardHistory = clipboardHistory.slice(0, MAX_HISTORY);
  }
  
  // Save to persistent storage
  store.set('clipboardHistory', clipboardHistory);
  
  // Send to renderer if window exists
  if (mainWindow) {
    mainWindow.webContents.send('clipboard-updated', clipboardHistory);
  }
};

// Load saved clipboard history
const loadHistory = () => {
  const saved = store.get('clipboardHistory', []);
  clipboardHistory = saved;
};

// App event handlers
app.whenReady().then(() => {
  createWindow();
  loadHistory();
  monitorClipboard();
  
  // Register global shortcut
  const hotkey = getHotkey();
  const registered = globalShortcut.register(hotkey, () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.webContents.send('clipboard-updated', clipboardHistory);
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  if (!registered) {
    console.log(`Failed to register global shortcut: ${hotkey}`);
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
ipcMain.handle('paste-item', (event, text) => {
  clipboard.writeText(text);
  mainWindow.hide();
});

ipcMain.handle('clear-history', () => {
  clipboardHistory = [];
  store.delete('clipboardHistory');
  mainWindow.webContents.send('clipboard-updated', clipboardHistory);
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});