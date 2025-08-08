const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen } = require('electron');
const path = require('path');
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

let mainWindow = null;
let clipboardHistory = [];
const MAX_HISTORY = 20; // Keep last 20 items
let lastActiveWindow = null; // store window info before overlay shows
let pasteSessionCompleted = false; // guard to prevent repeated pastes

// Track pending paste retry timers so we can cancel if needed
let pendingPasteTimers = [];

function clearPendingPasteTimers() {
  pendingPasteTimers.forEach(t => clearTimeout(t));
  pendingPasteTimers = [];
}

function simulatePasteKeystroke(attempt, totalAttempts) {
  if (pasteSessionCompleted) {
    return; // already pasted once this session
  }
  try {
    const platform = process.platform;
    const modifier = platform === 'darwin' ? 'command' : 'control';
    robot.keyTap('v', modifier);
    console.log(`[paste] Sent keystroke attempt ${attempt + 1}/${totalAttempts}`);
    // Mark session as completed after first successful send
    pasteSessionCompleted = true;
    // Cancel any remaining timers so no duplicate pastes
    clearPendingPasteTimers();
  } catch (e) {
    console.error('[paste] Failed to simulate keystroke attempt', attempt + 1, e);
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
  if (pasteSessionCompleted) return;
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
  // Keep the previously focused app active so simulated paste goes there.
  // We only need mouse clicks; keyboard shortcuts inside overlay are not required.
  focusable: false,
  acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: false
    }
  });

  // Prevent window from showing in taskbar on Windows
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(true);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  // Open DevTools for debugging
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Hide window when it loses focus
  // Delay hiding on blur to allow click events (e.g., paste) to be processed
  mainWindow.on('blur', () => {
    setTimeout(() => {
      // Only hide if the window is still not focused
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        mainWindow.hide();
      }
    }, 150);
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
  console.log('Adding to history:', text.substring(0, 50) + '...'); // Debug output
  
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
  if (mainWindow && !mainWindow.isDestroyed()) {
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
    if (!mainWindow) return;
    console.log('Hotkey pressed!'); // Debug output
    if (mainWindow.isVisible()) {
      console.log('Hiding window');
      mainWindow.hide();
    } else {
      activeWin().then(info => {
        lastActiveWindow = info;
        console.log('[focus] Captured last active window:', info ? `${info.owner.name} | ${info.title}` : 'unknown');
      }).catch(e => console.warn('[focus] Failed to get active window', e));
      console.log('Showing window');
      mainWindow.webContents.send('clipboard-updated', clipboardHistory);
      mainWindow.show(); // don't focus so previous window stays target for paste
    }
  });
  
  if (!registered) {
    console.log(`Failed to register global shortcut: ${hotkey}`);
  } else {
    console.log(`Successfully registered hotkey: ${hotkey}`);
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
  console.log('Paste request received with text length:', text?.length);
  if (!text) return false;
  pasteSessionCompleted = false; // reset guard for new session

  // 1. Put text onto system clipboard immediately
  clipboard.writeText(text);

  // 2. Hide our overlay FIRST so the previously focused app regains focus.
  //    (Original order sent the key stroke while our window still had focus.)
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Blur first to encourage focus to revert before hide
    try { mainWindow.blur(); } catch(_) {}
    mainWindow.hide();
  }

  // Cancel any previous pending attempts (user may have re-opened quickly)
  clearPendingPasteTimers();

  // Schedule multiple attempts
  schedulePasteRetries();

  return true;
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