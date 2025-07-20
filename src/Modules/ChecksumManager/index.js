var checksum = require('checksum')

const Manager = {};

Manager.Checksum = async (filePath) => {
    return new Promise((resolve, _reject) => {
        checksum.file(filePath, function (_err, sum) {
            return resolve(sum);
        })
    })
}

module.exports = {
    Manager
};