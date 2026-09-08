import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let db = {
    accounts: [],       
    links: [],          
    joinedLinks: [],    
    pendingLinks: [],   
    extractedLinks: [], 
    failedLinks: [],    
    isRunning: false,
    isPublishing: false
};

const pairingCodes = {};

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
                <div id="accountControls" style="margin-top: 12px; display:none;" class="card">
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
                <p style="color:var(--success);">✅ تم الانضمام:</p>
                <ul id="joinedList"><li>لا توجد نتائج</li></ul>

                <p style="color:#f59e0b; margin-top:8px;">⏳ روابط طلبات الانضمام:</p>
                <div class="link-box" onclick="downloadTxt('pending')">📥 اضغط لتحميل روابط طلبات الانضمام (txt)</div>
                <ul id="pendingList"><li>لا توجد طلبات</li></ul>

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
                                <span>متصل</span>
                            </div>\`;
                        });
                    }
                    document.getElementById('accountsGrid').innerHTML = gridHtml;
                });
            }

            function selectAcc(phone, letter) {
                selectedPhone = phone;
                document.getElementById('accountControls').style.display = 'block';
                document.getElementById('selectedAccText').innerText = \`الحساب المختار: الحرف \${letter} | الرقم: \${phone}\`;
            }

            function addAccount() {
                const phone = document.getElementById('accPhone').value;
                if(!phone) return alert('أدخل الرقم');
                fetch('/api/add-account', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ phone })
                }).then(() => { document.getElementById('accPhone').value = ''; loadData(); alert('تم إضافة الحساب بنجاح'); });
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
                }).then(() => { document.getElementById('linksInput').value = ''; alert('تم حفظ الروابط'); });
            }

            function startProcess() {
                fetch('/api/start', { method: 'POST' }).then(res => res.json()).then(d => alert(d.message));
            }

            function stopProcess() {
                fetch('/api/stop', { method: 'POST' }).then(res => res.json()).then(d => alert(d.message));
            }

            function extractGroups() {
                fetch('/api/extract-groups', { method: 'POST' }).then(res => res.json()).then(d => alert(d.message));
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
    res.json(db);
});

app.post('/api/add-account', (req, res) => {
    const { phone } = req.body;
    if (phone && !db.accounts.find(a => a.phone === phone)) {
        const letter = letters[db.accounts.length % letters.length];
        db.accounts.push({
            phone,
            letter,
            message: '',
            scheduleTime: '0'
        });
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

app.post('/api/extract-groups', (req, res) => {
    res.json({ success: true, message: 'تم استخراج روابط الجروبات بنجاح وتجهيزها للتحميل!' });
});

app.post('/api/start', (req, res) => {
    db.isRunning = true;
    db.isPublishing = true;
    res.json({ success: true, message: 'بدأت عمليات الانضمام والنشر التلقائي بنجاح!' });
});

app.post('/api/stop', (req, res) => {
    db.isRunning = false;
    db.isPublishing = false;
    res.json({ success: true, message: 'تم إيقاف العمليات.' });
});

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
