import { createPlugin, type SignalKApp } from './plugin';

// signalk-server loads plugins with require(): export the factory as module.exports.
export = (app: SignalKApp) => createPlugin(app);
