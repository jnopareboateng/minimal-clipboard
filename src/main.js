const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, screen, nativeImage, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const robot = require('robotjs'); // added for simulating paste keystroke
const activeWin = require('active-win'); // diagnostics & focus tracking
const { spawn } = require('child_process');

// Simple text compression using built-in zlib (no native dependencies)
const zlib = require('zlib');

// Enable GPU acceleration for better UI performance
// Only disable on known problematic configurations
const shouldDisableGPU = process.platform === 'linux' && process.arch === 'arm64';
if (shouldDisableGPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('--disable-gpu');
  app.commandLine.appendSwitch('--disable-gpu-sandbox');
  app.commandLine.appendSwitch('--disable-software-rasterizer');
} else {
  // Enable GPU acceleration for better performance on macOS/Windows
  app.commandLine.appendSwitch('--enable-gpu-rasterization');
  app.commandLine.appendSwitch('--enable-zero-copy');
  app.commandLine.appendSwitch('--enable-hardware-overlays');
}

// Initialize persistent storage
const store = new Store();

// Check for command line arguments
const args = process.argv.slice(1);
const startMinimized = args.includes('--minimized') || args.includes('--hidden');

// Settings and defaults
const DEFAULT_SETTINGS = {
  maxHistory: 20,
  thumbWidth: 320,
  singleClickAction: 'copy', // 'copy' | 'paste' | 'none'
  rememberPosition: true,
  hotkey: null // null means use platform default
};

// Memory optimization constants
const MAX_TEXT_SIZE = 50000; // 50KB text limit to prevent memory bloat
const COMPRESSION_THRESHOLD = 10000; // Compress text larger than 10KB
const MEMORY_CLEANUP_THRESHOLD = 150; // MB - trigger cleanup when heap exceeds this
const AGGRESSIVE_CLEANUP_THRESHOLD = 200; // MB - trigger aggressive cleanup
const MAX_HISTORY_SIZE = 50; // Maximum history size for memory optimization

// Memory monitoring utilities
let memoryLogInterval = null;
const MEMORY_LOG_INTERVAL = 30000; // Log memory every 30 seconds for more frequent monitoring
let lastMemoryCleanup = 0;
const MEMORY_CLEANUP_COOLDOWN = 300000; // 5 minutes between cleanups

let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));

// Memory monitoring functions
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
    external: Math.round(usage.external / 1024 / 1024), // MB
    historySize: clipboardHistory.length,
    textCacheSize: textCache.size,
    imageCacheSize: imageCache.size
  };
}

function logMemoryUsage() {
  const memory = getMemoryUsage();
  console.log(`[memory] RSS: ${memory.rss}MB, Heap: ${memory.heapUsed}/${memory.heapTotal}MB, External: ${memory.external}MB, History: ${memory.historySize}, Caches: ${memory.textCacheSize}+${memory.imageCacheSize}`);
}

function startMemoryMonitoring() {
  if (memoryLogInterval) return;
  console.log('[memory] Starting intelligent memory monitoring');
  logMemoryUsage(); // Initial log
  memoryLogInterval = setInterval(monitorMemoryUsage, MEMORY_LOG_INTERVAL);
}

function stopMemoryMonitoring() {
  clearMemoryMonitoring();
  console.log('[memory] Stopped memory monitoring');
}

function forceGarbageCollection() {
  if (global.gc) {
    console.log('[memory] Forcing garbage collection');
    global.gc();
    logMemoryUsage();
  } else {
    console.log('[memory] Garbage collection not available (run with --expose-gc)');
  }
}

// Intelligent memory management with automatic cleanup
function performMemoryCleanup(aggressive = false) {
  const now = Date.now();
  if (now - lastMemoryCleanup < MEMORY_CLEANUP_COOLDOWN && !aggressive) {
    return; // Too soon since last cleanup
  }

  console.log(`[memory] Performing ${aggressive ? 'aggressive' : 'standard'} memory cleanup`);
  lastMemoryCleanup = now;

  let cleanedCount = 0;
  const initialMemory = getMemoryUsage();

  // Force garbage collection first
  forceGarbageCollection();

  // Clean up old image files that are no longer referenced
  if (aggressive) {
    cleanupOrphanedImageFiles();
  }

  // Trim history if it's getting too large
  if (clipboardHistory.length > MAX_HISTORY_SIZE) {
    const toRemove = clipboardHistory.length - MAX_HISTORY_SIZE;
    const removedItems = clipboardHistory.splice(0, toRemove); // Remove oldest items

    // Clean up files for removed items
    removedItems.forEach(item => {
      if (item.type === 'image') {
        if (item.filePath) deleteFileQuiet(item.filePath);
        if (item.thumbPath) deleteFileQuiet(item.thumbPath);
      }
    });

    cleanedCount += toRemove;
    console.log(`[memory] Removed ${toRemove} old items from history`);
  }

  // Clear caches and rebuild them
  textCache.clear();
  imageCache.clear();
  rebuildCaches();

  // Log cleanup results
  const finalMemory = getMemoryUsage();
  const memorySaved = initialMemory.heapUsed - finalMemory.heapUsed;

  console.log(`[memory] Cleanup completed: ${cleanedCount} items removed, ${memorySaved > 0 ? memorySaved : 0}MB memory freed`);
  console.log(`[memory] Memory after cleanup: ${finalMemory.heapUsed}MB heap, ${finalMemory.historySize} items`);
}

function cleanupOrphanedImageFiles() {
  try {
    const imageDir = path.join(app.getPath('userData'), 'images');
    if (!fs.existsSync(imageDir)) return;

    const files = fs.readdirSync(imageDir);
    let cleanedFiles = 0;

    files.forEach(file => {
      const filePath = path.join(imageDir, file);
      const fileId = path.parse(file).name;

      // Check if this file is referenced in current history
      const isReferenced = clipboardHistory.some(item =>
        item.type === 'image' && (
          item.id === fileId ||
          (item.filePath && path.basename(item.filePath) === file) ||
          (item.thumbPath && path.basename(item.thumbPath) === file)
        )
      );

      if (!isReferenced) {
        deleteFileQuiet(filePath);
        cleanedFiles++;
      }
    });

    if (cleanedFiles > 0) {
      console.log(`[memory] Cleaned up ${cleanedFiles} orphaned image files`);
    }
  } catch (error) {
    console.warn('[memory] Error during orphaned file cleanup:', error.message);
  }
}

// Monitor memory usage and trigger cleanup when needed
function monitorMemoryUsage() {
  const memory = getMemoryUsage();
  const cacheStats = clipboardCache.getStats();

  if (memory.heapUsed > AGGRESSIVE_CLEANUP_THRESHOLD) {
    console.log(`[memory] CRITICAL: Heap usage ${memory.heapUsed}MB exceeds aggressive threshold`);
    performMemoryCleanup(true);
  } else if (memory.heapUsed > MEMORY_CLEANUP_THRESHOLD) {
    console.log(`[memory] WARNING: Heap usage ${memory.heapUsed}MB exceeds cleanup threshold`);
    performMemoryCleanup(false);
  }

  // Log memory usage and cache statistics periodically
  if (memory.heapUsed > 100 || memory.historySize > 20) {
    console.log(`[memory] Status: ${memory.heapUsed}MB heap, ${memory.historySize} items, ${memory.external}MB external`);
    console.log(`[LRU] Cache: ${cacheStats.size}/${cacheStats.maxSize} items, ${cacheStats.avgAccesses} avg accesses`);
  }
}

// Reset invalid hotkey to empty string (will use default)
if (settings.hotkey && !/^[\x00-\x7F]*$/.test(settings.hotkey)) {
  console.warn('Invalid hotkey detected, resetting to default:', settings.hotkey);
  settings.hotkey = null;
  store.set('settings', settings);
}

let mainWindow = null;
let backdropWindow = null;
let clipboardHistory = [];
// Optimization: Cache for fast duplicate detection
let textCache = new Set(); // For text content lookup
let imageCache = new Set(); // For image signature lookup
let imageStoreDir = null;
function getMaxHistory() {
  const v = Number(settings.maxHistory);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_SETTINGS.maxHistory;
}
let lastActiveWindow = null; // store window info before overlay shows
let pasteSessionCompleted = false; // guard to prevent repeated pastes

// Track pending paste retry timers so we can cancel if needed
let pendingPasteTimers = [];
let clipboardMonitorInterval = null;
let imageProcessingTimeouts = new Set(); // Track image processing timeouts

// LRU Cache for clipboard history management
class LRUCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map(); // key -> {item, accessCount, lastAccessed}
    this.accessOrder = []; // Array to maintain LRU order
  }

  get(key) {
    if (!this.cache.has(key)) return null;

    const entry = this.cache.get(key);
    entry.lastAccessed = Date.now();
    entry.accessCount++;

    // Move to end (most recently used)
    this.moveToEnd(key);

    return entry.item;
  }

  set(key, item) {
    const now = Date.now();

    if (this.cache.has(key)) {
      // Update existing item
      const entry = this.cache.get(key);
      entry.item = item;
      entry.lastAccessed = now;
      entry.accessCount++;
      this.moveToEnd(key);
    } else {
      // Add new item
      this.cache.set(key, {
        item,
        accessCount: 1,
        lastAccessed: now
      });
      this.accessOrder.push(key);

      // Evict if over capacity
      if (this.cache.size > this.maxSize) {
        this.evictLRU();
      }
    }
  }

  moveToEnd(key) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
      this.accessOrder.push(key);
    }
  }

  evictLRU() {
    if (this.accessOrder.length === 0) return;

    const lruKey = this.accessOrder.shift();
    const entry = this.cache.get(lruKey);

    // Clean up resources if it's an image
    if (entry && entry.item.type === 'image') {
      if (entry.item.filePath) deleteFileQuiet(entry.item.filePath);
      if (entry.item.thumbPath) deleteFileQuiet(entry.item.thumbPath);
    }

    this.cache.delete(lruKey);
    console.log(`[LRU] Evicted item: ${lruKey}`);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    if (this.cache.has(key)) {
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  clear() {
    // Clean up all image resources
    for (const [key, entry] of this.cache.entries()) {
      if (entry.item.type === 'image') {
        if (entry.item.filePath) deleteFileQuiet(entry.item.filePath);
        if (entry.item.thumbPath) deleteFileQuiet(entry.item.thumbPath);
      }
    }

    this.cache.clear();
    this.accessOrder = [];
  }

  size() {
    return this.cache.size;
  }

  // Get items in LRU order (most recently used first)
  getItemsInOrder() {
    return this.accessOrder.map(key => this.cache.get(key).item).reverse();
  }

  // Get cache statistics
  getStats() {
    const totalAccesses = Array.from(this.cache.values()).reduce((sum, entry) => sum + entry.accessCount, 0);
    const avgAccesses = totalAccesses / this.cache.size || 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      totalAccesses,
      avgAccesses: avgAccesses.toFixed(2),
      hitRate: this.cache.size > 0 ? (totalAccesses / (totalAccesses + (this.maxSize - this.cache.size))) * 100 : 0
    };
  }
}

// Global LRU cache instance
const clipboardCache = new LRUCache(30); // Cache up to 30 items

function clearPendingPasteTimers() {
  pendingPasteTimers.forEach(t => clearTimeout(t));
  pendingPasteTimers = [];
}

function clearImageProcessingTimeouts() {
  imageProcessingTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
  imageProcessingTimeouts.clear();
}

function clearMemoryMonitoring() {
  if (memoryLogInterval) {
    clearInterval(memoryLogInterval);
    memoryLogInterval = null;
  }
}

function clearClipboardMonitoring() {
  if (clipboardMonitorInterval) {
    clearInterval(clipboardMonitorInterval);
    clipboardMonitorInterval = null;
  }
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
function create_tray() {
  console.log('[tray] Creating system tray icon...');

  // Create a simple programmatic icon as fallback
  function createFallbackIcon() {
    const size = process.platform === 'darwin' ? 22 : 16; // macOS needs larger icons

    // Create a simple PNG buffer for the icon
    // This creates a blue square with a white clipboard shape
    const iconData = Buffer.alloc(size * size * 4); // RGBA

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;

        // Blue background
        iconData[idx] = 0;     // R
        iconData[idx + 1] = 122; // G
        iconData[idx + 2] = 204; // B
        iconData[idx + 3] = 255; // A (opaque)

        // Draw white clipboard shape
        const margin = Math.floor(size * 0.15);
        const clipWidth = size - margin * 2;
        const clipHeight = size - margin * 2;

        // Clipboard body (white rectangle)
        if (x >= margin && x < margin + clipWidth &&
            y >= margin + 3 && y < margin + clipHeight - 3) {
          iconData[idx] = 255;     // R
          iconData[idx + 1] = 255; // G
          iconData[idx + 2] = 255; // B
        }

        // Clipboard clip (blue rectangle at top)
        if (x >= margin + clipWidth/2 - 2 && x < margin + clipWidth/2 + 2 &&
            y >= margin && y < margin + 6) {
          iconData[idx] = 0;     // R
          iconData[idx + 1] = 122; // G
          iconData[idx + 2] = 204; // B
        }
      }
    }

    return nativeImage.createFromBuffer(iconData, { width: size, height: size });
  }

  let tray_icon;

  try {
    // Try to load the appropriately sized PNG icon first
    let iconPath;
    if (process.platform === 'darwin') {
      // macOS prefers 22x22 icons
      iconPath = path.join(__dirname, 'icon-22.png');
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'icon.png'); // fallback to original
      }
    } else {
      // Windows and Linux prefer 16x16 icons
      iconPath = path.join(__dirname, 'icon-16.png');
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, 'icon.png'); // fallback to original
      }
    }

    if (fs.existsSync(iconPath)) {
      tray_icon = nativeImage.createFromPath(iconPath);
      console.log('[tray] Loaded PNG icon from:', iconPath);
    } else {
      console.log('[tray] PNG icon not found at:', iconPath);
      // Fall back to programmatic icon
      tray_icon = createFallbackIcon();
      console.log('[tray] Created programmatic icon as fallback');
    }
  } catch (error) {
    console.warn('[tray] Failed to load PNG icon:', error);
    try {
      // Try to load SVG as fallback
      const icon_path = path.join(__dirname, '../assets/icon.svg');
      if (fs.existsSync(icon_path)) {
        tray_icon = nativeImage.createFromPath(icon_path);
        console.log('[tray] Loaded SVG icon as fallback');
      } else {
        tray_icon = nativeImage.createEmpty();
        console.log('[tray] Using empty icon as last resort');
      }
    } catch (svgError) {
      console.warn('[tray] Failed to load SVG icon:', svgError);
      tray_icon = nativeImage.createEmpty();
    }
  }

  // Configure icon for platform
  if (process.platform === 'darwin') {
    tray_icon.setTemplateImage(true);
  }

  // Create tray with the icon
  tray = new Tray(tray_icon);
  console.log('[tray] Tray created successfully');

  const context_menu = Menu.buildFromTemplate([
    {
      label: 'Show Clipboard Manager',
      click: () => {
        console.log('[tray] Show menu clicked');
        if (mainWindow) {
          sendHistoryToRenderer();
          showOverlayWindows();
        }
      }
    },
    {
      label: 'Clear History',
      click: () => {
        console.log('[tray] Clear history clicked');
        clipboardHistory = [];
        textCache.clear();
        imageCache.clear();
        store.set('clipboardHistory', []);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('history-updated', []);
        }
        console.log('History cleared from tray menu');
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        console.log('[tray] Quit clicked');
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Minimal Clipboard Manager');
  tray.setContextMenu(context_menu);

  // Double-click to show window
  tray.on('double-click', () => {
    console.log('[tray] Double-click detected');
    if (mainWindow) {
      sendHistoryToRenderer();
      showOverlayWindows();
    }
  });

  // Right-click to show context menu (for platforms that need it)
  tray.on('right-click', () => {
    console.log('[tray] Right-click detected');
    tray.popUpContextMenu();
  });

  console.log('[tray] Tray setup complete');

  return tray;
}

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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: false
    }
  });
  try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}

  // Configure windows to be minimized/hidden across all platforms
  if (process.platform === 'win32') {
    mainWindow.setSkipTaskbar(true);
    backdropWindow.setSkipTaskbar(true);
  } else if (process.platform === 'darwin') {
    // macOS: Ensure windows don't appear in exposé or mission control
    try {
      mainWindow.setSkipTaskbar(true);
      backdropWindow.setSkipTaskbar(true);
    } catch (_) {}
  } else if (process.platform === 'linux') {
    // Linux: Ensure windows don't show in taskbar/panel
    try {
      mainWindow.setSkipTaskbar(true);
      backdropWindow.setSkipTaskbar(true);
    } catch (_) {}
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
  
  // Cleanup on window destruction
  mainWindow.on('closed', () => {
    console.log('[cleanup] Main window closed, clearing timers...');
    clearPendingPasteTimers();
    clearImageProcessingTimeouts();
    mainWindow = null;
  });

  backdropWindow.on('closed', () => {
    console.log('[cleanup] Backdrop window closed');
    backdropWindow = null;
  });
};

// Monitor clipboard changes - OPTIMIZED VERSION
let lastClipboardSignature = '';
let lastClipboardCheck = 0;
let consecutiveEmptyChecks = 0;
const MIN_CHECK_INTERVAL = 2000; // Minimum 2 seconds between checks
const MAX_CHECK_INTERVAL = 10000; // Maximum 10 seconds when idle
let currentCheckInterval = MIN_CHECK_INTERVAL;

const monitorClipboard = () => {
  // Clear existing interval if any
  if (clipboardMonitorInterval) {
    clearInterval(clipboardMonitorInterval);
  }

  clipboardMonitorInterval = setInterval(() => {
    const now = Date.now();

    // Adaptive polling: slow down when no changes detected
    if (consecutiveEmptyChecks > 5) {
      if (now - lastClipboardCheck < currentCheckInterval) {
        return; // Skip this check
      }
      // Gradually increase interval up to max
      currentCheckInterval = Math.min(currentCheckInterval + 500, MAX_CHECK_INTERVAL);
    } else {
      // Reset to minimum interval when active
      currentCheckInterval = MIN_CHECK_INTERVAL;
    }

    lastClipboardCheck = now;

    try {
      // Prefer image if available; otherwise fall back to non-empty text
      const img = clipboard.readImage();
      const hasImage = img && !img.isEmpty();

      if (hasImage) {
        const size = img.getSize();
        const signature = `image:${size.width}x${size.height}`; // avoid heavy encoding in the polling loop
        if (signature !== lastClipboardSignature) {
          lastClipboardSignature = signature;
          consecutiveEmptyChecks = 0; // Reset idle counter

          // Defer heavy image processing to avoid blocking main thread
          setTimeout(() => {
            processImageClipboard(img, size, signature);
          }, 10);
        } else {
          consecutiveEmptyChecks++;
        }
        return; // do not process text if image present
      }

      let currentText = clipboard.readText();
      if (currentText && currentText.trim() !== '') {
        // Apply text size limit for memory optimization
        currentText = truncateText(currentText);
        const signature = `text:${currentText}`;
        if (signature !== lastClipboardSignature) {
          lastClipboardSignature = signature;
          consecutiveEmptyChecks = 0; // Reset idle counter
          addToHistory({ type: 'text', text: currentText });
        } else {
          consecutiveEmptyChecks++;
        }
      } else {
        consecutiveEmptyChecks++;
      }
    } catch (e) {
      console.warn('[clipboard] Monitor error:', e?.message || e);
      consecutiveEmptyChecks++;
    }
  }, 2000); // Check every 2 seconds (much more reasonable)
};

// Separate function for heavy image processing to avoid blocking main thread
function processImageClipboard(img, size, signature) {
  // Use process.nextTick and setImmediate for better async processing
  const processImage = () => {
    try {
                // Persist full-resolution image once per new image
          ensureImageStoreDir();
          const pngBuffer = img.toPNG();
          const { id, filePath } = saveImagePng(pngBuffer);

          // Build a lightweight thumbnail for UI using WebP for better compression
          const maxThumbWidth = getThumbWidth();
          const thumb = img.resize({ width: Math.min(maxThumbWidth, size.width) });
          const thumbBuffer = thumb.toPNG();
          const thumbPath = saveThumbnailWebP(thumbBuffer, 80); // 80% quality for good balance

      // Use setImmediate to defer history addition to next tick
      setImmediate(() => {
        addToHistory({
          type: 'image',
          id,
          filePath,
          width: size.width,
          height: size.height,
          thumbPath,
          signature
        });
      });
    } catch (e) {
      console.warn('[clipboard] Image processing error:', e?.message || e);
    }
  };

  // Track this timeout for cleanup
  const timeoutId = setTimeout(() => {
    process.nextTick(processImage);
    imageProcessingTimeouts.delete(timeoutId);
  }, 1); // Minimal delay to ensure async execution

  imageProcessingTimeouts.add(timeoutId);
}

// Add item to clipboard history (supports text and image)
const addToHistory = (item) => {
  if (!item) return;

  // Create unique key for LRU cache
  const cacheKey = item.type === 'text' ? `text_${item.text.substring(0, 100)}` : `image_${item.signature}`;

  // Check if item already exists in LRU cache
  const existingItem = clipboardCache.get(cacheKey);
  if (existingItem) {
    console.log(`[LRU] Item already in cache, updating access: ${cacheKey}`);
    return; // Item already exists and was accessed, no need to add again
  }

  if (item.type === 'text') {
    // Process text with compression and truncation
    const processedText = processText(item.text);
    console.log('Adding to history (text):', (typeof processedText === 'string' ? processedText : processedText.data).substring(0, 50) + '...');

    // Optimized duplicate removal using cache
    removeDuplicateText(item.text);
    const newItem = { type: 'text', text: processedText, timestamp: Date.now() };
    clipboardHistory.unshift(newItem);

    // Add to LRU cache and text cache
    clipboardCache.set(cacheKey, newItem);
    textCache.add(item.text);
  } else if (item.type === 'image') {
    const sizeLabel = `${item.width}x${item.height}`;
    console.log('Adding to history (image):', sizeLabel);
    // Optimized duplicate removal using cache
    removeDuplicateImage(item);
    const newItem = {
      type: 'image',
      id: item.id,
      filePath: item.filePath,
      width: item.width,
      height: item.height,
      thumbPath: item.thumbPath,
      signature: item.signature,
      timestamp: Date.now()
    };
    clipboardHistory.unshift(newItem);

    // Add to LRU cache and image cache
    clipboardCache.set(cacheKey, newItem);
    if (item.signature) imageCache.add(item.signature);
  } else {
    return;
  }

  // Limit history size
  if (clipboardHistory.length > getMaxHistory()) {
    const toRemove = clipboardHistory.slice(getMaxHistory());
    // Clean up image files and cache entries for removed items
    toRemove.forEach(i => { 
      if (i.type === 'image') {
        if (i.filePath) deleteFileQuiet(i.filePath);
        if (i.thumbPath) deleteFileQuiet(i.thumbPath);
        if (i.signature) imageCache.delete(i.signature);
      } else if (i.type === 'text') {
        textCache.delete(i.text);
      }
    });
    clipboardHistory = clipboardHistory.slice(0, getMaxHistory());
  }

  // Save to persistent storage
  store.set('clipboardHistory', clipboardHistory);

  // Log memory usage after adding item
  const memory = getMemoryUsage();
  if (memory.heapUsed > 100) { // Log if heap usage > 100MB
    console.log(`[memory] After adding ${item.type}: ${memory.heapUsed}MB heap, ${memory.historySize} items`);
  }

  // Send to renderer if window exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendHistoryToRenderer();
  }
};

// Load saved clipboard history
const loadHistory = () => {
  const saved = store.get('clipboardHistory', []);
  clipboardHistory = Array.isArray(saved) ? saved : [];
  
  // Migration: Remove old entries with thumbDataUrl to free memory
  // New clipboard monitoring will regenerate thumbnails as files
  let migrationNeeded = false;
  clipboardHistory = clipboardHistory.filter(item => {
    if (item.type === 'image' && item.thumbDataUrl && !item.thumbPath) {
      console.log('[migration] Removing old image entry with base64 thumbnail:', item.id);
      // Clean up the full-resolution file if it exists
      if (item.filePath) deleteFileQuiet(item.filePath);
      migrationNeeded = true;
      return false; // Remove this entry
    }
    return true; // Keep this entry
  });
  
  // Migration: Apply text size limits to existing text entries
  clipboardHistory.forEach(item => {
    if (item.type === 'text' && item.text && item.text.length > MAX_TEXT_SIZE) {
      console.log(`[migration] Truncating text entry from ${item.text.length} to ${MAX_TEXT_SIZE} characters`);
      item.text = truncateText(item.text);
      migrationNeeded = true;
    }
  });
  
  if (migrationNeeded) {
    console.log('[migration] Cleaned up old base64 thumbnails, saving updated history');
    store.set('clipboardHistory', clipboardHistory);
  }
  
  // Rebuild caches for optimized duplicate detection
  rebuildCaches();
  console.log(`[cache] Rebuilt caches: ${textCache.size} texts, ${imageCache.size} images`);
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

function saveThumbnailWebP(thumbnailBuffer, quality = 80) {
  ensureImageStoreDir();
  const id = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const thumbPath = path.join(imageStoreDir, `${id}.webp`);

  try {
    // Convert PNG buffer to nativeImage, then to WebP
    const image = nativeImage.createFromBuffer(thumbnailBuffer);
    const webpBuffer = image.toDataURL('image/webp', quality);

    // Extract base64 data and convert to buffer
    const base64Data = webpBuffer.split(',')[1];
    const webpImageBuffer = Buffer.from(base64Data, 'base64');

    fs.writeFileSync(thumbPath, webpImageBuffer);
    console.log(`[thumbnail] Saved WebP thumbnail: ${webpBuffer.length} -> ${webpImageBuffer.length} bytes`);
    return thumbPath;
  } catch (e) {
    console.warn('[thumbnail] WebP failed, falling back to PNG:', e?.message || e);
    // Fallback to PNG if WebP fails
    return saveThumbnailPng(thumbnailBuffer);
  }
}

function saveThumbnailPng(thumbnailBuffer) {
  ensureImageStoreDir();
  const id = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const thumbPath = path.join(imageStoreDir, `${id}.png`);
  try {
    fs.writeFileSync(thumbPath, thumbnailBuffer);
    return thumbPath;
  } catch (e) {
    console.error('[thumbnail] Failed to write thumbnail file', e?.message || e);
    return null;
  }
}

function deleteFileQuiet(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// Text compression functions using zlib (built-in, no native dependencies)
function compressText(text) {
  if (!text || typeof text !== 'string' || text.length < COMPRESSION_THRESHOLD) {
    return text;
  }

  try {
    const input = Buffer.from(text, 'utf8');
    const compressed = zlib.deflateSync(input);
    const originalSize = input.length;
    const compressedSize = compressed.length;
    const ratio = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);

    console.log(`[compression] Text compressed: ${originalSize} -> ${compressedSize} bytes (${ratio}% reduction)`);
    return {
      compressed: true,
      data: compressed.toString('base64'),
      originalSize,
      compressedSize
    };
  } catch (error) {
    console.warn('[compression] Failed to compress text:', error.message);
    return text;
  }
}

function decompressText(compressedData) {
  if (!compressedData || typeof compressedData === 'string') {
    return compressedData;
  }

  if (compressedData.compressed && compressedData.data) {
    try {
      const compressed = Buffer.from(compressedData.data, 'base64');
      const decompressed = zlib.inflateSync(compressed);
      return decompressed.toString('utf8');
    } catch (error) {
      console.warn('[compression] Failed to decompress text:', error.message);
      return compressedData.data || '';
    }
  }

  return compressedData;
}

function truncateText(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.length <= MAX_TEXT_SIZE) return text;

  const truncated = text.substring(0, MAX_TEXT_SIZE);
  console.log(`[memory] Text truncated from ${text.length} to ${truncated.length} characters`);
  return truncated + '\n\n[... text truncated for memory optimization]';
}

// Enhanced text processing with compression
function processText(text) {
  if (!text || typeof text !== 'string') return text;

  // First truncate if too large
  text = truncateText(text);

  // Then compress if still large enough
  return compressText(text);
}

// Cache management functions for optimized duplicate detection
function rebuildCaches() {
  textCache.clear();
  imageCache.clear();
  clipboardHistory.forEach(item => {
    if (item.type === 'text') {
      textCache.add(item.text);
    } else if (item.type === 'image' && item.signature) {
      imageCache.add(item.signature);
    }
  });
}

function removeDuplicateText(text) {
  if (!textCache.has(text)) return false;
  
  // Remove from array and cache
  const index = clipboardHistory.findIndex(h => h.type === 'text' && h.text === text);
  if (index !== -1) {
    clipboardHistory.splice(index, 1);
    textCache.delete(text);
    return true;
  }
  return false;
}

function removeDuplicateImage(item) {
  let removed = false;
  
  if (item.signature && imageCache.has(item.signature)) {
    // Remove by signature
    const index = clipboardHistory.findIndex(h => h.type === 'image' && h.signature === item.signature);
    if (index !== -1) {
      const oldItem = clipboardHistory[index];
      if (oldItem.filePath) deleteFileQuiet(oldItem.filePath);
      if (oldItem.thumbPath) deleteFileQuiet(oldItem.thumbPath);
      clipboardHistory.splice(index, 1);
      imageCache.delete(item.signature);
      removed = true;
    }
  } else {
    // Fallback: remove by dimensions
    const index = clipboardHistory.findIndex(h => 
      h.type === 'image' && h.width === item.width && h.height === item.height
    );
    if (index !== -1) {
      const oldItem = clipboardHistory[index];
      if (oldItem.filePath) deleteFileQuiet(oldItem.filePath);
      if (oldItem.thumbPath) deleteFileQuiet(oldItem.thumbPath);
      clipboardHistory.splice(index, 1);
      if (oldItem.signature) imageCache.delete(oldItem.signature);
      removed = true;
    }
  }
  
  return removed;
}

function sendHistoryToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Use LRU cache order if available, otherwise use regular history
  const itemsToSend = clipboardCache.size() > 0 ? clipboardCache.getItemsInOrder() : clipboardHistory;

  const lightweight = itemsToSend.map(i => {
    if (i.type === 'image') {
      // Use lazy loading for thumbnails - send file path instead of base64
      // Renderer will load thumbnails on demand
      let thumbDataUrl = null;
      if (i.thumbPath && fs.existsSync(i.thumbPath)) {
        try {
          // Only load thumbnail if it's WebP or small PNG, otherwise lazy load
          const stats = fs.statSync(i.thumbPath);
          if (stats.size < 50000 || i.thumbPath.endsWith('.webp')) { // Load small files or WebP immediately
            const thumbBuffer = fs.readFileSync(i.thumbPath);
            const format = i.thumbPath.endsWith('.webp') ? 'webp' : 'png';
            thumbDataUrl = `data:image/${format};base64,${thumbBuffer.toString('base64')}`;
          } else {
            // For large PNG files, send file path for lazy loading
            thumbDataUrl = `file://${i.thumbPath}`;
          }
        } catch (e) {
          console.warn('[thumbnail] Failed to read thumbnail file:', e?.message || e);
        }
      }
      return {
        type: 'image',
        id: i.id,
        width: i.width,
        height: i.height,
        thumbDataUrl,
        thumbPath: i.thumbPath, // Include path for lazy loading
        timestamp: i.timestamp
      };
    }

    // Decompress text before sending to renderer
    const decompressedText = decompressText(i.text);
    return { type: 'text', text: decompressedText, timestamp: i.timestamp };
  });
  mainWindow.webContents.send('clipboard-updated', lightweight);
}

// Configure app to start minimized across all platforms
function configureAppForMinimizedStartup() {
  console.log(`[startup] Configuring app to start minimized (startMinimized: ${startMinimized})`);

  // macOS: Set as accessory app to hide from dock
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    console.log('[startup] macOS: Set activation policy to accessory (hidden from dock)');
  }

  // Windows: Configure to not show in taskbar
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.getName());
    console.log('[startup] Windows: Set app user model ID');
  }

  // Linux: Additional configuration if needed
  if (process.platform === 'linux') {
    // Ensure app doesn't show in taskbar
    app.commandLine.appendSwitch('--disable-dev-shm-usage');
    app.commandLine.appendSwitch('--no-sandbox');
    console.log('[startup] Linux: Added command line switches for compatibility');
  }

  console.log('[startup] App configured for minimized startup');
}

// Global tray reference to prevent garbage collection
let tray = null;

// App event handlers
app.whenReady().then(() => {
  // Configure app to start minimized before creating windows
  configureAppForMinimizedStartup();

  createWindow();
  tray = create_tray(); // Store reference to prevent GC
  loadHistory();
  monitorClipboard();

  // Start memory monitoring
  startMemoryMonitoring();
  
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
  
  console.log(`Minimal Clipboard started minimized. Press ${hotkey} to open.`);
});

app.on('window-all-closed', () => {
  // Don't quit the app when all windows are closed - keep running in system tray
  // The app can only be quit through the tray menu or Cmd+Q
});

app.on('before-quit', () => {
  console.log('[cleanup] App before-quit, starting cleanup...');
  // Clean up tray when quitting
  if (tray) {
    tray.destroy();
    tray = null;
  }
  // Clear all timers and intervals
  clearPendingPasteTimers();
  clearImageProcessingTimeouts();
  clearMemoryMonitoring();
  clearClipboardMonitoring();
});

app.on('activate', () => {
  // On macOS, show the window when the dock icon is clicked
  if (process.platform === 'darwin' && mainWindow) {
    sendHistoryToRenderer();
    showOverlayWindows();
  }
});

app.on('will-quit', () => {
  // Comprehensive cleanup on app quit
  console.log('[cleanup] Starting comprehensive app cleanup...');

  // Clear all timers and intervals
  clearPendingPasteTimers();
  clearImageProcessingTimeouts();
  clearMemoryMonitoring();
  clearClipboardMonitoring();

  // Stop memory monitoring
  stopMemoryMonitoring();

  // Unregister all shortcuts
  globalShortcut.unregisterAll();

  console.log('[cleanup] Comprehensive app cleanup completed');
});

// IPC handlers
ipcMain.handle('paste-item', (event, payload) => {
  const isString = typeof payload === 'string';
  const isTextObj = payload && payload.type === 'text' && typeof payload.text === 'string';
  const isImageObj = payload && payload.type === 'image' && typeof payload.dataUrl === 'string';
  const isImageIdObj = payload && payload.type === 'image' && typeof payload.id === 'string';

  if (!isString && !isTextObj && !isImageObj && !isImageIdObj) return false;

  if (isString || isTextObj) {
    let text = isString ? payload : payload.text;
    console.log('Paste request received (text) with length:', text?.length);
    // Apply text size limit for memory optimization
    text = truncateText(text);
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
      let text = isString ? payload : payload.text;
      // Apply text size limit for memory optimization
      text = truncateText(text);
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
  const beforeMemory = getMemoryUsage();

  // Clean up all image and thumbnail files before clearing history
  clipboardHistory.forEach(i => {
    if (i.type === 'image') {
      if (i.filePath) deleteFileQuiet(i.filePath);
      if (i.thumbPath) deleteFileQuiet(i.thumbPath);
    }
  });

  clipboardHistory = [];
  // Clear all caches for optimized performance
  textCache.clear();
  imageCache.clear();
  clipboardCache.clear();
  store.delete('clipboardHistory');

  // Log memory cleanup
  const afterMemory = getMemoryUsage();
  const memoryFreed = beforeMemory.heapUsed - afterMemory.heapUsed;
  console.log(`[memory] Cleared history: ${beforeMemory.heapUsed}MB -> ${afterMemory.heapUsed}MB (freed ${memoryFreed > 0 ? memoryFreed : 0}MB)`);

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

// Lazy load thumbnail handler
ipcMain.handle('load-thumbnail', async (event, thumbPath) => {
  try {
    if (!thumbPath || !fs.existsSync(thumbPath)) {
      return null;
    }

    const thumbBuffer = fs.readFileSync(thumbPath);
    const format = thumbPath.endsWith('.webp') ? 'webp' : 'png';
    return `data:image/${format};base64,${thumbBuffer.toString('base64')}`;
  } catch (error) {
    console.warn('[thumbnail] Failed to lazy load thumbnail:', error.message);
    return null;
  }
});

// Memory monitoring IPC handlers
ipcMain.handle('get-memory-usage', () => {
  return getMemoryUsage();
});

ipcMain.handle('force-gc', () => {
  forceGarbageCollection();
  return getMemoryUsage();
});

ipcMain.handle('toggle-memory-monitoring', (event, enabled) => {
  if (enabled) {
    startMemoryMonitoring();
  } else {
    stopMemoryMonitoring();
  }
  return enabled;
});

function getThumbWidth() {
  const v = Number(settings.thumbWidth);
  return Number.isFinite(v) && v >= 60 ? Math.floor(v) : DEFAULT_SETTINGS.thumbWidth;
}