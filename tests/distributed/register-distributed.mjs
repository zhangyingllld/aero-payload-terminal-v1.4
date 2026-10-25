import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mocks = new URL('./distributed-native-doubles.mjs', import.meta.url).href;
const bindings = new Map([
  ['@ohos.distributedDeviceManager', 'deviceManager'], ['@ohos.data.distributedKVStore', 'kv'],
  ['@ohos.abilityAccessCtrl', 'access'], ['@ohos.util', 'util'], ['@ohos.hilog', 'hilog']
]);
registerHooks({
  resolve(specifier, context, next) {
    if (bindings.has(specifier)) return { url: 'distributed-double:' + specifier, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL) {
      for (const extension of ['.ts', '.ets']) {
        const candidate = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('distributed-double:')) return { format: 'module', shortCircuit: true,
      source: `export { ${bindings.get(url.slice(19))} as default } from ${JSON.stringify(mocks)};` };
    if (url.endsWith('.ets')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')) };
    return next(url, context);
  }
});
