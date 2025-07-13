const Config = require('../Config');
const colors = require('colors');
const fs = require('fs');
const path = require('path')


function Pad(Text, Length = 17) {
    return Text.padEnd(Length, " ").toUpperCase();
}

const Types = {
    Info: colors.cyan(Pad("INFO")),
    Warn: colors.magenta(Pad("WARN")),
    Gay: colors.rainbow(Pad("GAY")),
    Error: colors.red(Pad("ERROR")),
    Trace: colors.magenta(Pad("TRACE")),
    Debug: colors.grey(Pad("DEBUG")),
    Success: colors.green(Pad("SUCCESS")),
}

function Tag(Text, Type) {
	return `[${colors.cyan('ShowTrakClient')}] [${colors.cyan(Pad(Text))}] [${Types.hasOwnProperty(Type) ? Types[Type] : Types["Info"]}]`
}

class Logger {
    constructor(Alias) {
        this.Alias = Alias;
    }
    log(...args) {
        args.forEach(arg => console.log(Tag(this.Alias, "Info"), arg));
    }
    info(...args) {
        args.forEach(arg => console.log(Tag(this.Alias, "Info"), arg));
    }
    warn(...args) {
        args.forEach(arg => console.log(Tag(this.Alias, "Warn"), arg));
    }
    error(...args) {
        args.forEach(arg => console.log(Tag(this.Alias, "Error"), arg));
    }
    debug(...args) {
        if (Config.Production) return;
        args.forEach(arg => console.log(Tag(this.Alias, "Debug"), arg));
    }
    success(...args) {
        args.forEach(arg => console.log(Tag(this.Alias, "Success"), arg));
    }    
}

function CreateLogger(Alias) {
    return new Logger(Alias);
}

module.exports = {
    CreateLogger,
}