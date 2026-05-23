const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();    
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Rate Limiting
const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'طلبات كثيرة، حاول مرة أخرى بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'محاولات تسجيل دخول كثيرة، حاول بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false,
});

const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'تم إنشاء عدد كبير من الحسابات، حاول بعد ساعة' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(generalLimiter); 
     
// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'helaxia_super_secret_key_3911';

// Nodemailer
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,                    
    secure: false,                
    auth: { 
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    timeout: 10000,               
    connectionTimeout: 10000,     
    tls: {
        ciphers: 'SSLv3'          
    }
});

// Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage, 
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('مسموح فقط بملفات الصور (jpg, png, gif, webp)'));
        }
    }
});

const uploadSimple = multer({ dest: 'uploads/' });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Compression
const compression = require('compression');
app.use(compression());

// CORS + Helmet
const cors = require('cors');
const helmet = require('helmet');

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

// Logging
const winston = require('winston');
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'combined.log') }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

let db;
let pendingCodes = {};

// المتغيرات العامة للجلسات
let pendingAdminTokens = {};
let adminSessions = {};
let pendingAdminSignupCodes = {};
let pendingSettingsCodes = {};
let pendingExecutiveCodes = {};

let pendingCashierTokens = {};
let cashierSessions = {};
let pendingCashierSignups = {};

let pendingCashierResetTokens = {};
let pendingVendorResetTokens = {};
let pendingAdminResetTokens = {};
let pendingClientResetTokens = {};

let pendingVendorSignups = {};

let pendingCityDeleteTokens = {};

// دوال مساعدة آمنة
function generateCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

// ✅ دالة آمنة للاستعلامات (SELECT)
function dbQuery(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        if (params.length > 0) {
            stmt.bind(params);
        }
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (err) {
        logger.error(`Query error: ${sql} - ${err.message}`);
        return [];
    }
}

// ✅ دالة آمنة للعمليات (INSERT, UPDATE, DELETE)
function dbRun(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        if (params.length > 0) {
            stmt.bind(params);
        }
        stmt.step();
        stmt.free();
        saveDB();
        return true;
    } catch (err) {
        logger.error(`Run error: ${sql} - ${err.message}`);
        throw err;
    }
}

// ✅ دالة آمنة لجلب صف واحد
function dbGet(sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        if (params.length > 0) {
            stmt.bind(params);
        }
        if (stmt.step()) {
            const result = stmt.getAsObject();
            stmt.free();
            return result;
        }
        stmt.free();
        return null;
    } catch (err) {
        logger.error(`Get error: ${sql} - ${err.message}`);
        return null;
    }
}

function getExecutiveEmail() {
    const result = dbQuery("SELECT value FROM settings WHERE key = 'executive_email'");
    if (result.length > 0 && result[0].value) {
        return result[0].value;
    }
    return 'mhmdlwbany43@gmail.com';
}

// دوال JWT للتحقق
function getVendorIdFromToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'vendor') return null;
        return decoded.id;
    } catch(e) {
        return null;
    }
}

function getAdminFromToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') return null;
        return decoded;
    } catch(e) {
        return null;
    }
}

function getCashierFromToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'cashier') return null;
        return decoded;
    } catch(e) {
        return null;
    }
}

// دالة إرسال الكود عبر الإيميل
async function sendEmailCode(email, code, type = 'login') {
    let subject = '';
    let htmlContent = '';
    
    if (type === 'login') {
        subject = '🔐 كود الدخول إلى لوحة HELAXIA';
        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;">
                <div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA</h1></div>
                <div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;">
                    <h2 style="color: #2C4C6C;">🔐 كود الدخول إلى لوحة التحكم</h2>
                    <div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;">
                        <span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${code}</span>
                    </div>
                    <p style="color: #5A8CAA;">هذا الكود صالح لمدة 10 دقائق فقط</p>
                </div>
            </div>
        `;
    } else if (type === 'signup') {
        subject = '🔐 كود تفعيل حساب مدير جديد - HELAXIA';
        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;">
                <div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA ADMIN</h1></div>
                <div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;">
                    <h2 style="color: #2C4C6C;">🔐 كود إنشاء حساب مدير جديد</h2>
                    <div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;">
                        <span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${code}</span>
                    </div>
                    <p style="color: #5A8CAA;">هذا الكود صالح لمدة 10 دقائق</p>
                </div>
            </div>
        `;
    } else if (type === 'cashier_signup') {
        subject = '💰 كود إنشاء حساب أمين صندوق جديد - HELAXIA';
        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;">
                <div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA CASHIER</h1></div>
                <div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;">
                    <h2 style="color: #2C4C6C;">💰 كود إنشاء حساب أمين صندوق جديد</h2>
                    <div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;">
                        <span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${code}</span>
                    </div>
                    <p style="color: #5A8CAA;">هذا الكود صالح لمدة 10 دقائق</p>
                </div>
            </div>
        `;
    } else if (type === 'executive') {
        subject = '👑 كود الوصول إلى صلاحيات المدير التنفيذي - HELAXIA';
        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;">
                <div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA EXECUTIVE</h1></div>
                <div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;">
                    <h2 style="color: #2C4C6C;">👑 كود الوصول إلى صلاحيات المدير التنفيذي</h2>
                    <div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;">
                        <span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${code}</span>
                    </div>
                    <p style="color: #5A8CAA;">هذا الكود صالح لمدة 10 دقائق</p>
                </div>
            </div>
        `;
    }
    
    try {
        await transporter.sendMail({
            from: '"HELAXIA" <mhmdlwbany43@gmail.com>',
            to: email,
            subject: subject,
            html: htmlContent
        });
        console.log(`✅ كود ${type} أرسل إلى ${email}`);
        return true;
    } catch (err) {
        console.log(`❌ فشل إرسال الكود إلى ${email}:`, err);
        return false;
    }
}

// قاعدة البيانات
async function initDB() {
    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'helaxia.db');
    
    if (fs.existsSync(dbPath)) {
        const dbData = fs.readFileSync(dbPath);
        db = new SQL.Database(dbData);
        console.log('✅ Database connected');
    } else {
        console.log('🆕 Creating new database...');
        db = new SQL.Database();
        
        // إنشاء الجداول الأساسية
        db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'customer', is_verified INTEGER DEFAULT 0, verification_code TEXT, status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS stores (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, logo TEXT, description TEXT, whatsapp TEXT, phone TEXT, payment_proof_image TEXT DEFAULT '', city_id INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', rating REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT 0, store_id INTEGER DEFAULT 0, display_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER DEFAULT 0, name TEXT NOT NULL, description TEXT, fabric_type TEXT, sizes TEXT, colors TEXT, base_price INTEGER NOT NULL, image_url TEXT, images TEXT, is_featured INTEGER DEFAULT 0, is_global INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, category_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, UNIQUE(product_id, category_id))`);
        db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT UNIQUE NOT NULL, customer_id INTEGER, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, notes TEXT, items TEXT NOT NULL, total INTEGER NOT NULL, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, shipping_cost REAL DEFAULT 0, payment_status TEXT DEFAULT 'pending', pickup_location TEXT DEFAULT '')`);
        db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS cities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_en TEXT NOT NULL, display_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS financial_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_number TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL, vendor_id INTEGER NOT NULL, amount REAL NOT NULL, shipping_fee_vendor_share REAL DEFAULT 0, net_amount REAL NOT NULL, status TEXT DEFAULT 'pending', transaction_type TEXT DEFAULT 'sale', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS vendor_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER UNIQUE NOT NULL, total_earned REAL DEFAULT 0, pending_balance REAL DEFAULT 0, pending_withdrawal REAL DEFAULT 0, withdrawn_balance REAL DEFAULT 0, last_updated DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS withdrawal_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, request_number TEXT UNIQUE NOT NULL, vendor_id INTEGER NOT NULL, amount REAL NOT NULL, status TEXT DEFAULT 'pending', notes TEXT, requested_at DATETIME DEFAULT CURRENT_TIMESTAMP, processed_at DATETIME)`);
        
        // إضافة الإعدادات الافتراضية
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_whatsapp', '963995607915')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_email', 'mhmdlwbany43@gmail.com')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('exchange_rate', '13000')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('executive_email', 'mhmdlwbany43@gmail.com')");
        
        // إضافة المدن الافتراضية
        const defaultCities = [
            { name: 'دمشق', name_en: 'Damascus', order: 1 },
            { name: 'حلب', name_en: 'Aleppo', order: 2 },
            { name: 'حمص', name_en: 'Homs', order: 3 },
            { name: 'اللاذقية', name_en: 'Latakia', order: 4 },
            { name: 'طرطوس', name_en: 'Tartus', order: 5 },
            { name: 'دير الزور', name_en: 'Deir ez-Zor', order: 6 },
            { name: 'الرقة', name_en: 'Raqqa', order: 7 },
            { name: 'الحسكة', name_en: 'Hasakah', order: 8 },
            { name: 'إدلب', name_en: 'Idlib', order: 9 },
            { name: 'القامشلي', name_en: 'Qamishli', order: 10 }
        ];
        const stmt = db.prepare("INSERT INTO cities (name, name_en, display_order) VALUES (?, ?, ?)");
        for (const city of defaultCities) {
            stmt.bind([city.name, city.name_en, city.order]);
            stmt.step();
            stmt.reset();
        }
        stmt.free();
        
        saveDB();
        console.log('✅ Database created with all tables');
    }
    
    // تحديث الجداول القديمة
try { db.run("ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0"); } catch(e) {}
try { db.run("ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'pending'"); } catch(e) {}
try { db.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'"); } catch(e) {}
try { db.run("ALTER TABLE orders ADD COLUMN pickup_location TEXT DEFAULT ''"); } catch(e) {}
try { db.run("ALTER TABLE orders ADD COLUMN store_id INTEGER DEFAULT 0"); } catch(e) {}
}

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(path.join(__dirname, 'helaxia.db'), buffer);
}

// نسخ احتياطي تلقائي كل ساعة
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
    console.log('✅ مجلد النسخ الاحتياطي تم إنشاؤه');
}

function createBackup() {
    try {
        const date = new Date();
        const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}-${String(date.getMinutes()).padStart(2,'0')}`;
        const backupFileName = `helaxia_backup_${dateStr}.db`;
        const backupPath = path.join(backupDir, backupFileName);
        
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(backupPath, buffer);
        
        console.log(`💾 نسخة احتياطية: ${backupFileName}`);
        
        const backups = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('helaxia_backup_'))
            .sort()
            .reverse();
        
        if (backups.length > 24) {
            for (let i = 24; i < backups.length; i++) {
                fs.unlinkSync(path.join(backupDir, backups[i]));
                console.log(`🗑️ حذف نسخة قديمة: ${backups[i]}`);
            }
        }
    } catch (err) {
        console.error('❌ فشل إنشاء نسخة احتياطية:', err.message);
    }
}

setInterval(createBackup, 60 * 60 * 1000);
setTimeout(createBackup, 10000);
console.log('⏰ نظام النسخ الاحتياطي جاهز (كل ساعة)');

// ==================== API: تسجيل العميل ====================
app.post('/api/auth/signup', signupLimiter, async (req, res) => {
    const schema = Joi.object({
        name: Joi.string().min(3).max(50).required(),
        email: Joi.string().email().required(),
        password: Joi.string().min(6).max(50).required(),
        phone: Joi.string().allow('', null).optional().default('')
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { name, email, password, phone } = value;
    
    const existing = dbQuery("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) return res.status(400).json({ error: 'البريد موجود' });
    
    const hashed = await bcrypt.hash(password, 10);
    const code = generateCode();
    dbRun("INSERT INTO users (name, email, password, phone, verification_code) VALUES (?, ?, ?, ?, ?)", 
        [name, email, hashed, phone, code]);
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><h1 style="color: #2C4C6C;">HELAXIA</h1><p>مرحباً ${name},</p><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px;"><span style="font-size: 2rem; font-weight: bold; color: #2C4C6C;">${code}</span></div><p>هذا الرمز صالح لتأكيد حسابك</p></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA" <mhmdlwbany43@gmail.com>', to: email, subject: '✨ رمز تأكيد حساب HELAXIA ✨', html: htmlContent });
        console.log(`✅ إيميل التأكيد أرسل إلى ${email}`);
    } catch (err) {
        console.log(`⚠️ فشل إرسال الإيميل، لكن الحساب اتعمل. الكود: ${code}`);
    }
    
    res.json({ success: true, message: 'تم إنشاء الحساب بنجاح، تم إرسال رمز التأكيد إلى بريدك' });
});

app.post('/api/auth/verify', (req, res) => {
    const { email, code } = req.body;
    const user = dbGet("SELECT id, verification_code FROM users WHERE email = ?", [email]);
    if (!user || user.verification_code !== code) return res.status(401).json({ error: 'رمز خاطئ' });
    dbRun("UPDATE users SET is_verified = 1, verification_code = NULL WHERE id = ?", [user.id]);
    res.json({ success: true });
});

// إعادة إرسال رمز التأكيد
app.post('/api/auth/resend-code', async (req, res) => {
    const { email } = req.body;
    
    const user = dbGet("SELECT id, name, verification_code FROM users WHERE email = ? AND is_verified = 0", [email]);
    if (!user) {
        return res.status(404).json({ error: 'المستخدم غير موجود أو تم تأكيده مسبقاً' });
    }
    
    const code = generateCode();
    dbRun("UPDATE users SET verification_code = ? WHERE id = ?", [code, user.id]);
    
    const htmlContent = `<div style="...">${code}</div>`; // نفس قالب الإيميل
    
    try {
        await transporter.sendMail({
            from: '"HELAXIA" <mhmdlwbany43@gmail.com>',
            to: email,
            subject: '✨ رمز تأكيد حساب HELAXIA ✨',
            html: htmlContent
        });
        res.json({ success: true, message: 'تم إعادة إرسال الرمز' });
    } catch(err) {
        res.status(500).json({ error: 'فشل إرسال الرمز' });
    }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    logger.info(`محاولة تسجيل دخول من: ${req.body.email}`);
    
    const schema = Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(1).required()
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { email, password } = value;
    
    const user = dbGet("SELECT id, name, email, password, is_verified, status, role FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ error: 'بيانات خاطئة' });
    
    if (user.is_verified !== 1) return res.status(401).json({ error: 'يرجى تأكيد البريد أولاً' });
    if (user.status !== 'active') return res.status(401).json({ error: 'حسابك معطل' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'بيانات خاطئة' });
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/vendor-login', loginLimiter, async (req, res) => {
    const schema = Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(1).required()
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { email, password } = value;
    
    const user = dbGet("SELECT id, name, email, password, role, status FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ error: 'بيانات خاطئة' });
    
    if (user.role !== 'vendor') return res.status(401).json({ error: 'هذا الحساب ليس تاجراً' });
    if (user.status !== 'active') return res.status(401).json({ error: 'حسابك معطل' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'بيانات خاطئة' });
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
});

// ==================== API: الأقسام والمنتجات والمتاجر ====================
app.get('/api/categories/all', (req, res) => {
    const categories = dbQuery("SELECT * FROM categories ORDER BY parent_id, display_order");
    res.json(categories);
});

app.get('/api/categories/main', (req, res) => {
    const categories = dbQuery("SELECT id, name FROM categories WHERE parent_id = 0 ORDER BY display_order");
    res.json(categories);
});

app.post('/api/categories', (req, res) => {
    const { name, parent_id, store_id, display_order } = req.body;
    dbRun("INSERT INTO categories (name, parent_id, store_id, display_order) VALUES (?, ?, ?, ?)", 
        [name, parent_id || 0, store_id || 0, display_order || 0]);
    res.json({ message: 'Category added' });
});

app.delete('/api/categories/:id', (req, res) => {
    const categoryId = req.params.id;
    dbRun("DELETE FROM product_categories WHERE category_id = ?", [categoryId]);
    dbRun("DELETE FROM categories WHERE id = ?", [categoryId]);
    dbRun("DELETE FROM categories WHERE parent_id = ?", [categoryId]);
    res.json({ message: 'Category deleted' });
});

// ==================== API: المنتجات ====================
app.get('/api/products', (req, res) => {
    const products = dbQuery("SELECT * FROM products");
    const formatted = products.map(p => ({ 
        id: p.id, name: p.name, base_price: p.base_price, 
        images: JSON.parse(p.images || '[]'),
        description: p.description, fabric_type: p.fabric_type, sizes: p.sizes, colors: p.colors,
        store_id: p.store_id, is_featured: p.is_featured 
    }));
    res.json(formatted);
});

app.get('/api/products/by-category/:id', (req, res) => {
    const categoryId = req.params.id;
    const products = dbQuery(`
        SELECT p.id, p.name, p.base_price, p.images, p.fabric_type, p.sizes, p.colors, p.description
        FROM products p
        INNER JOIN product_categories pc ON p.id = pc.product_id
        WHERE pc.category_id = ?
    `, [categoryId]);
    const formatted = products.map(p => ({ 
        id: p.id, name: p.name, base_price: p.base_price, 
        images: JSON.parse(p.images || '[]'),
        fabric_type: p.fabric_type, sizes: p.sizes, colors: p.colors, description: p.description
    }));
    res.json(formatted);
});

app.post('/api/vendor/products/full', uploadSimple.fields([
    { name: 'images', maxCount: 6 },
    { name: 'name' },
    { name: 'base_price' },
    { name: 'description' },
    { name: 'sizes' },
    { name: 'colors' },
    { name: 'fabric_type' },
    { name: 'category_id' }
]), (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const schema = Joi.object({
        name: Joi.string().min(2).max(100).required(),
        base_price: Joi.number().integer().min(1).max(99999999).required(),
        description: Joi.string().allow('').max(1000).optional(),
        sizes: Joi.string().allow('').max(200).optional(),
        colors: Joi.string().allow('').max(200).optional(),
        fabric_type: Joi.string().allow('').max(100).optional(),
        category_id: Joi.any().optional()
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { name, base_price, description, sizes, colors, fabric_type, category_id } = value;    
    let imageUrls = [];
    if (req.files && req.files['images'] && req.files['images'].length) {
        imageUrls = req.files['images'].map(file => `/uploads/${file.filename}`);
    }
    const imagesJson = JSON.stringify(imageUrls);
    
    const store = dbGet("SELECT id FROM stores WHERE vendor_id = ?", [vendorId]);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }
    const storeId = store.id;
    
    dbRun(`INSERT INTO products (store_id, name, description, fabric_type, sizes, colors, base_price, images) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
        [storeId, name, description || '', fabric_type || '', sizes || '', colors || '', base_price, imagesJson]);
    
    const newProductId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    if (category_id && category_id !== 'null' && category_id !== 'undefined') {
        dbRun("INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)", [newProductId, category_id]);
    }
    res.json({ message: 'Product added', images: imageUrls });
});

app.put('/api/vendor/products/:id', uploadSimple.array('images', 6), (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, base_price, description, sizes, colors, fabric_type } = req.body;
    
    // التحقق من ملكية المنتج
    const product = dbGet("SELECT p.* FROM products p JOIN stores s ON p.store_id = s.id WHERE p.id = ? AND s.vendor_id = ?", [req.params.id, vendorId]);
    if (!product) return res.status(403).json({ error: 'غير مصرح بتعديل هذا المنتج' });
    
    let imageUrls = [];
    if (req.files && req.files.length) {
        imageUrls = req.files.map(file => `/uploads/${file.filename}`);
    }
    
    if (imageUrls.length > 0) {
        const imagesJson = JSON.stringify(imageUrls);
        dbRun("UPDATE products SET images = ? WHERE id = ?", [imagesJson, req.params.id]);
    }
    
    dbRun(`UPDATE products SET 
            name = ?, 
            base_price = ?, 
            description = ?, 
            sizes = ?, 
            colors = ?, 
            fabric_type = ?
            WHERE id = ?`, 
        [name, base_price, description || '', sizes || '', colors || '', fabric_type || '', req.params.id]);
    
    res.json({ message: 'Product updated' });
});

app.get('/api/vendor/products/:id', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const product = dbGet("SELECT p.* FROM products p JOIN stores s ON p.store_id = s.id WHERE p.id = ? AND s.vendor_id = ?", [req.params.id, vendorId]);
    if (!product) return res.status(404).json({ error: 'Not found' });
    
    res.json({ 
        id: product.id, name: product.name, description: product.description, fabric_type: product.fabric_type, 
        sizes: product.sizes, colors: product.colors, base_price: product.base_price, 
        images: JSON.parse(product.images || '[]')
    });
});

app.delete('/api/vendor/products/:id', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    // التحقق من ملكية المنتج
    const product = dbGet("SELECT p.* FROM products p JOIN stores s ON p.store_id = s.id WHERE p.id = ? AND s.vendor_id = ?", [req.params.id, vendorId]);
    if (!product) return res.status(403).json({ error: 'غير مصرح بحذف هذا المنتج' });
    
    dbRun("DELETE FROM product_categories WHERE product_id = ?", [req.params.id]);
    dbRun("DELETE FROM products WHERE id = ?", [req.params.id]);
    res.json({ message: 'Product deleted' });
});

// ==================== API للمتاجر ====================
app.get('/api/stores', (req, res) => {
    const cityId = req.query.city_id || 0;
    let query = "SELECT id, name, slug, logo, rating FROM stores WHERE status = 'active'";
    let params = [];
    if (cityId && cityId != 0) {
        query += " AND city_id = ?";
        params = [cityId];
    }
    const stores = dbQuery(query, params);
    res.json(stores);
});

app.get('/api/stores/:slug', (req, res) => {
    const slug = req.params.slug;
    const store = dbGet("SELECT id, name, slug, logo, description, rating FROM stores WHERE slug = ? AND status = 'active'", [slug]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
});

app.get('/api/stores/:slug/products', (req, res) => {
    const slug = req.params.slug;
    const store = dbGet("SELECT id FROM stores WHERE slug = ?", [slug]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const products = dbQuery("SELECT id, name, base_price, images FROM products WHERE store_id = ?", [store.id]);
    const formatted = products.map(p => ({ 
        id: p.id, name: p.name || 'منتج بدون اسم', 
        base_price: p.base_price || 0, 
        images: JSON.parse(p.images || '[]')
    }));
    res.json(formatted);
});

// ==================== API: الطلبات والإعدادات ====================
app.get('/api/orders', (req, res) => {
    const orders = dbQuery("SELECT id, order_number, created_at, customer_name, customer_phone, notes, items, total, status, shipping_cost, payment_status FROM orders ORDER BY id DESC");
    res.json(orders);
});

app.post('/api/orders', (req, res) => {
    const { order_number, customer_name, customer_phone, notes, items, total } = req.body;
    
    let verifiedTotal = 0;
    try {
        const itemsArray = JSON.parse(items);
        for (const item of itemsArray) {
            const product = dbGet("SELECT base_price FROM products WHERE id = ?", [item.id]);
            if (product) {
                const realPrice = product.base_price;
                verifiedTotal += realPrice * (item.quantity || 1);
            }
        }
    } catch(e) {}
    
    const finalTotal = verifiedTotal > 0 ? verifiedTotal : (total || 0);
    
// احسب store_id من أول منتج في الطلب
let storeId = 0;
try {
    const itemsArray = JSON.parse(items);
    if (itemsArray.length > 0 && itemsArray[0].id) {
        const product = dbGet("SELECT store_id FROM products WHERE id = ?", [itemsArray[0].id]);
        if (product) storeId = product.store_id || 0;
    }
} catch(e) {}

dbRun(`INSERT INTO orders (order_number, customer_name, customer_phone, notes, items, total, status, shipping_cost, payment_status, store_id) 
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 'pending', ?)`,
    [order_number, customer_name, customer_phone, notes || '', items, finalTotal, storeId]);
    
    res.json({ success: true, message: 'Order created', order_number, total: finalTotal });
});

app.put('/api/orders/:id/status', (req, res) => {
    const { status } = req.body;
    dbRun("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ message: 'Order status updated' });
});

app.delete('/api/orders/:id', (req, res) => {
    dbRun("DELETE FROM orders WHERE id = ?", [req.params.id]);
    res.json({ message: 'Order deleted' });
});

app.put('/api/orders/:id/confirm-receipt', (req, res) => {
    const orderId = req.params.id;
    
    // جلب الطلب للتأكد من وجوده
    const order = dbGet("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) {
        return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    
    // التحقق من أن حالة الطلب مناسبة للتأكيد (shipped)
    if (order.status !== 'shipped') {
        return res.status(400).json({ error: 'لا يمكن تأكيد استلام طلب لم يتم شحنه بعد' });
    }
    
    // تحديث حالة الطلب إلى delivered
    dbRun("UPDATE orders SET status = 'delivered' WHERE id = ?", [orderId]);
    
    // هنا يمكن إضافة منطق لتحويل المبلغ إلى رصيد التاجر
    // تحديث financial_transactions إلى released
    
    res.json({ success: true, message: 'تم تأكيد استلام المنتج بنجاح' });
});

app.get('/api/settings', (req, res) => {
    const settingsList = dbQuery("SELECT * FROM settings");
    const settings = {};
    settingsList.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
});

app.put('/api/settings', (req, res) => {
    const { admin_whatsapp, admin_email, exchange_rate, executive_email } = req.body;
    if (admin_whatsapp) dbRun("UPDATE settings SET value = ? WHERE key = 'admin_whatsapp'", [admin_whatsapp]);
    if (admin_email) dbRun("UPDATE settings SET value = ? WHERE key = 'admin_email'", [admin_email]);
    if (exchange_rate) dbRun("UPDATE settings SET value = ? WHERE key = 'exchange_rate'", [exchange_rate]);
    if (executive_email) dbRun("UPDATE settings SET value = ? WHERE key = 'executive_email'", [executive_email]);
    res.json({ message: 'Settings updated' });
});

// ==================== API: التاجر ====================
app.post('/api/vendor/apply', uploadSimple.single('logo'), (req, res) => {
    const { name, description, phone, email, userId } = req.body;
    let logo_url = '';
    if (req.file) logo_url = `/uploads/${req.file.filename}`;
    const slug = name.toLowerCase().replace(/[^\u0600-\u06FFa-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    try {
        if (userId && userId !== 'undefined') {
            dbRun("UPDATE users SET role = 'vendor' WHERE id = ?", [userId]);
            dbRun(`INSERT INTO stores (vendor_id, name, slug, description, logo, whatsapp, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`, 
                [userId, name, slug, description || '', logo_url, phone || '']);
        } else {
            const hashedPassword = bcrypt.hashSync('123456', 10);
            dbRun(`INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, 'vendor')`, 
                [name, email, hashedPassword, phone || '']);
            const newUserId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
            dbRun(`INSERT INTO stores (vendor_id, name, slug, description, logo, whatsapp, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`, 
                [newUserId, name, slug, description || '', logo_url, phone || '']);
        }
        res.json({ success: true, message: 'تم إرسال طلبك، سيتم التواصل معك قريباً' });
    } catch(err) { 
        res.status(500).json({ error: 'حدث خطأ في حفظ البيانات' }); 
    }
});

app.get('/api/vendor/categories', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const store = dbGet("SELECT id FROM stores WHERE vendor_id = ?", [vendorId]);
    if (!store) return res.json([]);
    const categories = dbQuery("SELECT id, name FROM categories WHERE store_id = ? AND parent_id != 0 ORDER BY display_order", [store.id]);
    res.json(categories);
});

app.post('/api/vendor/categories', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name } = req.body;
    const store = dbGet("SELECT id FROM stores WHERE vendor_id = ?", [vendorId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    dbRun("INSERT INTO categories (name, parent_id, store_id) VALUES (?, ?, ?)", [name, store.id, store.id]);
    res.json({ message: 'Category added' });
});

app.get('/api/vendor/categories/:id/products', (req, res) => {
    const catId = req.params.id;
    const products = dbQuery(`
        SELECT p.id, p.name, p.base_price, p.image_url
        FROM products p
        INNER JOIN product_categories pc ON p.id = pc.product_id
        WHERE pc.category_id = ?
    `, [catId]);
    res.json(products);
});

app.get('/api/vendor/products/stats', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const store = dbGet("SELECT id FROM stores WHERE vendor_id = ?", [vendorId]);
    if (!store) return res.json([]);
    const products = dbQuery("SELECT * FROM products WHERE store_id = ?", [store.id]);
    const formatted = products.map(p => {
        const ordersCount = dbGet("SELECT COUNT(*) as count FROM orders WHERE items LIKE ?", [`%"id":${p.id}%`]);
        const shippedCount = dbGet("SELECT COUNT(*) as count FROM orders WHERE items LIKE ? AND status='shipped'", [`%"id":${p.id}%`]);
        return { 
            id: p.id, name: p.name, base_price: p.base_price, image_url: p.image_url, 
            times_ordered: ordersCount?.count || 0, times_shipped: shippedCount?.count || 0 
        };
    });
    res.json(formatted);
});

app.get('/api/vendor/store', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const store = dbGet(`
        SELECT s.*, c.name as city_name 
        FROM stores s 
        LEFT JOIN cities c ON s.city_id = c.id 
        WHERE s.vendor_id = ?
    `, [vendorId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
});

app.put('/api/vendor/store', uploadSimple.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'paymentProofImage', maxCount: 1 }
]), (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, description, whatsapp, city_id } = req.body;
    let logo_url = '';
    let payment_proof_image = '';
    
    const currentStore = dbGet("SELECT logo, payment_proof_image FROM stores WHERE vendor_id = ?", [vendorId]);
    
    if (req.files && req.files['logo'] && req.files['logo'][0]) {
        logo_url = `/uploads/${req.files['logo'][0].filename}`;
    } else if (currentStore) {
        logo_url = currentStore.logo || '';
    }
    
    if (req.files && req.files['paymentProofImage'] && req.files['paymentProofImage'][0]) {
        payment_proof_image = `/uploads/${req.files['paymentProofImage'][0].filename}`;
    } else if (currentStore) {
        payment_proof_image = currentStore.payment_proof_image || '';
    }
    
    const newCityId = city_id ? parseInt(city_id) : 0;
    
    dbRun(`UPDATE stores SET name = ?, logo = ?, description = ?, whatsapp = ?, payment_proof_image = ?, city_id = ? WHERE vendor_id = ?`, 
        [name, logo_url, description || '', whatsapp || '', payment_proof_image, newCityId, vendorId]);
    res.json({ message: 'Store updated' });
});

app.get('/api/vendor/orders', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const store = dbGet("SELECT id FROM stores WHERE vendor_id = ?", [vendorId]);
    if (!store) return res.json([]);
    const orders = dbQuery("SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC", [store.id]);
    const formatted = orders.map(o => ({ 
        id: o.id, order_number: o.order_number, customer_name: o.customer_name, 
        product_name: JSON.parse(o.items || '[]')[0]?.name, total_price: o.total, status: o.status 
    }));
    res.json(formatted);
});

app.put('/api/vendor/orders/:id/confirm', (req, res) => {
    dbRun("UPDATE orders SET status = 'confirmed' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Order confirmed' });
});

app.get('/api/vendor/balance', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const balance = dbGet("SELECT total_earned, pending_balance, pending_withdrawal, withdrawn_balance FROM vendor_balances WHERE vendor_id = ?", [vendorId]);
    if (balance) {
        res.json({ total_earned: balance.total_earned || 0, pending_balance: balance.pending_balance || 0, pending_withdrawal: balance.pending_withdrawal || 0, withdrawn_balance: balance.withdrawn_balance || 0 });
    } else {
        res.json({ total_earned: 0, pending_balance: 0, pending_withdrawal: 0, withdrawn_balance: 0 });
    }
});

app.get('/api/vendor/transactions', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const transactions = dbQuery(`
        SELECT ft.*, o.order_number FROM financial_transactions ft
        LEFT JOIN orders o ON ft.order_id = o.id
        WHERE ft.vendor_id = ? ORDER BY ft.created_at DESC
    `, [vendorId]);
    const formatted = transactions.map(t => ({ id: t.id, transaction_number: t.transaction_number, order_number: t.order_number, amount: t.amount, shipping_fee_vendor_share: t.shipping_fee_vendor_share, net_amount: t.net_amount, status: t.status, created_at: t.created_at }));
    res.json(formatted);
});

app.get('/api/vendor/withdrawals', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const withdrawals = dbQuery("SELECT * FROM withdrawal_requests WHERE vendor_id = ? ORDER BY requested_at DESC", [vendorId]);
    res.json(withdrawals);
});

app.get('/api/vendor/last-withdrawal-date', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const last = dbGet("SELECT MAX(requested_at) as last_date FROM withdrawal_requests WHERE vendor_id = ?", [vendorId]);
    res.json({ last_date: last?.last_date || null });
});

app.post('/api/vendor/withdraw-request', (req, res) => {
    const vendorId = getVendorIdFromToken(req);
    if (!vendorId) return res.status(401).json({ error: 'غير مصرح' });
    
    const schema = Joi.object({
        amount: Joi.number().integer().min(1000).max(99999999).required()
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { amount } = value;
    
    const balance = dbGet("SELECT pending_balance FROM vendor_balances WHERE vendor_id = ?", [vendorId]);
    if (!balance || balance.pending_balance < amount) {
        return res.status(400).json({ error: 'الرصيد غير كافٍ' });
    }
    
    const lastRequest = dbGet("SELECT requested_at FROM withdrawal_requests WHERE vendor_id = ? AND requested_at > datetime('now', '-7 days') ORDER BY requested_at DESC LIMIT 1", [vendorId]);
    if (lastRequest) {
        return res.status(400).json({ error: 'يمكنك طلب سحب مرة واحدة فقط في الأسبوع' });
    }
    
    const requestNumber = `WDR-${Date.now()}-${vendorId}`;
    dbRun("UPDATE vendor_balances SET pending_balance = pending_balance - ?, pending_withdrawal = pending_withdrawal + ? WHERE vendor_id = ?", [amount, amount, vendorId]);
    dbRun("INSERT INTO withdrawal_requests (request_number, vendor_id, amount, status, requested_at) VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)", [requestNumber, vendorId, amount]);
    
    res.json({ success: true, message: 'تم إرسال طلب السحب بنجاح' });
});

// ==================== API: لوحة الإدارة ====================
app.post('/api/admin/init-login', loginLimiter, async (req, res) => {
    const schema = Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().min(1).required()
    });
    
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    
    const { email, password } = value;
    
    const user = dbGet("SELECT id, email, password, role, status FROM users WHERE email = ? AND role = 'admin'", [email]);
    if (!user) return res.status(401).json({ error: 'البريد الإلكتروني غير صحيح' });
    
    if (user.status !== 'active') return res.status(401).json({ error: 'حسابك معطل' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
    
    const adminToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    adminSessions[adminToken] = { email: user.email, userId: user.id, expires: Date.now() + 24 * 60 * 60 * 1000, role: 'admin' };
    res.json({ success: true, adminToken });
});

app.get('/api/admin/verify-token', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    res.json({ success: true, role: adminData.role });
});

app.post('/api/admin/logout', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && adminSessions[token]) delete adminSessions[token];
    res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const totalCategories = dbGet("SELECT COUNT(*) as count FROM categories WHERE parent_id != 0");
    const totalProducts = dbGet("SELECT COUNT(*) as count FROM products");
    const totalOrders = dbGet("SELECT COUNT(*) as count FROM orders");
    const totalVendors = dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'vendor'");
    
    res.json({ 
        totalCategories: totalCategories?.count || 0, 
        totalProducts: totalProducts?.count || 0, 
        totalOrders: totalOrders?.count || 0, 
        totalVendors: totalVendors?.count || 0 
    });
});

app.get('/api/admin/categories', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const categories = dbQuery(`SELECT c.id, c.name, c.parent_id, c.store_id, c.display_order, s.name as store_name 
        FROM categories c LEFT JOIN stores s ON c.store_id = s.id ORDER BY c.parent_id, c.display_order`);
    res.json(categories);
});

app.get('/api/admin/stores', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const stores = dbQuery(`
        SELECT s.*, c.name as city_name 
        FROM stores s 
        LEFT JOIN cities c ON s.city_id = c.id 
        ORDER BY s.id DESC
    `);
    res.json(stores);
});

app.put('/api/admin/stores/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, whatsapp, phone, city_id, status } = req.body;
    const storeId = req.params.id;
    
    dbRun(`UPDATE stores SET name = ?, whatsapp = ?, phone = ?, city_id = ?, status = ? WHERE id = ?`, 
        [name, whatsapp, phone || '', city_id || 0, status || 'active', storeId]);
    res.json({ success: true, message: 'تم تحديث المتجر بنجاح' });
});

app.post('/api/admin/categories', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, parent_id } = req.body;
    dbRun("INSERT INTO categories (name, parent_id, store_id, display_order) VALUES (?, ?, 0, 0)", [name, parent_id || 0]);
    res.json({ message: 'Category added' });
});

app.delete('/api/admin/categories/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const categoryId = req.params.id;
    dbRun("DELETE FROM product_categories WHERE category_id = ?", [categoryId]);
    dbRun("DELETE FROM categories WHERE id = ?", [categoryId]);
    dbRun("DELETE FROM categories WHERE parent_id = ?", [categoryId]);
    res.json({ success: true, message: 'تم حذف القسم بنجاح' });
});

app.post('/api/admin/categories/:id/add-product', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const categoryId = req.params.id;
    const { product_id } = req.body;
    
    const existing = dbGet("SELECT id FROM product_categories WHERE product_id = ? AND category_id = ?", [product_id, categoryId]);
    if (existing) return res.status(400).json({ error: 'المنتج موجود بالفعل' });
    
    dbRun("INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)", [product_id, categoryId]);
    res.json({ success: true, message: 'تم إضافة المنتج إلى القسم' });
});

app.post('/api/admin/products', uploadSimple.array('images', 6), (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, base_price, category_id, fabric_type, sizes, colors, description } = req.body;
    let imageUrls = [];
    if (req.files && req.files.length) imageUrls = req.files.map(file => `/uploads/${file.filename}`);
    const imagesJson = JSON.stringify(imageUrls);
    
    dbRun(`INSERT INTO products (name, base_price, images, fabric_type, sizes, colors, description, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`, 
        [name, base_price, imagesJson, fabric_type || '', sizes || '', colors || '', description || '']);
    
    const newProductId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    if (category_id && category_id != 0 && category_id != 'null' && category_id != 'undefined') {
        dbRun("INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)", [newProductId, category_id]);
    }
    res.json({ message: 'Product added', images: imageUrls });
});

app.get('/api/admin/products', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const products = dbQuery(`
        SELECT DISTINCT p.id, p.name, p.base_price, p.images, p.store_id, s.name as store_name
        FROM products p LEFT JOIN stores s ON p.store_id = s.id ORDER BY p.id DESC
    `);
    const formatted = products.map(p => {
        let images = [];
        try { images = JSON.parse(p.images || '[]'); } catch(e) {}
        const timesOrdered = dbGet("SELECT COUNT(*) as count FROM orders WHERE items LIKE ?", [`%"id":${p.id}%`]);
        return { 
            id: p.id, name: p.name, base_price: p.base_price, 
            image_url: images.length > 0 ? images[0] : 'https://placehold.co/50x50/2A4A6A/7BA5C0?text=HELAXIA',
            images: images,
            store_id: p.store_id, store_name: p.store_name || 'المنصة', 
            times_ordered: timesOrdered?.count || 0 
        };
    });
    res.json(formatted);
});

app.get('/api/admin/products/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const product = dbGet("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
    res.json({ id: product.id, name: product.name, base_price: product.base_price, images: JSON.parse(product.images || '[]'), fabric_type: product.fabric_type || '', sizes: product.sizes || '', colors: product.colors || '', description: product.description || '' });
});

app.put('/api/admin/products/:id', uploadSimple.array('images', 6), (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, base_price, fabric_type, sizes, colors, description } = req.body;
    const productId = req.params.id;
    
    dbRun(`UPDATE products SET name = ?, base_price = ?, fabric_type = ?, sizes = ?, colors = ?, description = ? WHERE id = ?`, 
        [name, base_price, fabric_type || '', sizes || '', colors || '', description || '', productId]);
    
    if (req.files && req.files.length > 0) {
        const imageUrls = req.files.map(file => `/uploads/${file.filename}`);
        const imagesJson = JSON.stringify(imageUrls);
        dbRun("UPDATE products SET images = ? WHERE id = ?", [imagesJson, productId]);
    }
    res.json({ success: true, message: 'تم تحديث المنتج' });
});

app.delete('/api/admin/products/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    dbRun("DELETE FROM product_categories WHERE product_id = ?", [req.params.id]);
    dbRun("DELETE FROM products WHERE id = ?", [req.params.id]);
    res.json({ message: 'Product deleted' });
});

app.get('/api/admin/orders', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const orders = dbQuery("SELECT id, order_number, created_at, customer_name, customer_phone, notes, items, total, status, shipping_cost, payment_status, pickup_location FROM orders ORDER BY id DESC");
    res.json(orders);
});

app.get('/api/admin/orders/search/:number', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const order = dbGet("SELECT * FROM orders WHERE order_number = ?", [req.params.number]);
    res.json({ order: order || null });
});

app.put('/api/admin/orders/:id/status', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { status } = req.body;
    dbRun("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ message: 'Order status updated' });
});

app.delete('/api/admin/orders/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    dbRun("DELETE FROM orders WHERE id = ?", [req.params.id]);
    res.json({ message: 'Order deleted' });
});

app.get('/api/admin/vendor-requests', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const requests = dbQuery("SELECT * FROM stores WHERE status = 'pending' ORDER BY id DESC");
    res.json(requests);
});

app.post('/api/admin/vendor-requests/:id/approve', async (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const requestId = req.params.id;
    const store = dbGet("SELECT vendor_id, name, whatsapp FROM stores WHERE id = ?", [requestId]);
    if (!store) return res.status(404).json({ error: 'Request not found' });
    
    dbRun("UPDATE stores SET status = 'active' WHERE id = ?", [requestId]);
    res.json({ message: 'Request approved' });
});

app.post('/api/admin/vendor-requests/:id/reject', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const requestId = req.params.id;
    dbRun("UPDATE stores SET status = 'rejected' WHERE id = ?", [requestId]);
    res.json({ message: 'Request rejected' });
});

app.get('/api/admin/settings', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const settingsList = dbQuery("SELECT * FROM settings");
    const settings = {};
    settingsList.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
});

app.put('/api/admin/settings', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { admin_whatsapp, admin_email, exchange_rate, executive_email } = req.body;
    if (admin_whatsapp) dbRun("UPDATE settings SET value = ? WHERE key = 'admin_whatsapp'", [admin_whatsapp]);
    if (admin_email) dbRun("UPDATE settings SET value = ? WHERE key = 'admin_email'", [admin_email]);
    if (exchange_rate) dbRun("UPDATE settings SET value = ? WHERE key = 'exchange_rate'", [exchange_rate]);
    if (executive_email) dbRun("UPDATE settings SET value = ? WHERE key = 'executive_email'", [executive_email]);
    res.json({ message: 'Admin settings updated' });
});

app.post('/api/admin/signup-request', async (req, res) => {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'الرجاء إدخال جميع البيانات' });
    
    const existingUser = dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser) return res.status(400).json({ error: 'هذا البريد مسجل بالفعل' });
    
    const signupCode = generateCode();
    const tempToken = signupCode + Date.now();
    const hashedPassword = await bcrypt.hash(password, 10);
    pendingAdminSignupCodes[tempToken] = { name, email, password: hashedPassword, phone, code: signupCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    await sendEmailCode(getExecutiveEmail(), signupCode, 'signup');
    res.json({ success: true, tempToken, message: '✅ تم إرسال الكود إلى إيميل المدير التنفيذي' });
});

app.post('/api/admin/verify-signup-code', async (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingAdminSignupCodes[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const signupData = pendingAdminSignupCodes[tempToken];
    if (signupData.used) { delete pendingAdminSignupCodes[tempToken]; return res.status(401).json({ error: 'هذا الكود مستخدم بالفعل' }); }
    if (Date.now() > signupData.expires) { delete pendingAdminSignupCodes[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الكود' }); }
    if (signupData.code !== code) return res.status(401).json({ error: 'الكود غير صحيح' });
    
    signupData.used = true;
    dbRun(`INSERT INTO users (name, email, password, phone, role, is_verified, status) VALUES (?, ?, ?, ?, 'admin', 1, 'active')`, 
        [signupData.name, signupData.email, signupData.password, signupData.phone || '']);
    delete pendingAdminSignupCodes[tempToken];
    res.json({ success: true, message: '✅ تم إنشاء حساب المدير بنجاح' });
});

// إعادة إرسال كود تفعيل حساب المدير
app.post('/api/admin/resend-signup-code', async (req, res) => {
    const { tempToken } = req.body;
    
    if (!pendingAdminSignupCodes[tempToken]) {
        return res.status(401).json({ error: 'طلب غير صالح أو منتهي الصلاحية' });
    }
    
    const signupData = pendingAdminSignupCodes[tempToken];
    if (Date.now() > signupData.expires) {
        delete pendingAdminSignupCodes[tempToken];
        return res.status(401).json({ error: 'انتهت صلاحية الجلسة' });
    }
    
    const newCode = generateCode();
    signupData.code = newCode;
    signupData.expires = Date.now() + 10 * 60 * 1000;
    
    await sendEmailCode(getExecutiveEmail(), newCode, 'signup');
    
    res.json({ success: true, message: 'تم إعادة إرسال الكود' });
});

app.get('/api/admin/admins', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const admins = dbQuery("SELECT id, email, name, status FROM users WHERE role = 'admin' AND email != 'admin@helaxia.com'");
    res.json(admins);
});

app.put('/api/admin/admins/:id/toggle', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { status } = req.body;
    dbRun("UPDATE users SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ message: 'Admin status updated' });
});

app.post('/api/admin/admins/:id/force-logout', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const adminId = req.params.id;
    const adminUser = dbGet("SELECT email FROM users WHERE id = ?", [adminId]);
    if (adminUser) {
        for (let sessionToken in adminSessions) {
            if (adminSessions[sessionToken].email === adminUser.email) delete adminSessions[sessionToken];
        }
    }
    res.json({ message: 'Admin force logged out' });
});

app.delete('/api/admin/admins/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    dbRun("DELETE FROM users WHERE id = ? AND role = 'admin'", [req.params.id]);
    res.json({ message: 'Admin deleted' });
});

app.post('/api/admin/send-executive-code', async (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const executiveCode = generateCode();
    const tempToken = executiveCode + Date.now();
    pendingExecutiveCodes[tempToken] = { code: executiveCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    await sendEmailCode(getExecutiveEmail(), executiveCode, 'executive');
    res.json({ success: true, tempToken });
});

app.post('/api/admin/verify-executive-code', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { code, tempToken } = req.body;
    if (!pendingExecutiveCodes[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const executiveData = pendingExecutiveCodes[tempToken];
    if (executiveData.used) { delete pendingExecutiveCodes[tempToken]; return res.status(401).json({ error: 'هذا الكود مستخدم بالفعل' }); }
    if (Date.now() > executiveData.expires) { delete pendingExecutiveCodes[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الكود' }); }
    if (executiveData.code !== code) return res.status(401).json({ error: 'الكود غير صحيح' });
    
    executiveData.used = true;
    delete pendingExecutiveCodes[tempToken];
    res.json({ success: true, message: 'تم التحقق بنجاح' });
});

app.get('/api/admin/financial-report', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'الرجاء تحديد تاريخ البداية والنهاية' });
    
    const stores = dbQuery("SELECT id, name, whatsapp FROM stores WHERE status = 'active'");
    const report = [];
    
    for (const store of stores) {
        const transactions = dbQuery(`SELECT SUM(amount) as total_sales, SUM(shipping_fee_vendor_share) as total_shipping, SUM(net_amount) as net_amount FROM financial_transactions WHERE vendor_id = ? AND date(created_at) BETWEEN ? AND ?`, 
            [store.id, start, end]);
        let totalSales = 0, totalShipping = 0, netAmount = 0;
        if (transactions.length > 0 && transactions[0].total_sales) {
            totalSales = parseFloat(transactions[0].total_sales) || 0;
            totalShipping = parseFloat(transactions[0].total_shipping) || 0;
            netAmount = parseFloat(transactions[0].net_amount) || 0;
        }
        if (totalSales > 0) {
            report.push({ vendor_id: store.id, store_name: store.name, whatsapp: store.whatsapp, total_sales: totalSales, total_shipping_share: totalShipping, net_amount: netAmount });
        }
    }
    res.json({ vendors: report, start, end });
});

app.post('/api/admin/set-shipping-cost', async (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { orderId, totalShippingCost } = req.body;
    
    if (!orderId || !totalShippingCost || totalShippingCost <= 0) {
        return res.status(400).json({ error: 'بيانات غير صحيحة' });
    }
    
    try {
        const vendorsShare = totalShippingCost / 2;
        
        // تحديث تكلفة الشحن في الطلب
        dbRun("UPDATE orders SET shipping_cost = ?, shipping_set_at = CURRENT_TIMESTAMP WHERE id = ?", 
            [totalShippingCost, orderId]);
        
        // جلب الطلب ومنتجاته
        const order = dbGet("SELECT items, total FROM orders WHERE id = ?", [orderId]);
        if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
        
        const items = JSON.parse(order.items);
        const vendorSales = {};
        
        // حساب مبيعات كل تاجر
        for (const item of items) {
            const product = dbGet("SELECT store_id FROM products WHERE id = ?", [item.id]);
            const vendorId = product?.store_id || 1;
            const itemTotal = (item.price || 0) * (item.quantity || 1);
            
            if (vendorSales[vendorId]) {
                vendorSales[vendorId].total += itemTotal;
            } else {
                vendorSales[vendorId] = { vendorId, total: itemTotal };
            }
        }
        
        const totalSales = Object.values(vendorSales).reduce((sum, v) => sum + v.total, 0);
        
        // توزيع حصة الشحن على التجار
        for (const vendor of Object.values(vendorSales)) {
            const share = (vendor.total / totalSales) * vendorsShare;
            const netAmount = vendor.total - share;
            const transactionNumber = `TXN-${Date.now()}-${vendor.vendorId}`;
            
            // تحديث أو إنشاء رصيد التاجر
            const balanceExists = dbGet("SELECT id FROM vendor_balances WHERE vendor_id = ?", [vendor.vendorId]);
            if (balanceExists) {
                dbRun(`UPDATE vendor_balances 
                    SET total_earned = total_earned + ?, 
                        pending_balance = pending_balance + ? 
                    WHERE vendor_id = ?`, 
                    [vendor.total, netAmount, vendor.vendorId]);
            } else {
                dbRun(`INSERT INTO vendor_balances (vendor_id, total_earned, pending_balance, pending_withdrawal, withdrawn_balance) 
                    VALUES (?, ?, ?, 0, 0)`, 
                    [vendor.vendorId, vendor.total, netAmount]);
            }
            
            // إنشاء سجل معاملة مالية
            dbRun(`INSERT INTO financial_transactions 
                (transaction_number, order_id, vendor_id, amount, shipping_fee_vendor_share, net_amount, status, transaction_type, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'sale', CURRENT_TIMESTAMP)`, 
                [transactionNumber, orderId, vendor.vendorId, vendor.total, share, netAmount]);
        }
        
        res.json({ 
            success: true, 
            message: `تم حفظ تكلفة الشحن ${totalShippingCost} ل.س`,
            customer_share: vendorsShare 
        });
        
    } catch (err) {
        console.error('Error setting shipping cost:', err);
        res.status(500).json({ error: 'فشل حفظ تكلفة الشحن: ' + err.message });
    }
});

app.get('/api/admin/vendor-report/:vendorId', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const vendorId = req.params.vendorId;
    const { start, end } = req.query;
    
    const store = dbGet("SELECT name, whatsapp FROM stores WHERE vendor_id = ?", [vendorId]);
    const storeName = store?.name || 'متجر غير معروف';
    const storeWhatsapp = store?.whatsapp || '';
    
    const transactions = dbQuery(`SELECT ft.*, o.order_number, o.created_at as order_created_at FROM financial_transactions ft JOIN orders o ON ft.order_id = o.id WHERE ft.vendor_id = ? AND date(ft.created_at) BETWEEN ? AND ? ORDER BY ft.created_at DESC`, 
        [vendorId, start, end]);
    
    const orders = transactions.map(t => ({ order_number: t.order_number, created_at: t.order_created_at, total_amount: t.amount, shipping_share: t.shipping_fee_vendor_share, net_amount: t.net_amount, status: t.status }));
    const summary = { total_sales: orders.reduce((sum, o) => sum + (o.total_amount || 0), 0), total_shipping: orders.reduce((sum, o) => sum + (o.shipping_share || 0), 0), net_amount: orders.reduce((sum, o) => sum + (o.net_amount || 0), 0) };
    
    res.json({ store_name: storeName, whatsapp: storeWhatsapp, orders, summary, start, end });
});

// ==================== API: أمين الصندوق ====================
app.post('/api/cashier/init-login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    const user = dbGet("SELECT id, email, password, role, status, is_verified FROM users WHERE email = ? AND role = 'cashier'", [email]);
    if (!user) return res.status(401).json({ error: 'البريد الإلكتروني غير صحيح أو ليس لديك صلاحية أمين صندوق' });
    if (user.status !== 'active') return res.status(401).json({ error: 'حسابك معطل. يرجى التواصل مع المدير التنفيذي' });
    if (user.is_verified !== 1) return res.status(401).json({ error: 'يرجى تأكيد بريدك الإلكتروني أولاً' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
    
    const tempToken = generateCode() + Date.now();
    pendingCashierTokens[tempToken] = { email: user.email, userId: user.id, expires: Date.now() + 10 * 60 * 1000, verified: false };
    res.json({ success: true, tempToken });
});

app.post('/api/cashier/send-email-code', async (req, res) => {
    const { tempToken } = req.body;
    if (!pendingCashierTokens[tempToken]) return res.status(401).json({ error: 'جلسة غير صالحة' });
    if (Date.now() > pendingCashierTokens[tempToken].expires) { delete pendingCashierTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    
    const emailCode = generateCode();
    pendingCashierTokens[tempToken].emailCode = emailCode;
    pendingCashierTokens[tempToken].emailCodeExpires = Date.now() + 10 * 60 * 1000;
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA CASHIER</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 رمز الدخول إلى لوحة أمين الصندوق</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${emailCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA Cashier" <mhmdlwbany43@gmail.com>', to: pendingCashierTokens[tempToken].email, subject: '🔐 رمز تأكيد الدخول إلى لوحة أمين الصندوق', html: htmlContent });
        res.json({ success: true, message: 'تم إرسال الرمز إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/cashier/verify-email-code', (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingCashierTokens[tempToken]) return res.status(401).json({ error: 'جلسة غير صالحة' });
    if (Date.now() > pendingCashierTokens[tempToken].expires) { delete pendingCashierTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    if (pendingCashierTokens[tempToken].emailCode !== code) return res.status(401).json({ error: 'رمز غير صحيح' });
    if (Date.now() > pendingCashierTokens[tempToken].emailCodeExpires) return res.status(401).json({ error: 'انتهت صلاحية الرمز' });
    
    const cashierToken = jwt.sign({ id: pendingCashierTokens[tempToken].userId, email: pendingCashierTokens[tempToken].email, role: 'cashier' }, JWT_SECRET, { expiresIn: '8h' });
    cashierSessions[cashierToken] = { email: pendingCashierTokens[tempToken].email, userId: pendingCashierTokens[tempToken].userId, expires: Date.now() + 8 * 60 * 60 * 1000, role: 'cashier' };
    delete pendingCashierTokens[tempToken];
    res.json({ success: true, cashierToken });
});

app.post('/api/cashier/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'الرجاء إدخال البريد الإلكتروني' });
    
    const user = dbGet("SELECT id, email, name FROM users WHERE email = ? AND role = 'cashier' AND status = 'active'", [email]);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
    
    const resetCode = generateCode();
    const tempToken = resetCode + Date.now();
    pendingCashierResetTokens[tempToken] = { email: user.email, userId: user.id, code: resetCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA CASHIER</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 إعادة تعيين كلمة المرور</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${resetCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA Cashier" <mhmdlwbany43@gmail.com>', to: user.email, subject: '🔐 إعادة تعيين كلمة مرور حساب أمين الصندوق', html: htmlContent });
        res.json({ success: true, tempToken, message: 'تم إرسال رمز إعادة التعيين إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/cashier/verify-reset-code', (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingCashierResetTokens[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingCashierResetTokens[tempToken];
    if (resetData.used) { delete pendingCashierResetTokens[tempToken]; return res.status(401).json({ error: 'هذا الرمز مستخدم بالفعل' }); }
    if (Date.now() > resetData.expires) { delete pendingCashierResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الرمز' }); }
    if (resetData.code !== code) return res.status(401).json({ error: 'رمز غير صحيح' });
    
    resetData.used = true;
    const newTempToken = generateCode() + Date.now();
    pendingCashierResetTokens[newTempToken] = { email: resetData.email, userId: resetData.userId, code: null, expires: Date.now() + 10 * 60 * 1000, used: false, verified: true };
    delete pendingCashierResetTokens[tempToken];
    res.json({ success: true, tempToken: newTempToken });
});

app.post('/api/cashier/reset-password', async (req, res) => {
    const { tempToken, newPassword } = req.body;
    if (!tempToken || !newPassword) return res.status(400).json({ error: 'بيانات غير مكتملة' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!pendingCashierResetTokens[tempToken] || !pendingCashierResetTokens[tempToken].verified) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingCashierResetTokens[tempToken];
    if (Date.now() > resetData.expires) { delete pendingCashierResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    dbRun("UPDATE users SET password = ? WHERE id = ? AND role = 'cashier'", [hashedPassword, resetData.userId]);
    delete pendingCashierResetTokens[tempToken];
    res.json({ success: true, message: '✅ تم تغيير كلمة المرور بنجاح' });
});

app.get('/api/cashier/verify-token', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    res.json({ success: true, role: cashierData.role });
});

app.get('/api/cashier/withdrawals/pending', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    const withdrawals = dbQuery(`SELECT w.*, s.name as store_name FROM withdrawal_requests w LEFT JOIN stores s ON w.vendor_id = s.vendor_id WHERE w.status = 'pending' ORDER BY w.requested_at DESC`);
    res.json(withdrawals);
});

app.post('/api/cashier/withdrawals/:id/approve', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { vendorId, amount } = req.body;
    const withdrawalId = req.params.id;
    
    dbRun("UPDATE withdrawal_requests SET status = 'approved', processed_at = CURRENT_TIMESTAMP WHERE id = ?", [withdrawalId]);
    dbRun("UPDATE vendor_balances SET pending_withdrawal = pending_withdrawal - ?, withdrawn_balance = withdrawn_balance + ? WHERE vendor_id = ?", [amount, amount, vendorId]);
    res.json({ success: true, message: 'تم قبول طلب السحب' });
});

app.post('/api/cashier/withdrawals/:id/reject', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { vendorId, amount } = req.body;
    const withdrawalId = req.params.id;
    
    dbRun("UPDATE withdrawal_requests SET status = 'rejected', processed_at = CURRENT_TIMESTAMP WHERE id = ?", [withdrawalId]);
    dbRun("UPDATE vendor_balances SET pending_withdrawal = pending_withdrawal - ?, pending_balance = pending_balance + ? WHERE vendor_id = ?", [amount, amount, vendorId]);
    res.json({ success: true, message: 'تم رفض طلب السحب' });
});

app.post('/api/cashier/set-shipping-cost', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح، الرجاء تسجيل الدخول كأمين صندوق' });
    
    const { orderId, totalShippingCost } = req.body;
    if (!orderId || !totalShippingCost || totalShippingCost <= 0) return res.status(400).json({ error: 'بيانات غير صحيحة' });
    
    try {
        const vendorsShare = totalShippingCost / 2;
        dbRun("UPDATE orders SET shipping_cost = ?, shipping_set_at = CURRENT_TIMESTAMP WHERE id = ?", [totalShippingCost, orderId]);
        
        const order = dbGet("SELECT items, total FROM orders WHERE id = ?", [orderId]);
        if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
        
        const items = JSON.parse(order.items);
        const vendorSales = {};
        
        for (const item of items) {
            const product = dbGet("SELECT store_id FROM products WHERE id = ?", [item.id]);
            const vendorId = product?.store_id || 1;
            const itemTotal = (item.price || 0) * (item.quantity || 1);
            if (vendorSales[vendorId]) {
                vendorSales[vendorId].total += itemTotal;
            } else {
                vendorSales[vendorId] = { vendorId, total: itemTotal };
            }
        }
        
        const totalSales = Object.values(vendorSales).reduce((sum, v) => sum + v.total, 0);
        
        for (const vendor of Object.values(vendorSales)) {
            const share = (vendor.total / totalSales) * vendorsShare;
            const netAmount = vendor.total - share;
            const transactionNumber = `TXN-${Date.now()}-${vendor.vendorId}`;
            
            const balanceExists = dbGet("SELECT id FROM vendor_balances WHERE vendor_id = ?", [vendor.vendorId]);
            if (balanceExists) {
                dbRun("UPDATE vendor_balances SET total_earned = total_earned + ?, pending_balance = pending_balance + ? WHERE vendor_id = ?", [vendor.total, netAmount, vendor.vendorId]);
            } else {
                dbRun("INSERT INTO vendor_balances (vendor_id, total_earned, pending_balance, pending_withdrawal, withdrawn_balance) VALUES (?, ?, ?, 0, 0)", [vendor.vendorId, vendor.total, netAmount]);
            }
            
            dbRun(`INSERT INTO financial_transactions (transaction_number, order_id, vendor_id, amount, shipping_fee_vendor_share, net_amount, status, transaction_type, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'sale', CURRENT_TIMESTAMP)`, 
                [transactionNumber, orderId, vendor.vendorId, vendor.total, share, netAmount]);
        }
        
        res.json({ success: true, message: `تم حفظ تكلفة الشحن ${totalShippingCost} ل.س`, customer_shipping: vendorsShare });
    } catch (err) { 
        res.status(500).json({ error: 'فشل حفظ تكلفة الشحن' }); 
    }
});

app.post('/api/cashier/orders/:id/confirm-payment', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    dbRun("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'تم تأكيد الدفع' });
});

app.get('/api/cashier/profile', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    const user = dbGet("SELECT id, name, email, phone FROM users WHERE email = ? AND role = 'cashier'", [cashierData.email]);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(user);
});

app.post('/api/cashier/logout', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && cashierSessions[token]) delete cashierSessions[token];
    res.json({ success: true });
});

app.post('/api/cashier/signup-request', async (req, res) => {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'الرجاء إدخال جميع البيانات' });
    
    const existingUser = dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser) return res.status(400).json({ error: 'هذا البريد مسجل بالفعل' });
    
    const signupCode = generateCode();
    const tempToken = signupCode + Date.now();
    const hashedPassword = await bcrypt.hash(password, 10);
    pendingCashierSignups[tempToken] = { name, email, password: hashedPassword, phone, code: signupCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    await sendEmailCode(getExecutiveEmail(), signupCode, 'cashier_signup');
    res.json({ success: true, tempToken, message: '✅ تم إرسال الكود إلى إيميل المدير التنفيذي. الرجاء إدخال الكود لإكمال التسجيل.' });
});

app.post('/api/cashier/verify-signup-code', async (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingCashierSignups[tempToken]) return res.status(401).json({ error: 'طلب غير صالح أو منتهي الصلاحية' });
    
    const signupData = pendingCashierSignups[tempToken];
    if (signupData.used) { delete pendingCashierSignups[tempToken]; return res.status(401).json({ error: 'هذا الكود مستخدم بالفعل' }); }
    if (Date.now() > signupData.expires) { delete pendingCashierSignups[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الكود' }); }
    if (signupData.code !== code) return res.status(401).json({ error: 'الكود غير صحيح' });
    
    signupData.used = true;
    const emailCode = generateCode();
    dbRun(`INSERT INTO users (name, email, password, phone, role, is_verified, verification_code, status) VALUES (?, ?, ?, ?, 'cashier', 1, ?, 'active')`, 
        [signupData.name, signupData.email, signupData.password, signupData.phone || '', emailCode]);
    
    await sendEmailCode(getExecutiveEmail(), 'تم الإنشاء', 'cashier_created');
    delete pendingCashierSignups[tempToken];
    res.json({ success: true, message: '✅ تم إنشاء حساب أمين الصندوق بنجاح. يمكنك الآن تسجيل الدخول.' });
});

app.post('/api/cashier/resend-signup-code', async (req, res) => {
    const { tempToken } = req.body;
    
    if (!pendingCashierSignups[tempToken]) {
        return res.status(401).json({ error: 'طلب غير صالح أو منتهي الصلاحية' });
    }
    
    const signupData = pendingCashierSignups[tempToken];
    if (Date.now() > signupData.expires) {
        delete pendingCashierSignups[tempToken];
        return res.status(401).json({ error: 'انتهت صلاحية الجلسة' });
    }
    
    const newCode = generateCode();
    signupData.code = newCode;
    signupData.expires = Date.now() + 10 * 60 * 1000;
    
    await sendEmailCode(getExecutiveEmail(), newCode, 'cashier_signup');
    
    res.json({ success: true, message: 'تم إعادة إرسال الكود' });
});

app.get('/api/admin/cashiers', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const cashiers = dbQuery("SELECT id, name, email, phone, status, created_at FROM users WHERE role = 'cashier' ORDER BY id DESC");
    res.json(cashiers);
});

app.put('/api/admin/cashiers/:id/toggle', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { status } = req.body;
    dbRun("UPDATE users SET status = ? WHERE id = ? AND role = 'cashier'", [status, req.params.id]);
    res.json({ message: 'Cashier status updated' });
});

app.delete('/api/admin/cashiers/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    dbRun("DELETE FROM users WHERE id = ? AND role = 'cashier'", [req.params.id]);
    res.json({ message: 'Cashier deleted' });
});

app.post('/api/cashier/set-pickup-location', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح، الرجاء تسجيل الدخول كأمين صندوق' });
    
    const { orderId, pickupLocation } = req.body;
    if (!orderId) return res.status(400).json({ error: 'رقم الطلب مطلوب' });
    if (!pickupLocation || pickupLocation.trim() === '') return res.status(400).json({ error: 'مكان تسليم الطلب مطلوب' });
    
    dbRun("UPDATE orders SET pickup_location = ? WHERE id = ?", [pickupLocation, orderId]);
    res.json({ success: true, message: `✅ تم تحديد مكان تسليم الطلب: ${pickupLocation}` });
});

app.get('/api/cashier/orders/pending-payment', (req, res) => {
    const cashierData = getCashierFromToken(req);
    if (!cashierData) return res.status(401).json({ error: 'غير مصرح' });
    
    const orders = dbQuery("SELECT id, order_number, customer_name, total, created_at FROM orders WHERE payment_status = 'pending' ORDER BY id DESC");
    res.json(orders);
});

// ==================== نسيت كلمة المرور ====================
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'الرجاء إدخال البريد الإلكتروني' });
    
    const user = dbGet("SELECT id, email, name FROM users WHERE email = ? AND role = 'customer' AND status = 'active'", [email]);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
    
    const resetCode = generateCode();
    const tempToken = resetCode + Date.now();
    pendingClientResetTokens[tempToken] = { email: user.email, userId: user.id, code: resetCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 إعادة تعيين كلمة المرور</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${resetCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA" <mhmdlwbany43@gmail.com>', to: user.email, subject: '🔐 إعادة تعيين كلمة مرور حساب HELAXIA', html: htmlContent });
        res.json({ success: true, tempToken, message: 'تم إرسال رمز إعادة التعيين إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/auth/verify-reset-code', (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingClientResetTokens[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingClientResetTokens[tempToken];
    if (resetData.used) { delete pendingClientResetTokens[tempToken]; return res.status(401).json({ error: 'هذا الرمز مستخدم بالفعل' }); }
    if (Date.now() > resetData.expires) { delete pendingClientResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الرمز' }); }
    if (resetData.code !== code) return res.status(401).json({ error: 'رمز غير صحيح' });
    
    resetData.used = true;
    const newTempToken = generateCode() + Date.now();
    pendingClientResetTokens[newTempToken] = { email: resetData.email, userId: resetData.userId, code: null, expires: Date.now() + 10 * 60 * 1000, used: false, verified: true };
    delete pendingClientResetTokens[tempToken];
    res.json({ success: true, tempToken: newTempToken });
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { tempToken, newPassword } = req.body;
    if (!tempToken || !newPassword) return res.status(400).json({ error: 'بيانات غير مكتملة' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!pendingClientResetTokens[tempToken] || !pendingClientResetTokens[tempToken].verified) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingClientResetTokens[tempToken];
    if (Date.now() > resetData.expires) { delete pendingClientResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    dbRun("UPDATE users SET password = ? WHERE id = ? AND role = 'customer'", [hashedPassword, resetData.userId]);
    delete pendingClientResetTokens[tempToken];
    res.json({ success: true, message: '✅ تم تغيير كلمة المرور بنجاح' });
});

app.post('/api/vendor/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'الرجاء إدخال البريد الإلكتروني' });
    
    const user = dbGet("SELECT id, email, name FROM users WHERE email = ? AND role = 'vendor' AND status = 'active'", [email]);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
    
    const resetCode = generateCode();
    const tempToken = resetCode + Date.now();
    pendingVendorResetTokens[tempToken] = { email: user.email, userId: user.id, code: resetCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA VENDOR</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 إعادة تعيين كلمة المرور (حساب تاجر)</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${resetCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA" <mhmdlwbany43@gmail.com>', to: user.email, subject: '🔐 إعادة تعيين كلمة مرور حساب التاجر', html: htmlContent });
        res.json({ success: true, tempToken, message: 'تم إرسال رمز إعادة التعيين إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/vendor/verify-reset-code', (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingVendorResetTokens[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingVendorResetTokens[tempToken];
    if (resetData.used) { delete pendingVendorResetTokens[tempToken]; return res.status(401).json({ error: 'هذا الرمز مستخدم بالفعل' }); }
    if (Date.now() > resetData.expires) { delete pendingVendorResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الرمز' }); }
    if (resetData.code !== code) return res.status(401).json({ error: 'رمز غير صحيح' });
    
    resetData.used = true;
    const newTempToken = generateCode() + Date.now();
    pendingVendorResetTokens[newTempToken] = { email: resetData.email, userId: resetData.userId, code: null, expires: Date.now() + 10 * 60 * 1000, used: false, verified: true };
    delete pendingVendorResetTokens[tempToken];
    res.json({ success: true, tempToken: newTempToken });
});

app.post('/api/vendor/reset-password', async (req, res) => {
    const { tempToken, newPassword } = req.body;
    if (!tempToken || !newPassword) return res.status(400).json({ error: 'بيانات غير مكتملة' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!pendingVendorResetTokens[tempToken] || !pendingVendorResetTokens[tempToken].verified) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingVendorResetTokens[tempToken];
    if (Date.now() > resetData.expires) { delete pendingVendorResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    dbRun("UPDATE users SET password = ? WHERE id = ? AND role = 'vendor'", [hashedPassword, resetData.userId]);
    delete pendingVendorResetTokens[tempToken];
    res.json({ success: true, message: '✅ تم تغيير كلمة المرور بنجاح' });
});

app.post('/api/admin/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'الرجاء إدخال البريد الإلكتروني' });
    
    const user = dbGet("SELECT id, email, name FROM users WHERE email = ? AND role = 'admin' AND status = 'active'", [email]);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد الإلكتروني' });
    
    const resetCode = generateCode();
    const tempToken = resetCode + Date.now();
    pendingAdminResetTokens[tempToken] = { email: user.email, userId: user.id, code: resetCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA ADMIN</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 إعادة تعيين كلمة المرور (حساب مدير)</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${resetCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA" <mhmdlwbany43@gmail.com>', to: user.email, subject: '🔐 إعادة تعيين كلمة مرور حساب المدير', html: htmlContent });
        res.json({ success: true, tempToken, message: 'تم إرسال رمز إعادة التعيين إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/admin/verify-reset-code', (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingAdminResetTokens[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingAdminResetTokens[tempToken];
    if (resetData.used) { delete pendingAdminResetTokens[tempToken]; return res.status(401).json({ error: 'هذا الرمز مستخدم بالفعل' }); }
    if (Date.now() > resetData.expires) { delete pendingAdminResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الرمز' }); }
    if (resetData.code !== code) return res.status(401).json({ error: 'رمز غير صحيح' });
    
    resetData.used = true;
    const newTempToken = generateCode() + Date.now();
    pendingAdminResetTokens[newTempToken] = { email: resetData.email, userId: resetData.userId, code: null, expires: Date.now() + 10 * 60 * 1000, used: false, verified: true };
    delete pendingAdminResetTokens[tempToken];
    res.json({ success: true, tempToken: newTempToken });
});

app.post('/api/admin/reset-password', async (req, res) => {
    const { tempToken, newPassword } = req.body;
    if (!tempToken || !newPassword) return res.status(400).json({ error: 'بيانات غير مكتملة' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (!pendingAdminResetTokens[tempToken] || !pendingAdminResetTokens[tempToken].verified) return res.status(401).json({ error: 'طلب غير صالح' });
    
    const resetData = pendingAdminResetTokens[tempToken];
    if (Date.now() > resetData.expires) { delete pendingAdminResetTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الجلسة' }); }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    dbRun("UPDATE users SET password = ? WHERE id = ? AND role = 'admin'", [hashedPassword, resetData.userId]);
    delete pendingAdminResetTokens[tempToken];
    res.json({ success: true, message: '✅ تم تغيير كلمة المرور بنجاح' });
});

app.post('/api/vendor/signup-request', uploadSimple.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'paymentProofImage', maxCount: 1 }
]), async (req, res) => {
    const { name, description, phone, email, userId, password } = req.body;
    let logo_url = '';
    let payment_proof_image = '';
    
    if (req.files && req.files['logo'] && req.files['logo'][0]) {
        logo_url = `/uploads/${req.files['logo'][0].filename}`;
    }
    if (req.files && req.files['paymentProofImage'] && req.files['paymentProofImage'][0]) {
        payment_proof_image = `/uploads/${req.files['paymentProofImage'][0].filename}`;
    }
    
    if (!name || !phone || !email || !password) {
        return res.status(400).json({ error: 'الرجاء إدخال جميع البيانات المطلوبة' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'كلمة السر يجب أن تكون 6 أحرف على الأقل' });
    }
    
    const existingUser = dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser) {
        return res.status(400).json({ error: 'هذا البريد مسجل بالفعل' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const signupCode = generateCode();
    const tempToken = signupCode + Date.now();
    pendingVendorSignups[tempToken] = {
        name, email, phone, description, logo_url, userId,
        hashedPassword,
        code: signupCode,
        expires: Date.now() + 10 * 60 * 1000,
        used: false,
        payment_proof_image: payment_proof_image
    };
    
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">HELAXIA</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">🔐 رمز تفعيل حساب التاجر</h2><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${signupCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق</p><p style="color: #5A8CAA;">أدخل هذا الرمز في الصفحة لتفعيل حساب التاجر الخاص بك.</p></div></div>`;
    
    try {
        await transporter.sendMail({ from: '"HELAXIA" <mhmdlwbany43@gmail.com>', to: email, subject: '🔐 رمز تفعيل حساب التاجر - HELAXIA', html: htmlContent });
        res.json({ success: true, tempToken, message: 'تم إرسال رمز التفعيل إلى بريدك الإلكتروني' });
    } catch(err) { res.status(500).json({ error: 'فشل إرسال الرمز إلى الإيميل' }); }
});

app.post('/api/vendor/verify-signup-code', async (req, res) => {
    const { tempToken, code } = req.body;
    if (!pendingVendorSignups[tempToken]) return res.status(401).json({ error: 'طلب غير صالح أو منتهي الصلاحية' });
    
    const signupData = pendingVendorSignups[tempToken];
    if (signupData.used) { delete pendingVendorSignups[tempToken]; return res.status(401).json({ error: 'هذا الكود مستخدم بالفعل' }); }
    if (Date.now() > signupData.expires) { delete pendingVendorSignups[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الكود' }); }
    if (signupData.code !== code) return res.status(401).json({ error: 'الكود غير صحيح' });
    
    signupData.used = true;
    const slug = signupData.name.toLowerCase().replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FFa-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
    
    try {
        dbRun(`INSERT INTO users (name, email, password, phone, role, is_verified, status) VALUES (?, ?, ?, ?, 'vendor', 1, 'active')`, 
            [signupData.name, signupData.email, signupData.hashedPassword, signupData.phone || '']);
        const newUserId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
        dbRun(`INSERT INTO stores (vendor_id, name, slug, description, logo, whatsapp, phone, payment_proof_image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`, 
            [newUserId, signupData.name, slug, signupData.description || '', signupData.logo_url || '', signupData.phone || '', signupData.phone || '', signupData.payment_proof_image || '']);
        delete pendingVendorSignups[tempToken];
        res.json({ success: true, message: '✅ تم إنشاء حساب التاجر بنجاح. يمكنك الآن تسجيل الدخول.' });
    } catch(err) { res.status(500).json({ error: 'حدث خطأ في حفظ البيانات: ' + err.message }); }
});

// ==================== API: المدن ====================
app.get('/api/cities', (req, res) => {
    const cities = dbQuery("SELECT id, name, name_en, display_order FROM cities WHERE is_active = 1 ORDER BY display_order");
    res.json(cities);
});

app.get('/api/admin/cities', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const cities = dbQuery("SELECT * FROM cities ORDER BY display_order");
    res.json(cities);
});

app.post('/api/admin/cities', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, name_en, display_order } = req.body;
    if (!name || !name_en) return res.status(400).json({ error: 'الاسم والاسم بالإنجليزية مطلوبان' });
    
    const order = display_order || 999;
    dbRun("INSERT INTO cities (name, name_en, display_order, is_active) VALUES (?, ?, ?, 1)", [name, name_en, order]);
    res.json({ success: true, message: 'تم إضافة المدينة بنجاح' });
});

app.put('/api/admin/cities/:id', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { name, name_en, display_order, is_active } = req.body;
    const cityId = req.params.id;
    
    dbRun("UPDATE cities SET name = ?, name_en = ?, display_order = ?, is_active = ? WHERE id = ?", 
        [name, name_en, display_order || 999, is_active !== undefined ? is_active : 1, cityId]);
    res.json({ success: true, message: 'تم تحديث المدينة بنجاح' });
});

app.post('/api/admin/cities/:id/request-delete', async (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const cityId = req.params.id;
    const deleteCode = generateCode();
    const tempToken = deleteCode + Date.now();
    pendingCityDeleteTokens[tempToken] = { cityId: parseInt(cityId), code: deleteCode, expires: Date.now() + 10 * 60 * 1000, used: false };
    
    const executiveEmail = getExecutiveEmail();
    const htmlContent = `<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 550px; margin: auto; background: linear-gradient(145deg, #F0F4FA, #E0E8F0); border-radius: 32px; padding: 40px 30px; text-align: center;"><div><h1 style="font-size: 2rem; color: #2C4C6C;">⚠️ حذف مدينة</h1></div><div style="background: rgba(90,140,170,0.1); border-radius: 28px; padding: 20px;"><h2 style="color: #2C4C6C;">رمز تأكيد حذف مدينة</h2><p style="color: #3A6A8A;">أنت على وشك حذف مدينة مرتبطة بمتاجر ومنتجات.</p><div style="background: #FFFFFF; border-radius: 50px; display: inline-block; padding: 12px 35px; margin: 20px 0;"><span style="font-size: 2rem; font-weight: bold; letter-spacing: 5px; color: #2C4C6C;">${deleteCode}</span></div><p style="color: #5A8CAA;">هذا الرمز صالح لمدة 10 دقائق فقط</p></div></div>`;
    await transporter.sendMail({ from: '"HELAXIA Admin" <mhmdlwbany43@gmail.com>', to: executiveEmail, subject: '⚠️ رمز تأكيد حذف مدينة - HELAXIA', html: htmlContent });
    res.json({ success: true, tempToken, message: 'تم إرسال رمز التأكيد إلى إيميل المدير التنفيذي' });
});

app.post('/api/admin/cities/:id/confirm-delete', (req, res) => {
    const adminData = getAdminFromToken(req);
    if (!adminData) return res.status(401).json({ error: 'غير مصرح' });
    
    const { tempToken, code } = req.body;
    const cityId = req.params.id;
    
    if (!pendingCityDeleteTokens[tempToken]) return res.status(401).json({ error: 'طلب غير صالح' });
    const deleteData = pendingCityDeleteTokens[tempToken];
    if (deleteData.used) { delete pendingCityDeleteTokens[tempToken]; return res.status(401).json({ error: 'هذا الكود مستخدم بالفعل' }); }
    if (Date.now() > deleteData.expires) { delete pendingCityDeleteTokens[tempToken]; return res.status(401).json({ error: 'انتهت صلاحية الكود' }); }
    if (deleteData.code !== code) return res.status(401).json({ error: 'الكود غير صحيح' });
    if (deleteData.cityId !== parseInt(cityId)) return res.status(400).json({ error: 'خطأ في معرف المدينة' });
    
    deleteData.used = true;
    delete pendingCityDeleteTokens[tempToken];
    
    try {
        const stores = dbQuery("SELECT id, vendor_id FROM stores WHERE city_id = ?", [cityId]);
        for (const store of stores) {
            dbRun("DELETE FROM products WHERE store_id = ?", [store.id]);
            dbRun("DELETE FROM categories WHERE store_id = ?", [store.id]);
            dbRun("DELETE FROM stores WHERE id = ?", [store.id]);
            dbRun("UPDATE users SET role = 'customer' WHERE id = ?", [store.vendor_id]);
        }
        dbRun("DELETE FROM cities WHERE id = ?", [cityId]);
        res.json({ success: true, message: 'تم حذف المدينة وجميع المتاجر والمنتجات المرتبطة بها بنجاح' });
    } catch(err) { res.status(500).json({ error: 'فشل حذف المدينة: ' + err.message }); }
});

app.get('/api/products/filtered', (req, res) => {
    const cityId = req.query.city_id || 0;
    
    const globalProducts = dbQuery("SELECT * FROM products WHERE is_global = 1");
    const formattedGlobal = globalProducts.map(p => ({ 
        id: p.id, name: p.name, base_price: p.base_price, 
        images: JSON.parse(p.images || '[]'),
        description: p.description, fabric_type: p.fabric_type, sizes: p.sizes, colors: p.colors,
        store_id: p.store_id, is_featured: p.is_featured, is_global: p.is_global || 0
    }));
    
    let storeProducts = [];
    if (cityId && cityId != 0) {
        const products = dbQuery(`
            SELECT p.* FROM products p
            INNER JOIN stores s ON p.store_id = s.id
            WHERE s.status = 'active' AND s.city_id = ? AND (p.is_global IS NULL OR p.is_global = 0)
        `, [cityId]);
        storeProducts = products.map(p => ({ 
            id: p.id, name: p.name, base_price: p.base_price, 
            images: JSON.parse(p.images || '[]'),
            description: p.description, fabric_type: p.fabric_type, sizes: p.sizes, colors: p.colors,
            store_id: p.store_id, is_featured: p.is_featured, is_global: p.is_global || 0
        }));
    }
    
    const allProducts = [...formattedGlobal, ...storeProducts];
    res.json(allProducts);
});

// ==================== صفحات الويب ====================
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/signup', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'signup.html')); });
app.get('/verify', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'verify.html')); });
app.get('/shop', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'shop.html')); });
app.get('/cart.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'cart.html')); });
app.get('/stores.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'stores.html')); });
app.get('/my-orders.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'my-orders.html')); });
app.get('/vendor-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'vendor-login.html')); });
app.get('/vendor-apply', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'vendor-apply.html')); });
app.get('/section', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'section.html')); });
app.get('/vendor/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'vendor-dashboard.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/admin-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin-login.html')); });
app.get('/add-existing-product.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'add-existing-product.html')); });
app.get('/cashier-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'cashier-login.html')); });
app.get('/cashier', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'cashier.html')); });
app.get('/store/:slug', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'store.html')); });

// ==================== تشغيل الخادم ====================
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ HELAXIA v3 running on http://localhost:${PORT}`);
        console.log(`🔗 Shop: http://localhost:${PORT}/shop`);
        console.log(`🔗 Vendor: http://localhost:${PORT}/vendor/dashboard`);
        console.log(`🔗 Admin: http://localhost:${PORT}/admin`);
        console.log(`💰 Cashier: http://localhost:${PORT}/cashier`);
    });
}).catch(err => console.error(err));