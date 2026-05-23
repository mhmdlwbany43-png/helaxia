const fs = require('fs');
const initSqlJs = require('sql.js');
const path = require('path');

const DB_PATH = path.join(__dirname, 'helaxia.db');
let db;

async function initDatabase() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const dbData = fs.readFileSync(DB_PATH);
        db = new SQL.Database(dbData);
        console.log('✅ Database loaded from file');
        
        // ========== تحديث قاعدة البيانات القديمة لإضافة الجداول الجديدة ==========
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS product_categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    category_id INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
                    UNIQUE(product_id, category_id)
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS financial_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transaction_number TEXT UNIQUE NOT NULL,
                    order_id INTEGER NOT NULL,
                    vendor_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    shipping_fee_vendor_share REAL DEFAULT 0,
                    shipping_fee_customer_share REAL DEFAULT 0,
                    net_amount REAL NOT NULL,
                    status TEXT DEFAULT 'pending',
                    transaction_type TEXT DEFAULT 'sale',
                    confirmed_by INTEGER,
                    confirmed_at DATETIME,
                    released_at DATETIME,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS vendor_balances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    vendor_id INTEGER UNIQUE NOT NULL,
                    total_earned REAL DEFAULT 0,
                    pending_balance REAL DEFAULT 0,
                    pending_withdrawal REAL DEFAULT 0,
                    withdrawn_balance REAL DEFAULT 0,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS withdrawal_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_number TEXT UNIQUE NOT NULL,
                    vendor_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    status TEXT DEFAULT 'pending',
                    notes TEXT,
                    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    processed_at DATETIME,
                    processed_by INTEGER,
                    completed_at DATETIME,
                    FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS shipping_costs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    total_shipping_cost REAL NOT NULL,
                    customer_share REAL NOT NULL,
                    vendors_share REAL NOT NULL,
                    distribution_method TEXT DEFAULT 'by_sales',
                    notes TEXT,
                    set_by INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS product_sales_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    vendor_id INTEGER NOT NULL,
                    order_id INTEGER NOT NULL,
                    quantity INTEGER NOT NULL,
                    unit_price REAL NOT NULL,
                    total_price REAL NOT NULL,
                    shipping_deduction REAL DEFAULT 0,
                    customer_received INTEGER DEFAULT 0,
                    received_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                    FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    related_id INTEGER,
                    is_read INTEGER DEFAULT 0,
                    sent_via_whatsapp INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
        } catch(e) {}
        
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS system_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    action TEXT NOT NULL,
                    details TEXT,
                    ip_address TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                )
            `);
        } catch(e) {}
        
        // ========== إضافة الأعمدة الجديدة للجدول stores (للقاعدة القديمة) ==========
        try {
            db.run("ALTER TABLE stores ADD COLUMN phone TEXT DEFAULT ''");
            console.log('✅ phone column added to stores');
        } catch(e) {}
        
        try {
            db.run("ALTER TABLE stores ADD COLUMN payment_proof_image TEXT DEFAULT ''");
            console.log('✅ payment_proof_image column added to stores');
        } catch(e) {}
        
        // ========== إضافة عمود pickup_location إلى جدول orders (للقاعدة القديمة) ==========
        try {
            db.run("ALTER TABLE orders ADD COLUMN pickup_location TEXT DEFAULT ''");
            console.log('✅ pickup_location column added to orders');
        } catch(e) {}
        
        // ========== إضافة أعمدة نظام المدن (للقاعدة القديمة) ==========
        try {
            db.run("ALTER TABLE stores ADD COLUMN city_id INTEGER DEFAULT 0");
            console.log('✅ city_id column added to stores');
        } catch(e) {}
        
        try {
            db.run("ALTER TABLE products ADD COLUMN is_global INTEGER DEFAULT 0");
            console.log('✅ is_global column added to products');
        } catch(e) {}
        
        // ========== إنشاء جدول المدن (للقاعدة القديمة) ==========
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS cities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    name_en TEXT NOT NULL,
                    display_order INTEGER DEFAULT 0,
                    is_active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ cities table created');
            
            // ✅ تم إصلاحها: إضافة المدن الافتراضية باستخدام Prepared Statement
            const citiesCount = db.exec("SELECT COUNT(*) FROM cities");
            if (!citiesCount[0] || citiesCount[0].values[0][0] === 0) {
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
                
                // ✅ آمن - Prepared Statement
                const stmt = db.prepare("INSERT INTO cities (name, name_en, display_order) VALUES (?, ?, ?)");
                for (const city of defaultCities) {
                    stmt.bind([city.name, city.name_en, city.order]);
                    stmt.step();
                    stmt.reset();
                }
                stmt.free();
                console.log('✅ Default cities added');
            }
        } catch(e) {
            console.log('⚠️ Cities table creation error:', e.message);
        }
        
    } else {
        db = new SQL.Database();
        console.log('✅ Creating new database...');
        
        // 1. Users table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                phone TEXT,
                role TEXT DEFAULT 'customer',
                is_verified INTEGER DEFAULT 0,
                verification_code TEXT,
                status TEXT DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 2. Stores table (مع الأعمدة الجديدة)
        db.run(`
            CREATE TABLE IF NOT EXISTS stores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vendor_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                slug TEXT UNIQUE NOT NULL,
                logo TEXT,
                description TEXT,
                whatsapp TEXT,
                phone TEXT,
                payment_proof_image TEXT DEFAULT '',
                city_id INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                rating REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        // 3. Cities table
        db.run(`
            CREATE TABLE IF NOT EXISTS cities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                name_en TEXT NOT NULL,
                display_order INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Cities table created');
        
        // ✅ تم إصلاحها: إضافة المدن الافتراضية باستخدام Prepared Statement
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
        
        // ✅ آمن - Prepared Statement
        const stmt = db.prepare("INSERT INTO cities (name, name_en, display_order) VALUES (?, ?, ?)");
        for (const city of defaultCities) {
            stmt.bind([city.name, city.name_en, city.order]);
            stmt.step();
            stmt.reset();
        }
        stmt.free();
        console.log('✅ Default cities added');
        
        // 4. Categories table
        db.run(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER DEFAULT 0,
                store_id INTEGER DEFAULT 0,
                display_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Categories table created');
        
        // 5. Products table (مع عمود is_global)
        db.run(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                store_id INTEGER DEFAULT 0,
                name TEXT NOT NULL,
                description TEXT,
                fabric_type TEXT,
                sizes TEXT,
                colors TEXT,
                base_price INTEGER NOT NULL,
                image_url TEXT,
                images TEXT,
                is_featured INTEGER DEFAULT 0,
                is_global INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 6. Product-Categories (Many-to-Many)
        db.run(`
            CREATE TABLE IF NOT EXISTS product_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
                UNIQUE(product_id, category_id)
            )
        `);
        console.log('✅ product_categories table created');
        
        // 7. Orders table (مع عمود pickup_location)
        db.run(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number TEXT UNIQUE NOT NULL,
                customer_id INTEGER,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL,
                notes TEXT,
                items TEXT NOT NULL,
                total INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                shipping_cost REAL DEFAULT 0,
                payment_status TEXT DEFAULT 'pending',
                pickup_location TEXT DEFAULT '',
                FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        
        // 8. Settings table
        db.run(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);
        
        // ========== الجداول الجديدة لنظام الدفع ==========
        
        db.run(`
            CREATE TABLE IF NOT EXISTS financial_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_number TEXT UNIQUE NOT NULL,
                order_id INTEGER NOT NULL,
                vendor_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                shipping_fee_vendor_share REAL DEFAULT 0,
                shipping_fee_customer_share REAL DEFAULT 0,
                net_amount REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                transaction_type TEXT DEFAULT 'sale',
                confirmed_by INTEGER,
                confirmed_at DATETIME,
                released_at DATETIME,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS vendor_balances (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vendor_id INTEGER UNIQUE NOT NULL,
                total_earned REAL DEFAULT 0,
                pending_balance REAL DEFAULT 0,
                pending_withdrawal REAL DEFAULT 0,
                withdrawn_balance REAL DEFAULT 0,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS withdrawal_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_number TEXT UNIQUE NOT NULL,
                vendor_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                notes TEXT,
                requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                processed_at DATETIME,
                processed_by INTEGER,
                completed_at DATETIME,
                FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS shipping_costs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                total_shipping_cost REAL NOT NULL,
                customer_share REAL NOT NULL,
                vendors_share REAL NOT NULL,
                distribution_method TEXT DEFAULT 'by_sales',
                notes TEXT,
                set_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS product_sales_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                vendor_id INTEGER NOT NULL,
                order_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL,
                total_price REAL NOT NULL,
                shipping_deduction REAL DEFAULT 0,
                customer_received INTEGER DEFAULT 0,
                received_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                related_id INTEGER,
                is_read INTEGER DEFAULT 0,
                sent_via_whatsapp INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        
        // Default settings
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_whatsapp', '963995607915')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_email', 'mhmdlwbany43@gmail.com')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('exchange_rate', '13000')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('cashier_whatsapp', '963995607915')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('platform_fee_percent', '0')");
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('max_shipping_deduction_percent', '2')");
        
        // ========== لا توجد بيانات تجريبية ==========
        
        console.log('✅ All tables created successfully (no sample data)');
    }
    
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
    return db;
}

function getDb() {
    if (!db) throw new Error('Database not initialized');
    return db;
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

module.exports = { initDatabase, getDb, saveDatabase };

if (require.main === module) {
    initDatabase().catch(console.error);
}