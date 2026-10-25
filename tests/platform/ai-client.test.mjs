import test from 'node:test';
import assert from 'node:assert/strict';
import { state,reset } from './ai-http-mock.mjs';
import { analyzeAiSummary } from '../../payload-app/entry/src/main/ets/platform/AiClient.ets';
import { buildAiSummary } from '../../payload-app/entry/src/main/ets/core/aiSummary.ts';
import { initialView } from '../../payload-app/entry/src/main/ets/core/models.ts';
const summary=()=>buildAiSummary(initialView());
test('AI client only calls fixed loopback endpoint once and destroys native request',async()=>{
 reset();const result=await analyzeAiSummary(summary(),'a'.repeat(32));
 assert.equal(result.model,'deepseek-flash');assert.equal(state.calls.length,1);assert.equal(state.destroyed,1);
 assert.equal(state.calls[0].url,'http://127.0.0.1:43190/analyze');assert.equal(state.calls[0].options.usingProxy,false);
 assert.equal(state.calls[0].options.readTimeout,55000);assert.equal(state.calls[0].options.maxLimit,32768);
});
test('AI client refuses malformed group token before making request',async()=>{
 reset();await assert.rejects(analyzeAiSummary(summary(),'short'),/连接口令/);assert.equal(state.calls.length,0);
});
test('AI client shows token failure without reflecting response text or key',async()=>{
 reset();state.response={responseCode:401,result:'private-secret'};
 await assert.rejects(analyzeAiSummary(summary(),'a'.repeat(32)),error=>error.message.includes('口令')&&!error.message.includes('private-secret'));
 assert.equal(state.calls.length,1);assert.equal(state.destroyed,1);
});
test('AI client sanitizes transport exceptions and does not auto retry',async()=>{
 reset();state.error=new Error('Bearer private-secret');
 await assert.rejects(analyzeAiSummary(summary(),'a'.repeat(32)),error=>!error.message.includes('private-secret'));
 assert.equal(state.calls.length,1);assert.equal(state.destroyed,1);
});
test('AI client rejects invalid success and oversized model output',async()=>{
 for(const text of ['', 'x'.repeat(17000)]){reset();state.response.result=JSON.stringify({ok:true,text,model:'deepseek-flash',elapsedMs:1,simulated:true});await assert.rejects(analyzeAiSummary(summary(),'a'.repeat(32)),/格式/);}
});
