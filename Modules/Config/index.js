const Config = {};

Config.Application = {
    Version: '3.0.0',
    Name: 'My Application',
}

Config.Shared = {
    Version: Config.Application.Version,
}

module.exports = {
    Config,
}