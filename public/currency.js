// currency.js - تحويل العملة العام لجميع صفحات HELAXIA

let globalCurrency = localStorage.getItem('helaxia_currency') || 'SYP';
let exchangeRate = 13000;

async function loadExchangeRate() {
    try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        if (settings.exchange_rate) {
            exchangeRate = parseFloat(settings.exchange_rate);
            localStorage.setItem('exchange_rate', exchangeRate);
        }
    } catch(e) { 
        console.error('فشل تحميل سعر الصرف:', e);
    }
}

function convertPrice(priceSYP) {
    const price = parseFloat(priceSYP);
    if (isNaN(price)) return 0;
    if (globalCurrency === 'USD') {
        return (price / exchangeRate).toFixed(2);
    }
    return price;
}

function formatPrice(priceSYP) {
    const converted = convertPrice(priceSYP);
    if (globalCurrency === 'USD') {
        // إزالة الأصفار الزائدة من الدولار (مثال: 10.00 → 10)
        const num = parseFloat(converted);
        const formatted = num % 1 === 0 ? num.toString() : num.toFixed(2);
        return `${formatted} $`;
    } else {
        // عرض الليرة السورية بدون كسور (عدد صحيح)
        return `${Math.floor(converted)} ل.س`;
    }
}

function formatPriceForCart(priceSYP) {
    // نفس formatPrice ولكن بدون أي معالجة إضافية
    const converted = convertPrice(priceSYP);
    if (globalCurrency === 'USD') {
        const num = parseFloat(converted);
        const formatted = num % 1 === 0 ? num.toString() : num.toFixed(2);
        return `${formatted} $`;
    } else {
        return `${Math.floor(converted)} ل.س`;
    }
}

function toggleGlobalCurrency() {
    globalCurrency = globalCurrency === 'SYP' ? 'USD' : 'SYP';
    localStorage.setItem('helaxia_currency', globalCurrency);
    updateAllPrices();
    
    // تحديث نص زر العملة
    const currencyText = document.getElementById('globalCurrencyText');
    if (currencyText) {
        currencyText.innerText = globalCurrency === 'SYP' ? 'ل.س' : '$';
    }
    
    // إذا كنا في صفحة السلة، أعد تحميلها
    if (window.location.pathname.includes('/cart.html')) {
        if (typeof renderCart === 'function') {
            renderCart();
        } else if (window.renderCart) {
            window.renderCart();
        }
    }
}

function updateCartPrices() {
    // تحديث الأسعار في صفحة السلة
    // وحدات الأسعار الفردية
    document.querySelectorAll('.unit-price, .item-total, .cart-total, .summary-total').forEach(el => {
        const syp = el.getAttribute('data-syp');
        if (syp && !isNaN(parseFloat(syp))) {
            el.innerHTML = formatPrice(parseFloat(syp));
        }
    });
    
    // تحديث الإجمالي في ملخص الطلب
    const totalElement = document.querySelector('.total-row span:last-child, .summary-row.total-row span:last-child');
    if (totalElement) {
        const totalText = totalElement.innerText;
        const match = totalText.match(/(\d+(?:\.\d+)?)/);
        if (match && match[1]) {
            const price = parseFloat(match[1]);
            if (!isNaN(price)) {
                // نحتاج إلى معرف السعر الأصلي بالليرة
                // إذا لم يكن هناك data-syp، نفترض أن السعر المعروض هو بالليرة
                const originalPrice = price;
                totalElement.innerHTML = formatPrice(originalPrice);
            }
        }
    }
}

function updateAllPrices() {
    // تحديث جميع العناصر التي تحمل class price-value
    document.querySelectorAll('.price-value').forEach(el => {
        const syp = el.getAttribute('data-syp');
        if (syp && !isNaN(parseFloat(syp))) {
            el.innerHTML = formatPrice(parseFloat(syp));
        }
    });
    
    // تحديث عناصر السلة
    updateCartPrices();
    
    // تحديث أي عناصر أخرى تعرض الأسعار
    document.querySelectorAll('.fifa-price, .product-price, .modal-price, .mini-product-price').forEach(el => {
        const syp = el.getAttribute('data-syp');
        if (syp && !isNaN(parseFloat(syp))) {
            el.innerHTML = formatPrice(parseFloat(syp));
        } else {
            // محاولة استخراج السعر من النص إذا لم يكن هناك data-syp
            const text = el.innerText;
            const match = text.match(/(\d+(?:\.\d+)?)/);
            if (match && match[1]) {
                const price = parseFloat(match[1]);
                if (!isNaN(price) && price < 1000000) { // تجنب الأرقام الكبيرة جداً
                    el.setAttribute('data-syp', price);
                    el.innerHTML = formatPrice(price);
                }
            }
        }
    });
    
    // تحديث عداد السلة (يبقى كما هو لا يتغير)
    const cartCount = document.getElementById('cartCount');
    if (cartCount && window.cart) {
        const count = window.cart.reduce((s, i) => s + (i.quantity || 1), 0);
        cartCount.innerText = count;
    }
}

// دالة لتهيئة العملة في أي صفحة
async function initCurrency() {
    await loadExchangeRate();
    
    // استعادة العملة المحفوظة
    const savedCurrency = localStorage.getItem('helaxia_currency');
    if (savedCurrency === 'USD' || savedCurrency === 'SYP') {
        globalCurrency = savedCurrency;
    } else {
        globalCurrency = 'SYP';
    }
    
    // تحديث نص زر العملة
    const currencyText = document.getElementById('globalCurrencyText');
    if (currencyText) {
        currencyText.innerText = globalCurrency === 'SYP' ? 'ل.س' : '$';
    }
    
    updateAllPrices();
}

// تصدير الدوال للاستخدام العالمي
window.formatPrice = formatPrice;
window.formatPriceForCart = formatPriceForCart;
window.convertPrice = convertPrice;
window.toggleGlobalCurrency = toggleGlobalCurrency;
window.loadExchangeRate = loadExchangeRate;
window.updateAllPrices = updateAllPrices;
window.updateCartPrices = updateCartPrices;
window.initCurrency = initCurrency;

// تحميل سعر الصرف عند بدء الصفحة
initCurrency();