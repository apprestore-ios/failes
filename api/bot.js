export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(200).json({ status: 'Bot is running' });
    }

    const body = req.body;
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO; // например: username/repository

    // Функция для отправки сообщения в Telegram
    async function sendMessage(chatId, text, replyMarkup = null) {
        const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    // Вспомогательные функции для работы с GitHub API (database.json)
    async function getGitHubDB() {
        try {
            const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/database.json`, {
                headers: { "Authorization": `Bearer ${GITHUB_TOKEN}`, "Accept": "application/vnd.github.v3+json" }
            });
            if (!res.ok) return null;
            const data = await res.json();
            const decoded = JSON.parse(decodeURIComponent(escape(atob(data.content))));
            return { db: decoded, sha: data.sha };
        } catch (e) {
            return null;
        }
    }

    async function saveGitHubDB(newData, sha) {
        try {
            const jsonString = JSON.stringify(newData, null, 2);
            const encodedContent = btoa(unescape(encodeURIComponent(jsonString)));
            const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/database.json`, {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${GITHUB_TOKEN}`,
                    "Accept": "application/vnd.github.v3+json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    message: "Bot update database.json",
                    content: encodedContent,
                    sha: sha
                })
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    // Обработка входящих запросов от Telegram (сообщения или уведомления)
    try {
        // 1. Если это специальное внутреннее уведомление об активации ссылки (из сайта)
        if (body.action === 'notify_activation') {
            const { token, app_keys, device_name } = body;
            // Здесь вы можете указать свой Telegram ID, чтобы получать уведомления о покупках/установках
            // Или отправлять в чат администратора
            const adminChatId = process.env.ADMIN_CHAT_ID; 
            if (adminChatId) {
                const appsList = (app_keys || []).map(name => `• ${name}`).join('\n');
                const alertText = `⚡ <b>Ссылка открыта покупателем!</b>\n\n🔑 Токен: <code>${token}</code>\n📱 Устройство: ${device_name || 'Не определено'}\n\n📦 Приложения:\n${appsList}`;
                await sendMessage(adminChatId, alertText);
            }
            return res.status(200).json({ ok: true });
        }

        // 2. Обычные сообщения от пользователя боту
        const message = body.message;
        if (!message || !message.text) {
            return res.status(200).json({ ok: true });
        }

        const chatId = message.chat.id;
        const text = message.text.trim();

        if (text === '/start') {
            const welcomeText = 
                `👋 <b>Добро пожаловать в AppRestore IOS!</b>\n\n` +
                `Здесь вы можете безопасно установить нужные приложения на свой iPhone без ПК и потери данных.\n\n` +
                `🌐 Наш сайт: https://apprestore-ios.ru`;
            
            // Кнопка для открытия Web App (админки или каталога)
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📦 Открыть каталог", web_app: { url: "https://apprestore-ios.ru" } }]
                ]
            };
            await sendMessage(chatId, welcomeText, keyboard);
        } 
        else if (text === '/admin') {
            // Если команду написал администратор (можно ограничить по вашему ID)
            const keyboard = {
                inline_keyboard: [
                    [{ text: "⚙️ Панель управления", web_app: { url: "https://apprestore-ios.ru/admin.html" } }]
                ]
            };
            await sendMessage(chatId, "🔐 Нажмите кнопку ниже для открытия панели администратора:", keyboard);
        }
        else {
            await sendMessage(chatId, "Используйте кнопку каталога ниже или перейдите на сайт: https://apprestore-ios.ru");
        }

    } catch (err) {
        console.error(err);
    }

    return res.status(200).json({ ok: true });
}
