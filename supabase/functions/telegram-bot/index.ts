import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || Deno.env.get('TELEGRAM_ADMIN_ID')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://gwypxcdnefxlhwvtkvkc.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function parseDeviceName(ua: string): string {
  if (!ua) return "iPhone (модель не передана сайтом)";
  if (ua.includes("iPhone")) {
    if (ua.includes("CPU OS 18_")) return "iPhone (модель не определена, iOS 18)";
    if (ua.includes("CPU OS 17_")) return "iPhone (модель не определена, iOS 17)";
    if (ua.includes("CPU OS 16_")) return "iPhone (модель не определена, iOS 16)";
    return "iPhone (модель не определена)";
  }
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "Mac (Safari)";
  if (ua.includes("Windows")) return "Windows PC";
  if (ua.includes("Android")) return "Android устройство";
  return "Мобильное устройство";
}


async function validateTelegramInitData(initData: string): Promise<any | null> {
  if (!initData || !TELEGRAM_BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash'); if (!hash) return null; params.delete('hash');
    const entries = [...params.entries()].sort(([a],[b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k,v]) => `${k}=${v}`).join('\n');
    const enc = new TextEncoder();
    const secretKey = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(TELEGRAM_BOT_TOKEN));
    const hmacKey = await crypto.subtle.importKey('raw', secret, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckString)));
    const hex = [...signature].map(b=>b.toString(16).padStart(2,'0')).join('');
    if (hex !== hash) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now()/1000 - authDate > 86400) return null;
    const userRaw = params.get('user'); return userRaw ? JSON.parse(userRaw) : null;
  } catch { return null; }
}
async function db(path: string, init: RequestInit = {}) {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Не настроен SUPABASE_SERVICE_ROLE_KEY в Edge Function');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: {
    apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation', ...(init.headers||{})
  }});
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0,300)}`);
  return text ? JSON.parse(text) : [];
}
async function telegramSend(chatId: string | number, text: string, replyMarkup?: any) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,reply_markup:replyMarkup})});
}
const STATUS_LABELS: Record<string,string> = {pending:'Ожидает оплаты',paid:'Оплата на проверке',issued:'Ссылка выдана',cancelled:'Отменён'};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return new Response(JSON.stringify({ success: false, error: 'TELEGRAM_BOT_TOKEN не настроен' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const body = await req.json()

    // Клиентские и административные действия мини-приложения. Telegram initData проверяется на сервере.
    const orderActions = ['create_order','my_orders','mark_paid','admin_orders','confirm_payment','cancel_order'];
    if (orderActions.includes(body.action)) {
      const user = await validateTelegramInitData(String(body.initData || ''));
      if (!user?.id) return new Response(JSON.stringify({success:false,error:'Откройте мини-приложение через Telegram-бота.'}), {status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
      const isAdmin = String(user.id) === String(ADMIN_CHAT_ID);
      const sendJson = (payload:any, status=200) => new Response(JSON.stringify(payload), {status,headers:{...corsHeaders,'Content-Type':'application/json'}});
      if (body.action === 'create_order') {
        const rawItems = Array.isArray(body.items) ? body.items : [];
        const keys = [...new Set(rawItems.map((x:any)=>String(x.app_key||'')).filter(Boolean))];
        if (!keys.length || keys.length > 30) return sendJson({success:false,error:'Корзина пуста или слишком большая.'},400);
        const prices = await db(`app_prices?select=app_key,price&app_key=in.(${keys.map(encodeURIComponent).join(',')})`);
        const visibility = await db(`app_visibility?select=app_key,is_visible&app_key=in.(${keys.map(encodeURIComponent).join(',')})`);
        const priceMap = new Map(prices.map((r:any)=>[r.app_key,Number(r.price)]));
        const visibleMap = new Map(visibility.map((r:any)=>[r.app_key,r.is_visible]));
        const items = keys.map((key:string)=>({app_key:key,app_name:String(rawItems.find((x:any)=>String(x.app_key)===key)?.app_name||key).slice(0,120),price:priceMap.get(key)}));
        if (items.some((i:any)=>!Number.isFinite(i.price) || i.price < 0 || visibleMap.get(i.app_key) === false)) return sendJson({success:false,error:'Одно из приложений недоступно для заказа. Обновите каталог.'},400);
        const total = items.reduce((sum:number,i:any)=>sum+Math.round(i.price),0);
        const orderNumber = String(Date.now()).slice(-8) + String(Math.floor(Math.random()*90+10));
        const created = await db('orders', {method:'POST',body:JSON.stringify({order_number:orderNumber,telegram_user_id:user.id,username:user.username||null,first_name:user.first_name||null,total_amount:total,status:'pending'})});
        const orderId = created?.[0]?.id;
        if (!orderId) throw new Error('Не удалось создать заказ.');
        await db('order_items', {method:'POST',body:JSON.stringify(items.map((i:any)=>({...i,order_id:orderId})))});
        if (ADMIN_CHAT_ID) await telegramSend(ADMIN_CHAT_ID, `🧾 Новый заказ №${orderNumber}\nКлиент: ${user.first_name||''} ${user.username?'(@'+user.username+')':''}\n${items.map((i:any)=>'• '+i.app_name+' — '+i.price+' ₽').join('\n')}\nИтого: ${total} ₽\n\nОткройте админ-панель → Заказы клиентов.`);
        return sendJson({success:true,order:{order_number:orderNumber,total_amount:total,items,status:'pending'}});
      }
      if (body.action === 'my_orders') {
        const rows = await db(`orders?telegram_user_id=eq.${Number(user.id)}&select=*&order=created_at.desc&limit=30`);
        const orders = await Promise.all(rows.map(async (o:any)=>({...o,status_label:STATUS_LABELS[o.status]||o.status,items:await db(`order_items?order_id=eq.${o.id}&select=app_key,app_name,price`)})));
        return sendJson({success:true,orders});
      }
      if (body.action === 'mark_paid') {
        const orderNumber=String(body.order_number||'');
        const rows=await db(`orders?order_number=eq.${encodeURIComponent(orderNumber)}&telegram_user_id=eq.${Number(user.id)}&select=id,status`);
        if(!rows.length) return sendJson({success:false,error:'Заказ не найден.'},404);
        if(rows[0].status!=='pending') return sendJson({success:false,error:'Этот заказ уже отмечен.'},400);
        await db(`orders?id=eq.${rows[0].id}`,{method:'PATCH',body:JSON.stringify({status:'paid',paid_at:new Date().toISOString()})});
        if(ADMIN_CHAT_ID) await telegramSend(ADMIN_CHAT_ID,`💳 Клиент отметил оплату заказа №${orderNumber}. Проверьте поступление перевода в банке, затем подтвердите заказ в админ-панели.`);
        return sendJson({success:true});
      }
      if (!isAdmin) return sendJson({success:false,error:'Доступ разрешён только администратору.'},403);
      if (body.action === 'admin_orders') {
        const rows=await db('orders?select=*&order=created_at.desc&limit=100');
        const orders=await Promise.all(rows.map(async(o:any)=>({...o,status_label:STATUS_LABELS[o.status]||o.status,items:await db(`order_items?order_id=eq.${o.id}&select=app_key,app_name,price`)})));
        return sendJson({success:true,orders});
      }
      const orderNumber=String(body.order_number||'');
      const found=await db(`orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=*`);
      if(!found.length) return sendJson({success:false,error:'Заказ не найден.'},404);
      const order=found[0];
      if(body.action==='cancel_order') {
        if(order.status==='issued') return sendJson({success:false,error:'Заказ со ссылкой уже выдан. Отмена невозможна через панель.'},400);
        await db(`orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'cancelled',cancelled_at:new Date().toISOString()})});
        await telegramSend(order.telegram_user_id,`Заказ №${orderNumber} отменён. По вопросам обратитесь в поддержку @dizabled.`);
        return sendJson({success:true});
      }
      if(body.action==='confirm_payment') {
        if(order.status==='issued' && order.install_token) return sendJson({success:true,token:order.install_token});
        if(order.status==='cancelled') return sendJson({success:false,error:'Заказ отменён.'},400);
        const items=await db(`order_items?order_id=eq.${order.id}&select=app_key,app_name,price`);
        if(!items.length) return sendJson({success:false,error:'В заказе нет приложений.'},400);
        const token=String(Math.floor(10000000+Math.random()*90000000));
        await db('app_links',{method:'POST',body:JSON.stringify({token,app_keys:items.map((i:any)=>i.app_key),ttl_minutes:15,is_used:false,activated_at:0,device_id:null,created_at:Date.now()})});
        await db(`orders?id=eq.${order.id}`,{method:'PATCH',body:JSON.stringify({status:'issued',paid_at:order.paid_at||new Date().toISOString(),issued_at:new Date().toISOString(),install_token:token})});
        const link=`https://apprestore-ios.ru/?${token}`;
        await telegramSend(order.telegram_user_id,`✅ Оплата заказа №${orderNumber} подтверждена!\n\nВаша персональная ссылка на установку (действует 15 минут с момента первого открытия, только на одном устройстве):\n${link}`);
        return sendJson({success:true,token,link});
      }
    }

    // 1. Уведомление об активации (для сайта/приложения)
    if (body.action === 'notify_activation') {
      const { token, app_keys, device_name, device_model } = body
      const appsList = Array.isArray(app_keys) ? app_keys.join(', ') : (app_keys || 'Не указаны')

      const ekbTime = new Date().toLocaleTimeString("ru-RU", { timeZone: "Asia/Yekaterinburg", hour: '2-digit', minute: '2-digit' });

      // Сайт передаёт примерную модель iPhone в device_model.
      // Используем её в приоритете, чтобы не заменять на общее «iPhone».
      const suppliedDeviceModel =
        typeof device_model === 'string' && device_model.trim()
          ? device_model.trim()
          : (typeof device_name === 'string' && device_name.trim() ? device_name.trim() : '');

      // В уведомлении показываем только название устройства, без параметров экрана.
      const deviceFormatted = (suppliedDeviceModel || parseDeviceName(''))
        .split(' · ')[0]
        .slice(0, 100);

      // Пустая строка между каждым пунктом делает уведомление читабельнее.
      const text = `🔔 *Новая активация!*\n\n📦 Приложения: \`${appsList}\`\n\n🔑 Токен: \`${token || 'Не указан'}\`\n\n⏰ Время (Екб): \`${ekbTime}\`\n\n📱 Устройство: \`${deviceFormatted}\``

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "🗑 Удалить уведомление", callback_data: "delete_msg" }]
        ]
      };

      if (!ADMIN_CHAT_ID) {
        return new Response(JSON.stringify({ success: false, error: 'ADMIN_CHAT_ID / TELEGRAM_ADMIN_ID не настроен' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          text,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        })
      })
      const telegramResult = await telegramResponse.json()
      if (!telegramResponse.ok || !telegramResult.ok) {
        return new Response(JSON.stringify({ success: false, error: 'Telegram sendMessage failed' }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200
      })
    }

    // 2. Обработка запросов от Telegram (команда /start)
    if (body.message) {
      const chatId = body.message.chat.id
      const text = body.message.text
      const isAdmin = String(chatId) === String(ADMIN_CHAT_ID)

      if (text === '/start') {
        const replyMarkup: any = { inline_keyboard: [] }
        if (isAdmin) {
          replyMarkup.inline_keyboard.push([
            { text: "⚙️ Открыть Админ-панель", web_app: { url: "https://apprestore-ios.ru/admin.html" } }
          ])
        }

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: chatId, 
            text: "ПАНЕЛЬ АДМИНИСТРАТОРА ПРОЕКТА AppRestore IOS!",
            reply_markup: replyMarkup
          })
        })
      }
    }

    // 3. Обработка нажатия на инлайн-кнопку «Удалить уведомление»
    if (body.callback_query) {
      const query = body.callback_query
      if (query.data === 'delete_msg') {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: query.message.chat.id, message_id: query.message.message_id })
        })
      }
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: query.id })
      })
    }

    return new Response('OK', { status: 200 })
  } catch (err) {
    return new Response('Error: ' + err.message, { status: 500 })
  }
})
