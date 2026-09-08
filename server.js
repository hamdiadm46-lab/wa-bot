import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let db = {
    accounts: [],       // { phone, letter, index, message, scheduleTime, currentIndex }
    links: [],          // روابط عامة للانضمام
    joinedLinks: [],    // تم الانضمام بنجاح
    pendingLinks: [],   // روابط تتطلب طلب انضمام
    extractedLinks: [], // الروابط المستخرجة من الجروبات (آخر 48 ساعة)
    failedLinks: [],    // أخطاء
    isRunning: false,
    isPublishing: false
};

const activeSockets = {};
const pairingCodes = {};

function getRandomDelay(minSec, maxSec) {
    return Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;
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
            if (shouldReconnect) connectWhatsAppAccount(phone);
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

// دالة الانضمام التلقائي (التعامل مع طلبات الانضمام والروابط العادية)
async function startAutomation() {
    if (!db.isRunning || db.accounts.length === 0 || db.links.length === 0) return;

    for (let acc of db.accounts) {
        if (!db.isRunning) break;
        let sock = activeSockets[acc.phone];
        if (!sock) {
            sock = await connectWhatsAppAccount(acc.phone);
            await new Promise(r => setTimeout(r, 5000));
        }

        const batch = db.links.slice(acc.currentIndex, acc.currentIndex + 30);
        for (let link of batch) {
            if (!db.isRunning) break;
            acc.currentIndex++;

            const cleanLink = link.trim();
            const match = cleanLink.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]{20,})/);
            if (!match) {
                db.failedLinks.unshift({ link: cleanLink, error: 'رابط غير صالح' });
                continue;
            }

            try {
                // محاولة الانضمام
                await sock.groupAcceptInvite(match[1]);
                db.joinedLinks.unshift({ link: cleanLink, phone: acc.phone });
            } catch (err) {
                const msg = err.message || '';
                // إذا تطلب الرابط طلب انضمام (Approval)
                if (msg.includes('approval') || msg.includes('admin') || msg.includes('request')) {
                    if (!db.pendingLinks.find(p => p.link === cleanLink)) {
                        db.pendingLinks.unshift({ link: cleanLink, phone: acc.phone });
                    }
                } else {
                    db.failedLinks.unshift({ link: cleanLink, error: msg || 'مجموعة مغلقة أو منتهية' });
                }
            }
            await new Promise(r => setTimeout(r, getRandomDelay(30, 60)));
        }
    }
    db.isRunning = false;
}

// دالة النشر التلقائي في المجموعات (بين كل جروب وجروب 20 ثانية)
async function startPublishing() {
    if (!db.isPublishing) return;

    for (let acc of db.accounts) {
        if (!db.isPublishing) break;
        const sock = activeSockets[acc.phone];
        if (!sock || !acc.message) continue;

        try {
            const chats = await sock.groupFetchAllParticipating();
            const groups = Object.keys(chats);

            for (let gId of groups) {
                if (!db.isPublishing) break;
                try {
                    await sock.sendMessage(gId, { text: acc.message });
                    await new Promise(r => setTimeout(r, 20000)); // 20 ثانية بين كل جروب
                } catch (e) {
                    console.log('خطأ في إرسال الرسالة لجروب:', e);
                }
            }
        } catch (e) {
            console.log('خطأ في جلب مجموعات الحساب:', e);
        }
    }
    db.isPublishing = false;
}

// دالة استخراج روابط الجروبات لآخر 48 ساعة
async function extractUserGroups() {
    const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
    for (let acc of db.accounts) {
        const sock = activeSockets[acc.phone];
        if (!sock) continue;
        try {
            const chats = await sock.groupFetchAllParticipating();
            for (let gId in chats) {
                const group = chats[gId];
                // التحقق من النشاط أو الإنشاء خلال آخر 48 ساعة إن توفرت البيانات
                const createdTime = (group.creation || 0) * 1000;
                if (createdTime === 0 || createdTime >= twoDaysAgo) {
                    // توليد أو محاولة جلب رابط الدعوة إن أمكن أو تخزين معرف المجموعة كمرجع
                    const inviteLink = `https://chat.whatsapp.com/${gId}`;
                    if (!db.extractedLinks.includes(inviteLink)) {
                        db.extractedLinks.push(inviteLink);
                    }
                }
            }
        } catch (e) {
            console.log('خطأ في استخراج المجموعات:', e);
        }
    }
}

app.get(['/', '/api/status'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>لوحة التحكم الذكية - واتساب</title>
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --accent: #3b82f6; --success: #10b981; --danger: #ef4444; --text: #f8fafc; }
            body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 12px; }
            #lockScreen { position: fixed; inset: 0; background: var(--bg); z-index: 9999; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 20px; }
            .card { background: var(--card); border-radius: 14px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); border: 1px solid #334155; }
            h2 { text-align: center; color: var(--success); margin-bottom: 16px; font-size: 20px; }
            h3 { margin-top: 0; font-size: 16px; border-bottom: 1px solid #334151; padding-bottom: 8px; color: #38bdf8; }
            .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; margin-top: 8px; transition: 0.2s; }
            .btn-blue { background: var(--accent); color: white; }
            .btn-green { background: var(--success); color: white; }
            .btn-red { background: var(--danger); color: white; }
            .btn:active { transform: scale(0.98); }
            input, textarea { width: 100%; padding: 10px; margin-top: 6px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: white; box-sizing: border-box; font-size: 14px; }
            .accounts-grid { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
            .account-badge { background: #334155; border: 2px solid var(--accent); border-radius: 10px; padding: 10px; width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: bold; cursor: pointer; position: relative; }
            .account-badge span { font-size: 10px; position: absolute; bottom: 2px; color: #cbd5e1; }
            ul { padding-right: 20px; max-height: 120px; overflow-y: auto; background: #0f172a; border-radius: 6px; padding: 8px; margin: 5px 0; }
            li { font-size: 12px; margin-bottom: 4px; word-break: break-all; border-bottom: 1px solid #1e293b; padding-bottom: 3px; }
            .link-box { background: #0f172a; padding: 10px; border-radius: 6px; text-align: center; cursor: pointer; border: 1px dashed var(--accent); margin-top: 6px; font-weight: bold; color: #38bdf8; }
        </style>
    </head>
    <body>

        <!-- شاشة قفل التطبيق -->
        <div id="lockScreen">
            <div class="card" style="width: 100%; max-width: 320px; text-align: center;">
                <h3>🔐 قفل الحماية</h3>
                <p style="font-size: 13px; color: #94a3b8;">أدخل رمز المرور لفتح التطبيق:</p>
                <input type="password" id="passCode" placeholder="أدخل الرمز هنا..." style="text-align: center; letter-spacing: 2px;">
                <button class="btn btn-blue" onclick="checkUnlock()" style="margin-top: 12px;">دخول</button>
            </div>
        </div>

        <div id="mainApp" style="display:none;">
            <h2>لوحة التحكم الذكية</h2>

            <div class="card">
                <h3>إضافة حساب واتساب جديد</h3>
                <input type="text" id="accPhone" placeholder="رقم الهاتف مع الرمز (مثال: 967775890747)">
                <button class="btn btn-blue" onclick="addAccount()">إضافة الحساب</button>
            </div>

            <div class="card">
                <h3>الحسابات المضافة (اضغط على الرمز لإظهار الرقم)</h3>
                <div id="accountsGrid" class="accounts-grid">جاري التحميل...</div>
                <div id="accountControls" style="margin-top: 12px; display:none;" class="card" style="background:#0f172a;">
                    <p id="selectedAccText" style="font-weight:bold; color:#38bdf8; margin-top:0;"></p>
                    <button class="btn btn-red" onclick="deleteActiveAccount()">حذف الحساب</button>
                    <button class="btn btn-blue" onclick="setAccountMessage()">إضافة / تعديل النشرة</button>
                    <button class="btn btn-green" onclick="setAccountSchedule()">جدولة النشر (وقت/0)</button>
                </div>
            </div>

            <div class="card">
                <h3>إضافة روابط المجموعات (للانضمام)</h3>
                <textarea id="linksInput" rows="3" placeholder="الصق الروابط هنا (كل رابط في سطر)..."></textarea>
                <button class="btn btn-blue" onclick="addLinks()">حفظ الروابط</button>
            </div>

            <div class="card">
                <h3>النتائج والسجلات</h3>
                <p style="color:var(--success);">✅ تم الانضمام (${db.joinedLinks.length}):</p>
                <ul>${db.joinedLinks.map(i => `<li>[${i.phone}] ${i.link}</li>`).join('') || '<li>لا توجد نتائج</li>'}</ul>

                <p style="color:#f59e0b; margin-top:8px;">⏳ روابط طلبات الانضمام (${db.pendingLinks.length}):</p>
                <div class="link-box" onclick="downloadTxt('pending')">📥 اضغط لتحميل روابط طلبات الانضمام (txt)</div>
                <ul>${db.pendingLinks.map(i => `<li>[${i.phone}] ${i.link}</li>`).join('') || '<li>لا توجد طلبات</li>'}</ul>

                <p style="color:#38bdf8; margin-top:8px;">🔗 روابط الجروبات المستخرجة (آخر 48 ساعة):</p>
                <div class="link-box" onclick="downloadTxt('extracted')">📥 اضغط لتحميل الروابط المستخرجة العامة (txt)</div>
            </div>

            <div class="card">
                <h3>التحكم العام والمهام</h3>
                <button class="btn btn-green" onclick="startProcess()">تشغيل عمليات الانضمام والنشر</button>
                <button class="btn btn-red" onclick="stopProcess()" style="margin-top:6px;">إيقاف العمليات</button>
                <button class="btn btn-blue" onclick="extractGroups()" style="margin-top:6px;">استخراج روابط الجروبات (آخر 48 ساعة)</button>
            </div>
        </div>

        <script>
            let selectedPhone = null;

            function checkUnlock() {
                const val = document.getElementById('passCode').value;
                if(val === '1997$7') {
                    localStorage.setItem('unlocked', 'true');
                    document.getElementById('lockScreen').style.display = 'none';
                    document.getElementById('mainApp').style.display = 'block';
                } else {
                    alert('رمز المرور غير صحيح!');
                }
            }

            window.onload = function() {
                if(localStorage.getItem('unlocked') === 'true') {
                    document.getElementById('lockScreen').style.display = 'none';
                    document.getElementById('mainApp').style.display = 'block';
                }
                loadData();
                setInterval(loadData, 4000);
            }

            function loadData() {
                fetch('/api/get-data').then(res => res.json()).then(data => {
                    let gridHtml = '';
                    if(data.accounts.length === 0) {
                        gridHtml = '<p style="font-size:13px; color:#94a3b8;">لا توجد حسابات مضافة.</p>';
                        document.getElementById('accountControls').style.display = 'none';
                    } else {
                        data.accounts.forEach(acc => {
                            gridHtml += \`<div class="account-badge" onclick="selectAcc('\${acc.phone}', '\${acc.letter}')">
                                \${acc.letter}
                                <span>\${acc.pairingCode ? 'متصل' : 'رابط'}</span>
                            </div>\`;
                        });
                    }
                    document.getElementById('accountsGrid').innerHTML = gridHtml;
                });
            }

            function selectAcc(phone, letter) {
                selectedPhone = phone;
                document.getElementById('accountControls').style.display = 'block';
                document.getElementById('selectedAccText.innerHTML' = `الحساب المختار: الحرف \${letter} | الرقم: \${phone}`);
                document.getElementById('selectedAccText').innerText = `الحساب المختار: الحرف ${letter} | الرقم: ${phone}`;
            }

            function addAccount() {
                const phone = document.getElementById('accPhone').value;
                if(!phone) return alert('أدخل الرقم');
                fetch('/api/add-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                }).then(() => { document.getElementById('accPhone').value = ''; loadData(); alert('جاري إضافة الحساب وتوليد كود الربط إن لم يكن مسجلاً'); });
            }

            function deleteActiveAccount() {
                if(!selectedPhone) return;
                fetch('/api/delete-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone: selectedPhone })
                }).then(() => { selectedPhone = null; document.getElementById('accountControls').style.display = 'none'; loadData(); });
            }

            function setAccountMessage() {
                if(!selectedPhone) return;
                const msg = prompt('أدخل نص الرسالة المراد نشرها لهذا الحساب:');
                if(msg !== null) {
                    fetch('/api/set-message', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ phone: selectedPhone, message: msg })
                    }).then(() => alert('تم حفظ النشرة بنجاح'));
                }
            }

            function setAccountSchedule() {
                if(!selectedPhone) return;
                const time = prompt('أدخل وقت الجدولة بنظام 24 (مثال 08:20) أو أدخل 0 للبدء فوراً:');
                if(time !== null) {
                    fetch('/api/set-schedule', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ phone: selectedPhone, scheduleTime: time })
                    }).then(() => alert('تم تعيين جدول النشر'));
                }
            }

            function addLinks() {
                const text = document.getElementById('linksInput').value;
                if(!text) return;
                const links = text.split('\\n').map(l => l.trim()).filter(l => l);
                fetch('/api/add-links', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ links })
                }).then(() => { document.getElementById('linksInput').value = ''; alert('تم حفظ الروابط'); location.reload(); });
            }

            function startProcess() {
                fetch('/api/start', { method: 'POST' }).then(res => res.json()).then(d => alert(d.message));
            }

            function stopProcess() {
                fetch('/api/stop', { method: 'POST' }).then(res => res.json()).then(d => alert(d.message));
            }

            function extractGroups() {
                fetch('/api/extract-groups', { method: 'POST' }).then(res => res.json()).then(d => {
                    alert('تم استخراج روابط الجروبات بنجاح!');
                    location.reload();
                });
            }

            function downloadTxt(type) {
                window.location.href = '/api/download/' + type;
            }
        </script>
    </body>
    </html>
    `);
});

const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

app.get('/api/get-data', (req, res) => {
    const accs = db.accounts.map(acc => ({
        ...acc,
        pairingCode: pairingCodes[acc.phone] || null
    }));
    res.json({ ...db, accounts: accs });
});

app.post('/api/add-account', async (req, res) => {
    const { phone } = req.body;
    if (phone && !db.accounts.find(a => a.phone === phone)) {
        const letter = letters[db.accounts.length % letters.length];
        db.accounts.push({
            phone,
            letter,
            message: '',
            scheduleTime: '0',
            currentIndex: 0
        });
        await connectWhatsAppAccount(phone);
    }
    res.json({ success: true });
});

app.post('/api/delete-account', (req, res) => {
    const { phone } = req.body;
    db.accounts = db.accounts.filter(a => a.phone !== phone);
    res.json({ success: true });
});

app.post('/api/set-message', (req, res) => {
    const { phone, message } = req.body;
    const acc = db.accounts.find(a => a.phone === phone);
    if (acc) acc.message = message;
    res.json({ success: true });
});

app.post('/api/set-schedule', (req, res) => {
    const { phone, scheduleTime } = req.body;
    const acc = db.accounts.find(a => a.phone === phone);
    if (acc) acc.scheduleTime = scheduleTime;
    res.json({ success: true });
});

app.post('/api/add-links', (req, res) => {
    const { links } = req.body;
    links.forEach(l => {
        if (!db.links.includes(l)) db.links.push(l);
    });
    res.json({ success: true });
});

app.post('/api/extract-groups', async (req, res) => {
    await extractUserGroups();
    res.json({ success: true });
});

app.post('/api/start', (req, res) => {
    db.isRunning = true;
    db.isPublishing = true;
    startAutomation();
    startPublishing();
    res.json({ success: true, message: 'بدأت عمليات الانضمام والنشر التلقائي بنجاح!' });
});

app.post('/api/stop', (req, res) => {
    db.isRunning = false;
    db.isPublishing = false;
    res.json({ success: true, message: 'تم إيقاف العمليات.' });
});

// تحميل الملفات بصيغة txt
app.get('/api/download/:type', (req, res) => {
    const type = req.params.type;
    let dataList = [];
    let fileName = 'links.txt';

    if (type === 'pending') {
        dataList = db.pendingLinks.map(i => i.link);
        fileName = 'pending_approval_links.txt';
    } else if (type === 'extracted') {
        dataList = db.extractedLinks;
        fileName = 'extracted_groups_48h.txt';
    }

    res.setHeader('Content-disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-type', 'text/plain');
    res.send(dataList.join('\n'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
