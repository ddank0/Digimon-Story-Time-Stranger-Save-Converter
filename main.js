const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const saveFormat = require('./lib/save-format');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    title: "DSTS Save Converter",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true,
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-zip', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('convert', async (event, args) => {
  const { inputFolder, outputFolder, templateZip, direction } = args;

  if (!fs.existsSync(inputFolder)) return { success: false, error: 'Input folder does not exist.' };
  if (!fs.existsSync(outputFolder)) return { success: false, error: 'Output folder does not exist.' };
  if (direction === 'pc-to-switch' && (!templateZip || !fs.existsSync(templateZip))) {
    return { success: false, error: 'Original Switch Backup ZIP is required.' };
  }

  try {
    const files = fs.readdirSync(inputFolder);
    const mainFiles = files.filter(f => /^\d{4}\.bin$/.test(f));
    const slotFiles = files.filter(f => /^slot_\d{4}\.bin$/.test(f));

    if (mainFiles.length === 0 && slotFiles.length === 0) {
      return { success: false, error: 'Could not find any .bin or slot_.bin files in the input folder.' };
    }

    let processedCount = 0;
    let zip = null;
    let zipEntries = [];
    if (direction === 'pc-to-switch') {
      zip = new AdmZip(templateZip);
      zipEntries = zip.getEntries();
    }

    const putInZip = (file, data) => {
      const entry = zipEntries.find(e => e.entryName.endsWith(`/${file}`) || e.entryName === file);
      if (entry) zip.updateFile(entry.entryName, data);
      else zip.addFile(`savedata/${file}`, data);
    };

    for (const file of mainFiles) {
      const inputMain = fs.readFileSync(path.join(inputFolder, file));
      try {
        if (direction === 'switch-to-pc') {
          const outputMain = saveFormat.switchToPc(inputMain);
          fs.writeFileSync(path.join(outputFolder, file), outputMain);
        } else if (direction === 'pc-to-switch') {
          putInZip(file, saveFormat.pcToSwitch(inputMain));
        }
      } catch (err) {
        throw new Error(`${file}: ${err.message}`);
      }
      processedCount++;
    }

    for (const file of slotFiles) {
      if (direction === 'switch-to-pc') {
        fs.copyFileSync(path.join(inputFolder, file), path.join(outputFolder, file));
      } else if (direction === 'pc-to-switch') {
        putInZip(file, fs.readFileSync(path.join(inputFolder, file)));
      }
      processedCount++;
    }

    let message = '';
    if (direction === 'pc-to-switch') {
      const outputZipPath = path.join(outputFolder, 'DSTS_Switch_Converted.zip');
      zip.writeZip(outputZipPath);
      message = `Successfully generated JKSV ZIP: DSTS_Switch_Converted.zip! Transfer this file to your JKSV backups folder on your SD card.`;
    }

    return { success: true, processed: processedCount, message };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});
