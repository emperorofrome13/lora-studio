# LoRA Studio

A local, private toolbox for people who make images with Stable Diffusion / ComfyUI and collect LoRAs.
Everything runs on your own computer; images you drop in are read in the browser and never uploaded.

| Tab | What it does |
|---|---|
| **My LoRAs** | Browse folders of `.safetensors` LoRAs: title, trigger words, base model, Civitai match and preview. Saved folders are re-checked for new files on every start. |
| **Civitai** | Browse civitai.com images, filter for ones with real ComfyUI workflows, search models, save favourites, block uploaders. |
| **Prompt** | Drop or paste an image to read its prompt, negative prompt, LoRAs and settings (A1111, ComfyUI, EXIF, XMP). |
| **Grid** | Contact sheet of your images grouped by generation settings, the LoRA strength grid (grid / flip / side-by-side / wipe), and **picks**: click ♥ on the images you like to see them together as one tight cube grid, then ★ the best ones as finalists. Export the cube as a PNG or copy the files to a folder. |
| **Strip** | Save copies of images with **all** metadata removed (prompts, workflows, EXIF, XMP, IPTC, hidden data) without re-compressing. Every saved file is read back from disk and checked, and a **Double-check** panel audits any image you drop on it. |
| **Workflow** | Drop a pile of images and see which ones carry a ComfyUI workflow. Preview the node graph (pan, zoom, search, click a node for its values) and download the workflow `.json`. |
| **Tester** | Runs the bundled **LoRA Tester**: imports LoRAs, runs each through a strength matrix on your ComfyUI models, labels every image, and sends finished runs straight to the Grid's strength grid. |

## Requirements

- **Windows 10/11, macOS or Linux** with a desktop.
- **Node.js 20 or newer** — https://nodejs.org. No `npm install` needed: it uses Node's built-in modules only.
- For the **Tester** tab only: **Python 3.10+** (https://www.python.org; on Windows tick *Add python.exe to PATH*) and **ComfyUI** running locally (usually `http://127.0.0.1:8188`).
- Linux only, for the folder window: `zenity` (GNOME and most desktops) or `kdialog` (KDE). Without either, the app opens its own built-in folder browser instead.

## Start

1. Download or clone this folder.
2. Start it:
   - **Windows:** double-click **`quickstart.bat`**.
   - **macOS / Linux:** open a terminal in this folder and run `sh start.sh`.
3. It starts the server in the background and opens http://127.0.0.1:4400 (or the next free port) in Google Chrome, or in your default browser when Chrome is not installed.
4. To stop it: **`stop.bat`** on Windows, `sh stop.sh` on macOS / Linux.

Command line alternative on any system: `npm start`, then open http://127.0.0.1:4400.

## Choosing folders

You never have to type a path. **📁 Choose LoRA folder…** (My LoRAs), **📁 Browse…** (Strip, Grid, Tester) open your system's own folder window — Explorer on Windows, Finder on macOS, zenity/kdialog on Linux — and the chosen folder is filled in for you. Typing or pasting a path still works too.

The first time you press **Start LoRA Tester**, the app creates a private Python environment in `tester/.venv` and installs Flask and Pillow (about a minute). After that it starts in seconds. LoRA Tester keeps running when LoRA Studio stops, so a long test is not interrupted; stop it from the Tester tab.

### Civitai API key (optional)

The Civitai tab works without an account. To use your own account's permissions (for example mature content on civitai.red), create a key at civitai.com → *Account settings* → *API Keys*, then paste it into **CIVITAI API KEY** in the Civitai tab's sidebar and press **Save**. The app checks it with Civitai once, then keeps it only on your computer in `data/settings.json` (git-ignored). It is never shown again and never sent anywhere except civitai.com. **Remove saved key** deletes it.

Advanced: a `CIVITAI_TOKEN` environment variable, if set, is used instead of the saved key.

## Keys

`1`–`7` switch tabs. Grid: `F` expanded view, arrows step through images; in the image viewer `P` picks and `S` marks a finalist. Civitai: `Ctrl+K` search. Workflow: `0` fits the graph.

## Privacy and safety

- The server listens on `127.0.0.1` only and refuses requests whose Host header is not local.
- Images dropped into Prompt, Grid, Strip and Workflow are read inside your browser. Nothing is uploaded.
- Your LoRA files are only read, never modified. Saving (Strip, Grid "Copy files") never overwrites: an existing name gets " (1)" added.
- Your settings live in `data/` and `tester/data/`, which are not part of the repository (see `.gitignore`).

## Tests

```
npm test
```

LoRA Tester's own tests (after its first start created `tester/.venv`):

```
cd tester
.venv\Scripts\python.exe -m unittest discover -s tests
```

## License

MIT — see [LICENSE](LICENSE). LoRA Studio is not affiliated with Civitai or ComfyUI.

## Layout

```
server.mjs          HTTP server: static files and the /api routes
lib/                LoRA library, Civitai proxy, safe file saving, LoRA Tester manager
public/             the web app (one module per tab in public/js)
tester/             LoRA Tester (Python + Flask), started on demand from the Tester tab
tests/              node --test suites
launch.mjs/stop.mjs used by quickstart.bat / stop.bat (Windows) and start.sh / stop.sh (macOS, Linux)
```
