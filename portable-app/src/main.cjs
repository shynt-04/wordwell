const { app, BrowserWindow, Menu, dialog, shell, Tray } = require('electron');
const { mkdirSync, accessSync, constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { portablePaths, isApplicationUrl, isReferenceUrl, shouldHideToTray } = require('./paths.cjs');

app.setName('Wordwell');
// An explicit local test flag keeps automated packaged-runtime checks invisible.
// It does not expose any renderer API or enable debugging during normal launches.
const smokeTest = process.argv.includes('--wordwell-smoke-test');
const paths = portablePaths({ packaged: app.isPackaged, executable: process.execPath, sourceDirectory: __dirname, portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR });
let window;
let server;
let shutdown = false;
let startupError;
let tray = null, keepRunningTray = false, quitting = false;
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'wordwell.ico') : path.resolve(__dirname, '../build/wordwell.ico');
function showWindow() { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function updateBackground(preferences) {
  keepRunningTray = preferences.keepRunningTray === true;
  if (keepRunningTray && !tray) {
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Wordwell is running. Your computer must stay awake for Telegram.');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Wordwell', click: showWindow }, { type: 'separator' }, { label: 'Quit Wordwell', click: () => { quitting = true; app.quit(); } }]));
      tray.on('double-click', showWindow);
    } catch { tray = null; keepRunningTray = false; if (!smokeTest) dialog.showErrorBox('Tray mode is unavailable', 'Closing the window will stop Wordwell. Keep the window open for Telegram, or restart the app and try again.'); }
  } else if (!keepRunningTray && tray) { tray.destroy(); tray = null; if (window && !window.isVisible() && !smokeTest) showWindow(); }
}

try {
  mkdirSync(paths.browser, { recursive: true });
  accessSync(paths.data, constants.W_OK);
  app.setPath('userData', paths.browser);
  app.setPath('sessionData', paths.browser);
  app.setAppLogsPath(path.join(paths.data, 'logs'));
} catch {
  startupError = 'Wordwell needs write access beside the application. Move it to a writable folder (for example Documents or a USB drive), then try again. No personal data has been moved.';
}

if (!startupError && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    quitting = true;
    if (!server || shutdown || BrowserWindow.getAllWindows().length) return;
    event.preventDefault();
    shutdown = true;
    const timer = setTimeout(() => { server.closeAllConnections(); }, 1500);
    timer.unref();
    server.close(() => { clearTimeout(timer); app.quit(); });
    server.closeIdleConnections();
  });

  app.whenReady().then(async () => {
    if (startupError) throw new Error(startupError);
    const source = app.isPackaged ? path.join(process.resourcesPath, 'vocab-app') : path.resolve(__dirname, '../../vocab-app');
    const { createAppServer, loadConfig } = await import(pathToFileURL(path.join(source, 'server.mjs')).href);
    const { createDatabase } = await import(pathToFileURL(path.join(source, 'database.mjs')).href);
    // Ignore shell credentials and PORT. Only an optional .env beside this app
    // configures the portable copy; keys from the website are never inherited.
    const config = await loadConfig(paths.config, {});
    server = createAppServer({ ...config, database: createDatabase(paths.database), settingsPath: paths.settings, desktop: true, onTelegramSettings: updateBackground });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      title: 'Wordwell', width: 1280, height: 860, minWidth: 760, minHeight: 600,
      backgroundColor: '#f3f5fb', autoHideMenuBar: true, show: false,
      icon: iconPath,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: true, devTools: !app.isPackaged }
    });
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    // The UI needs only its packaged scripts/styles, inline SVG icons and
    // prepared local images. All provider traffic is handled by the server.
    session.webRequest.onHeadersReceived((details, callback) => {
      if (!details.url.startsWith(`${origin}/`)) return callback({});
      callback({ responseHeaders: { ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'"],
        'Referrer-Policy': ['no-referrer']
      } });
    });
    const openReference = value => { if (isReferenceUrl(value)) void shell.openExternal(value).catch(() => {}); };
    window.webContents.setWindowOpenHandler(({ url }) => { openReference(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!isApplicationUrl(url, origin)) { event.preventDefault(); openReference(url); } });
    window.webContents.on('will-redirect', (event, url) => { if (!isApplicationUrl(url, origin)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-prevent-unload', event => {
      const leave = dialog.showMessageBoxSync(window, { type: 'question', title: 'Leave Wordwell?', message: 'You have unfinished work.', detail: 'Unsaved passage material or pending edits may be lost. Cancel to finish or save your work first.', buttons: ['Keep working', 'Close Wordwell'], defaultId: 0, cancelId: 0, noLink: true });
      if (leave === 1) event.preventDefault(); else quitting = false;
    });
    window.webContents.on('render-process-gone', () => {
      dialog.showErrorBox('Wordwell stopped displaying', 'Close and reopen Wordwell. Saved learning data remains in the data folder beside the application.');
    });
    window.on('close', event => { if (shouldHideToTray({ keepRunningTray, quitting, hasTray: Boolean(tray) })) { event.preventDefault(); window.hide(); if (smokeTest) console.log('Wordwell smoke check: window hidden in tray'); } });
    window.on('closed', () => { window = null; tray?.destroy(); tray = null; });
    await window.loadURL(`${origin}/`);
    updateBackground((await server.telegramReady).state());
    if (!smokeTest) window.show();
  }).catch(error => {
    // Do not expose provider credentials or full filesystem details in dialogs.
    if (!smokeTest) dialog.showErrorBox('Could not start Wordwell', startupError || 'The portable app could not start. Check write access to its folder, back up data if it exists, and try again. Your existing website data has not been changed.');
    console.error(`Wordwell startup failed: ${error.code || error.name || 'Error'}`);
    if (server) { server.closeAllConnections(); server.close(); }
    app.exit(1);
  });
}
