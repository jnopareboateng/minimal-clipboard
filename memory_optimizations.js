// Memory Optimization Implementation Examples
// This file contains specific code changes to implement the highest impact optimizations

const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

// Configuration constants
const MAX_TEXT_SIZE = 10 * 1024; // 10KB limit for text entries
const MAX_THUMBNAIL_SIZE = 150; // Maximum thumbnail dimension
const THUMBNAIL_QUALITY = 0.8; // JPEG quality for thumbnails

// Global cleanup tracking
let clipboard_monitor_interval = null;
let pending_paste_timers = [];
let thumbnail_store_dir = null;

// Optimized timer management
function clear_pending_paste_timers() {
  pending_paste_timers.forEach(timer => clearTimeout(timer));
  pending_paste_timers = [];
}

function add_paste_timer(timer_id) {
  pending_paste_timers.push(timer_id);
}

// Optimized clipboard monitoring with debouncing
function start_clipboard_monitoring() {
  let last_check_time = 0;
  let consecutive_empty_checks = 0;
  
  clipboard_monitor_interval = setInterval(() => {
    const now = Date.now();
    
    // Adaptive monitoring frequency
    if (consecutive_empty_checks > 10) {
      // Slow down monitoring if no changes detected
      if (now - last_check_time < 1000) return;
    }
    
    try {
      const current_text = clipboard.readText();
      const current_image = clipboard.readImage();
      
      if (current_text || !current_image.isEmpty()) {
        consecutive_empty_checks = 0;
        process_clipboard_content(current_text, current_image);
      } else {
        consecutive_empty_checks++;
      }
      
      last_check_time = now;
    } catch (error) {
      console.warn('[clipboard] Monitor error:', error?.message || error);
      consecutive_empty_checks++;
    }
  }, 500);
}

function stop_clipboard_monitoring() {
  if (clipboard_monitor_interval) {
    clearInterval(clipboard_monitor_interval);
    clipboard_monitor_interval = null;
  }
}

// Optimized thumbnail generation and storage
function ensure_thumbnail_store_dir() {
  if (!thumbnail_store_dir) {
    thumbnail_store_dir = path.join(app.getPath('userData'), 'thumbnails');
  }
  try {
    fs.mkdirSync(thumbnail_store_dir, { recursive: true });
  } catch (error) {
    console.error('[thumbnail] Failed to create directory:', error);
  }
}

function create_optimized_thumbnail(native_image) {
  try {
    const size = native_image.getSize();
    
    // Calculate optimal thumbnail size maintaining aspect ratio
    let thumb_width = size.width;
    let thumb_height = size.height;
    
    if (thumb_width > MAX_THUMBNAIL_SIZE || thumb_height > MAX_THUMBNAIL_SIZE) {
      const ratio = Math.min(
        MAX_THUMBNAIL_SIZE / thumb_width,
        MAX_THUMBNAIL_SIZE / thumb_height
      );
      thumb_width = Math.round(thumb_width * ratio);
      thumb_height = Math.round(thumb_height * ratio);
    }
    
    // Resize and compress
    const resized = native_image.resize({ width: thumb_width, height: thumb_height });
    const jpeg_buffer = resized.toJPEG(Math.round(THUMBNAIL_QUALITY * 100));
    
    return {
      buffer: jpeg_buffer,
      width: thumb_width,
      height: thumb_height
    };
  } catch (error) {
    console.error('[thumbnail] Failed to create thumbnail:', error);
    return null;
  }
}

function save_thumbnail(jpeg_buffer) {
  ensure_thumbnail_store_dir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const file_path = path.join(thumbnail_store_dir, `${id}.jpg`);
  
  try {
    fs.writeFileSync(file_path, jpeg_buffer);
    return { id, file_path };
  } catch (error) {
    console.error('[thumbnail] Failed to save thumbnail:', error);
    return null;
  }
}

function delete_thumbnail_file(file_path) {
  try {
    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
    }
  } catch (error) {
    console.warn('[thumbnail] Failed to delete file:', file_path, error);
  }
}

// Optimized history management using Map for O(1) operations
class OptimizedClipboardHistory {
  constructor(max_size = 20) {
    this.max_size = max_size;
    this.items = new Map(); // key -> item
    this.order = []; // maintain insertion order
    this.text_signatures = new Set(); // for fast duplicate detection
    this.image_signatures = new Set();
  }
  
  add_text_item(text) {
    // Truncate large text
    if (text.length > MAX_TEXT_SIZE) {
      text = text.substring(0, MAX_TEXT_SIZE) + '\n... [content truncated]';
    }
    
    const signature = this.create_text_signature(text);
    
    // Remove existing duplicate
    if (this.text_signatures.has(signature)) {
      this.remove_by_signature(signature, 'text');
    }
    
    const item = {
      type: 'text',
      text: text,
      signature: signature,
      timestamp: Date.now()
    };
    
    this.add_item(item);
  }
  
  add_image_item(native_image) {
    const thumbnail_data = create_optimized_thumbnail(native_image);
    if (!thumbnail_data) return;
    
    const saved_thumbnail = save_thumbnail(thumbnail_data.buffer);
    if (!saved_thumbnail) return;
    
    const signature = this.create_image_signature(native_image);
    
    // Remove existing duplicate
    if (this.image_signatures.has(signature)) {
      this.remove_by_signature(signature, 'image');
    }
    
    const item = {
      type: 'image',
      id: saved_thumbnail.id,
      thumbnail_path: saved_thumbnail.file_path,
      width: thumbnail_data.width,
      height: thumbnail_data.height,
      signature: signature,
      timestamp: Date.now()
    };
    
    this.add_item(item);
  }
  
  add_item(item) {
    const key = `${item.type}_${item.timestamp}_${Math.random()}`;
    
    this.items.set(key, item);
    this.order.unshift(key);
    
    if (item.type === 'text') {
      this.text_signatures.add(item.signature);
    } else if (item.type === 'image') {
      this.image_signatures.add(item.signature);
    }
    
    // Cleanup old items
    while (this.order.length > this.max_size) {
      this.remove_oldest();
    }
  }
  
  remove_oldest() {
    if (this.order.length === 0) return;
    
    const oldest_key = this.order.pop();
    const item = this.items.get(oldest_key);
    
    if (item) {
      // Cleanup resources
      if (item.type === 'image' && item.thumbnail_path) {
        delete_thumbnail_file(item.thumbnail_path);
      }
      
      // Remove from signature sets
      if (item.type === 'text') {
        this.text_signatures.delete(item.signature);
      } else if (item.type === 'image') {
        this.image_signatures.delete(item.signature);
      }
    }
    
    this.items.delete(oldest_key);
  }
  
  remove_by_signature(signature, type) {
    for (const [key, item] of this.items.entries()) {
      if (item.signature === signature && item.type === type) {
        // Remove from order array
        const index = this.order.indexOf(key);
        if (index > -1) {
          this.order.splice(index, 1);
        }
        
        // Cleanup resources
        if (item.type === 'image' && item.thumbnail_path) {
          delete_thumbnail_file(item.thumbnail_path);
        }
        
        this.items.delete(key);
        break;
      }
    }
  }
  
  create_text_signature(text) {
    // Simple hash for duplicate detection
    return text.length + '_' + text.substring(0, 100);
  }
  
  create_image_signature(native_image) {
    const size = native_image.getSize();
    const buffer = native_image.toPNG();
    // Use size and first few bytes as signature
    return `${size.width}x${size.height}_${buffer.length}_${buffer.slice(0, 16).toString('hex')}`;
  }
  
  get_lightweight_history() {
    return this.order.map(key => {
      const item = this.items.get(key);
      if (item.type === 'image') {
        return {
          type: 'image',
          id: item.id,
          width: item.width,
          height: item.height,
          thumbnail_path: item.thumbnail_path,
          timestamp: item.timestamp
        };
      }
      return {
        type: 'text',
        text: item.text,
        timestamp: item.timestamp
      };
    });
  }
  
  clear() {
    // Cleanup all image files
    for (const item of this.items.values()) {
      if (item.type === 'image' && item.thumbnail_path) {
        delete_thumbnail_file(item.thumbnail_path);
      }
    }
    
    this.items.clear();
    this.order = [];
    this.text_signatures.clear();
    this.image_signatures.clear();
  }
}

// Memory monitoring utilities
function log_memory_usage(label = '') {
  const usage = process.memoryUsage();
  console.log(`[memory${label ? ' ' + label : ''}]`, {
    rss: Math.round(usage.rss / 1024 / 1024) + 'MB',
    heap_used: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
    heap_total: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
    external: Math.round(usage.external / 1024 / 1024) + 'MB'
  });
}

function force_garbage_collection() {
  if (global.gc) {
    global.gc();
    console.log('[memory] Forced garbage collection');
  }
}

// Comprehensive cleanup function
function cleanup_all_resources() {
  console.log('[cleanup] Starting comprehensive cleanup...');
  
  // Stop monitoring
  stop_clipboard_monitoring();
  
  // Clear all timers
  clear_pending_paste_timers();
  
  // Clear history and associated files
  if (window.optimized_history) {
    window.optimized_history.clear();
  }
  
  // Force garbage collection if available
  force_garbage_collection();
  
  console.log('[cleanup] Cleanup completed');
}

// Export optimized functions
module.exports = {
  OptimizedClipboardHistory,
  start_clipboard_monitoring,
  stop_clipboard_monitoring,
  clear_pending_paste_timers,
  add_paste_timer,
  log_memory_usage,
  force_garbage_collection,
  cleanup_all_resources,
  MAX_TEXT_SIZE,
  MAX_THUMBNAIL_SIZE
};