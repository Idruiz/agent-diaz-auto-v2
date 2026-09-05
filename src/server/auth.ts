import crypto from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

const COOKIE = "diaz_session";
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const passwordHash = (password: string) => crypto.scryptSync(password, "agent-diaz-owner-v2", 64);

export function createAuth(config: Config, db: Db) {
  const expected = passwordHash(config.ADMIN_PASSWORD);
  const requireAuth: RequestHandler = (req,res,next) => {
    const token=req.cookies?.[COOKIE];
    if(!token || !db.getSession(hashToken(token))) return res.status(401).json({error:"Authentication required"});
    next();
  };
  const verifyOrigin: RequestHandler = (req,res,next) => {
    if(["GET","HEAD","OPTIONS"].includes(req.method)) return next();
    const origin=req.get("origin");
    if(origin && origin !== new URL(config.BASE_URL).origin) return res.status(403).json({error:"Origin rejected"});
    next();
  };
  return {
    requireAuth, verifyOrigin,
    login(password:string,res:any) {
      const got=passwordHash(password);
      if(!crypto.timingSafeEqual(got,expected)) return false;
      const token=crypto.randomBytes(32).toString("base64url");
      const expires=new Date(Date.now()+config.SESSION_DAYS*86400000);
      db.createSession(crypto.randomUUID(),hashToken(token),expires.toISOString());
      res.cookie(COOKIE,token,{httpOnly:true,sameSite:"strict",secure:config.NODE_ENV==="production",expires,path:"/"});
      return true;
    },
    logout(req:any,res:any) { const t=req.cookies?.[COOKIE]; if(t)db.deleteSession(hashToken(t)); res.clearCookie(COOKIE,{path:"/"}); }
  };
}
