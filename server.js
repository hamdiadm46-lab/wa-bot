import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let db = {
    accounts: [],       // { phone, letter, postMessage, scheduleTime, currentIndex }
    links: [],          // روابط عامة مضافة
    requestLinks: [],   // روابط طلبات الانضمام (التي تتطلب موافقة)
    extractedLinks: [], // الروابط المستخرجة من آخر 48 ساعة
    joinedLinks: [], 
    failedLinks: [], 
    isRunning: false,
    isPostingRunning: false
};

const activeSockets = {};
const pairingCodes = {};

function getLetter(index) {
    return String.fromCharCode(65 + index); // A, B, C, ...
}

function getRandomDelay() {
    const min = 30000; 
    const max = 60000; 
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function connectWhatsAppAccount(phone) {
    const authFolder = `./auth_${phone}`;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    activeSockets[phone] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectWhatsAppAccount(phone);
            }
        }
    });

    if (!sock.authState.creds.registered) {
        try {
            setTimeout(async () => {
                const code = await sock.requestPairingCode(phone);
                pairingCodes[phone] = code;
            }, 3000);
        } catch (e) {
            console.log('خطأ في طلب كود الربط:', e);
        }
    }

    return sock;
}

// دالة الانضمام التلقائي (التعرف على طلبات الانضمام والروابط العادية)
async function startAutomation() {
    if (!db.isRunning || db.accounts.length === 0 || db.links.length === 0) return;

    for (let acc of db.accounts) {
        if (!db.isRunning) break;

        if (acc.currentIndex >= db.links.length) {
            acc.currentIndex = 0; 
        }

        let sock = activeSockets[acc.phone];
        if (!sock) {
            sock = await connectWhatsAppAccount(acc.phone);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const batchLinks = db.links.slice(acc.currentIndex, acc.currentIndex + 30);
        
        for (let link of batchLinks) {
            if (!db.isRunning) break;
            acc.currentIndex++;

            try {
                const cleanLink = link.trim();
                const codeMatch = cleanLink.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]{20,})/);
                
                if (!codeMatch) {
                    db.failedLinks.unshift({ link: cleanLink, error: 'رابط غير صالح أو صيغة غير صحيحة' });
                    continue;
                }
                
                const inviteCode = codeMatch[1];
                
                try {
                    const response = await sock.groupAcceptInvite(inviteCode);
                    // إذا تطلب الأمر موافقة مشرف (Request Approval)
                    if (response && (response.includes?.('request') || typeof response === 'string' && response.includes('request'))) {
                        if (!db.requestLinks.includes(cleanLink)) db.requestLinks.unshift(cleanLink);
                    } else {
                        db.joinedLinks.unshift({ link: cleanLink, phone: acc.phone });
                    }
                } catch (err) {
                    const errMsg = err.message || '';
                    if (errMsg.includes('approval') || errMsg.includes('admin') || errMsg.includes('request')) {
                        if (!db.requestLinks.includes(cleanLink)) db.requestLinks.unshift(cleanLink);
                    } else {
                        db.failedLinks.unshift({ link: cleanLink, error: errMsg || 'فشل الانضمام أو المجموعة مغلقة' });
                    }
                }
                
                const delay = getRandomDelay();
                await new Promise(resolve => setTimeout(resolve, delay));

            } catch (e) {
                db.failedLinks.unshift({ link, error: e.message || 'خطأ غير معروف' });
            }
        }
    }
    db.isRunning = false;
}

// دالة استخراج الروابط من آخر 48 ساعة لكل حساب
async function extractRecentLinks() {
    for (let acc of db.accounts) {
        const sock = activeSockets[acc.phone];
        if (!sock) continue;
        try {
            const chats = await sock.groupFetchAllParticipating();
            const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
            
            for (const jid in chats) {
                const group = chats[jid];
                // محاولة جلب رسائل القروب الحديثة (إن وجدت الصلاحية) لاستخراج الروابط
                const messages = await sock.fetchMessages(jid, { count: 50 }).catch(() => []);
                for (const msg of messages) {
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                    const matches = text.match(/https:\/\/chat\.whatsapp\.com\/[0-9A-Za-z_-]{20,}/g);
                    if (matches) {
                        matches.forEach(m => {
                            if (!db.extractedLinks.includes(m)) {
                                db.extractedLinks.push(m);
                            }
                        });
                    }
                }
            }
        } catch (e) {
            console.log('خطأ في استخراج الروابط:', e);
        }
    }
}

// دالة النشر التلقائي في المجموعات لكل حساب بفاصل 20 ثانية
async function startPostingAutomation() {
    db.isPostingRunning = true;
    while (db.isPostingRunning) {
        for (let acc of db.accounts) {
            if (!db.isPostingRunning) break;
            if (!acc.postMessage) continue;

            const sock = activeSockets[acc.phone];
            if (!sock) continue;

            try {
                const chats = await sock.groupFetchAllParticipating();
                for (const jid in chats) {
                    if (!db.isPostingRunning) break;
                    await sock.sendMessage(jid, { text: acc.postMessage });
                    await new Promise(resolve => setTimeout(resolve, 20000)); // 20 ثانية بين كل جروب
                }
            } catch (e) {
                console.log('خطأ أثناء النشر:', e);
            }
        }
        // الانتظار لدورة جديدة أو التحقق كل دقيقة
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

app.get(['/', '/api/status'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة تحكم الواتساب المتقدمة</title>
        <style>
            body { font-family: system-ui, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 15px; }
            .card { background: #1e293b; border-radius: 14px; padding: 18px; margin-bottom: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.4); border: 1px solid #334155; }
            h2 { text-align: center; color: #38bdf8; margin-bottom: 20px; }
            h3 { margin-top: 0; font-size: 17px; border-bottom: 1px solid #334151; padding-bottom: 8px; color: #e2e8f0; }
            .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; transition: 0.2s; }
            .btn:active { transform: scale(0.98); }
            .btn-green { background: #10b981; color: white; }
            .btn-red { background: #ef4444; color: white; }
            .btn-blue { background: #0284c7; color: white; }
            .btn-purple { background: #8b5cf6; color: white; }
            input, textarea { width: 100%; padding: 10px; margin-top: 6px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: white; box-sizing: border-box; }
            ul { padding-right: 20px; max-height: 140px; overflow-y: auto; background: #0f172a; border-radius: 6px; padding: 8px; }
            li { font-size: 13px; margin-bottom: 6px; word-break: break-all; border-bottom: 1px solid #334151; padding-bottom: 4px; }
            .badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; }
            .running { background: #10b981; color: #fff; }
            .stopped { background: #ef4444; color: #fff; }
            .account-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
            .account-box { background: #0f172a; border: 2px solid #38bdf8; border-radius: 10px; padding: 12px; width: calc(50% - 6px); box-sizing: border-box; text-align: center; cursor: pointer; }
            .account-box span { font-size: 22px; font-weight: bold; color: #38bdf8; display: block; margin-bottom: 5px; }
            #loginScreen { position: fixed; inset: 0; background: #0f172a; display: flex; justify-content: center; align-items: center; z-index: 999; }
            .login-card { background: #1e293b; padding: 30px; border-radius: 16px; width: 90%; max-width: 350px; text-align: center; border: 1px solid #334151; }
        </style>
    </head>
    <body>

        <!-- شاشة تسجيل الدخول -->
        <div id="loginScreen">
            <div class="login-card">
                <h3 style="color:#38bdf8;">حماية التطبيق</h3>
                <p style="font-size:13px; color:#94a3b8;">يرجى إدخال رمز المرور للمتابعة</p>
                <input type="password" id="passInput" placeholder="أدخل رمز المرور..." style="text-align:center; font-size:16px;">
                <button class="btn btn-blue" onclick="checkPassword()">دخول</button>
            </div>
        </div>

        <div id="mainApp" style="display:none;">
            <h2>لوحة التحكم المتقدمة</h2>

            <div class="card">
                <h3>حالة النظام</h3>
                <p>الحالة العامة: <span class="badge ${db.isRunning ? 'running' : 'stopped'}">${db.isRunning ? 'يعمل 🚀' : 'متوقف ⏹'}</span></p>
                <p>حالة النشر: <span class="badge ${db.isPostingRunning ? 'running' : 'stopped'}">${db.isPostingRunning ? 'يشر تلقائياً 📢' : 'متوقف 🔕'}</span></p>
                <p>الحسابات المضافة: <b>${db.accounts.length}</b> | إجمالي الروابط: <b>${db.links.length}</b></p>
            </div>

            <div class="card">
                <h3>إضافة حساب واتساب</h3>
                <input type="text" id="accPhone" placeholder="أدخل رقم الهاتف (مثال: 967775890747)">
                <button class="btn btn-blue" onclick="addAccount()">إضافة وربط الحساب</button>
            </div>

            <div class="card">
                <h3>الحسابات المضافة (اضغط على الحرف لعرض الرقم)</h3>
                <div id="accountsList" class="account-grid">جاري التحميل...</div>
            </div>

            <div class="card">
                <h3>إضافة روابط المجموعات العامة للانضمام</h3>
                <textarea id="linksInput" rows="3" placeholder="الصق الروابط هنا (كل رابط في سطر)..."></textarea>
                <button class="btn btn-blue" onclick="addLinks()">حفظ الروابط (بدون تكرار)</button>
            </div>

            <div class="card">
                <h3>استخراج الروابط من آخر 48 ساعة</h3>
                <button class="btn btn-purple" onclick="extractLinksAction()">بدء استخراج الروابط العامة</button>
                <p style="margin-top:10px; font-size:13px;">الروابط المستخرجة (${db.extractedLinks.length}):</p>
                <button class="btn btn-blue" style="background:#047857;" onclick="downloadFile('/api/download/extracted', 'Extracted_Links_48h.txt')">تحميل ملف الروابط المستخرجة (TXT)</button>
            </div>

            <div class="card">
                <h3>روابط طلبات الانضمام (التي تتطلب موافقة)</h3>
                <p style="font-size:13px; color:#38bdf8;">الإجمالي: ${db.requestLinks.length}</p>
                <button class="btn btn-blue" onclick="downloadFile('/api/download/requests', 'Request_Approval_Links.txt')">تحميل روابط طلبات الانضمام كـ TXT</button>
            </div>

            <div class="card">
                <h3>النتائج والسجلات الحية</h3>
                <p style="color:#10b981;">✅ تم الانضمام (${db.joinedLinks.length}):</p>
                <ul>${db.joinedLinks.map(item => `<li><b>[${item.phone}]</b> ${item.link}</li>`).join('') || '<li>لا توجد نتائج بعد</li>'}</ul>

                <p style="color:#ef4444; margin-top:10px;">❌ الأخطاء أو الروابط التالفة (${db.failedLinks.length}):</p>
                <ul>${db.failedLinks.map(item => `<li>🔗 ${item.link}<br><span style="color:#f87171; font-size:11px;">السبب: ${item.error}</span></li>`).join('') || '<li>لا توجد أخطاء</li>'}</ul>
            </div>

            <div class="card">
                <h3>التحكم العام</h3>
                <button class="btn btn-green" onclick="startProcess()">تشغيل الانضمام (30 رابط لكل حساب)</button>
                <button class="btn btn-red" onclick="stopProcess()">إيقاف عمليات الانضمام</button>
                <button class="btn btn-purple" onclick="startPosting()">تشغيل النشر التلقائي في المجموعات</button>
                <button class="btn btn-red" onclick="stopPosting()">إيقاف النشر التلقائي</button>
            </div>
        </div>

        <script>
            function checkPassword() {
                const pass = document.getElementById('passInput').value;
                if(pass === '1997$7') {
                    document.getElementById('loginScreen').style.display = 'none';
                    document.getElementById('mainApp').style.display = 'block';
                    loadData();
                } else {
                    alert('رمز المرور غير صحيح!');
                }
            }

            function loadData() {
                fetch('/api/get-data').then(res => res.json()).then(data => {
                    let accHtml = '';
                    if(data.accounts.length === 0) {
                        accHtml = '<p style="color:#9ca3af; font-size:13px; width:100%; text-align:center;">لا توجد حسابات مضافة.</p>';
                    } else {
                        data.accounts.forEach((acc, index) => {
                            accHtml += \`
                            <div class="account-box" onclick="showAccountDetails('\${acc.phone}', '\${acc.letter}', \${index})">
                                <span>\${acc.letter}</span>
                                <small style="color:#cbd5e1;">كود: \${acc.pairingCode || 'جاهز'}</small>
                            </div>\`;
                        });
                    }
                    document.getElementById('accountsList').innerHTML = accHtml;
                });
            }

            function showAccountDetails(phone, letter, index) {
                let action = prompt(\`الحساب [\${letter}]\\nرقم الهاتف: \\\n\${phone}\\\n\\\nاختر العملية المطلوبة:\\n1. حذف الحساب\\n2. إضافة/تعديل رسالة النشر\\n3. جدولة وقت النشر (نظام 24, مثال 08:20 أو 0 لتبدأ فوراً)\`);
                
                if(action === '1') {
                    if(confirm('هل أنت متأكد من حذف هذا الحساب؟')) {
                        fetch('/api/delete-account', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ index })
                        }).then(() => loadData());
                    }
                } else if(action === '2') {
                    let msg = prompt('أدخل نص الرسالة المراد نشرها في الجروبات لهذا الحساب:');
                    if(msg !== null) {
                        fetch('/api/set-post', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ index, message: msg })
                        }).then(() => alert('تم حفظ النشرة بنجاح'));
                    }
                } else if(action === '3') {
                    let time = prompt('أدخل وقت الجدولة بنظام 24 (مثال 08:20) أو أدخل 0 للبدء فوراً:');
                    if(time !== null) {
                        fetch('/api/set-schedule', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ index, time })
                        }).then(() => alert('تم ضبط وقت الجدولة بنجاح'));
                    }
                }
            }

            function addAccount() {
                const phone = document.getElementById('accPhone').value;
                if(!phone) return alert('يرجى إدخال الرقم');
                fetch('/api/add-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                }).then(() => { document.getElementById('accPhone').value = ''; loadData(); alert('جاري ربط الحساب وتوليد كود الربط إن لم يكن مسجلاً...'); });
            }

            function addLinks() {
                const text = document.getElementById('linksInput').value;
                if(!text) return alert('يرجى لصق الروابط');
                const links = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                fetch('/api/add-links', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ links })
                }).then(res => res.json()).then(data => {
                    document.getElementById('linksInput').value = '';
                    alert('تم حفظ الروابط العامة بدون تكرار! الإجمالي: ' + data.totalLinks);
                    location.reload();
                });
            }

            function extractLinksAction() {
                fetch('/api/extract-links', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            function downloadFile(url, filename) {
                fetch(url).then(res => res.text()).then(text => {
                    const blob = new Blob([text], { type: 'text/plain' });
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = filename;
                    link.click();
                });
            }

            function startProcess() {
                fetch('/api/start', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            function stopProcess() {
                fetch('/api/stop', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            function startPosting() {
                fetch('/api/start-posting', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            function stopPosting() {
                fetch('/api/stop-posting', { method: 'POST' }).then(res => res.json()).then(data => {
                    alert(data.message);
                    location.reload();
                });
            }

            setInterval(loadData, 5000);
        </script>
    </body>
    </html>
    `);
});

app.get('/api/get-data', (req, res) => {
    const updatedAccounts = db.accounts.map(acc => ({
        ...acc,
        pairingCode: pairingCodes[acc.phone] || null
    }));
    res.json({ ...db, accounts: updatedAccounts });
});

app.post('/api/add-account', async (req, res) => {
    const { phone } = req.body;
    if (phone && !db.accounts.find(a => a.phone === phone)) {
        const letter = getLetter(db.accounts.length);
        db.accounts.push({ phone, letter, postMessage: '', scheduleTime: '0', currentIndex: 0 });
        await connectWhatsAppAccount(phone);
    }
    res.json({ success: true, accounts: db.accounts });
});

app.post('/api/delete-account', (req, res) => {
    const { index } = req.body;
    if (index >= 0 && index < db.accounts.length) {
        db.accounts.splice(index, 1);
        // إعادة ترتيب الحروف للأبجدية من جديد
        db.accounts.forEach((acc, i) => acc.letter = getLetter(i));
    }
    res.json({ success: true, accounts: db.accounts });
});

app.post('/api/set-post', (req, res) => {
    const { index, message } = req.body;
    if (db.accounts[index]) {
        db.accounts[index].postMessage = message;
    }
    res.json({ success: true });
});

app.post('/api/set-schedule', (req, res) => {
    const { index, time } = req.body;
    if (db.accounts[index]) {
        db.accounts[index].scheduleTime = time;
    }
    res.json({ success: true });
});

app.post('/api/add-links', (req, res) => {
    const { links } = req.body;
    if (links && Array.isArray(links)) {
        links.forEach(link => {
            if (!db.links.includes(link)) {
                db.links.push(link);
            }
        });
    }
    res.json({ success: true, totalLinks: db.links.length });
});

app.post('/api/extract-links', async (req, res) => {
    await extractRecentLinks();
    res.json({ success: true, message: 'تم الانتهاء من استخراج الروابط الحديثة بنجاح!' });
});

app.get('/api/download/extracted', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(db.extractedLinks.join('\n'));
});

app.get('/api/download/requests', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(db.requestLinks.join('\n'));
});

app.post('/api/start', (req, res) => {
    if (db.accounts.length === 0) return res.json({ success: false, message: 'أضف حساباً واحداً على الأقل!' });
    if (db.links.length === 0) return res.json({ success: false, message: 'أضف روابط مجموعات أولاً!' });
    
    db.isRunning = true;
    startAutomation();
    res.json({ success: true, message: 'بدأت عملية الانضمام والتحقق من طلبات الانضمام بنجاح!' });
});

app.post('/api/stop', (req, res) => {
    db.isRunning = false;
    res.json({ success: true, message: 'تم إيقاف العمليات.' });
});

app.post('/api/start-posting', (req, res) => {
    if (db.accounts.length === 0) return res.json({ success: false, message: 'أضف حساباً أولاً!' });
    startPostingAutomation();
    res.json({ success: true, message: 'بدأ النشر التلقائي في المجموعات (بفاصل 20 ثانية بين كل مجموعة)!' });
});

app.post('/api/stop-posting', (req, res) => {
    db.isPostingRunning = false;
    res.json({ success: true, message: 'تم إيقاف النشر التلقائي.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
