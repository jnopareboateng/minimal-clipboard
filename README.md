
# minimal-clipboard

A minimalistic clipboard manager with cross-platform support (Windows, macOS, Linux).

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or newer recommended)
- [Git](https://git-scm.com/)

### Installation

#### 1. Clone the repository
```bash
git clone https://github.com/jnopareboateng/minimal-clipboard.git
cd minimal-clipboard
```

#### 2. Install dependencies
```bash
npm install
```

#### 3. Run the app
```bash
npm start
```

#### 4. Build for production (optional)
- **Windows**:
  ```bash
  npm run build:win
  ```
- **macOS**:
  ```bash
  npm run build:mac
  ```
- **Linux**:
  ```bash
  npm run build:linux
  ```

---

## Platform-specific Notes

### Windows
- Hotkey: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> (or <kbd>Win</kbd>+<kbd>V</kbd> on some systems)
- If auto-paste does not work, try running as administrator or check your antivirus settings.

### macOS
- Hotkey: <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
- You may need to grant Accessibility permissions for keyboard simulation (System Preferences → Security & Privacy → Accessibility).

### Linux
- Hotkey: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
- Some desktop environments may require additional clipboard or accessibility permissions.

---

## Usage

1. Start the app (`npm start`).
2. Use the global hotkey to open the clipboard overlay.
3. Click any clipboard item to paste it into the last focused application.
4. Use the "Clear" button to erase clipboard history.

### Features
- Keeps a history of your last 20 clipboard items.
- Click to paste directly into any app (auto-paste supported on most platforms).
- Overlay hides automatically after selection.

---

## Troubleshooting

- **Auto-paste not working?**
	- On Windows, try running as administrator.
	- On macOS, ensure Accessibility permissions are granted.
	- On Linux, check your desktop environment's clipboard and accessibility settings.
- **Hotkey conflict?**
	- You can change the hotkey in `src/main.js` by editing the `getHotkey()` function.
- **App not showing/hiding?**
	- Make sure no other overlay or security software is interfering.

---


## Open Source & Contributing

This project is open source and welcomes contributions from the community! Whether you want to report bugs, suggest features, or submit pull requests, your input is highly valued.

1. Fork this repository.
2. Create a new branch for your feature or bugfix.
3. Make your changes and add tests if applicable.
4. Submit a pull request with a clear description of your changes.

Please read our [CONTRIBUTING.md](CONTRIBUTING.md) (if available) for more details.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Community

We encourage you to open issues for any questions, suggestions, or problems you encounter. All contributions, big or small, are welcome!

---

*Happy coding and thank you for helping make minimal-clipboard better!*
