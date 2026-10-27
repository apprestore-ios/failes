import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const body = await req.json()
    if (body.action === 'notify_activation') {
      const { token, app_keys, device_name } = body
      const appsList = Array.isArray(app_keys) ? app_keys.join(', ') : app_keys
      const text = `🚀 *Новая активация!*\n\n🔑 Токен: \`${token}\`\n📱 Устройство: ${device_name}\n📦 Приложения: ${appsList}`
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: text, parse_mode: 'Markdown' })
      })
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 })
    }
    if (body.message && body.message.text) {
      if (body.message.text === '/start') {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: body.message.chat.id, text: "👋 Привет! Я бот системы AppRestore IOS. Я готов присылать уведомления об активациях." })
        })
      }
      return new Response('OK', { status: 200 })
    }
    return new Response('Ignore', { status: 200 })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
  }
})
