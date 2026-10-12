import { stripComments } from "./verilog";
import { stripVhdlComments } from "./vhdl";
import { parseParameters } from "./parameters";

export interface ConstantType {width:number;signed:boolean}
export type ConstantValues = Map<string, number | undefined> & { sized?: Set<string>; loopVariables?:Set<string>;types?:Map<string,ConstantType> };
const safe = (n: number) => Number.isSafeInteger(n) ? n : undefined;

export function cloneConstants(values:ConstantValues):ConstantValues {const copy:ConstantValues=new Map(values);if(values.sized)copy.sized=new Set(values.sized);if(values.loopVariables)copy.loopVariables=new Set(values.loopVariables);if(values.types)copy.types=new Map(values.types);return copy;}
export function setConstant(values:ConstantValues,name:string,text:string|undefined,inputs:ConstantValues,vhdl:boolean,typeDeclaration?:string):void {
  let value=text===undefined?undefined:evaluateConstant(text,inputs,vhdl);
  let type:ConstantType|undefined=!typeDeclaration?inputs.types?.get(text?.trim()??""):undefined;
  if(typeDeclaration) {
    if(vhdl) {
      const declaration=typeDeclaration.toLowerCase();
      if(!/^(?:integer|natural|positive|boolean)\b/.test(declaration))value=undefined;
      else if(value!==undefined&&(/^natural\b/.test(declaration)&&value<0||/^positive\b/.test(declaration)&&value<1||/^boolean\b/.test(declaration)&&value!==0&&value!==1))value=undefined;
      if(/\brange\b/.test(declaration))value=undefined;
    }else{
      const range=/\[([^\]]+)\]/.exec(typeDeclaration);
      const words=typeDeclaration.replace(/\[[^\]]+\]/g,"").trim().split(/\s+/).filter(Boolean);
      const builtin=words.find(w=>!["signed","unsigned"].includes(w));
      const accepted=(typeDeclaration.match(/\[/g)??[]).length<=1&&words.every(w=>["signed","unsigned","bit","logic","reg","wire","integer","int","byte","shortint"].includes(w));
      let width:number|undefined;
      if(range){const parts=range[1].split(":");const a=evaluateConstant(parts[0],values),b=parts.length===2?evaluateConstant(parts[1],values):undefined;if(a!==undefined&&b!==undefined)width=Math.abs(a-b)+1;}
      else if(["integer","int"].includes(builtin??""))width=32;
      else if(builtin==="byte")width=8;else if(builtin==="shortint")width=16;
      else if(builtin)width=1;
      else {const literal=/^\s*(\d+)'/.exec(text??"");width=literal?Number(literal[1]):inputs.types?.get(text?.trim()??"")?.width??32;}
      const signed=words.includes("signed")||!words.includes("unsigned")&&["integer","int","byte","shortint"].includes(builtin??"");
      if(!accepted||width===undefined||width<1||width>52)value=undefined;
      else {type={width,signed};if(value!==undefined){const integer=text?.trim()==="'1"?(1n<<BigInt(width))-1n:BigInt(value);value=Number(signed?BigInt.asIntN(width,integer):BigInt.asUintN(width,integer));}}
    }
  }
  const sizedInput=!vhdl&&text&&( /\d+'/.test(text)||[...text.matchAll(/\b\w+\b/g)].some(m=>inputs.sized?.has(m[0])));
  values.types?.delete(name);values.sized?.delete(name);
  values.set(name,value);
  if(type)(values.types??=new Map()).set(name,type);
  if(sizedInput) (values.sized??=new Set()).add(name);
  if(type&&(type.width!==32||!type.signed))(values.sized??=new Set()).add(name);
}

/** 有界整数常量子集；不执行调用，不猜测 X/Z、宽度溢出或未知名字。 */
export function evaluateConstant(text: string, values: ConstantValues, vhdl = false): number | undefined {
  if(text.length>8192)return;
  const tokenRe = /\s*(\d*'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01]|\d+(?:#[_\da-fA-F]+#)?|\$clog2|[A-Za-z_]\w*|===|!==|<=|>=|==|!=|\/=|\*\*|&&|\|\||<<|>>|[()+\-*/%<>=!~&|^?:])/gy;
  const tokens: string[]=[];
  let pos=0;
  while (pos<text.length) {
    if (/^\s*$/.test(text.slice(pos))) break;
    tokenRe.lastIndex=pos; const m=tokenRe.exec(text);
    if (!m || tokens.length>=512) return;
    tokens.push(vhdl ? m[1].toLowerCase() : m[1]); pos=tokenRe.lastIndex;
  }
  // 算术需完整 sized/signed 传播；当前整数子集保守拒绝，避免溢出选择错误分支。
  const hasSized=!vhdl&&tokens.some(t=>/^\d+'/.test(t)||values.sized?.has(t));
  const compound=tokens.some(t=>["+","-","*","/","%","**","~","<<",">>","&","|","^","==","!=","<","<=",">",">="].includes(t));
  const simpleUnsignedShift=/^\s*\d+'[bBoOdDhH][\da-fA-F_]+\s*>>\s*\d+\s*$/.test(text);
  const comparison=/^\s*([A-Za-z_]\w*|-?\d+)\s*(?:==|!=|<=|>=|<|>)\s*([A-Za-z_]\w*|-?\d+)\s*$/.exec(text);
  const typedComparison=!!comparison&&[comparison[1],comparison[2]].every(t=>/^-?\d+$/.test(t)||values.types?.has(t))&&
    ([comparison[1],comparison[2]].every(t=>/^-?\d+$/.test(t)||values.types?.get(t)?.signed)||[comparison[1],comparison[2]].every(t=>(/^-?\d+$/.test(t)?Number(t):values.get(t)??-1)>=0));
  if(hasSized&&compound&&!simpleUnsignedShift&&!typedComparison)return;
  let at=0, depth=0;
  const precedence: Record<string,number> = {"||":1,or:1,xor:2,"&&":3,and:3,"|":4,"^":5,"&":6,"==":7,"!=":7,"=":7,"/=":7,"<":8,"<=":8,">":8,">=":8,"<<":9,">>":9,"+":10,"-":10,"*":11,"/":11,"%":11,mod:11,rem:11,"**":12};
  function primary(): number | undefined {
    if (++depth>64) return;
    const t=tokens[at++]; let value:number|undefined;
    if (t==="(") { value=expression(0); if(tokens[at++]!==")") value=undefined; }
    else if (["+","-","!","~","not"].includes(t)) {
      const n=primary();
      if(n!==undefined) value=t==="-" ? safe(-n) : t==="~" ? safe(Number(~BigInt(n))) : t==="+" ? n : Number(!n);
    } else if (t==="$clog2") {
      if(tokens[at++]==="(") {const n=expression(0); if(tokens[at++]===")" && n!==undefined && n>=0) value=n<=1?0:(BigInt(n)-1n).toString(2).length;}
    } else if (vhdl&&(t==="true" || t==="false")) value=Number(t==="true");
    else if (t && /^\d+$/.test(t)) value=safe(Number(t));
    else if(t && /^'([01])$/.test(t)) value=Number(t[1]);
    else if(vhdl&&t && /^\d+#/.test(t)) {const [radix,digits]=t.split("#"); const r=Number(radix),d=digits.replace(/_/g,""); if(r>=2&&r<=16&&d&&[...d].every(c=>parseInt(c,16)<r)) value=safe(parseInt(d,r));}
    else if(t && t.includes("'")) {
      const m=/^(\d*)'([sS]?)([bBoOdDhH])([\da-fA-F_]+)$/.exec(t);
      if(m) {
        const radix={b:2,o:8,d:10,h:16}[m[3].toLowerCase() as "b"|"o"|"d"|"h"];
        const digits=m[4].replace(/_/g,"");
        if(digits.length&&[...digits].every(c=>parseInt(c,16)<radix)) {
          const prefix={2:"0b",8:"0o",10:"",16:"0x"}[radix]!;
          let integer=BigInt(prefix+digits);const width=Number(m[1]);
          if(!m[1] || width>0&&width<=52) {
            if(m[1]) integer=m[2]?BigInt.asIntN(width,integer):BigInt.asUintN(width,integer);
            value=safe(Number(integer));
          }
        }
      }
    } else if(t) value=values.get(t);
    depth--; return value;
  }
  function expression(min:number):number|undefined {
    let left=primary();
    while(at<tokens.length && (precedence[tokens[at]]??-1)>=min) {
      const op=tokens[at++], p=precedence[op], right=expression(p+(op==="**"?0:1));
      if(left===undefined||right===undefined) {left=undefined;continue;}
      const a=left,b=right;
      if(!vhdl&&(a < -2147483648 || a > 2147483647 || b < -2147483648 || b > 2147483647)&&!simpleUnsignedShift){left=undefined;continue;}
      switch(op) {
        case "+":left=safe(a+b);break; case "-":left=safe(a-b);break; case "*":left=safe(a*b);break;
        case "/":left=b?safe(Math.trunc(a/b)):undefined;break;
        case "%":case "rem":left=b?safe(a%b):undefined;break;
        case "mod":left=b?safe(((a%b)+b)%b):undefined;break;
        case "**":left=b>=0&&b<=52?safe(a**b):undefined;break;
        case "<<":case ">>":left=b>=0&&b<=52?safe(Number(op==="<<"?BigInt(a)<<BigInt(b):(vhdl||a>=0?BigInt(a):BigInt.asUintN(32,BigInt(a)))>>BigInt(b))):undefined;break;
        case "&":left=safe(Number(BigInt(a)&BigInt(b)));break;case "|":left=safe(Number(BigInt(a)|BigInt(b)));break;case "^":left=safe(Number(BigInt(a)^BigInt(b)));break;
        case "=":case "==":left=Number(a===b);break;case "!=":case "/=":left=Number(a!==b);break;
        case "<":left=Number(a<b);break;case "<=":left=Number(a<=b);break;case ">":left=Number(a>b);break;case ">=":left=Number(a>=b);break;
        case "&&":case "and":left=Number(!!a&&!!b);break;case "||":case "or":left=Number(!!a||!!b);break;case "xor":left=Number(!!a!==!!b);break;
      }
      if(!vhdl&&left!==undefined&&(left < -2147483648 || left > 2147483647)&&!simpleUnsignedShift)left=undefined;
    }
    if(min===0&&tokens[at]==="?") {at++;const yes=expression(0);if(tokens[at++]!==":")return;const no=expression(0);left=left===undefined?undefined:left?yes:no;}
    return left;
  }
  const result=expression(0); return at===tokens.length ? result : undefined;
}

export interface StaticRegion {start:number;end:number;scope:string;values:ConstantValues;names:Map<string,string>}
export interface StaticBoundary {start:number;end:number;reason:string}
export interface SourceView {file:string;start:number;end:number;scope:string;text:string;sourceMap:number[];names?:Map<string,string>}

/** 替换 genvar／generate 局部对象时，逐字符保留原偏移。 */
export function specializeText(text:string,start:number,region:StaticRegion,vhdl:boolean,replaceConstants=false):{text:string;sourceMap:number[]} {
  const clean=vhdl?stripVhdlComments(text):stripComments(text);
  let out="",from=0;const map:number[]=[];
  const append=(s:string,at:number,originalLength=s.length)=>{out+=s;for(let k=0;k<s.length;k++)map.push(start+at+Math.min(k,Math.max(0,originalLength-1)));};
  for(const m of clean.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const key=vhdl?m[0].toLowerCase():m[0];
    const value=region.names.get(key) ?? ((replaceConstants||region.values.loopVariables?.has(key))&&region.values.has(key)&&region.values.get(key)!==undefined?String(region.values.get(key)):undefined);
    if(value===undefined) continue;
    append(text.slice(from,m.index),from);append(value,m.index!,m[0].length);from=m.index!+m[0].length;
  }
  append(text.slice(from),from);map.push(start+text.length);return{text:out,sourceMap:map};
}

/** 仅处理调用者已定位的模块区域；过程区域遮蔽，不将运行时 if/for 当作 generate。 */
export function expandStaticGenerate(source:string,start:number,end:number,values:ConstantValues,vhdl:boolean,excluded:{start:number;end:number}[],maxIterations=256):{regions:StaticRegion[];boundaries:StaticBoundary[]} {
  let clean=vhdl?stripVhdlComments(source):stripComments(source);
  for(const p of excluded) if(p.start<end&&p.end>start) clean=clean.slice(0,p.start)+clean.slice(p.start,p.end).replace(/[^\n]/g," ")+clean.slice(p.end);
  const regions:StaticRegion[]=[],boundaries:StaticBoundary[]=[];let iterations=0,depth=0;
  const ws=(p:number)=>{while(p<end&&/\s/.test(clean[p]))p++;return p;};
  const parens=(p:number)=>{let d=0;for(let i=p;i<end;i++){if(clean[i]==="(")d++;if(clean[i]===")"&&--d===0)return i+1;}return end;};
  function statement(p:number):{start:number;end:number;bodyStart:number;bodyEnd:number;label:string;complete?:boolean} {
    p=ws(p);const begin=/^begin\b(?:\s*:\s*(\w+))?/.exec(clean.slice(p));
    if(begin) {
      const re=/\b(begin|end)\b/g;re.lastIndex=p;let d=0,m:RegExpExecArray|null;
      while((m=re.exec(clean))&&m.index<end) {d+=m[1]==="begin"?1:-1;if(!d)return{start:p,end:re.lastIndex,bodyStart:p+begin[0].length,bodyEnd:m.index,label:begin[1]??`genblk_${p}`};}
      return{start:p,end,bodyStart:p+begin[0].length,bodyEnd:end,label:begin[1]??`genblk_${p}`,complete:false};
    }
    if(/^if\b/.test(clean.slice(p))) {
      const open=ws(p+2),close=clean[open]==="("?parens(open):open;
      const yes=statement(close);let finish=yes.end;
      const otherwise=ws(finish);if(/^else\b/.test(clean.slice(otherwise)))finish=statement(otherwise+4).end;
      return{start:p,end:finish,bodyStart:p,bodyEnd:finish,label:`genblk_${p}`,complete:yes.complete};
    }
    const close=clean.indexOf(";",p);const e=close<0?end:close+1;return{start:p,end:e,bodyStart:p,bodyEnd:e,label:`genblk_${p}`};
  }
  function blockNames(a:number,b:number,scope:string,inherited:Map<string,string>):Map<string,string> {
    const names=new Map(inherited);if(!scope)return names;
    const declaration=vhdl?/\b(?:signal|constant)\s+([\w\s,]+)\s*:/gi:/\b(?:wire|reg|logic|bit|integer|int|localparam)\s+(?:signed\s+|unsigned\s+)?(?:\[[^\]]+\]\s*)?([^;]+);/g;
    // Nested generate declarations belong to their own child region.
    for(const m of clean.slice(a,b).matchAll(declaration)) {
      const prefix=clean.slice(a,a+m.index!);const opens=(prefix.match(vhdl?/\bgenerate\b/gi:/\bbegin\b/g)??[]).length;
      const closes=(prefix.match(vhdl?/\bend\s+generate\b/gi:/\bend\b/g)??[]).length;
      if(opens>(vhdl?2:1)*closes)continue;
      const declared=vhdl?m[1].split(",").map(s=>s.trim()):parseParameters(m[1],m[1],false,true).map(p=>p.name);
      for(const name of declared) names.set(vhdl?name.toLowerCase():name,`__gen_${scope.replace(/[^\w]/g,"_")}_${name}`);
    }
    return names;
  }
  const part=(a:number,b:number,scope:string,env:ConstantValues,names:Map<string,string>)=>{if(b>a)regions.push({start:a,end:b,scope,values:cloneConstants(env),names:new Map(names)});};
  function walk(a:number,b:number,scope:string,inputValues:ConstantValues,inherited:Map<string,string>) {
    if(++depth>32){boundaries.push({start:a,end:b,reason:"generate 嵌套超过分析预算"});depth--;return;}
    const env=cloneConstants(inputValues);
    const constants=vhdl?/\bconstant\s+(\w+)\s*:[^;]*?:=\s*([^;]+);/gi:/\blocalparam\s+([^;]+);/g;
    for(const c of clean.slice(a,b).matchAll(constants)) {
      const prefix=clean.slice(a,a+c.index!);
      const opens=(prefix.match(vhdl?/\bgenerate\b/gi:/\bbegin\b/g)??[]).length,closes=(prefix.match(vhdl?/\bend\s+generate\b/gi:/\bend\b/g)??[]).length;
      if(opens>(vhdl?2:1)*closes)continue;
      if(vhdl){const declaration=clean.slice(a+c.index!,a+c.index!+c[0].length);for(const p of parseParameters(declaration,declaration,true,true))setConstant(env,p.name.toLowerCase(),p.defaultValue,env,true,p.typeDeclaration);}
      else for(const p of parseParameters(c[1],c[1],false,true))setConstant(env,p.name,p.defaultValue,env,false,p.typeDeclaration);
    }
    const names=blockNames(a,b,scope,inherited);
    const re=vhdl?/\b(\w+)\s*:\s*(if|for|case)\b([\s\S]*?)\bgenerate\b/gi:/\b(generate|if|for|case|casex|casez)\b/g;
    re.lastIndex=a;let cursor=a,m:RegExpExecArray|null;
    while((m=re.exec(clean))&&m.index<b) {
      if(!vhdl&&m[1]==="generate") {
        part(cursor,m.index,scope,env,names);
        if(clean.indexOf("endgenerate",re.lastIndex)<0){boundaries.push({start:m.index,end:b,reason:"generate 区域未闭合"});cursor=b;break;}
        cursor=re.lastIndex;continue;
      }
      if(!vhdl&&/^case/.test(m[1])) {
        const tail=/\b(case|casex|casez|endcase)\b/g;tail.lastIndex=m.index;let nesting=0,token:RegExpExecArray|null,finish=b;
        while((token=tail.exec(clean))&&token.index<b){nesting+=token[1]==="endcase"?-1:1;if(!nesting){finish=tail.lastIndex;break;}}
        part(cursor,m.index,scope,env,names);boundaries.push({start:m.index,end:finish,reason:"case generate 尚不支持静态选择"});cursor=finish;re.lastIndex=finish;continue;
      }
      let finish:number,bodyStart:number,bodyEnd:number,label:string,header:string,kind:string,unsupportedSelection=false,incomplete=false,alternative:{start:number;end:number;label:string}|undefined;
      if(vhdl) {
        label=m[1];kind=m[2].toLowerCase();header=m[3].trim();bodyStart=re.lastIndex;
        const tokens=/\bend\s+generate\b[^;]*;|\bgenerate\b/gi;tokens.lastIndex=bodyStart;let nesting=1,t:RegExpExecArray|null,elseAt:number|undefined,elseBody:number|undefined;bodyEnd=b;finish=b;
        while((t=tokens.exec(clean))&&t.index<b){
          const branch=!/^end/i.test(t[0])?/\b(else|elsif\b[^;]*?)\s*$/i.exec(clean.slice(bodyStart,t.index)):null;
          if(branch){if(nesting===1){if(/^else\s*$/i.test(branch[1])){elseAt=bodyStart+branch.index;elseBody=tokens.lastIndex;}else unsupportedSelection=true;}continue;}
          nesting+=/^end/i.test(t[0])?-1:1;if(!nesting){bodyEnd=t.index;finish=tokens.lastIndex;break;}
        }
        incomplete=nesting!==0;
        // VHDL-2008 else generate does not increase the outer nesting.
        if(elseAt!==undefined){alternative={start:elseBody!,end:bodyEnd,label:`${label}_else`};bodyEnd=elseAt;}
      }else {
        kind=m[1];const open=ws(re.lastIndex);if(clean[open]!=="(")continue;
        const close=parens(open);header=clean.slice(open+1,close-1);const stmt=statement(close);
        incomplete=clean[close-1]!==")"||stmt.complete===false;
        bodyStart=stmt.bodyStart;bodyEnd=stmt.bodyEnd;finish=stmt.end;label=stmt.label;
        if(kind==="if") {
          const elseAt=ws(finish);const el=/^else\b/.exec(clean.slice(elseAt));
          if(el){const other=statement(elseAt+el[0].length);alternative={start:other.bodyStart,end:other.bodyEnd,label:other.label};finish=other.end;incomplete ||= other.complete===false;}
        }
      }
      part(cursor,m.index,scope,env,names);
      const childScope=(s:string)=>scope?`${scope}.${s}`:s;
      if(incomplete) {
        boundaries.push({start:m.index,end:finish,reason:"generate 条件或区域未闭合"});
      }else if(kind==="case" || unsupportedSelection) {
        boundaries.push({start:m.index,end:finish,reason:"generate case/elsif 选择尚不支持静态展开"});
      }else if(kind==="if") {
        const condition=evaluateConstant(header,env,vhdl);
        if(condition===undefined)boundaries.push({start:m.index,end:finish,reason:`generate 条件无法静态确定：${header}`});
        else if(condition)walk(bodyStart,bodyEnd,childScope(label),env,names);
        else if(alternative)walk(alternative.start,alternative.end,childScope(alternative.label),env,names);
      }else {
        let variable:string|undefined,initial:number|undefined,condition:string|undefined,update:string|undefined,last:number|undefined,step=1;
        if(vhdl){const f=/^(\w+)\s+in\s+(.+?)\s+(to|downto)\s+(.+)$/i.exec(header);if(f){variable=f[1].toLowerCase();initial=evaluateConstant(f[2],env,true);last=evaluateConstant(f[4],env,true);step=f[3].toLowerCase()==="to"?1:-1;}}
        else{const f=/^\s*(?:genvar\s+)?(\w+)\s*=\s*([^;]+);([^;]+);(.+)$/.exec(header);if(f){variable=f[1];initial=evaluateConstant(f[2],env);condition=f[3];update=f[4].trim();}}
        const loopValues:number[]=[];let n=initial,failed=!variable||n===undefined||(vhdl&&last===undefined);const visited=new Set<number>();
        while(!failed&&n!==undefined&&variable) {
          const local=cloneConstants(env).set(variable,n);const test=vhdl?Number(step>0?n<=last!:n>=last!):evaluateConstant(condition!,local);
          if(test===0)break;if(test===undefined){failed=true;break;}
          if(visited.has(n)||iterations+loopValues.length>=maxIterations){failed=true;break;}visited.add(n);loopValues.push(n);
          if(vhdl)n=safe(n+step);
          else if(new RegExp(`^(?:${variable}\\+\\+|\\+\\+${variable})$`).test(update!))n=safe(n+1);
          else if(new RegExp(`^(?:${variable}--|--${variable})$`).test(update!))n=safe(n-1);
          else{const next=new RegExp(`^${variable}\\s*(=|\\+=|-=)\\s*(.+)$`).exec(update!);n=next?evaluateConstant(next[1]==="="?next[2]:`${variable}${next[1][0]}(${next[2]})`,local):undefined;}
          if(n===undefined)failed=true;
        }
        if(failed)boundaries.push({start:m.index,end:finish,reason:"generate 循环无法静态确定、未终止或超过分析预算"});
        else{iterations+=loopValues.length;for(const value of loopValues){const local=cloneConstants(env).set(variable!,value);(local.loopVariables??=new Set()).add(variable!);walk(bodyStart,bodyEnd,childScope(`${label}[${value}]`),local,names);}}
      }
      cursor=finish;re.lastIndex=finish;
    }
    part(cursor,b,scope,env,names);depth--;
  }
  walk(start,end,"",values,new Map());return{regions,boundaries};
}
