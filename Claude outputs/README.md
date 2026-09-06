# ANGEL — desktop assistant overlay

An always-on-top, frameless assistant that floats over whatever you're doing. Ask by
typing, by voice, or by showing it your screen. Answers stream in from **Google Gemini**
using your own API key.

Everything runs locally: audio, screenshots and text go straight from this app to
Google's API. There is no server in between and nothing is logged anywhere else.

---

## 1. Get a Gemini API key

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account → **Create API key**
3. Copy the key (it starts with `AIza…`)

The free tier is enough for normal daily use. Nobody can hand you a working key —
they're tied to a Google account and billing project, so this one has to be yours.

## 2. Install and run

```bash
npm install
npm start
```

Requires Node.js 18+. The first `npm install` downloads Electron (~100 MB), so give it
a minute.

On first launch the settings panel opens. Paste your key, hit **Save key**, and you're
running. The key is encrypted with your OS keystore (Windows DPAPI / macOS Keychain /
libsecret on Linux) and stored in the app's user-data folder — never in this project
directory, so it can't be committed by accident.

Prefer an environment variable? Set `GEMINI_API_KEY` and it takes precedence:

```powershell
$env:GEMINI_API_KEY = "AIza..."   # PowerShell
npm start
```

## 3. Package a standalone app

```bash
npm run build:win     # NSIS installer in dist/
npm run build:mac
npm run build:linux
```

---

## What it does

| Feature | Notes |
|---|---|
| **Streaming answers** | Token-by-token via `streamGenerateContent`, with a stop button mid-answer |
| **Push to talk** | 16 kHz mono WAV captured in-app, transcribed by Gemini, then answered |
| **Screen vision** | Grabs the display the overlay sits on, hides itself first, sends it as an image part |
| **Model picker** | Switch between Flash / Flash Lite / Pro without restarting |
| **Conversation memory** | Rolling window (2–60 messages), tunable in settings |
| **Custom persona** | Editable system prompt applied to every turn |
| **Markdown + code** | Headings, lists, links, fenced code blocks with copy buttons |
| **Encrypted key storage** | OS keystore via Electron `safeStorage`, with a clear fallback warning |
| **Global hotkeys** | Work even when the app isn't focused |
| **Click-through mode** | Mouse passes through to the window underneath |
| **Tray + window state** | Lives in the tray, remembers size, position and opacity |
| **Export** | Save any conversation as Markdown |

## Hotkeys

| Action | Keys |
|---|---|
| Show / hide overlay | `Ctrl+Shift+Space` |
| Push to talk | `Ctrl+Shift+A` |
| Ask about my screen | `Ctrl+Shift+S` |
| Toggle click-through | `Ctrl+Shift+X` |

Click-through makes clicks pass straight through the window, so the hotkey is the only
way to switch it back off.

## Files

```
main.js       Electron main process — windows, tray, hotkeys, key storage, all Gemini calls
preload.js    The only renderer↔main bridge; enumerates exactly what the UI may do
renderer.js   UI, microphone capture, WAV encoding, markdown rendering, conversation state
index.html    Layout and styling
```

## Design notes

- **The API key never enters the renderer.** Every network call happens in the main
  process; the UI only sees text coming back. The preload bridge whitelists a fixed set
  of channels, `contextIsolation` is on and `nodeIntegration` is off.
- **A strict CSP** on the page blocks remote scripts and remote images entirely.
- **Model output is escaped before markdown rendering**, so a response can't inject HTML.
- **The window is deliberately visible** in the taskbar, in alt-tab and in screen shares.
  Content protection is not enabled — if you're on a call, people can see it, which is
  the point.

## Troubleshooting

**"Microphone unavailable"** — Windows Settings → Privacy & security → Microphone →
allow desktop apps. On macOS, System Settings → Privacy & Security → Microphone.

**Screenshot is blank on macOS** — grant Screen Recording permission and restart the app.

**A hotkey does nothing** — another app has claimed it. The console prints
`hotkey already taken`; change the accelerator in `registerShortcuts()` in `main.js`.

**"Model not found"** — that model isn't available on your key's tier. Pick another in
settings; `gemini-3.5-flash-lite` is the safest fallback.

## License

MIT.
