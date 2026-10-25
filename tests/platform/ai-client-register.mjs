import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const mocks = new URL('./ai-http-mock.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@ohos.net.http') return {url:'ai-http-mock:local',shortCircuit:true};
    if (specifier.startsWith('.') && context.parentURL) {
      for (const extension of ['.ts','.ets']) { const candidate=new URL(specifier+extension,context.parentURL); if(existsSync(fileURLToPath(candidate)))return next(candidate.href,context); }
    }
    return next(specifier,context);
  },
  load(url,context,next) {
    if(url==='ai-http-mock:local')return {format:'module',shortCircuit:true,source:`export { mockHttp as default } from ${JSON.stringify(mocks)};`};
    if(url.endsWith('.ets'))return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'))};
    return next(url,context);
  }
});
