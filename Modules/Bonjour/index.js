const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('Bonjour');

const { Bonjour } = require('bonjour-service');
const { Config } = require('../Config');

const instance = new Bonjour()
const Manager = {
    OnFind: (callback) => {
        instance.find({ type: 'ShowTrak' }, callback)
    },
    Terminate: () => {
        instance.destroy();
        console.log('Bonjour service shut down.');
    }
}

module.exports = { 
    Manager,
}