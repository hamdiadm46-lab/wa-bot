const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

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

async function startWASessionWithCode(chatId, phoneNumber, accountName) {
    const sessionKey = `${chatId}_${accountName}`;
    const sessionDir = path.join(__dirname, 'sessions', sessionKey);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            bot.sendMessage(chatId, `✅ **تم اتصال حساب الواتساب [${accountName}] بنجاح!**`, { parse_mode: 'Markdown' });
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                startWASessionWithCode(chatId, phoneNumber, accountName);
            } else {
                bot.sendMessage(chatId, `⚠️ تم تسجيل الخروج من حساب الواتساب [${accountName}].`);
            }
        }
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                const pairingCode = await sock.requestPairingCode(cleanPhone);
                
                // إضافة المبدل لتنسيق الكود بشكل مقروء (مثال: ABCD-1234)
                const formattedCode = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;

                bot.sendMessage(
                    chatId,
                    `📱 **كود ربط الحساب المخصص لك:**\n\n\`${formattedCode}\`\n\n*(اضغط على الكود أعلاه لنسخه فوراً)*\n\n**طريقة التفعيل:**\n1. افتح الواتساب على هاتفك.\n2. اذهب إلى **الأجهزة المرتبطة** > **ربط جهاز**.\n3. اختر **الربط برقم الهاتف** ثم أدخل الكود.`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error("خطأ في جلب الكود:", err);
                bot.sendMessage(chatId, "❌ لم يتم إصدار الكود. يرجى التأكد من إعادة المحاولة وإدخال الرقم الصحيح مقترناً برمز الدولة بدون علامة (+).");
            }
        }, 6000);
    }

    waSessions[sessionKey] = sock;
    return sock;
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

    if (!isApproved(chatId)) {
        if (!db.pendingUsers.includes(chatId)) {
            db.pendingUsers.push(chatId);
            saveDB();

            bot.sendMessage(
                ADMIN_ID, 
                `🔔 **طلب جديد لاستخدام البوت!**\n\nالمستخدم: ${msg.from.first_name || ''} (@${msg.from.username || 'بدون_معرف'})\nالمعرف (ID): \`${chatId}\``, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "✅ موافقة", callback_data: `approve_${chatId}` },
                                { text: "❌ رفض", callback_data: `reject_${chatId}` }
                            ]
                        ]
                    }
                }
            );
        }
        return bot.sendMessage(chatId, "⏳ **طلبك قيد المراجعة.**\nيرجى الانتظار حتى يتم قبول حسابك من قبل المالك.");
    }

    bot.sendMessage(chatId, `🤖 **أهلاً بك في لوحة التحكم الخاصة بك!**\nكل حساباتك وإعداداتك مستقلة تماماً.`, {
        parse_mode: 'Markdown',
        reply_markup: getMainKeyboard(chatId)
    });
});

const userStates = {};

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

        bot.sendMessage(chatId, `🔄 **جاري الاتصال بخوادم الواتساب وجلب كود الربط للرقم:** \`${text}\`...\nانتظر بضعة ثوانٍ.`, { parse_mode: 'Markdown' });
        startWASessionWithCode(chatId, text, accId);
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('approve_') && chatId === ADMIN_ID) {
        const targetId = parseInt(data.split('_')[1]);
        if (!db.approvedUsers.includes(targetId)) {
            db.approvedUsers.push(targetId);
            db.pendingUsers = db.pendingUsers.filter(id => id !== targetId);
            saveDB();

            bot.answerCallbackQuery(query.id, { text: "تمت الموافقة بنجاح!" });
            bot.sendMessage(targetId, "🎉 **تمت الموافقة على استخدامك للبوت!**\nاضغط /start للبدء.");
            bot.editMessageText(`✅ تم قبول المستخدم \`${targetId}\``, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        }
        return;
    }

    if (data.startsWith('reject_') && chatId === ADMIN_ID) {
        const targetId = parseInt(data.split('_')[1]);
        db.pendingUsers = db.pendingUsers.filter(id => id !== targetId);
        saveDB();

        bot.answerCallbackQuery(query.id, { text: "تم الرفض." });
        bot.sendMessage(targetId, "❌ للأسف، تم رفض طلبك لاستخدام البوت.");
        bot.editMessageText(`❌ تم رفض المستخدم \`${targetId}\``, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        return;
    }

    if (!isApproved(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: "عذراً، الحساب غير معتمد.", show_alert: true });
    }

    if (data === "menu_add_acc") {
        bot.answerCallbackQuery(query.id);
        userStates[chatId] = 'AWAITING_PHONE';
        bot.sendMessage(
            chatId, 
            "📞 **يرجى إرسال رقم الواتساب الخاص بك مع رمز الدولة دون أي مسافات أو أرمز:**\n\nمثال: `966500000000` أو `96770000000`", 
            { parse_mode: 'Markdown' }
        );
    } else if (data === "menu_accounts") {
        bot.answerCallbackQuery(query.id);
        const userAccs = db.userAccounts[chatId] || [];
        const accListText = userAccs.length > 0 
            ? userAccs.map((a, i) => `${i + 1}. \`${a}\``).join('\n') 
            : 'لا توجد حسابات مرتبطة حالياً.';
        
        bot.sendMessage(chatId, `📱 **حسابات الواتساب الخاصة بك:**\n\n${accListText}`, {
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(chatId)
        });
    } else if (data === "menu_status") {
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, "⚙️ **حالة النظام:**\nالنظام يعمل بنجاح ومستقر.", {
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(chatId)
        });
    } else if (data === "admin_users" && chatId === ADMIN_ID) {
        bot.answerCallbackQuery(query.id);
        const approvedList = db.approvedUsers.map(id => `• \`${id}\``).join('\n');
        const pendingList = db.pendingUsers.length > 0 
            ? db.pendingUsers.map(id => `• \`${id}\``).join('\n') 
            : 'لا يوجد طلبات قائمة.';

        bot.sendMessage(
            chatId, 
            `👑 **إدارة المستخدمين:**\n\n**المستخدمون المعتمدون:**\n${approvedList}\n\n**طلبات الانتظار:**\n${pendingList}`, 
            { parse_mode: 'Markdown', reply_markup: getMainKeyboard(chatId) }
        );
    }
});

console.log("🚀 Server running...");
