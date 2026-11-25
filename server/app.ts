import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { DomainError, Store } from './store';
import type { Role } from '../shared/types';
import { PRICES } from '../shared/types';
import { PaymentEventConflict } from './ledger';
import { AuthError, type Account } from './auth';
import {relayConfiguration} from './relay';
import {randomUUID} from 'node:crypto';

export function createApp(store: Store) {
  const app=express();
  app.disable('x-powered-by');
  app.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
  const origins=new Set((process.env.ALLOWED_ORIGINS??'http://localhost:8081,http://localhost:8082,http://127.0.0.1:8081,http://127.0.0.1:8082').split(',').map((v:string)=>v.trim()));
  app.use((req,res,next)=>{if(req.headers.origin&&!origins.has(req.headers.origin))return res.status(403).json({error:'Origin is not allowed'});next();});
  app.use(cors({credentials:true,origin:(origin,callback)=>callback(null,!origin||origins.has(origin))}));
  app.use(express.json({limit:'16kb'}));
  app.use((req,res,next)=>{const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);if(process.env.LOG_REQUESTS==='true'){const started=Date.now();res.on('finish',()=>console.info(JSON.stringify({requestId,method:req.method,path:req.path,status:res.statusCode,durationMs:Date.now()-started})));}next();});
  app.get('/health',(_req,res)=>res.json({ok:true}));
  app.get('/ready',(_req,res)=>{try{store.db.prepare('SELECT 1').get();res.json({ok:true});}catch{res.status(503).json({ok:false});}});
  const attempts=new Map<string,{count:number;expires:number}>();
  const authLimit:express.RequestHandler=(req,res,next)=>{
    const key=req.path+':'+req.ip;const now=Date.now();let entry=attempts.get(key);
    if(!entry||entry.expires<now){entry={count:0,expires:now+60000};attempts.set(key,entry);}
    if(++entry.count>10)return res.status(429).json({error:'Too many attempts. Please try again in a minute.'});
    if(attempts.size>10000)for(const [k,v] of attempts)if(v.expires<now)attempts.delete(k);
    next();
  };
  const roleSchema=z.enum(['customer','bestie','admin']);
  const secure=(req:express.Request)=>req.secure||process.env.COOKIE_SECURE==='true';
  app.post('/auth/register',authLimit,async(req,res)=>{
    const body=z.object({email:z.email().max(254),password:z.string().min(12).max(128),nickname:z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N} _-]+$/u),role:z.enum(['customer','bestie'])}).parse(req.body);
    const user=await store.accounts.register(body.email,body.password,body.nickname,body.role);res.status(201).json({user});
  });
  app.post('/auth/login',authLimit,async(req,res)=>{
    const body=z.object({email:z.email().max(254),password:z.string().min(1).max(128),role:roleSchema}).parse(req.body);
    const result=await store.accounts.login(body.email,body.password,body.role);
    const web=req.header('x-client-platform')==='web';
    if(web)res.cookie('halo_'+result.user.role,result.token,{httpOnly:true,secure:secure(req),sameSite:'strict',path:'/',maxAge:7*86400000});
    res.json({user:result.user,...(!web?{token:result.token}:{})});
  });
  app.use('/api',(req,res,next)=>{
    const bearer=req.header('authorization');const appRole=roleSchema.optional().parse(req.header('x-app-role'));
    const cookieName='halo_'+appRole;
    const cookie=req.headers.cookie?.split(';').map((v:string)=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const token=bearer?.startsWith('Bearer ')?bearer.slice(7):appRole?cookie:undefined;
    if(!token)throw new AuthError('Please sign in to continue');
    const user=store.accounts.authenticate(token);
    if(appRole&&appRole!==user.role)throw new AuthError('Use the app for your account role',403);
    res.locals.user=user;res.locals.role=user.role;res.locals.token=token;
    if(user.role==='admin'&&!req.path.startsWith('/admin')&&!req.path.startsWith('/auth'))throw new AuthError('Use administrator endpoints for support actions',403);
    next();
  });
  app.get('/api/auth/me',(_req,res)=>res.json({user:res.locals.user}));
  app.post('/api/auth/logout',(_req,res)=>{
    store.accounts.logout(res.locals.token);res.clearCookie('halo_'+res.locals.role,{httpOnly:true,secure:secure(_req),sameSite:'strict',path:'/'});res.json({ok:true});
  });
  // Account identifiers stay inside the backend; listeners receive only the session nickname.
  app.use('/api',(_req,res,next)=>{
    const json=res.json.bind(res);
    res.json=((value:unknown)=>json(JSON.parse(JSON.stringify(value,(key,value)=>key==='customerId'||key==='bestieId'?undefined:value)))) as typeof res.json;
    next();
  });
  app.use('/api/bookings/:id',(req,res,next)=>{store.authorize(res.locals.user as Account,z.string().uuid().parse(req.params.id));next();});
  const only=(role: Role): express.RequestHandler => (_req,res,next) => {
    if(res.locals.role !== role) return res.status(403).json({error:'This action belongs to the other app'});
    next();
  };
  const id=(req: express.Request) => z.string().uuid().parse(req.params.id);
  const admin:express.RequestHandler=(_req,res,next)=>{if(res.locals.user.role!=='admin')throw new AuthError('Administrator access required',403);next();};
  app.get('/api/admin/reports',admin,(_req,res)=>res.json(store.db.prepare("SELECT * FROM reports WHERE status='open' ORDER BY created LIMIT 100").all()));
  app.post('/api/admin/reports/:reportId/resolve',admin,(req,res)=>{
    const target=z.string().uuid().parse(req.params.reportId);const result=store.db.prepare("UPDATE reports SET status='resolved' WHERE id=?").run(target);
    if(!result.changes)throw new DomainError('Report not found',404);store.audit(res.locals.user.id,'resolve_report',target);res.json({ok:true});
  });
  app.get('/api/admin/refunds',admin,(_req,res)=>res.json(store.db.prepare("SELECT * FROM refunds WHERE status<>'completed' ORDER BY updated LIMIT 100").all()));
  app.post('/api/admin/refunds/:refundId/retry',admin,(req,res)=>{
    const target=z.string().min(1).max(200).parse(req.params.refundId);
    if(!store.db.prepare('SELECT id FROM refunds WHERE id=?').get(target))throw new DomainError('Refund not found',404);
    const result=store.transaction(()=>store.ledger.process(target));store.audit(res.locals.user.id,'retry_refund',target);res.json(result);
  });
  app.get('/api/admin/health',admin,(_req,res)=>res.json({database:'ok',lastReconcileAt:store.lastReconcileAt,lastReconcileError:store.lastReconcileError,sessions:store.db.prepare("SELECT status,COUNT(*) AS count FROM bookings GROUP BY status").all(),refunds:store.db.prepare("SELECT status,COUNT(*) AS count FROM refunds GROUP BY status").all(),openReports:store.db.prepare("SELECT COUNT(*) AS count FROM reports WHERE status='open'").get()}));
  const outcome=z.object({outcome:z.enum(['success','failure']),eventId:z.string().uuid().optional()});
  app.get('/api/quote',only('customer'),(req,res) => {
    const service=z.enum(['text','voice']).parse(req.query.service);
    const minutes=z.enum(['10','30','60']).transform(v=>Number(v) as 10|30|60).parse(req.query.minutes);
    res.json({service,minutes,amount:PRICES[service][minutes],currency:'IDR'});
  });
  app.get('/api/state',(req,res) => res.json(store.snapshot(res.locals.role,req.query.bookingId===undefined ? undefined : z.string().uuid().parse(req.query.bookingId),res.locals.user.id)));
  app.post('/api/profile',only('customer'),(req,res) => {
    const body=z.object({nickname:z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N} _-]+$/u,'Use letters, numbers, spaces, underscores or hyphens')}).parse(req.body);
    res.json(store.updateNickname(body.nickname,res.locals.user.id));
  });
  app.post('/api/availability',only('bestie'),(req,res) => {
    store.availability(z.object({online:z.boolean()}).parse(req.body).online,res.locals.user.id); res.json({ok:true});
  });
  app.post('/api/bookings',only('customer'),(req,res) => {
    const body=z.object({service:z.enum(['text','voice']),minutes:z.union([z.literal(10),z.literal(30),z.literal(60)]),method:z.enum(['QRIS','EWALLET','VIRTUAL_ACCOUNT']).default('QRIS'),requestId:z.string().uuid().optional()}).parse(req.body);
    res.status(201).json(store.create(body.service,body.minutes,body.method,body.requestId,res.locals.user.id));
  });
  app.post('/api/bookings/:id/pay',only('customer'),(req,res) => {
    const body=outcome.parse(req.body);res.json(store.pay(id(req),body.outcome,body.eventId));
  });
  app.post('/api/bookings/:id/cancel',only('customer'),(req,res) => res.json(store.cancel(id(req))));
  app.post('/api/bookings/:id/accept',only('bestie'),(req,res) => res.json(store.accept(id(req),res.locals.user.id)));
  app.post('/api/bookings/:id/decline',only('bestie'),(req,res) => res.json(store.decline(id(req))));
  app.post('/api/bookings/:id/end', (req,res) => res.json(store.finish(id(req),res.locals.role)));
  app.post('/api/bookings/:id/rating',only('customer'),(req,res) => {
    const body=z.object({stars:z.number().int().min(1).max(5),comment:z.string().trim().max(300)}).parse(req.body);
    res.json(store.rate(id(req),body.stars,body.comment));
  });
  app.post('/api/bookings/:id/ready',(req,res) => res.json(store.ready(id(req),res.locals.role)));
  app.post('/api/bookings/:id/report',(req,res)=>res.status(201).json(store.report(res.locals.user,id(req),z.object({reason:z.string().trim().min(5).max(1000)}).parse(req.body).reason)));
  app.post('/api/bookings/:id/block',(req,res)=>res.json(store.block(res.locals.user,id(req))));
  app.get('/api/bookings/:id/voice/config',(req,res)=>{store.voiceAccess(id(req));res.json(relayConfiguration(res.locals.user.id,id(req)));});
  app.get('/api/bookings/:id/payment-proof',(req,res)=>res.json(store.paymentProof(id(req))));
  const description=(type:'offer'|'answer')=>z.object({type:z.literal(type),sdp:z.string().min(1).max(12000)});
  const voiceSignal=z.intersection(z.object({id:z.string().uuid(),callId:z.string().uuid()}),z.discriminatedUnion('kind',[
    z.object({kind:z.literal('offer'),payload:description('offer')}),
    z.object({kind:z.literal('answer'),payload:description('answer')}),
    z.object({kind:z.literal('ice'),payload:z.object({candidate:z.string().min(1).max(2000),sdpMid:z.string().max(100).nullable(),sdpMLineIndex:z.number().int().min(0).max(20).nullable(),usernameFragment:z.string().max(200).nullable().optional()})})
  ]));
  app.post('/api/bookings/:id/voice/signals',(req,res)=>res.json(store.voiceSignal(id(req),res.locals.role,voiceSignal.parse(req.body))));
  app.get('/api/bookings/:id/voice/signals',(req,res)=>res.json(store.voicePoll(id(req),res.locals.role,z.coerce.number().int().min(0).default(0).parse(req.query.after))));
  app.post('/api/bookings/:id/voice/presence',(req,res)=>{const body=z.object({callId:z.string().uuid(),connected:z.boolean()}).parse(req.body);res.json(store.voicePresence(id(req),res.locals.role,body.callId,body.connected));});
  app.post('/api/bookings/:id/messages',(req,res) => {
    const body=z.object({id:z.string().uuid(),body:z.string().trim().min(1).max(2000)}).parse(req.body);
    res.status(201).json(store.send(id(req),res.locals.role,body.id,body.body));
  });
  app.post('/api/bookings/:id/extensions',only('customer'),(req,res) => res.status(201).json(store.extend(id(req))));
  app.post('/api/bookings/:id/extensions/:extensionId/pay',only('customer'),(req,res) => {
    const body=outcome.parse(req.body);
    res.json(store.payExtension(id(req),z.string().uuid().parse(req.params.extensionId),body.outcome,body.eventId));
  });
  app.use((error: unknown,_req:express.Request,res:express.Response,_next:express.NextFunction) => {
    if(error instanceof z.ZodError) return res.status(400).json({error:'Invalid request',details:error.issues.map(i => i.message)});
    if(error instanceof AuthError)return res.status(error.status).json({error:error.message});
    if(error instanceof DomainError) return res.status(error.status).json({error:error.message});
    if(error instanceof PaymentEventConflict) return res.status(409).json({error:error.message});
    if(error instanceof SyntaxError) return res.status(400).json({error:'Invalid JSON'});
    console.error(error); res.status(500).json({error:'Something went wrong. Please retry.'});
  });
  return app;
}
