const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8851852954:AAFodYLJ-weYJhRya3pauO1UYdktpFZ9FM4';
const ADMIN_ID = 7640301049;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

if (!fs.existsSync('./sessions')) {
    fs.mkdirSync('./sessions', { recursive: true });
}

const DB_FILE = './database.json';
let db = { approvedUsers: [ADMIN_ID], pendingUsers: [], userAccounts: {} };

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) {}
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const waSessions = {};
const userStates = {};

const cancelKeyboard = {
    reply_markup: {
        inline_keyboard: [[{ text: "❌ إلغاء العمليّة", callback_data: "cancel_action" }]]
    }
};

async function startWASessionWithCode(chatId, phoneNumber, accountName) {
    const sessionKey = `${chatId}_${accountName}`;
    const sessionDir = path.join(__dirname, 'sessions', sessionKey);

    // إغلاق أي جلسة قديمة مسجلة للحد من التكرار
    if (waSessions[sessionKey]) {
        try { waSessions[sessionKey].end(); } catch (e) {}
        delete waSessions[sessionKey];
    }

    // إزالة مجلد الجلسة لضمان توليد مفتاح تشفير جديد
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS("Desktop"),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 20000
        });

        waSessions[sessionKey] = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                bot.sendMessage(chatId, `✅ **تم اتصال حساب الواتساب [${accountName}] بنجاح!**`, {
                    parse_mode: 'Markdown',
                    reply_markup: getMainKeyboard(chatId)
                });
            } else if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                // إعادة الاتصال فقط إذا كان الحساب مسجلاً ومقترناً بالفعل وليس أثناء طلب الكود
                if (statusCode !== DisconnectReason.loggedOut && sock.authState.creds.registered) {
                    startWASessionWithCode(chatId, phoneNumber, accountName);
                }
            }
        });

        // طلب كود الربط مرة واحدة فقط دون تكرار
        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                    const pairingCode = await sock.requestPairingCode(cleanPhone);

                    bot.sendMessage(
                        chatId,
                        `📱 **كود الربط المخصص لك:**\n\n\`${pairingCode}\`\n\n*(اضغط على الكود أعلاه لنسخه فوراً)*\n\n⚠️ **تنبيه:** أدخل هذا الكود في تطبيق الواتساب الآن دون تأخير.`,
                        { parse_mode: 'Markdown', ...cancelKeyboard }
                    );
                } catch (err) {
                    bot.sendMessage(
                        chatId, 
                        `❌ **خطأ أثناء طلب الكود:**\n\`${err.message || err}\``,
                        { parse_mode: 'Markdown', reply_markup: getMainKeyboard(chatId) }
                    );
                }
            }, 3000);
        }
    } catch (e) {
        bot.sendMessage(chatId, `⚠️ **خطأ في السيرفر:**\n\`${e.message}\``, { parse_mode: 'Markdown' });
    }
}

function isApproved(chatId) {
    return db.approvedUsers.includes(chatId);
}

function getMainKeyboard(chatId) {
    const isAdmin = (chatId === ADMIN_ID);
    const inline_keyboard = [
        [
            { text: "📱 حسابات الواتساب", callback_data: "menu_accounts" },
            { text: "➕ ربط حساب جديد", callback_data: "menu_add_acc" }
        ],
        [
            { text: "📢 نظام النشر والإعلانات", callback_data: "menu_broadcast" },
            { text: "🔍 نظام الفلترة والمراقبة", callback_data: "menu_monitor" }
        ],
        [
            { text: "📊 حالة النظام والخدمة", callback_data: "menu_status" }
        ]
    ];

    if (isAdmin) {
        inline_keyboard.push([{ text: "👑 إدارة المستخدمين والموافقات", callback_data: "admin_users" }]);
    }

    return { inline_keyboard };
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    delete userStates[chatId];

    if (!isApproved(chatId)) {
        if (!db.pendingUsers.includes(chatId)) {
            db.pendingUsers.push(chatId);
            saveDB();
        }
        return bot.sendMessage(chatId, "⏳ **طلبك قيد المراجعة.**");
    }

    bot.sendMessage(chatId, `🤖 **أهلاً بك في لوحة التحكم!**`, {
        parse_mode: 'Markdown',
        reply_markup: getMainKeyboard(chatId)
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text && text.startsWith('/')) return;

    if (userStates[chatId] === 'AWAITING_PHONE') {
        delete userStates[chatId];
        
        const accId = `acc_${Date.now().toString().slice(-4)}`;
        if (!db.userAccounts[chatId]) db.userAccounts[chatId] = [];
        db.userAccounts[chatId].push(accId);
        saveDB();

        bot.sendMessage(
            chatId, 
            `🔄 **جاري جلب كود الربط للرقم:** \`${text}\`...\nجهز الواتساب الآن.`, 
            { parse_mode: 'Markdown', ...cancelKeyboard }
        );
        startWASessionWithCode(chatId, text, accId);
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === "cancel_action") {
        delete userStates[chatId];
        bot.answerCallbackQuery(query.id, { text: "تم إلغاء العملية." });
        return bot.sendMessage(chatId, "🛑 **تم إلغاء العمليّة بنجاح.**", {
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(chatId)
        });
    }

    if (!isApproved(chatId)) return;

    if (data === "menu_add_acc") {
        bot.answerCallbackQuery(query.id);
        userStates[chatId] = 'AWAITING_PHONE';
        bot.sendMessage(
            chatId, 
            "📞 **يرجى إرسال رقم الواتساب الخاص بك مع رمز الدولة دون (+):**\n\nمثال: `966500000000` أو `96770000000`", 
            { parse_mode: 'Markdown', ...cancelKeyboard }
        );
    } else if (data === "menu_accounts") {
        bot.answerCallbackQuery(query.id);
        const userAccs = db.userAccounts[chatId] || [];
        
        if (userAccs.length === 0) {
            return bot.sendMessage(chatId, "📱 **حسابات الواتساب:**\n\nلا توجد حسابات مرتبطة حالياً.", {
                parse_mode: 'Markdown',
                reply_markup: getMainKeyboard(chatId)
            });
        }

        const buttons = userAccs.map(acc => [
            { text: `📱 ${acc}`, callback_data: `info_${acc}` },
            { text: `🗑️ حذف ${acc}`, callback_data: `delete_${acc}` }
        ]);
        buttons.push([{ text: "❌ إلغاء العمليّة", callback_data: "cancel_action" }]);

        bot.sendMessage(chatId, "📱 **حسابات الواتساب الخاصة بك:**\nاختر حسابتً للتحكم به أو حذفه:", {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } else if (data.startsWith("delete_")) {
        const accToDelete = data.replace("delete_", "");
        bot.answerCallbackQuery(query.id, { text: `جاري حذف الحساب ${accToDelete}...` });

        if (db.userAccounts[chatId]) {
            db.userAccounts[chatId] = db.userAccounts[chatId].filter(acc => acc !== accToDelete);
            saveDB();
        }

        const sessionKey = `${chatId}_${accToDelete}`;
        if (waSessions[sessionKey]) {
            try { waSessions[sessionKey].end(); } catch (e) {}
            delete waSessions[sessionKey];
        }

        const sessionDir = path.join(__dirname, 'sessions', sessionKey);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        bot.sendMessage(chatId, `🗑️ **تم حذف الحساب [${accToDelete}] ومسح الجلسة بنجاح.**`, {
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(chatId)
        });
    } else if (data === "menu_status") {
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, "⚙️ **حالة الخدمة:** تعمل بنجاح.", {
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(chatId)
        });
    }
});
