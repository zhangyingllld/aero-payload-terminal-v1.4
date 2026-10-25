import type { ActionSpec, Capability, MetricSpec, Option, Role, Value } from './models';
import { emptyCapability } from './models';

export function utf8Length(text: string): number {
  let length: number = 0;
  for (let i: number = 0; i < text.length; i++) {
    const code: number = text.charCodeAt(i);
    if (code < 128) length += 1;
    else if (code < 2048) length += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) { length += 4; i++; }
    else length += 3;
  }
  return length;
}
function metric(id: string, label: string, valueType: string, unit: string, display: string, validForMs: number): MetricSpec { return { id: id, label: label, valueType: valueType, unit: unit, display: display, validForMs: validForMs }; }
function action(id: string, label: string, control: string, valueType: string, boundMetricId: string, min: number, max: number, step: number, options: Option[]): ActionSpec { return { id: id, label: label, control: control, valueType: valueType, boundMetricId: boundMetricId, min: min, max: max, step: step, options: options }; }

export function capabilityForRole(role: Role, nodeId: string): Capability {
  const cap: Capability = emptyCapability(nodeId);
  cap.revision = 1;
  if (role === 'camera') {
    cap.name = '图像采集载荷'; cap.payloadType = 'camera';
    cap.metrics = [metric('mode', '工作模式', 'string', '', 'text', 10000), metric('captureCount', '抓拍计数', 'number', '次', 'number', 10000), metric('imageId', '最近模拟图像', 'string', '', 'image', 10000)];
    cap.actions = [action('capture', '模拟抓拍', 'button', 'boolean', '', 0, 0, 1, [{ label: '抓拍', value: true }]), action('set_mode', '工作模式', 'select', 'string', 'mode', 0, 0, 1, [{ label: '单次', value: 'single' }, { label: '连续', value: 'continuous' }])];
  } else if (role === 'environment') {
    cap.name = '环境监测载荷'; cap.payloadType = 'environment';
    cap.metrics = [metric('temperature', '温度', 'number', '℃', 'line', 15000), metric('humidity', '湿度', 'number', '%', 'number', 15000), metric('interval', '采样间隔', 'number', '秒', 'number', 10000)];
    cap.actions = [action('set_interval', '采样间隔', 'select', 'number', 'interval', 1, 5, 1, [{ label: '1秒', value: 1 }, { label: '2秒', value: 2 }, { label: '5秒', value: 5 }])];
  } else if (role === 'light') {
    cap.name = '照明载荷'; cap.payloadType = 'lighting';
    cap.metrics = [metric('power', '电源', 'boolean', '', 'status', 10000), metric('brightness', '亮度', 'number', '%', 'number', 10000)];
    cap.actions = [action('set_power', '电源开关', 'switch', 'boolean', 'power', 0, 1, 1, []), action('set_brightness', '设置亮度', 'slider', 'number', 'brightness', 0, 100, 1, [])];
  }
  return cap;
}
function textField(value: string, max: number, empty: boolean): boolean { return typeof value === 'string' && value.length <= max && (empty || value.length > 0); }
function idField(value: string): boolean { return textField(value, 64, false) && /^[A-Za-z0-9_-]+$/.test(value); }
export function isValue(value: Value): boolean { return typeof value === 'boolean' || (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isFinite(value)); }
function fail(path: string): void { throw new Error('INVALID_DESCRIPTOR: ' + path); }

export function validateCapability(value: Capability, expectedDeviceId: string): Capability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object');
  if (utf8Length(JSON.stringify(value)) > 16384) fail('descriptor exceeds 16KiB');
  if (value.descriptorVersion !== '1.0') fail('descriptorVersion');
  if (!Number.isInteger(value.revision) || value.revision < 0) fail('revision');
  if (!idField(value.deviceId) || value.deviceId !== expectedDeviceId) fail('deviceId');
  if (!textField(value.name, 80, false) || !textField(value.payloadType, 40, false) || typeof value.simulated !== 'boolean') fail('identity');
  if (!Array.isArray(value.metrics) || value.metrics.length < 1 || value.metrics.length > 32 || !Array.isArray(value.actions) || value.actions.length > 32) fail('metrics/actions');
  const metricIds: Set<string> = new Set<string>();
  for (const m of value.metrics) {
    if (!m || !idField(m.id) || metricIds.has(m.id)) fail('metrics.id');
    metricIds.add(m.id);
    if (!textField(m.label, 80, false) || !textField(m.unit, 20, true) || ['number', 'boolean', 'string'].indexOf(m.valueType) < 0 || ['number', 'status', 'line', 'text', 'image'].indexOf(m.display) < 0) fail('metrics.' + m.id);
    if (!Number.isInteger(m.validForMs) || m.validForMs < 1 || m.validForMs > 60000) fail('metrics.validForMs');
    if ((m.display === 'number' || m.display === 'line') && m.valueType !== 'number') fail('metrics.display/type');
    if (m.display === 'image' && m.valueType !== 'string') fail('metrics.image/type');
  }
  const actionIds: Set<string> = new Set<string>();
  for (const a of value.actions) {
    if (!a || !idField(a.id) || actionIds.has(a.id)) fail('actions.id');
    actionIds.add(a.id);
    if (!textField(a.label, 80, false) || ['button', 'switch', 'select', 'slider'].indexOf(a.control) < 0 || ['number', 'boolean', 'string'].indexOf(a.valueType) < 0 || !textField(a.boundMetricId, 64, true)) fail('actions.' + a.id);
    if (!Array.isArray(a.options) || a.options.length > 32 || !Number.isFinite(a.min) || !Number.isFinite(a.max) || !Number.isFinite(a.step) || a.step <= 0 || a.max < a.min) fail('actions.constraints');
    if (a.control !== 'button') {
      const bound: MetricSpec | undefined = value.metrics.find((m: MetricSpec): boolean => m.id === a.boundMetricId);
      if (!bound || bound.valueType !== a.valueType) fail('actions.boundMetricId');
    }
    if (a.control === 'switch' && a.valueType !== 'boolean') fail('actions.switch');
    if (a.control === 'slider' && (a.valueType !== 'number' || a.max <= a.min)) fail('actions.slider');
    if (a.control === 'select' && a.options.length === 0) fail('actions.select');
    const optionValues: Set<string> = new Set<string>();
    for (const o of a.options) {
      if (!o || !textField(o.label, 80, false) || !isValue(o.value) || typeof o.value !== a.valueType) fail('actions.options');
      const key: string = JSON.stringify(o.value);
      if (optionValues.has(key)) fail('actions.options.duplicate');
      optionValues.add(key);
    }
  }
  return JSON.parse(JSON.stringify(value)) as Capability;
}
export function validateActionValue(action: ActionSpec, value: Value): boolean {
  if (!isValue(value) || typeof value !== action.valueType) return false;
  if (action.control === 'slider') {
    const n: number = value as number;
    if (n < action.min || n > action.max) return false;
    const steps: number = (n - action.min) / action.step;
    if (Math.abs(steps - Math.round(steps)) > 0.000001) return false;
  }
  if (action.control === 'select' || action.options.length > 0) return action.options.some((o: Option): boolean => o.value === value);
  return true;
}
