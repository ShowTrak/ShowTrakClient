// const { CreateLogger } = require('../Logger');
// const Logger = CreateLogger('Bonjour');

const { Bonjour } = require('bonjour-service');
// const { Config } = require('../Config');

var instance = null;
const Manager = {
    OnFind: (callback) => {
        instance = new Bonjour()
        instance.find({ type: 'ShowTrak' }, callback)
    },
    Terminate: async () => {
        if (!instance) return;
        instance.destroy();
        instance = null;
        console.log('Bonjour service shut down.');
    }
}

module.exports = { 
    Manager,
}