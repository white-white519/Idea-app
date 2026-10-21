const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 800,
        transparent: true, frame: false, alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: true, // Позволяет использовать require в renderer.js
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    win.loadFile('index.html');
    
    // ВСЕГДА ОТКРЫВАЕМ КОНСОЛЬ ДЛЯ ПОИСКА ОШИБОК
    win.webContents.openDevTools();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
