const fs=require('fs'),path=require('path');
const ROOT='/Users/wutiaoyun/Desktop/Campus-Network-Connector';
const { GlyphEngine } = require(ROOT+'/src/features/safari-repair/engine');
(async()=>{
  const [font,out]=process.argv.slice(2);
  const bytes=fs.readFileSync(font);
  const e=new GlyphEngine({log:()=>{}});
  const r=await e.processScope('x',[],{kind:'data',value:bytes.toString('base64')},{});
  const m=r.mapping||{};
  const outp={};
  for(const [k,v] of Object.entries(m)) outp[k.codePointAt(0).toString()]=v.codePointAt(0);
  fs.writeFileSync(out,JSON.stringify(outp));
  console.log('TS 引擎映射条数:',Object.keys(outp).length);
})();
