# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- System tray functionality for background operation
- Memory optimization features:
  - File-based thumbnail storage instead of base64
  - Text size limits to prevent memory bloat
  - Cache-based duplicate detection
  - Comprehensive timer cleanup
  - Memory monitoring and logging utilities
- Cross-platform support (macOS, Windows, Linux)
- Global hotkey support (Alt+Shift+` by default)
- Clipboard history with configurable size
- Image and text clipboard support
- Drag and drop functionality
- Position memory for overlay window

### Changed
- Application now runs in system tray instead of dock/taskbar
- Improved memory efficiency and performance
- Enhanced clipboard monitoring

### Fixed
- Memory leaks from pending timers
- Unbounded memory growth from large text items
- Performance issues with duplicate detection

## [1.0.0] - Initial Release

### Added
- Basic clipboard manager functionality
- Electron-based cross-platform application
- Text and image clipboard support