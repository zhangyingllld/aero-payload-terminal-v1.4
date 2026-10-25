import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mocks = new URL('./ohos-mocks.mjs', import.meta.url).href;
const exports = new Map([
  ['@ohos.net.socket', 'mockSocket'], ['@ohos.util', 'mockUtil'],
  ['@ohos.file.fs', 'mockFs'], ['@ohos.systemDateTime', 'mockTime'], ['@ohos.hilog', 'mockLog']
]);
registerHooks({
  resolve(specifier, context, next) {
    if (exports.has(specifier)) return { url: 'ohos-mock:' + specifier, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL) {
      for (const extension of ['.ts', '.ets']) {
        const candidate = new URL(specifier + extension, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('ohos-mock:')) {
      return { format: 'module', shortCircuit: true,
        source: `export { ${exports.get(url.slice(10))} as default } from ${JSON.stringify(mocks)};` };
    }
    if (url.endsWith('.ets')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')) };
    return next(url, context);
  }
});
