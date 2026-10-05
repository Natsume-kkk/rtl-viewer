export interface PortInfo {
  name: string;
  direction?: string;
  width?: string;
}

export interface InstanceInfo {
  module: string;
  inst: string;
  line: number;
}

export interface ModuleInfo {
  name: string;
  file: string;
  line: number;
  ports: PortInfo[];
  instances: InstanceInfo[];
}

export interface DefinitionRef {
  name: string;
  line: number;
}

export interface IpInfo {
  name: string;
  file: string;
  vlnv?: string;
}
