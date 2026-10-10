export interface PortInfo {
  name: string;
  direction?: string;
  width?: string;
}

export interface ParameterInfo { name: string; defaultValue?: string }

export interface PortConnection {
  /** 命名连接的端口名；位置连接无此字段 */
  port?: string;
  /** 连接的表达式原文（去首尾空白），空连接为空串 */
  expr: string;
  line: number;
}

export interface InstanceInfo {
  module: string;
  inst: string;
  line: number;
  /** 端口连接表，仅 parseFileDetail（信号链分析）填充 */
  connections?: PortConnection[];
  /** 例化语句收尾所在行，仅 parseFileDetail 填充 */
  endLine?: number;
}

export interface ModuleInfo {
  name: string;
  file: string;
  line: number;
  ports: PortInfo[];
  parameters?: ParameterInfo[];
  instances: InstanceInfo[];
}

export interface IpInfo {
  name: string;
  file: string;
  vlnv?: string;
}
