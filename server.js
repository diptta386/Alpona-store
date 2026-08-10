import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';
import pg from 'pg';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const required = ['DATABASE_URL','SESSION_SECRET','OWNER_EMAIL','OWNER_PASSWORD'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}. Copy .env.example to .env and set it.`);
if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const PgStore = connectPgSimple(session);
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'alpona.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000*60*60*8 }
}));

const generalLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15*60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', generalLimiter);

const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), cost INTEGER NOT NULL CHECK(cost>=0),
  stock INTEGER NOT NULL CHECK(stock>=0), image TEXT NOT NULL, description TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(email)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_id BIGINT REFERENCES customers(id), customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
  area TEXT NOT NULL, payment TEXT NOT NULL, subtotal INTEGER NOT NULL, delivery INTEGER NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New','Confirmed','Processing','Shipped','Delivered','Cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id BIGINT REFERENCES products(id),
  product_name TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), price INTEGER NOT NULL, cost INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY, description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscribers (
  id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, active BOOLEAN NOT NULL DEFAULT true, consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsubscribe_token TEXT UNIQUE NOT NULL, unsubscribed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
`;

async function bootstrap(){
  await pool.query(schemaSql);
  const owner = await pool.query('SELECT id FROM users WHERE email=$1',[process.env.OWNER_EMAIL.toLowerCase()]);
  if (!owner.rowCount) {
    const hash = await bcrypt.hash(process.env.OWNER_PASSWORD, 12);
    await pool.query('INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)',[process.env.OWNER_EMAIL.toLowerCase(),hash,'owner']);
  }
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  if (count.rows[0].count === 0) {
    const seed = [
      ['Hand-painted Alpona Décor Set','Home Décor',1250,650,8,'assets/decor.jpeg','Traditional hand-painted decorative set inspired by Bengali alpona motifs. Perfect for festive décor, gifting and home styling.'],
      ['Hand-painted Peacock Tote','Bags',850,390,12,'assets/bag.jpeg','Reusable fabric tote featuring a hand-painted peacock motif and traditional decorative detailing.'],
      ['Traditional Hand-painted Wear','Clothing',1650,780,6,'assets/clothing.jpeg','Wearable art inspired by Bengali motifs, combining traditional style with detailed hand-painted craftsmanship.']
    ];
    for(const p of seed) await pool.query('INSERT INTO products(name,category,price,cost,stock,image,description) VALUES($1,$2,$3,$4,$5,$6,$7)',p);
  }
}

const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT||587), secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
}) : null;

async function sendMail({to,subject,html}){
  if (!transporter) { console.log('[EMAIL PREVIEW]', {to,subject}); return; }
  await transporter.sendMail({ from: process.env.MAIL_FROM || 'Alpona <no-reply@localhost>', to, subject, html });
}
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
function orderEmail(order, status){
  return `<div style="font-family:Arial;max-width:620px;margin:auto"><h2>Alpona — ${esc(status)}</h2><p>Hello ${esc(order.customer_name)},</p><p>Your order <b>${esc(order.id)}</b> is now <b>${esc(status)}</b>.</p><p>Total: <b>৳${Number(order.total).toLocaleString()}</b></p><p>Thank you for shopping with Alpona.</p></div>`;
}
async function notifySubscribers(product){
  const { rows } = await pool.query('SELECT email,unsubscribe_token FROM subscribers WHERE active=true');
  await Promise.allSettled(rows.map(s=>sendMail({
    to:s.email, subject:`New at Alpona: ${product.name}`,
    html:`<div style="font-family:Arial;max-width:620px;margin:auto"><h2>New product available</h2><h3>${esc(product.name)}</h3><p>${esc(product.description)}</p><p><b>৳${Number(product.price).toLocaleString()}</b></p><p><a href="${esc(process.env.SITE_URL||'')}">Shop Alpona</a></p><p style="font-size:12px"><a href="${esc(process.env.SITE_URL||'')}/unsubscribe?token=${encodeURIComponent(s.unsubscribe_token)}">Unsubscribe</a></p></div>`
  })));
}

function requireOwner(req,res,next){ if(req.session?.user?.role==='owner') return next(); return res.status(401).json({error:'Unauthorized'}); }
const loginSchema=z.object({email:z.string().email(),password:z.string().min(8).max(200)});
const checkoutSchema=z.object({
  name:z.string().min(2).max(100), email:z.string().email().max(200), phone:z.string().min(6).max(30), address:z.string().min(5).max(400),
  area:z.enum(['Inside Dhaka','Outside Dhaka']), payment:z.enum(['Cash on Delivery','Manual bKash confirmation']), marketingOptIn:z.boolean().optional().default(false),
  items:z.array(z.object({id:z.coerce.number().int().positive(),qty:z.coerce.number().int().min(1).max(20)})).min(1).max(30)
});
const productSchema=z.object({name:z.string().min(2).max(160),category:z.string().min(2).max(80),price:z.coerce.number().int().min(0),cost:z.coerce.number().int().min(0),stock:z.coerce.number().int().min(0),image:z.string().min(1).max(500),description:z.string().min(5).max(3000)});
const expenseSchema=z.object({description:z.string().min(2).max(300),amount:z.coerce.number().int().min(0)});

app.get('/api/products', async(req,res)=>{ const {rows}=await pool.query('SELECT id,name,category,price,stock,image,description FROM products WHERE active=true ORDER BY id'); res.json(rows); });
app.post('/api/orders', async(req,res,next)=>{
  const parsed=checkoutSchema.safeParse(req.body); if(!parsed.success) return res.status(400).json({error:'Please check your checkout information.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN'); const d=parsed.data; const ids=d.items.map(x=>x.id);
    const pRes=await client.query('SELECT id,name,price,cost,stock FROM products WHERE active=true AND id=ANY($1::bigint[]) FOR UPDATE',[ids]);
    if(pRes.rowCount!==new Set(ids).size) throw Object.assign(new Error('One or more products are unavailable.'),{status:409});
    const byId=new Map(pRes.rows.map(p=>[Number(p.id),p])); let subtotal=0;
    for(const item of d.items){const p=byId.get(item.id); if(!p||p.stock<item.qty) throw Object.assign(new Error(`${p?.name||'Product'} does not have enough stock.`),{status:409}); subtotal+=p.price*item.qty;}
    const delivery=d.area==='Inside Dhaka'?80:140, total=subtotal+delivery; const orderId='ALP-'+Date.now().toString().slice(-6)+crypto.randomInt(10,99);
    const c=await client.query(`INSERT INTO customers(name,email,phone,address,marketing_opt_in) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,address=EXCLUDED.address,marketing_opt_in=customers.marketing_opt_in OR EXCLUDED.marketing_opt_in,updated_at=now() RETURNING id`,[d.name,d.email.toLowerCase(),d.phone,d.address,d.marketingOptIn]);
    await client.query(`INSERT INTO orders(id,customer_id,customer_name,email,phone,address,area,payment,subtotal,delivery,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[orderId,c.rows[0].id,d.name,d.email.toLowerCase(),d.phone,d.address,d.area,d.payment,subtotal,delivery,total]);
    for(const item of d.items){const p=byId.get(item.id); await client.query('INSERT INTO order_items(order_id,product_id,product_name,qty,price,cost) VALUES($1,$2,$3,$4,$5,$6)',[orderId,p.id,p.name,item.qty,p.price,p.cost]); await client.query('UPDATE products SET stock=stock-$1,updated_at=now() WHERE id=$2',[item.qty,p.id]);}
    if(d.marketingOptIn) await client.query(`INSERT INTO subscribers(email,name,unsubscribe_token) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET active=true,name=EXCLUDED.name,unsubscribed_at=NULL`,[d.email.toLowerCase(),d.name,crypto.randomBytes(24).toString('hex')]);
    await client.query('COMMIT');
    const order={id:orderId,customer_name:d.name,email:d.email,total}; sendMail({to:d.email,subject:`Alpona order ${orderId} received`,html:orderEmail(order,'Received')}).catch(console.error);
    res.status(201).json({id:orderId,total});
  }catch(err){await client.query('ROLLBACK'); next(err);}finally{client.release();}
});

app.post('/api/subscribe', async(req,res)=>{
  const parsed=z.object({email:z.string().email(),name:z.string().max(100).optional()}).safeParse(req.body); if(!parsed.success)return res.status(400).json({error:'Enter a valid email.'});
  const token=crypto.randomBytes(24).toString('hex'); await pool.query(`INSERT INTO subscribers(email,name,unsubscribe_token) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET active=true,name=COALESCE(EXCLUDED.name,subscribers.name),unsubscribed_at=NULL`,[parsed.data.email.toLowerCase(),parsed.data.name||null,token]); res.json({ok:true});
});
app.get('/unsubscribe', async(req,res)=>{const token=String(req.query.token||''); if(token) await pool.query('UPDATE subscribers SET active=false,unsubscribed_at=now() WHERE unsubscribe_token=$1',[token]); res.type('html').send('<h2>You have been unsubscribed from Alpona marketing emails.</h2><p>You will still receive transactional emails about orders you place.</p>');});

app.post('/api/admin/login',authLimiter,async(req,res)=>{const p=loginSchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:'Invalid login.'}); const q=await pool.query('SELECT * FROM users WHERE email=$1',[p.data.email.toLowerCase()]); if(!q.rowCount||!(await bcrypt.compare(p.data.password,q.rows[0].password_hash)))return res.status(401).json({error:'Incorrect email or password.'}); req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Login failed.'});req.session.user={id:q.rows[0].id,email:q.rows[0].email,role:q.rows[0].role};res.json({ok:true});});});
app.post('/api/admin/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me',(req,res)=>res.json({authenticated:req.session?.user?.role==='owner'}));
app.get('/api/admin/dashboard',requireOwner,async(req,res)=>{
  const [orders,products,expenses,stats]=await Promise.all([
    pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('name',oi.product_name,'qty',oi.qty,'price',oi.price,'cost',oi.cost)) FILTER (WHERE oi.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 500`),
    pool.query('SELECT * FROM products WHERE active=true ORDER BY id'), pool.query('SELECT * FROM expenses ORDER BY created_at DESC LIMIT 500'),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN o.status<>'Cancelled' THEN o.total ELSE 0 END),0)::int sales, COUNT(*)::int orders,
      COALESCE((SELECT SUM(amount) FROM expenses),0)::int expenses,
      (COALESCE(SUM(CASE WHEN o.status<>'Cancelled' THEN o.total ELSE 0 END),0)-COALESCE(SUM(CASE WHEN o.status<>'Cancelled' THEN (SELECT SUM(oi.cost*oi.qty) FROM order_items oi WHERE oi.order_id=o.id) ELSE 0 END),0)-COALESCE((SELECT SUM(amount) FROM expenses),0))::int profit FROM orders o`)
  ]); res.json({orders:orders.rows,products:products.rows,expenses:expenses.rows,stats:stats.rows[0]});
});
app.patch('/api/admin/orders/:id',requireOwner,async(req,res)=>{const status=z.enum(['New','Confirmed','Processing','Shipped','Delivered','Cancelled']).safeParse(req.body.status);if(!status.success)return res.status(400).json({error:'Invalid status.'});const q=await pool.query('UPDATE orders SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status.data,req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Order not found.'});sendMail({to:q.rows[0].email,subject:`Alpona order ${q.rows[0].id}: ${status.data}`,html:orderEmail(q.rows[0],status.data)}).catch(console.error);res.json({ok:true});});
app.post('/api/admin/products',requireOwner,async(req,res)=>{const p=productSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Check product information.'});const d=p.data;const q=await pool.query('INSERT INTO products(name,category,price,cost,stock,image,description) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[d.name,d.category,d.price,d.cost,d.stock,d.image,d.description]);notifySubscribers(q.rows[0]).catch(console.error);res.status(201).json(q.rows[0]);});
app.put('/api/admin/products/:id',requireOwner,async(req,res)=>{const p=productSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Check product information.'});const d=p.data;const q=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,cost=$4,stock=$5,image=$6,description=$7,updated_at=now() WHERE id=$8 RETURNING *',[d.name,d.category,d.price,d.cost,d.stock,d.image,d.description,req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Product not found.'});res.json(q.rows[0]);});
app.delete('/api/admin/products/:id',requireOwner,async(req,res)=>{await pool.query('UPDATE products SET active=false,updated_at=now() WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.post('/api/admin/expenses',requireOwner,async(req,res)=>{const p=expenseSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Check expense.'});await pool.query('INSERT INTO expenses(description,amount) VALUES($1,$2)',[p.data.description,p.data.amount]);res.status(201).json({ok:true});});
app.delete('/api/admin/expenses/:id',requireOwner,async(req,res)=>{await pool.query('DELETE FROM expenses WHERE id=$1',[req.params.id]);res.json({ok:true});});

app.post('/api/ai/chat',aiLimiter,async(req,res)=>{
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'AI assistant is not configured yet.'});
  const parsed=z.object({message:z.string().min(1).max(1000)}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Message is too long or empty.'});
  const products=(await pool.query('SELECT name,category,price,stock,description FROM products WHERE active=true ORDER BY id LIMIT 100')).rows;
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const prompt=`You are Alpona customer support. Answer only about Alpona products, ordering, delivery, payment and general store help. Never reveal internal costs, profit, owner data, database information, secrets, or other customers' information. If asked for a specific customer's order, tell them a human agent must verify identity before sharing private order details. Prices are BDT. Current public products: ${JSON.stringify(products)}`;
  const response=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-5-mini',instructions:prompt,input:parsed.data.message});
  res.json({reply:response.output_text||'Please contact Alpona customer care for help.'});
});

app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
app.use((err,req,res,next)=>{console.error(err);res.status(err.status||500).json({error:err.status?err.message:'Something went wrong. Please try again.'});});

await bootstrap();
const port=Number(process.env.PORT||3000); app.listen(port,()=>console.log(`Alpona secure store running on port ${port}`));
