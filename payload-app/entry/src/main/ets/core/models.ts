export type Value = string | number | boolean;
export type Role = 'controller' | 'observer' | 'camera' | 'environment' | 'light';
export type LinkState = 'DISCONNECTED' | 'CONNECTING' | 'NEGOTIATING' | 'READY' | 'STALE' | 'OFFLINE' | 'INCOMPATIBLE';
export interface AppConfig { role: Role; nodeId: string; listenPort: number; controllerHost: string; controllerPort: number; cameraHost: string; cameraPort: number; environmentHost: string; environmentPort: number; lightHost: string; lightPort: number; }
export interface MetricSpec { id: string; label: string; valueType: string; unit: string; display: string; validForMs: number; }
export interface Option { label: string; value: Value; }
export interface ActionSpec { id: string; label: string; control: string; valueType: string; boundMetricId: string; min: number; max: number; step: number; options: Option[]; }
export interface Capability { descriptorVersion: string; revision: number; deviceId: string; name: string; payloadType: string; simulated: boolean; metrics: MetricSpec[]; actions: ActionSpec[]; }
export interface Reading { id: string; value: Value; ageMs: number; }
export interface CommandRecord { requestId: string; deviceId: string; actionId: string; status: string; detail: string; value: Value; time: string; }
export interface EventRecord { id: string; time: string; deviceId: string; kind: string; detail: string; requestId: string; }
export interface PayloadView { deviceId: string; name: string; linkState: string; capability: Capability; readings: Reading[]; lastCommand: CommandRecord; stateRevision: number; bootId: string; trend: number[]; }
export interface AppView { config: AppConfig; running: boolean; status: string; mainLinkState: string; payloads: PayloadView[]; events: EventRecord[]; local: PayloadView; paused: boolean; fault: string; error: string; }

export function defaultConfig(role: Role): AppConfig {
  let nodeId: string = 'TERM-01';
  if (role === 'observer') nodeId = 'VIEW-01';
  if (role === 'camera') nodeId = 'CAM-01';
  if (role === 'environment') nodeId = 'ENV-01';
  if (role === 'light') nodeId = 'LIGHT-01';
  return { role: role, nodeId: nodeId, listenPort: role === 'controller' ? 43181 : 43180, controllerHost: '192.168.50.11', controllerPort: 43181, cameraHost: '192.168.50.13', cameraPort: 43180, environmentHost: '192.168.50.14', environmentPort: 43180, lightHost: '192.168.50.15', lightPort: 43180 };
}
export function emptyCommand(): CommandRecord { return { requestId: '', deviceId: '', actionId: '', status: '', detail: '', value: '', time: '' }; }
export function emptyCapability(deviceId: string): Capability { return { descriptorVersion: '1.0', revision: 0, deviceId: deviceId, name: deviceId, payloadType: '', simulated: true, metrics: [], actions: [] }; }
export function emptyPayload(deviceId: string): PayloadView { return { deviceId: deviceId, name: deviceId, linkState: 'DISCONNECTED', capability: emptyCapability(deviceId), readings: [], lastCommand: emptyCommand(), stateRevision: 0, bootId: '', trend: [] }; }
export function initialView(): AppView { return { config: defaultConfig('controller'), running: false, status: '请选择角色并启动', mainLinkState: 'DISCONNECTED', payloads: [], events: [], local: emptyPayload(''), paused: false, fault: 'none', error: '' }; }
