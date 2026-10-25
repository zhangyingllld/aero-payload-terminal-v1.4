// Contract-level doubles for otherwise unavailable OpenHarmony APIs. These tests are not real-board KV evidence.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export const state = { permission: 0, peers: [], requests: [], opened: [], closed: 0, dmCreated: 0, released: 0,
  records: new Map(), dm: new EventEmitter(), store: new EventEmitter(), bindCallback: null };
state.store.on = function(event, typeOrListener, optionalListener) {
  return EventEmitter.prototype.on.call(this, event, optionalListener || typeOrListener);
};
state.store.getEntries = async prefix => [...state.records].filter(([key]) => key.startsWith(prefix))
  .map(([key, value]) => ({ key, value: { type: 0, value } }));
state.store.put = async (key, value) => state.records.set(key, value);
state.store.delete = async key => state.records.delete(key);
state.store.sync = (ids, mode, delay) => state.requests.push({ ids, mode, delay });
state.dm.getLocalDeviceId = () => 'local-device-1234';
state.dm.getLocalDeviceName = () => '本机';
state.dm.getAvailableDeviceListSync = () => state.peers;
state.dm.startDiscovering = () => {};
state.dm.stopDiscovering = () => {};
state.dm.bindTarget = (_id, _options, callback) => { state.bindCallback = callback; };
export const deviceManager = {
  createDeviceManager() { state.dmCreated++; return state.dm; },
  releaseDeviceManager() { state.released++; }
};
export const kv = {
  KVStoreType: { SINGLE_VERSION: 1 }, SecurityLevel: { S1: 1 },
  SubscribeType: { SUBSCRIBE_TYPE_REMOTE: 1 }, SyncMode: { PUSH_PULL: 2 },
  createKVManager: config => ({
    async getKVStore(id, options) { state.opened.push({ config, id, options }); return state.store; },
    async closeKVStore() { state.closed++; }
  })
};
export const access = { createAtManager: () => ({ requestPermissionsFromUser: async () => ({ authResults: [state.permission] }) }) };
export const util = { generateRandomUUID: () => randomUUID() };
export const hilog = { info() {} };
export function reset() {
  state.permission = 0; state.peers = []; state.requests = []; state.opened = []; state.closed = 0;
  state.dmCreated = 0; state.released = 0; state.records.clear(); state.dm.removeAllListeners(); state.store.removeAllListeners();
  state.bindCallback = null;
}
