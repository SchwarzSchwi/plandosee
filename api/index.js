import {createClient} from '@supabase/supabase-js';
const names=['plans','plan_versions','tasks','execution_logs','reviews'];
const columns={plans:['title','start_date','end_date','priority','success_criteria','estimated_minutes','description'],tasks:['plan_id','title','description','due_date','priority','tags','estimated_minutes','status','deleted_at'],execution_logs:['task_id','started_at','ended_at','actual_minutes','blocker'],reviews:['plan_id','improvement']};
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)return res.status(503).json({error:'Supabase 환경 변수가 필요합니다'});
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
 const {table,id,action}=req.query;const validId=x=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(x||'');
 try{
 if(req.method==='GET'){
 if(action==='export'){const result={exported_at:new Date().toISOString()};for(const t of names){const {data,error}=await db.from(t).select('*');if(error)throw error;result[t]=data}return res.json(result)}
 if(!names.includes(table))return res.status(400).json({error:'invalid table'});
 const {data,error}=await db.from(table).select('*').order('created_at');if(error)throw error;return res.json(data);
 }
 if(!columns[table]||!['POST','PATCH','DELETE'].includes(req.method))return res.status(405).json({error:'not allowed'});
 if(req.method!=='POST'&&!validId(id))return res.status(400).json({error:'invalid id'});
 const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
 if(JSON.stringify(body).length>12000)return res.status(413).json({error:'too large'});
 const payload=Object.fromEntries(Object.entries(body).filter(([k])=>columns[table].includes(k)));
 if(req.method==='DELETE'){
 if(table!=='tasks')return res.status(405).json({error:'not allowed'});
 const {error}=await db.from('tasks').update({deleted_at:new Date().toISOString()}).eq('id',id);if(error)throw error;return res.json({ok:true});
 }
 if(table==='plans'&&req.method==='PATCH'){
 const {data:old,error}=await db.from('plans').select('*').eq('id',id).single();if(error)throw error;
 const {error:versionError}=await db.from('plan_versions').insert({plan_id:id,snapshot:old});if(versionError)throw versionError;
 }
 if(table==='tasks'&&req.method==='PATCH'&&payload.status==='done'){
 const {data:old,error}=await db.from('tasks').select('status').eq('id',id).single();if(error)throw error;
 if(old.status==='done')return res.json({unchanged:true});
 }
 if(table==='execution_logs'){
 const start=Date.parse(payload.started_at),end=Date.parse(payload.ended_at);
 if(!validId(payload.task_id)||!Number.isFinite(start)||!Number.isFinite(end)||end<start)return res.status(400).json({error:'invalid execution time'});
 payload.actual_minutes=Math.round((end-start)/60000);
 }
 const q=req.method==='POST'?db.from(table).insert(payload):db.from(table).update(payload).eq('id',id);
 const {data,error}=await q.select().single();if(error)throw error;return res.json(data);
 }catch(e){return res.status(400).json({error:e.message})}
}
