import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { DomainError, Store } from './store';
import type { Role } from '../shared/types';
import { PRICES } from '../shared/types';
import { PaymentEventConflict } from './ledger';

export function createApp(store: Store) {
  const app=express();
  app.use(cors());
  app.use(express.json({limit:'16kb'}));
  app.get('/health',(_req,res) => res.json({ok:true,mode:'local'}));
  app.use('/api',(req,res,next) => {
    const token=req.header('authorization');
    if(token === 'Bearer local-customer') res.locals.role='customer';
    else if(token === 'Bearer local-bestie') res.locals.role='bestie';
    else return res.status(401).json({error:'Local identity required'});
    next();
  });
  const only=(role: Role): express.RequestHandler => (_req,res,next) => {
    if(res.locals.role !== role) return res.status(403).json({error:'This action belongs to the other app'});
    next();
  };
  const id=(req: express.Request) => z.string().uuid().parse(req.params.id);
  const outcome=z.object({outcome:z.enum(['success','failure']),eventId:z.string().uuid().optional()});
  app.get('/api/quote',only('customer'),(req,res) => {
    const service=z.enum(['text','voice']).parse(req.query.service);
    const minutes=z.enum(['10','30','60']).transform(v=>Number(v) as 10|30|60).parse(req.query.minutes);
    res.json({service,minutes,amount:PRICES[service][minutes],currency:'IDR'});
  });
  app.get('/api/state',(req,res) => res.json(store.snapshot(res.locals.role,req.query.bookingId===undefined ? undefined : z.string().uuid().parse(req.query.bookingId))));
  app.post('/api/profile',only('customer'),(req,res) => {
    const body=z.object({nickname:z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N} _-]+$/u,'Use letters, numbers, spaces, underscores or hyphens')}).parse(req.body);
    res.json(store.updateNickname(body.nickname));
  });
  app.post('/api/availability',only('bestie'),(req,res) => {
    store.availability(z.object({online:z.boolean()}).parse(req.body).online); res.json({ok:true});
  });
  app.post('/api/bookings',only('customer'),(req,res) => {
    const body=z.object({service:z.enum(['text','voice']),minutes:z.union([z.literal(10),z.literal(30),z.literal(60)]),method:z.enum(['QRIS','EWALLET','VIRTUAL_ACCOUNT']).default('QRIS'),requestId:z.string().uuid().optional()}).parse(req.body);
    res.status(201).json(store.create(body.service,body.minutes,body.method,body.requestId));
  });
  app.post('/api/bookings/:id/pay',only('customer'),(req,res) => {
    const body=outcome.parse(req.body);res.json(store.pay(id(req),body.outcome,body.eventId));
  });
  app.post('/api/bookings/:id/cancel',only('customer'),(req,res) => res.json(store.cancel(id(req))));
  app.post('/api/bookings/:id/accept',only('bestie'),(req,res) => res.json(store.accept(id(req))));
  app.post('/api/bookings/:id/decline',only('bestie'),(req,res) => res.json(store.decline(id(req))));
  app.post('/api/bookings/:id/end', (req,res) => res.json(store.finish(id(req),res.locals.role)));
  app.post('/api/bookings/:id/rating',only('customer'),(req,res) => {
    const body=z.object({stars:z.number().int().min(1).max(5),comment:z.string().trim().max(300)}).parse(req.body);
    res.json(store.rate(id(req),body.stars,body.comment));
  });
  app.post('/api/bookings/:id/ready',(req,res) => res.json(store.ready(id(req),res.locals.role)));
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
    if(error instanceof DomainError) return res.status(error.status).json({error:error.message});
    if(error instanceof PaymentEventConflict) return res.status(409).json({error:error.message});
    if(error instanceof SyntaxError) return res.status(400).json({error:'Invalid JSON'});
    console.error(error); res.status(500).json({error:'Something went wrong. Please retry.'});
  });
  return app;
}
