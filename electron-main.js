const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow = null;
let serverChild = null;

function checkServer(url, timeout = 1000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

function startBackend() {
    return new Promise((resolve) => {
        try {
            console.log('[Electron] Starting background Node backend...');
            const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';
            
            try {
                serverChild = spawn(nodeExe, [path.join(__dirname, 'server.js')], {
                    cwd: __dirname,
                    env: { ...process.env, PORT: '3000' },
                    stdio: 'ignore',
                    windowsHide: true
                });
            } catch (err) {
                serverChild = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
                    cwd: __dirname,
                    env: { ...process.env, PORT: '3000', ELECTRON_RUN_AS_NODE: '1' },
                    stdio: 'ignore'
                });
            }

            if (serverChild) {
                serverChild.on('error', (err) => {
                    console.warn('[Electron] Failed to start backend process:', err);
                });
            }

            // Poll for server readiness up to 8 seconds
            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                const ready = await checkServer('http://localhost:3000/api/health', 500);
                if (ready || attempts > 16) {
                    clearInterval(interval);
                    resolve(ready);
                }
            }, 500);
        } catch (e) {
            console.warn('[Electron] Error launching backend:', e);
            resolve(false);
        }
    });
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1366,
        height: 768,
        minWidth: 1024,
        minHeight: 600,
        title: "Anudeep Khadi Bandar - GST Billing",
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#f3f4f6',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
        }
    });

    // Clean modern titlebar without default menu
    Menu.setApplicationMenu(null);

    // Maximize for convenient desktop workstation billing
    mainWindow.maximize();

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Check if server is already running
    const isRunning = await checkServer('http://localhost:3000/api/health', 1000);
    if (isRunning) {
        console.log('[Electron] Connected to existing server on port 3000');
        mainWindow.loadURL('http://localhost:3000');
    } else {
        const started = await startBackend();
        if (started) {
            console.log('[Electron] Connected to newly started backend on port 3000');
            mainWindow.loadURL('http://localhost:3000');
        } else {
            console.log('[Electron] Falling back to local index.html with Cloud GAS sync');
            mainWindow.loadFile(path.join(__dirname, 'index.html'));
        }
    }

    // Intercept external links (WhatsApp, Telegram, external documentation)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://wa.me') || url.startsWith('https://api.whatsapp.com') || url.startsWith('https://web.whatsapp.com') || url.startsWith('https://t.me')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (serverChild) {
        try {
            serverChild.kill();
        } catch (_) {}
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
