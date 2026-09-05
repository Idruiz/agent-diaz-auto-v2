import fs from "node:fs";
import path from "node:path";

export function safeJoin(root: string, filename: string): string {
  const cleaned=path.basename(filename).replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,180);
  if(!cleaned || cleaned==="." || cleaned==="..") throw new Error("Invalid filename");
  const target=path.resolve(root,cleaned);
  if(!target.startsWith(path.resolve(root)+path.sep)) throw new Error("Path rejected");
  return target;
}

export function ensureDirs(...dirs:string[]):void { for(const d of dirs)fs.mkdirSync(d,{recursive:true}); }

export function atomicWrite(file:string,data:Buffer):void {
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,data,{flag:"wx"}); fs.renameSync(tmp,file);
}
