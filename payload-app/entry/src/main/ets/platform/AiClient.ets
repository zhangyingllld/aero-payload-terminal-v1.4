import http from '@ohos.net.http';
import type { AiSummary } from '../core/aiSummary';
import { utf8Length } from '../core/capabilities';

export interface AiAnswer { text: string; model: string; elapsedMs: number; }
interface GatewayResponse { ok: boolean; text: string; model: string; elapsedMs: number; simulated: boolean; }

export async function analyzeAiSummary(summary: AiSummary, token: string): Promise<AiAnswer> {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) { throw new Error('请填写24至128位组内连接口令；不要填写模型API密钥。'); }
  const body: string = JSON.stringify(summary);
  if (utf8Length(body) > 65536) { throw new Error('本次记录太长，请减少记录后重试。'); }
  const request: http.HttpRequest = http.createHttp();
  let safeError: string = '无法连接AI助手。请检查电脑代理、USB连接和端口转发，再手动重试。';
  try {
    const response: http.HttpResponse = await request.request('http://127.0.0.1:43190/analyze', {
      method: http.RequestMethod.POST,
      header: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      extraData: body, expectDataType: http.HttpDataType.STRING,
      usingCache: false, usingProxy: false, connectTimeout: 5000, readTimeout: 55000, maxLimit: 32768
    });
    if (response.responseCode !== 200) {
      if (response.responseCode === 401) { safeError = '组内连接口令不匹配，请核对电脑代理与本机配置。'; }
      else if (response.responseCode === 429) { safeError = 'AI助手正在处理请求或请求过于频繁，请稍后手动重试。'; }
      else if (response.responseCode === 502) { safeError = '模型服务暂时不可用，请检查电脑联网、模型配置和额度后手动重试。'; }
      else { safeError = 'AI助手未接受本次记录，请核对代理版本后手动重试。'; }
      throw new Error(safeError);
    }
    safeError = 'AI返回格式不符合要求，本次结果未采用，请稍后手动重试。';
    if (typeof response.result !== 'string' || utf8Length(response.result) > 32768) { throw new Error(safeError); }
    const data: GatewayResponse = JSON.parse(response.result) as GatewayResponse;
    if (!data || data.ok !== true || data.simulated !== true || typeof data.text !== 'string' || data.text.trim().length === 0 || utf8Length(data.text) > 16384 ||
      typeof data.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.model) || typeof data.elapsedMs !== 'number' || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) {
      throw new Error(safeError);
    }
    return { text: data.text, model: data.model, elapsedMs: data.elapsedMs };
  } catch (_) {
    // Never reflect native HTTP exceptions, request headers or proxy response details into the UI/logs.
    throw new Error(safeError);
  } finally { request.destroy(); }
}
