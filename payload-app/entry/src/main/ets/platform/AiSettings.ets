import fs from '@ohos.file.fs';
import type common from '@ohos.app.ability.common';

// This is only the local USB gateway token, never the DeepSeek API credential.
export class AiSettings {
  private path: string;
  constructor(context: common.UIAbilityContext) { this.path = context.filesDir + '/ai-gateway-token.txt'; }
  load(): string {
    if (!fs.accessSync(this.path)) { return ''; }
    const text = fs.readTextSync(this.path).trim();
    return text.length <= 128 ? text : '';
  }
  save(value: string): void {
    const token = value.trim();
    if (token.length > 128 || /[\r\n]/.test(token)) { throw new Error('连接口令格式无效'); }
    const temp = this.path + '.tmp';
    const file = fs.openSync(temp, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try { if (fs.writeSync(file.fd, token) !== token.length) { throw new Error('连接口令保存不完整'); } }
    finally { fs.closeSync(file); }
    fs.renameSync(temp, this.path);
  }
}
