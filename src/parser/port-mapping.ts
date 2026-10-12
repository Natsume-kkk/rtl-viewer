import { analyzeExpression } from "./procedural";

export interface MappingAccess { reads:string[]; targets:string[]; addresses:string[]; writable:boolean }

/** 范围与拼接只确认基对象读写，不声称位宽或逐位绑定。 */
export function mappingAccess(text:string,vhdl:boolean):MappingAccess {
  const expression=analyzeExpression(text,vhdl);
  const reads=[...new Set([...expression.reads,...expression.blockedReads])];
  const targets:string[]=[],addresses:string[]=[];
  function lvalue(raw:string):boolean {
    const s=raw.trim();
    if(!vhdl&&s.startsWith("{")&&s.endsWith("}")) {
      let depth=0,from=1;const entries:string[]=[];
      for(let i=1;i<s.length-1;i++){if(/[([{]/.test(s[i]))depth++;if(/[)\]}]/.test(s[i]))depth--;if(s[i]===","&&!depth){entries.push(s.slice(from,i));from=i+1;}}
      entries.push(s.slice(from,-1));return entries.length>0&&entries.every(lvalue);
    }
    const match=vhdl?/^([A-Za-z_]\w*)\s*(?:\(([^()]*)\))?$/.exec(s):/^([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)$/.exec(s);
    if(!match)return false;
    targets.push(match[1]);
    if(match[2]){const e=analyzeExpression(match[2],vhdl);addresses.push(...e.reads,...e.blockedReads);}
    return true;
  }
  const writable=lvalue(text);
  return{reads,targets:writable?[...new Set(targets)]:[],addresses:[...new Set(addresses)],writable};
}
