const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ScriptManager');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: ChecksumManager } = require('../ChecksumManager');

const fs = require('fs');
const path = require('path');

let ScriptCache = [];

const Manager = {};

const Internal = {};

Internal.RunBatchFile = async (Path) => {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(`"${Path}"`, (error, stdout, stderr) => {
            if (error) {
                Logger.error(`Error executing batch file: ${error.message}`);
                return reject(error);
            }
            if (stderr) {
                Logger.error(`Batch file stderr: ${stderr}`);
                return reject(new Error(stderr));
            }
            Logger.success(`Batch file executed successfully: ${stdout}`);
            resolve(stdout);
        });
    });
}

Manager.SetScripts = async (Scripts) => {
    ScriptCache = Scripts || [];
}

Manager.Execute = async (_RequestID, ScriptID) => {
    let Script = ScriptCache.find(s => s.ID === ScriptID);
    if (!Script) return ['Script not found', false];
    Logger.log(`Executing script: ${Script.Name} (${Script.ID})`);
    try {
        const ScriptPath = path.join(AppDataManager.GetScriptsDirectory(), Script.ID)
        if (!fs.existsSync(ScriptPath)) {
            Logger.error(`Script path does not exist: ${ScriptPath}`);
            return ['Script path does not exist', false];
        }
        let Result = await Internal.RunBatchFile(path.join(ScriptPath, Script.Path))
        Logger.success(`Script ${Script.Name} executed successfully`);
        return [null, true];
    } catch (error) {
        Logger.error(`Error executing script ${Script.Name}`, error);
        return ['An error occured during script execution', false];
    }

}

Manager.DeleteScripts = async () => {
    ScriptCache = [];
    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    if (fs.existsSync(ScriptsDirectory)) {
        fs.rmSync(ScriptsDirectory, { recursive: true, force: true });
        Logger.success(`Deleted all scripts from ${ScriptsDirectory}`);
    }
    fs.mkdirSync(ScriptsDirectory, { recursive: true });
    return;
}

Manager.DownloadScripts = async (IP, Port, Scripts) => {
    ScriptCache = Scripts || [];

    Logger.log(`Updating scripts from server ${IP}:${Port}`);

    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();

    for (const Script of Scripts) {        
        const ScriptPath = path.join(ScriptsDirectory, Script.ID);
        Logger.log(`Downloading SCRIPT: ${Script.ID}`);

        if (!fs.existsSync(ScriptPath)) {
            fs.mkdirSync(ScriptPath, { recursive: true });
        }

        for (const File of Script.Files) {
            let { Path, Type } = File;

            const FilePath = path.join(ScriptPath, Path);

            if (Type === 'directory') {
                fs.mkdirSync(FilePath, { recursive: true });
                Logger.success(`Created Folder ${FilePath}`);
            } else {
                const { Checksum } = File;
                let ShouldDownload = true;
                if (fs.existsSync(FilePath)) {
                    let OldChecksum = await ChecksumManager.Checksum(FilePath);
                    if (OldChecksum === Checksum) {
                        ShouldDownload = false;
                        Logger.success(`Checksum for file ${FilePath} matches, skipping`);
                    } else {
                        Logger.warn(`Checksum for file ${FilePath} does not match, downloading`);
                    }
                } else {
                    Logger.success(`File does not exist: ${Path}, downloading`);
                }
                if (ShouldDownload) {
                    const fileUrl = `http://${IP}:${Port}/${Script.ID}/${Path.replaceAll('\\', '/')}`;
                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        Logger.error(`Failed to download ${Path} from ${fileUrl}: ${response.statusText}`);
                        continue;
                    }
                    Logger.success(`Downloaded ${FilePath}`);
                    const buffer = await response.arrayBuffer();
                    fs.writeFileSync(FilePath, Buffer.from(buffer));
                }
            }
        }

        Logger.success(`Downloaded script ${Script.ID}`);

    }
}

module.exports = {
    Manager,
}